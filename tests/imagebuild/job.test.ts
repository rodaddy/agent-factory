/**
 * @module tests/imagebuild/job
 * @description Hermetic tests for the pure Kaniko Job renderer. The
 *   claim under test is a MIRROR claim: the object this factory renders must be
 *   indistinguishable from one `scripts/image-build-job.sh` rendered out of
 *   `kaniko-job.template.yaml` on rtech-infra main. So the golden test writes the
 *   expected fields BY HAND from the template rather than importing them from the
 *   module — a fixture derived from the code under test would pass no matter what
 *   the code said.
 *
 *   THE LOAD-BEARING CASES beyond the golden shape are the ones that cost a real
 *   incident upstream: the per-app owner override (`web-bb-landing` published under
 *   `rtech/` and the k3s-deploy bump pointed at a tag that did not exist), the
 *   quoted `GIT_REF` (an all-digit 40-char SHA is a legal SHA and an unquoted one
 *   is parsed as a number, rejected by the API server for ~1 commit in 10^8), the
 *   40-hex reproducibility gate (a branch ref makes the image irreproducible, and
 *   there is no `--allow-unpinned` on this side, ever), and the
 *   unsubstituted-placeholder guard the script runs after `sed`.
 */
import { describe, expect, test } from "bun:test";
import { DNS_LABEL_PATTERN } from "../../src/names/dns-label";
import {
	IMAGE_BUILDS,
	jobLabelSelector,
	renderKanikoJob,
	resolveRegistryOwner,
	tagLabel,
} from "../../src/imagebuild/job";

/** A fixed 40-hex commit, letters included, so it is a legal ordinary SHA. */
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** The same length, all digits — a legal SHA that YAML would read as a number. */
const ALL_DIGIT_SHA = "1234567890123456789012345678901234567890";

