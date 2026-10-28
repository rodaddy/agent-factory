/**
 * Functional tests for `hosted-app render` at its two boundaries: the pure
 * `renderTarget` map, and the CLI's exit code. The fixtures are the same two
 * documents the validator tests use, so a schema change that breaks the
 * documented shape goes red in both places.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { runHostedApp } from "../../src/hostedapp/command";
import { renderTarget, writeRendered } from "../../src/hostedapp/render";
import type { Declaration, RegistryEntry } from "../../src/hostedapp/schema";
import { validateDeclaration, validateRegistryEntry } from "../../src/hostedapp/validate";
import { testTmpBase } from "../support/test-temp";

/** A fresh output directory beneath the portable test temp base. */
function makeTempDir(prefix: string): string {
	return mkdtempSync(join(testTmpBase(), `${prefix}-`));
}

const FIXTURES = "tests/hostedapp/fixtures";
const DECL_PATH = `${FIXTURES}/declaration.yaml`;
const ENTRY_PATH = `${FIXTURES}/registry-entry.yaml`;

/** Why a validate result failed, across both failure variants. */
function why(r: { problems: unknown } | { harness: string }): string {
	return "harness" in r ? r.harness : JSON.stringify(r.problems);
}

/** The fixture declaration, parsed; a fixture that stops validating is a bug. */
async function decl(): Promise<Declaration> {
	const r = validateDeclaration(await Bun.file(DECL_PATH).text());
	if (!r.ok) throw new Error(`fixture declaration invalid: ${why(r)}`);
	return r.value;
}

/** The fixture registry entry, parsed. */
async function entry(): Promise<RegistryEntry> {
	const r = validateRegistryEntry(await Bun.file(ENTRY_PATH).text());
	if (!r.ok) throw new Error(`fixture entry invalid: ${why(r)}`);
	return r.value;
}

/** The config-file content map the fixture declaration needs to render. */
async function configs(): Promise<Map<string, string>> {
	return new Map([["app-config", await Bun.file(`${FIXTURES}/deploy/config.yaml`).text()]]);
}

/**
 * The fixture declaration with a `uat` override that ADDS a second config
 * file, written to a temp dir. `--source-dir` still points at the fixtures,
 * so both `deploy/` paths resolve; only the declaration is derived.
 */
async function overrideFixtureDir(): Promise<string> {
	const dir = makeTempDir("hostedapp-override-decl");
	const base = await Bun.file(DECL_PATH).text();
	const anchor = [
		"      hostnames:",
		"        - { host: linkedin-uat.rtech.internal, public: false }",
	].join("\n");
	if (!base.includes(anchor)) throw new Error("fixture declaration lost its uat override block");
	const declared = base.replace(
		anchor,
		[
			anchor,
			"      config_files:",
			"        - { name: app-config, mount: /etc/app/config.yaml, path: deploy/config.yaml }",
			"        - { name: uat-extra, mount: /etc/app/uat-extra.yaml, path: deploy/uat-extra.yaml }",
		].join("\n"),
	);
	await Bun.write(`${dir}/declaration.yaml`, declared);
	return dir;
}