describe("renderKanikoJob — the golden mirror of kaniko-job.template.yaml", () => {
	const rendered = renderKanikoJob({
		repository: "acme/web-bb-landing",
		tag: "v0.6.0",
		commitSha: SHA,
	});

	test("apiVersion, kind, and metadata mirror the template", () => {
		expect(rendered.apiVersion).toBe("batch/v1");
		expect(rendered.kind).toBe("Job");
		expect(rendered.metadata.generateName).toBe("build-web-bb-landing-");
		expect(rendered.metadata.namespace).toBe("image-builds");
		// Written out, not spread from the module: the four template labels plus
		// the two adoption-key labels the factory adds — the adoption
		// key must include the commit, or a force-moved tag adopts the old build.
		expect(rendered.metadata.labels).toEqual({
			"app.kubernetes.io/name": "image-build",
			"app.kubernetes.io/component": "kaniko",
			"image-builds.rtech/app": "web-bb-landing",
			"image-builds.rtech/tag": "v0.6.0",
			"image-builds.rtech/sha": SHA,
			"image-builds.rtech/owner": "acme",
		});
	});

	test("job spec knobs mirror the env map", () => {
		expect(rendered.spec.backoffLimit).toBe(0);
		expect(rendered.spec.ttlSecondsAfterFinished).toBe(86400);
		expect(rendered.spec.activeDeadlineSeconds).toBe(1800);
		expect(rendered.spec.template.metadata.labels).toEqual({
			"app.kubernetes.io/name": "image-build",
			"image-builds.rtech/app": "web-bb-landing",
		});
		expect(rendered.spec.template.spec.restartPolicy).toBe("Never");
		expect(rendered.spec.template.spec.automountServiceAccountToken).toBe(false);
	});

	test("the clone initContainer carries the split repo URL and ref", () => {
		const clone = rendered.spec.template.spec.initContainers[0];
		expect(clone?.name).toBe("clone");
		expect(clone?.image).toBe("alpine/git:v2.49.1");
		expect(clone?.command[0]).toBe("/bin/sh");
		expect(clone?.command[1]).toBe("-c");
		// The script splits `git://host/owner/repo.git#sha` into URL and ref, and
		// prefixes plain HTTP because the fleet registry speaks it.
		expect(clone?.env).toEqual([
			{ name: "GIT_HOST", value: "10.0.20.58:3000" },
			{
				name: "GIT_REPO_URL",
				value: "http://10.0.20.58:3000/acme/web-bb-landing.git",
			},
			{ name: "GIT_REF", value: SHA },
			{
				name: "GIT_USERNAME",
				valueFrom: { secretKeyRef: { name: "image-builds-git", key: "username" } },
			},
			{
				name: "GIT_PASSWORD",
				valueFrom: { secretKeyRef: { name: "image-builds-git", key: "password" } },
			},
		]);
		expect(clone?.volumeMounts).toEqual([{ name: "workspace", mountPath: "/workspace" }]);
		expect(clone?.resources).toEqual({
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "500m", memory: "512Mi" },
		});
		// The pin is ENFORCED inside the pod, not merely requested.
		expect(clone?.command[2]).toContain('git fetch -q --depth 1 origin "$GIT_REF"');
		expect(clone?.command[2]).toContain("REFUSED: asked for $GIT_REF but HEAD is $GOT");
	});

	test("the kaniko args list matches the template in order", () => {
		const kaniko = rendered.spec.template.spec.containers[0];
		expect(kaniko?.name).toBe("kaniko");
		expect(kaniko?.image).toBe("gcr.io/kaniko-project/executor:v1.24.0");
		expect(kaniko?.args).toEqual([
			"--context=dir:///workspace/src",
			"--dockerfile=Dockerfile",
			"--destination=10.0.20.58:3000/acme/web-bb-landing:v0.6.0",
			"--cache=true",
			"--cache-repo=10.0.20.58:3000/rtech/kaniko-cache",
			"--snapshot-mode=redo",
			"--insecure",
			"--insecure-pull",
			"--skip-tls-verify",
			"--skip-tls-verify-pull",
			"--verbosity=info",
		]);
		expect(kaniko?.volumeMounts).toEqual([
			{ name: "docker-config", mountPath: "/kaniko/.docker", readOnly: true },
			{ name: "workspace", mountPath: "/workspace" },
		]);
		expect(kaniko?.resources).toEqual({
			requests: { cpu: "500m", memory: "1Gi" },
			limits: { cpu: "2", memory: "4Gi" },
		});
	});

	test("the kaniko securityContext keeps exactly the layer-extraction caps", () => {
		const kaniko = rendered.spec.template.spec.containers[0];
		expect(kaniko?.securityContext).toEqual({
			runAsUser: 0,
			allowPrivilegeEscalation: false,
			privileged: false,
			readOnlyRootFilesystem: false,
			capabilities: {
				drop: ["ALL"],
				add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
			},
		});
	});

	test("volumes are the regcred secret projected to config.json plus an emptyDir", () => {
		expect(rendered.spec.template.spec.volumes).toEqual([
			{
				name: "docker-config",
				secret: {
					secretName: "image-builds-regcred",
					items: [{ key: ".dockerconfigjson", path: "config.json" }],
				},
			},
			{ name: "workspace", emptyDir: {} },
		]);
	});

	test("a non-default dockerfile reaches the kaniko args", () => {
		const custom = renderKanikoJob({
			repository: "rtech/thing",
			tag: "v1.0.0",
			commitSha: SHA,
			dockerfile: "docker/Dockerfile.prod",
		});
		expect(custom.spec.template.spec.containers[0]?.args[1]).toBe(
			"--dockerfile=docker/Dockerfile.prod",
		);
	});
});

describe("resolveRegistryOwner — the script's three-step order", () => {
	test("a per-app entry in the env map wins over the fleet default", () => {
		expect(resolveRegistryOwner("web-bb-landing")).toBe("acme");
	});

	test("an app with no entry falls back to the fleet default", () => {
		expect(resolveRegistryOwner("web-rtech-consulting")).toBe("rtech");
		expect(IMAGE_BUILDS.registryOwner).toBe("rtech");
	});

	test("an explicit owner beats everything", () => {
		expect(resolveRegistryOwner("web-bb-landing", "someorg")).toBe("someorg");
		expect(resolveRegistryOwner("web-rtech-consulting", "someorg")).toBe("someorg");
	});

	test("the destination follows the resolved owner, not the repository owner", () => {
		// `acme/web-bb-landing` and the override agree here; the case that
		// matters is an app whose git owner differs from its registry owner.
		const rendered = renderKanikoJob({
			repository: "rtech/web-bb-landing",
			tag: "v0.6.0",
			commitSha: SHA,
		});
		expect(rendered.spec.template.spec.containers[0]?.args[2]).toBe(
			"--destination=10.0.20.58:3000/acme/web-bb-landing:v0.6.0",
		);
	});
});

describe("tagLabel — the script's TAG_LABEL transform", () => {
	test("characters outside [A-Za-z0-9_.-] become '-'", () => {
		expect(tagLabel("v1.0.0+build/3")).toBe("v1.0.0-build-3");
	});

	test("a 70-char tag is cut to 63", () => {
		const long = "v".repeat(70);
		expect(long.length).toBe(70);
		expect(tagLabel(long)).toBe("v".repeat(63));
		expect(tagLabel(long).length).toBe(63);
	});

	test("a plain semver tag is unchanged", () => {
		expect(tagLabel("v0.6.0")).toBe("v0.6.0");
	});
});

describe("jobLabelSelector", () => {
	test("selects on app, LABELISED tag, sha, and owner", () => {
		expect(
			jobLabelSelector({
				owner: "acme",
				app: "web-bb-landing",
				tag: "v1.0.0+build/3",
				sha: SHA,
			}),
		).toBe(
			`image-builds.rtech/app=web-bb-landing,image-builds.rtech/tag=v1.0.0-build-3,image-builds.rtech/sha=${SHA},image-builds.rtech/owner=acme`,
		);
	});
});

describe("renderKanikoJob refusals", () => {
	test("a 7-char sha is refused", () => {
		expect(() =>
			renderKanikoJob({ repository: "rtech/thing", tag: "v1.0.0", commitSha: "a1b2c3d" }),
		).toThrow(/commitSha/);
	});

	test("a 40-char sha carrying an uppercase letter is refused", () => {
		const upper = `A${SHA.slice(1)}`;
		expect(upper.length).toBe(40);
		expect(() =>
			renderKanikoJob({ repository: "rtech/thing", tag: "v1.0.0", commitSha: upper }),
		).toThrow(/commitSha/);
	});

	test("a repository that is not <owner>/<repo> is refused", () => {
		for (const repository of ["thing", "a/b/c", "rtech/th ing", "rtech/"]) {
			expect(() => renderKanikoJob({ repository, tag: "v1.0.0", commitSha: SHA })).toThrow(
				/repository/,
			);
		}
	});

	test("a tag with an illegal character or over 128 chars is refused", () => {
		expect(() =>
			renderKanikoJob({ repository: "rtech/thing", tag: "v1.0.0 bad", commitSha: SHA }),
		).toThrow(/tag/);
		expect(() =>
			renderKanikoJob({ repository: "rtech/thing", tag: "v".repeat(129), commitSha: SHA }),
		).toThrow(/tag/);
	});

	test("a short name that is not an RFC 1123 DNS label is refused", () => {
		// It would land in metadata.generateName and be rejected at admission with
		// a 422, which the pass reads as "may have created a Job" — pending forever.
		for (const repository of [
			"owner/Web_Landing",
			"owner/.hidden",
			"owner/-lead",
			"owner/trail-",
		]) {
			expect(() => renderKanikoJob({ repository, tag: "v1.0.0", commitSha: SHA })).toThrow(/app/);
		}
	});

	test("a short name too long for the generateName prefix is refused", () => {
		// `build-` + app + `-` + 5 generated suffix characters must fit in 63.
		const app = "a".repeat(52);
		expect(`build-${app}-`.length + 5).toBeGreaterThan(63);
		expect(() =>
			renderKanikoJob({ repository: `owner/${app}`, tag: "v1.0.0", commitSha: SHA }),
		).toThrow(/app/);
	});

	test("an owner that is not a legal label value is refused", () => {
		for (const repository of ["-owner/thing", "owner./thing", `${"o".repeat(64)}/thing`]) {
			expect(() => renderKanikoJob({ repository, tag: "v1.0.0", commitSha: SHA })).toThrow(/owner/);
		}
	});

	test("a tag whose labelised form does not start and end alphanumeric is refused", () => {
		// tagLabel("+x.") is "-x." — a value the API server rejects on the LABEL.
		expect(tagLabel("+x.")).toBe("-x.");
		expect(() =>
			renderKanikoJob({ repository: "rtech/thing", tag: "+x.", commitSha: SHA }),
		).toThrow(/tag/);
	});

	test("the legal cases still render", () => {
		expect(() =>
			renderKanikoJob({ repository: "acme/web-bb-landing", tag: "v1.2.3", commitSha: SHA }),
		).not.toThrow();
		// `1.2.3+build.7` labelises to `1.2.3-build.7`, which is legal.
		expect(tagLabel("1.2.3+build.7")).toBe("1.2.3-build.7");
		expect(() =>
			renderKanikoJob({
				repository: "acme/web-bb-landing",
				tag: "1.2.3+build.7",
				commitSha: SHA,
			}),
		).not.toThrow();
	});

	test("no error message carries the whole rendered object", () => {
		try {
			renderKanikoJob({ repository: "rtech/thing", tag: "v1.0.0", commitSha: "a1b2c3d" });
			throw new Error("expected a refusal");
		} catch (error) {
			expect((error as Error).message.length).toBeLessThan(200);
		}
	});
});