/** Render a target, failing the test rather than returning a problem union. */
async function render(
	target: string,
	mutate: (d: Declaration, e: RegistryEntry) => void = () => {},
): Promise<Map<string, string>> {
	const d = await decl();
	const e = await entry();
	mutate(d, e);
	const r = renderTarget(d, e, target, await configs());
	if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.problems)}`);
	return r.files;
}

/** Every YAML document in one rendered file. */
function documents(text: string): Record<string, unknown>[] {
	return parseAllDocuments(text)
		.map((d) => d.toJS() as Record<string, unknown> | null)
		.filter((d): d is Record<string, unknown> => d !== null);
}

/** The one document of `kind` in a rendered file. */
function kind(text: string, want: string): Record<string, unknown> {
	const found = documents(text).find((d) => d.kind === want);
	if (found === undefined) throw new Error(`no ${want} in:\n${text}`);
	return found;
}

describe("renderTarget", () => {
	test("emits the k3s-deploy file set for the target", async () => {
		const files = await render("uat");
		const slug = "linkedin-automation-uat";
		expect([...files.keys()].sort()).toEqual(
			[
				`apps/${slug}.yaml`,
				`manifests/apps/${slug}/MANIFEST-NOTES.md`,
				`manifests/apps/${slug}/configmap.yaml`,
				`manifests/apps/${slug}/cronjob.yaml`,
				`manifests/apps/${slug}/deployment.yaml`,
				`manifests/apps/${slug}/kustomization.yaml`,
				`manifests/apps/${slug}/namespace.yaml`,
				`manifests/apps/${slug}/pvc.yaml`,
				`manifests/apps/${slug}/route.yaml`,
				`manifests/apps/${slug}/service.yaml`,
			].sort(),
		);
	});

	test("the Deployment carries the accepted digest, never a floating tag", async () => {
		const files = await render("uat");
		const dep = kind(
			files.get("manifests/apps/linkedin-automation-uat/deployment.yaml") as string,
			"Deployment",
		);
		const spec = dep.spec as Record<string, unknown>;
		const pod = (spec.template as Record<string, unknown>).spec as Record<string, unknown>;
		const container = (pod.containers as Record<string, unknown>[])[0] as Record<string, unknown>;
		expect(container.image).toBe(
			"10.0.20.58:3000/rtech/linkedin-automation:v0.3.0@sha256:aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111",
		);
	});

	test("<name>-<target> is the namespace and the Application name", async () => {
		const files = await render("uat");
		const slug = "linkedin-automation-uat";
		const app = kind(files.get(`apps/${slug}.yaml`) as string, "Application");
		expect((app.metadata as Record<string, unknown>).name).toBe(slug);
		const spec = app.spec as Record<string, unknown>;
		expect((spec.destination as Record<string, unknown>).namespace).toBe(slug);
		expect((spec.source as Record<string, unknown>).path).toBe(`manifests/apps/${slug}`);
		const ns = kind(files.get(`manifests/apps/${slug}/namespace.yaml`) as string, "Namespace");
		expect((ns.metadata as Record<string, unknown>).name).toBe(slug);
	});

	test("a private host renders an IngressRoute and NO Certificate", async () => {
		const files = await render("uat");
		const text = files.get("manifests/apps/linkedin-automation-uat/route.yaml") as string;
		expect(documents(text).map((d) => d.kind)).toEqual(["IngressRoute"]);
	});

	test("a public host renders both the Certificate and the IngressRoute", async () => {
		const files = await render("prod");
		const text = files.get("manifests/apps/linkedin-automation-prod/route.yaml") as string;
		expect(documents(text).map((d) => d.kind)).toEqual(["Certificate", "IngressRoute"]);
		const cert = kind(text, "Certificate");
		expect((cert.spec as Record<string, unknown>).dnsNames).toEqual(["linkedin.example.net"]);
	});

	test("a paused entry renders replicas: 0 and suspends every CronJob", async () => {
		const files = await render("uat", (_d, e) => {
			e.state = "paused";
		});
		const dir = "manifests/apps/linkedin-automation-uat";
		const dep = kind(files.get(`${dir}/deployment.yaml`) as string, "Deployment");
		expect((dep.spec as Record<string, unknown>).replicas).toBe(0);
		const crons = documents(files.get(`${dir}/cronjob.yaml`) as string);
		expect(crons.length).toBeGreaterThan(0);
		for (const c of crons) expect((c.spec as Record<string, unknown>).suspend).toBe(true);
	});

	test("an active entry leaves the CronJobs unsuspended", async () => {
		const files = await render("uat");
		const crons = documents(
			files.get("manifests/apps/linkedin-automation-uat/cronjob.yaml") as string,
		);
		for (const c of crons) expect((c.spec as Record<string, unknown>).suspend).toBe(false);
	});

	test("the kustomization lists every emitted manifest and no notes file", async () => {
		const files = await render("uat");
		const dir = "manifests/apps/linkedin-automation-uat";
		const kust = parseYaml(files.get(`${dir}/kustomization.yaml`) as string) as Record<
			string,
			unknown
		>;
		const listed = (kust.resources as string[]).slice().sort();
		const emitted = [...files.keys()]
			.filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".yaml"))
			.map((p) => p.slice(dir.length + 1))
			.filter((n) => n !== "kustomization.yaml")
			.sort();
		expect(listed).toEqual(emitted);
	});

	test("secrets and the database reach the container as secretKeyRef env", async () => {
		const files = await render("uat");
		const dep = kind(
			files.get("manifests/apps/linkedin-automation-uat/deployment.yaml") as string,
			"Deployment",
		);
		const pod = ((dep.spec as Record<string, unknown>).template as Record<string, unknown>)
			.spec as Record<string, unknown>;
		const container = (pod.containers as Record<string, unknown>[])[0] as Record<string, unknown>;
		const env = container.env as Record<string, unknown>[];
		const byName = new Map(env.map((e) => [e.name as string, e]));
		expect(byName.get("SESSION_SECRET")).toEqual({
			name: "SESSION_SECRET",
			valueFrom: { secretKeyRef: { name: "linkedin-automation-secrets", key: "SESSION_SECRET" } },
		});
		expect(byName.get("DATABASE_URL")).toEqual({
			name: "DATABASE_URL",
			valueFrom: { secretKeyRef: { name: "linkedin-automation-uat-db", key: "uri" } },
		});
	});

	test("no Secret object and no foreign namespace is ever emitted", async () => {
		const files = await render("uat");
		for (const [path, text] of files) {
			if (!path.endsWith(".yaml")) continue;
			for (const d of documents(text)) {
				expect(d.kind).not.toBe("Secret");
				const meta = (d.metadata ?? {}) as Record<string, unknown>;
				if (d.kind === "Namespace") expect(meta.name).toBe("linkedin-automation-uat");
				else if (d.kind !== "Application" && meta.namespace !== undefined) {
					expect(meta.namespace).toBe("linkedin-automation-uat");
				}
			}
		}
	});

	test("an unaccepted target is a problem, not a render", async () => {
		const r = renderTarget(await decl(), await entry(), "staging", await configs());
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.problems.map((p) => p.message).join(" ")).toContain("staging");
	});

	test("config_files with no content read is refused, naming --source-dir", async () => {
		const r = renderTarget(await decl(), await entry(), "uat", new Map());
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.problems[0]?.message).toContain("config_files needs --source-dir");
	});

	// A target override that ADDS a config_files entry must be visible to the
	// CLI's config read, or the added file is reported missing and a changed
	// path serves the base file's stale content.
	test("a target's config_files override is read, not just merged after", async () => {
		const out = makeTempDir("hostedapp-render-override");
		const declPath = `${await overrideFixtureDir()}/declaration.yaml`;
		const code = await runHostedApp([
			"render",
			declPath,
			"--registry",
			ENTRY_PATH,
			"--target",
			"uat",
			"--out",
			out,
			"--source-dir",
			FIXTURES,
		]);
		expect(code).toBe(0);
		const text = await Bun.file(
			`${out}/manifests/apps/linkedin-automation-uat/configmap.yaml`,
		).text();
		const names = documents(text).map((d) => (d.metadata as Record<string, unknown>).name);
		expect(names.sort()).toEqual(
			["linkedin-automation-uat-app-config", "linkedin-automation-uat-uat-extra"].sort(),
		);
	});

	// Component names are schema-valid on their own but are appended to
	// `<name>-<target>-`, so the generated Kubernetes name can exceed 63.
	test("an over-long generated PVC name is a problem, never a crash", async () => {
		const d = await decl();
		const e = await entry();
		const long = "a".repeat(40);
		const target = "b".repeat(16);
		d.name = long;
		e.name = long;
		d.targets = [{ name: target }];
		e.targets = [{ name: target, merge: "auto" }];
		const image = e.accepted.images.uat;
		if (image === undefined) throw new Error("fixture lost its uat image");
		e.accepted.images = { [target]: image };
		d.storage = [{ name: "c".repeat(20), mount: "/var/lib/app", size: "5Gi" }];
		const r = renderTarget(d, e, target, await configs());
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		const message = r.problems.map((p) => p.message).join(" ");
		expect(message).toContain(`${long}-${target}-${"c".repeat(20)}`);
		expect(message).toContain("63");
	});

	// `runtime.health.port` was ignored: probes always hit the named `http`
	// port, so a sidecar-style health port silently probed the wrong one.
	test("a health port distinct from the runtime port gets its own container port", async () => {
		const files = await render("uat", (d) => {
			d.runtime.health = { path: "/healthz", port: 9090 };
		});
		const dep = kind(
			files.get("manifests/apps/linkedin-automation-uat/deployment.yaml") as string,
			"Deployment",
		);
		const pod = ((dep.spec as Record<string, unknown>).template as Record<string, unknown>)
			.spec as Record<string, unknown>;
		const container = (pod.containers as Record<string, unknown>[])[0] as Record<string, unknown>;
		const ports = container.ports as Record<string, unknown>[];
		expect(ports).toEqual([
			{ name: "http", containerPort: 8080, protocol: "TCP" },
			{ name: "health", containerPort: 9090, protocol: "TCP" },
		]);
		for (const key of ["startupProbe", "readinessProbe", "livenessProbe"]) {
			const p = container[key] as Record<string, unknown>;
			expect((p.httpGet as Record<string, unknown>).port).toBe("health");
		}
	});

	test("a health port equal to the runtime port keeps the single http port", async () => {
		const files = await render("uat");
		const dep = kind(
			files.get("manifests/apps/linkedin-automation-uat/deployment.yaml") as string,
			"Deployment",
		);
		const pod = ((dep.spec as Record<string, unknown>).template as Record<string, unknown>)
			.spec as Record<string, unknown>;
		const container = (pod.containers as Record<string, unknown>[])[0] as Record<string, unknown>;
		expect(container.ports).toEqual([{ name: "http", containerPort: 8080, protocol: "TCP" }]);
		const p = container.startupProbe as Record<string, unknown>;
		expect((p.httpGet as Record<string, unknown>).port).toBe("http");
	});

	// A mixed list produced ONE route whose Certificate held only the public
	// names, so the private host was served under a cert that never named it.
	test("mixed public and private hosts render one route each, one Certificate", async () => {
		// Set the mixed list on the target override: `uat` overrides `hostnames`,
		// so a mutation of the base list would be discarded by the merge.
		const files = await render("uat", (d) => {
			const uat = d.targets.find((t) => t.name === "uat");
			if (uat === undefined) throw new Error("fixture lost its uat target");
			uat.overrides = {
				hostnames: [
					{ host: "linkedin.example.net", public: true },
					{ host: "linkedin-uat.rtech.internal", public: false },
				],
			};
		});
		const text = files.get("manifests/apps/linkedin-automation-uat/route.yaml") as string;
		const all = documents(text);
		expect(all.filter((d) => d.kind === "IngressRoute").length).toBe(2);
		const certs = all.filter((d) => d.kind === "Certificate");
		expect(certs.length).toBe(1);
		const cert = certs[0];
		if (cert === undefined) throw new Error("no Certificate rendered");
		expect((cert.spec as Record<string, unknown>).dnsNames).toEqual(["linkedin.example.net"]);
		const routes = all.filter((d) => d.kind === "IngressRoute");
		const bySecret = routes.map((r) => (r.spec as Record<string, unknown>).tls);
		expect(bySecret).toContainEqual({ secretName: "linkedin-automation-uat-tls" });
		expect(bySecret).toContainEqual({});
	});
});

describe("hosted-app render CLI", () => {
	test("writes the files and exits 0", async () => {
		const out = makeTempDir("hostedapp-render");
		const code = await runHostedApp([
			"render",
			DECL_PATH,
			"--registry",
			ENTRY_PATH,
			"--target",
			"uat",
			"--out",
			out,
		]);
		expect(code).toBe(0);
		const app = Bun.file(`${out}/apps/linkedin-automation-uat.yaml`);
		expect(await app.exists()).toBe(true);
	});

	test("an unaccepted target exits 1", async () => {
		const out = makeTempDir("hostedapp-render-bad");
		const code = await runHostedApp([
			"render",
			DECL_PATH,
			"--registry",
			ENTRY_PATH,
			"--target",
			"staging",
			"--out",
			out,
		]);
		expect(code).toBe(1);
	});

	test("a missing declaration is a harness error", async () => {
		const out = makeTempDir("hostedapp-render-missing");
		const code = await runHostedApp([
			"render",
			`${FIXTURES}/does-not-exist.yaml`,
			"--registry",
			ENTRY_PATH,
			"--target",
			"uat",
			"--out",
			out,
		]);
		expect(code).toBe(3);
	});

	test("writeRendered creates nested directories", async () => {
		const out = makeTempDir("hostedapp-write");
		const n = await writeRendered(new Map([["a/b/c.yaml", "kind: Test\n"]]), out);
		expect(n).toBe(1);
		expect(await Bun.file(`${out}/a/b/c.yaml`).text()).toBe("kind: Test\n");
	});
});