describe("the rendered object is safe to POST", () => {
	test("GIT_REF is a string even for an all-digit sha", () => {
		const rendered = renderKanikoJob({
			repository: "rtech/thing",
			tag: "v1.0.0",
			commitSha: ALL_DIGIT_SHA,
		});
		const ref = rendered.spec.template.spec.initContainers[0]?.env.find(
			(entry) => entry.name === "GIT_REF",
		);
		expect(typeof ref?.value).toBe("string");
		expect(ref?.value).toBe(ALL_DIGIT_SHA);
	});

	test("it round-trips through JSON unchanged and contains no undefined", () => {
		const rendered = renderKanikoJob({
			repository: "acme/web-bb-landing",
			tag: "v0.6.0",
			commitSha: SHA,
		});
		const serialised = JSON.stringify(rendered);
		expect(JSON.parse(serialised)).toEqual(rendered);
		expect(serialised).not.toContain("undefined");
	});

	test("no unsubstituted __PLACEHOLDER__ survives (the script's own guard)", () => {
		const serialised = JSON.stringify(
			renderKanikoJob({ repository: "acme/web-bb-landing", tag: "v0.6.0", commitSha: SHA }),
		);
		expect(serialised).not.toContain("__");
	});
});

describe("Job adoption key when the repository owner and the registry owner differ", () => {
	test("the owner LABEL is the repository's owner and the adoption SELECTOR asks for the same value", () => {
		// rodaddy/api publishes to <registry>/rtech/api: the registry owner is
		// resolved from the image name, the owner label is the repository's.
		// The build lane's selector uses ownerOf(row.repository), the same
		// segment, so a lost create response is recovered by adoption rather
		// than duplicated. This pins the two sides against each other.
		const rendered = renderKanikoJob({ repository: "rodaddy/api", tag: "v1.0.0", commitSha: SHA });
		const args = rendered.spec.template.spec.containers[0]?.args ?? [];
		expect(args[2]).toBe("--destination=10.0.20.58:3000/rtech/api:v1.0.0");
		expect(rendered.metadata.labels["image-builds.rtech/owner"]).toBe("rodaddy");
		const selector = jobLabelSelector({ owner: "rodaddy", app: "api", tag: "v1.0.0", sha: SHA });
		for (const pair of selector.split(",")) {
			const [key, value] = pair.split("=");
			expect(rendered.metadata.labels[key ?? ""]).toBe(value);
		}
	});
});

describe("renderKanikoJob image override", () => {
	test("an explicit image names the destination, generateName, and app label, not the repository short name", () => {
		const rendered = renderKanikoJob({
			repository: "rodaddy/rtech-mcps",
			tag: "v0.1.0",
			commitSha: SHA,
			image: "mcp-gitingest",
			dockerfile: "servers/gitingest/Containerfile",
		});
		expect(rendered.metadata.generateName).toBe("build-mcp-gitingest-");
		expect(rendered.metadata.labels["image-builds.rtech/app"]).toBe("mcp-gitingest");
		expect(rendered.metadata.labels["image-builds.rtech/owner"]).toBe("rodaddy");
		const args = rendered.spec.template.spec.containers[0]?.args ?? [];
		expect(args[1]).toBe("--dockerfile=servers/gitingest/Containerfile");
		expect(args[2]).toBe("--destination=10.0.20.58:3000/rtech/mcp-gitingest:v0.1.0");
	});

	test("an image that is not a DNS label is refused like a bad short name", () => {
		for (const image of ["Mcp_Gitingest", "-lead", "a".repeat(52)]) {
			expect(() =>
				renderKanikoJob({ repository: "rodaddy/rtech-mcps", tag: "v0.1.0", commitSha: SHA, image }),
			).toThrow(/app/);
		}
	});
});

describe("the imagebuild DNS label is capped at 63 chars", () => {
	test("a 64-char label is refused and a 63-char label is accepted", () => {
		expect(DNS_LABEL_PATTERN.test("a".repeat(64))).toBe(false);
		expect(DNS_LABEL_PATTERN.test("a".repeat(63))).toBe(true);
	});
});
