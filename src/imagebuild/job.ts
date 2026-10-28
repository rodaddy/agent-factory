/**
 * @module imagebuild/job
 * @description Render the Kaniko build Job for a build-bump candidate.
 *   PURE: no I/O, no env reads, no clock, no randomness — the whole module is a
 *   function from a candidate to a plain JSON-serialisable object, so a test can
 *   assert the exact bytes that would be POSTed without a cluster.
 *
 *   THIS IS A MIRROR, NOT A DESIGN. The object below is
 *   `gitops/k3s-deploy/manifests/image-builds/kaniko-job.template.yaml` on
 *   rtech-infra `main`, rendered with the values from
 *   `scripts/k3s-image-builds.env` on that same branch, by the substitution rules
 *   in `scripts/image-build-job.sh`. A human reading `kubectl -n image-builds get
 *   job -o yaml` must not be able to tell whether the shell renderer or this
 *   factory produced it. THE ENV MAP ON rtech-infra main IS CANONICAL: any
 *   divergence between `IMAGE_BUILDS` here and
 *   `rtech-infra:scripts/k3s-image-builds.env` is a FACTORY DEFECT to be fixed
 *   here, never a value to "improve" locally — that file's own header states
 *   "the map is one file" and forbids a consumer restating a value from it.
 *
 *   THE 40-HEX GATE HAS NO ESCAPE HATCH HERE. The shell renderer offers
 *   `--allow-unpinned` for a human doing a one-off; the factory does not and must
 *   not. A branch or tag ref means the image called `v0.6.0` is whatever the
 *   branch happened to be at build time — irreproducible by construction, and the
 *   build-bump rail exists to publish reproducible tags.
 *
 *   REFUSALS THROW. `src/imagebuild/kube.ts` returns a bounded result because its
 *   failures are REMOTE and expected (a 404, a network drop); a refusal here is a
 *   PROGRAMMING or DATA error in the factory's own candidate, discovered before
 *   anything leaves the process, so it throws a bounded `Error`. Messages name the
 *   offending field and are short; they never interpolate a rendered object.
 *
 *   THE ADOPTION KEY MUST INCLUDE THE COMMIT AND THE OWNER. The
 *   rendered Job carries `image-builds.rtech/sha` (the full 40-hex commit) and
 *   `image-builds.rtech/owner` (the repository's owner segment) beside app and
 *   tag, because the candidate table is unique on (repository, tag, sha): a
 *   force-moved tag produces a SECOND row with a new sha, and an app+tag-only
 *   selector adopts the Job that built the OLD commit — marking a row built for
 *   a commit nothing ever built. The owner term separates `rtech/web` from
 *   `acme/web`, whose short names collide.
 *
 *   EVERY DERIVED VALUE IS VALIDATED AGAINST THE GRAMMAR IT LANDS IN (sf#543
 *   P1b). The repository and tag patterns admit values whose DERIVED forms the
 *   API server rejects: an app lands in `metadata.generateName` (RFC 1123 DNS
 *   label) and in a label value, an owner lands in a label value, and a
 *   labelised tag can begin or end with `-` (`tagLabel("+x.")` is `"-x."`).
 *   Such a Job is rejected at admission with 422, which the build pass reads as
 *   "may have created a Job" — so the row stays pending and retries forever.
 *   Refusing here turns that silent loop into one terminal failure.
 *
 *   `GIT_REF` IS A STRING AND THAT IS LOAD-BEARING. An all-digit 40-char SHA is a
 *   legal SHA, and a YAML renderer that emits it unquoted produces a NUMBER the
 *   API server rejects ("cannot unmarshal number into Go struct field EnvVar"). A
 *   JSON object cannot make that mistake, and the test pins it anyway so a future
 *   refactor through YAML cannot reintroduce it.
 *
 * @outputs
 *   - `IMAGE_BUILDS` -- the frozen mirror of the rtech-infra env map
 *   - `resolveRegistryOwner` -- explicit -> per-app override -> fleet default
 *   - `tagLabel` -- the script's TAG_LABEL transform for a k8s label value
 *   - `jobLabelSelector` -- the selector the watch lane lists Jobs with
 *   - `renderKanikoJob` -- the candidate -> Job object renderer
 *   - `KanikoJobSpec` / `KanikoJobRequest` -- the rendered shape and its input
 *
 * @dependencies
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { traced } from "../log";
import { DNS_LABEL_PATTERN } from "../names/dns-label";

/**
 * Mirror of `rtech-infra:scripts/k3s-image-builds.env` (branch `main`). Every
 * value is copied verbatim from that file; see the module header — the env map
 * is canonical and a mismatch here is a factory defect.
 */
export const IMAGE_BUILDS = Object.freeze({
	/** K3S_IMAGE_BUILDS_NAMESPACE — the rail's whole blast radius. */
	namespace: "image-builds",
	/** K3S_IMAGE_BUILDS_REGISTRY_HOST */
	registryHost: "10.0.20.58",
	/** K3S_IMAGE_BUILDS_REGISTRY_PORT */
	registryPort: "3000",
	/** K3S_IMAGE_BUILDS_REGISTRY — host:port, plain HTTP (hence the insecure flags). */
	registry: "10.0.20.58:3000",
	/** K3S_IMAGE_BUILDS_REGISTRY_OWNER — the fleet default owner. */
	registryOwner: "rtech",
	/**
	 * K3S_IMAGE_BUILDS_OWNER_<APP> — per-app overrides. Keyed by the app
	 * name as written, rather than by the env map's upper-cased/underscored key,
	 * because the lookup input here is always the app name itself.
	 */
	ownerOverrides: Object.freeze({ "web-bb-landing": "acme" }) as Readonly<Record<string, string>>,
	/** K3S_IMAGE_BUILDS_CACHE_REPO */
	cacheRepo: "10.0.20.58:3000/rtech/kaniko-cache",
	/** K3S_IMAGE_BUILDS_GIT_SECRET — read-only Forgejo credential, keys username/password. */
	gitSecret: "image-builds-git",
	/** K3S_IMAGE_BUILDS_REGCRED_SECRET — registry-WRITE dockerconfigjson. */
	regcredSecret: "image-builds-regcred",
	/** K3S_IMAGE_BUILDS_KANIKO_IMAGE — pinned, never `latest`. */
	kanikoImage: "gcr.io/kaniko-project/executor:v1.24.0",
	/** K3S_IMAGE_BUILDS_GIT_IMAGE — kaniko's git resolver cannot speak plain HTTP. */
	gitImage: "alpine/git:v2.49.1",
	/** K3S_IMAGE_BUILDS_TTL_SECONDS — the pod IS the build log; a day of them stay readable. */
	ttlSeconds: 86400,
	/** K3S_IMAGE_BUILDS_BACKOFF_LIMIT — zero; a Kaniko failure is deterministic. */
	backoffLimit: 0,
	/** K3S_IMAGE_BUILDS_ACTIVE_DEADLINE_SECONDS — 30 min wall clock. */
	activeDeadlineSeconds: 1800,
	/** K3S_IMAGE_BUILDS_REQUEST_CPU */
	requestCpu: "500m",
	/** K3S_IMAGE_BUILDS_REQUEST_MEMORY */
	requestMemory: "1Gi",
	/** K3S_IMAGE_BUILDS_LIMIT_CPU */
	limitCpu: "2",
	/** K3S_IMAGE_BUILDS_LIMIT_MEMORY — sized for the layer-extraction peak. */
	limitMemory: "4Gi",
});

/**
 * The clone initContainer's shell script, VERBATIM from the template. The
 * credential is written into a git credential store inside the pod and never
 * reaches argv or the URL, so it cannot surface in `kubectl describe`, the audit
 * log, or `ps` inside the container. The `$GIT_REF != $GOT` check is what makes
 * the SHA pin enforced rather than trusted.
 */
const CLONE_SCRIPT = `set -eu
printf 'http://%s:%s@%s\\n' "$GIT_USERNAME" "$GIT_PASSWORD" "$GIT_HOST" > /root/.git-credentials
chmod 600 /root/.git-credentials
git config --global credential.helper store
git config --global --add safe.directory /workspace/src
mkdir -p /workspace/src
git init -q /workspace/src
cd /workspace/src
git remote add origin "$GIT_REPO_URL"
git fetch -q --depth 1 origin "$GIT_REF"
git checkout -q FETCH_HEAD
# The pin is ENFORCED, not assumed. A fetch that silently landed
# on a different commit would produce an image tagged with a
# version it does not contain.
GOT="$(git rev-parse HEAD)"
if [ "$GIT_REF" != "$GOT" ]; then
  echo "REFUSED: asked for $GIT_REF but HEAD is $GOT" >&2
  exit 1
fi
echo "checked out $GOT"
rm -f /root/.git-credentials
`;

/** A pinned context ref. The shell renderer's reproducibility gate, no opt-out. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** `<owner>/<repo>` of Forgejo-legal segments. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Legal OCI tag characters, as the factory admits them. */
const TAG_PATTERN = /^[A-Za-z0-9._+-]+$/;
/** A Kubernetes label VALUE: alphanumeric ends, `_.-` inside. */
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
/** Kubernetes caps a label value at 63 characters. */
const LABEL_MAX = 63;
/**
 * Characters the API server appends to a `generateName` prefix. A name over 63
 * characters is rejected at admission, so the prefix must leave room for them.
 */
const GENERATED_SUFFIX_LENGTH = 5;
/** A tag longer than this is not a tag anyone meant to publish. */
const TAG_MAX = 128;

/** An env entry on the clone initContainer: a literal, or a Secret key ref. */
export interface KanikoEnvVar {
	name: string;
	value?: string;
	valueFrom?: { secretKeyRef: { name: string; key: string } };
}

/** Requests and limits, as the template writes them. */
export interface KanikoResources {
	requests: { cpu: string; memory: string };
	limits: { cpu: string; memory: string };
}

/** The rendered Job. A plain JSON-serialisable mirror of the template. */
export interface KanikoJobSpec {
	apiVersion: "batch/v1";
	kind: "Job";
	metadata: {
		generateName: string;
		namespace: string;
		labels: Record<string, string>;
	};
	spec: {
		backoffLimit: number;
		ttlSecondsAfterFinished: number;
		activeDeadlineSeconds: number;
		template: {
			metadata: { labels: Record<string, string> };
			spec: {
				restartPolicy: "Never";
				automountServiceAccountToken: false;
				initContainers: Array<{
					name: string;
					image: string;
					command: string[];
					env: KanikoEnvVar[];
					volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
					resources: KanikoResources;
				}>;
				containers: Array<{
					name: string;
					image: string;
					args: string[];
					volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
					resources: KanikoResources;
					securityContext: {
						runAsUser: number;
						allowPrivilegeEscalation: boolean;
						privileged: boolean;
						readOnlyRootFilesystem: boolean;
						capabilities: { drop: string[]; add: string[] };
					};
				}>;
				volumes: Array<Record<string, unknown>>;
			};
		};
	};
}

/** One build-bump candidate, as the render takes it. */
export interface KanikoJobRequest {
	/** `<owner>/<repo>` from the managed-repo config, e.g. `acme/web-bb-landing`. */
	repository: string;
	/** The tag being built, e.g. `v0.6.0`. */
	tag: string;
	/** The full 40-hex commit the tag points at. Refused if it is anything else. */
	commitSha: string;
	/** Dockerfile within the context. Template default. */
	dockerfile?: string;
	/** The image name under the owner. Defaults to the repository's short name. */
	image?: string;
	/** Explicit registry owner. Beats the per-app override and the fleet default. */
	owner?: string;
}

/**
 * Resolve the Forgejo registry owner an image publishes under, in the shell
 * renderer's order: explicit argument, then the per-app override from the env
 * map, then the fleet default. Rule three is what preserves today's behaviour
 * for every app with no entry.
 *
 * @param app - the image name under the owner (the repository's short name)
 * @param owner - an explicit owner, if the caller has one
 */
export const resolveRegistryOwner = traced(
	"imagebuild.resolveRegistryOwner",
	function resolveRegistryOwner(app: string, owner?: string): string {
		if (owner !== undefined && owner !== "") return owner;
		return IMAGE_BUILDS.ownerOverrides[app] ?? IMAGE_BUILDS.registryOwner;
	},
);

/**
 * The script's `TAG_LABEL`: a Kubernetes label value admits `[-A-Za-z0-9_.]`
 * only, so a tag carrying a `+` or `/` (both legal in an image tag) would make
 * the Job unschedulable with an admission error naming the LABEL, not the tag.
 *
 * @param tag - the image tag as published
 */
export const tagLabel = traced("imagebuild.tagLabel", function tagLabel(tag: string): string {
	return tag.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, LABEL_MAX);
});

/**
 * The label selector the watch lane lists this rail's Jobs with. The tag half is
 * the LABELISED tag, because that is what the Job actually carries. The sha and
 * owner terms are what make the key identify ONE build: see the module header.
 *
 * @param selector - the repository owner, app, published tag, and pinned commit
 */
export const jobLabelSelector = traced(
	"imagebuild.jobLabelSelector",
	function jobLabelSelector(selector: {
		owner: string;
		app: string;
		tag: string;
		sha: string;
	}): string {
		return [
			`image-builds.rtech/app=${selector.app}`,
			`image-builds.rtech/tag=${tagLabel(selector.tag)}`,
			`image-builds.rtech/sha=${selector.sha}`,
			`image-builds.rtech/owner=${selector.owner}`,
		].join(",");
	},
);

/**
 * Refuse the values DERIVED from a valid repository and tag that the API server
 * would reject at admission. Split out of `refuseInvalid` so neither function
 * grows past the repo's length bound.
 *
 * @param app - the repository's short name, bound for generateName and a label
 * @param owner - the repository's owner segment, bound for a label value
 * @param tag - the published tag, whose LABELISED form is checked
 */
function refuseInvalidDerived(app: string, owner: string, tag: string): void {
	if (!DNS_LABEL_PATTERN.test(app)) {
		throw new Error(
			"app (the image name, by default the repository short name) must be a DNS label",
		);
	}
	if (`build-${app}-`.length + GENERATED_SUFFIX_LENGTH > LABEL_MAX) {
		throw new Error(`app is too long: build-<app>- plus a generated suffix must fit ${LABEL_MAX}`);
	}
	if (owner.length > LABEL_MAX || !LABEL_VALUE_PATTERN.test(owner)) {
		throw new Error(`owner must be a label value of at most ${LABEL_MAX} characters`);
	}
	const labelised = tagLabel(tag);
	if (!LABEL_VALUE_PATTERN.test(labelised)) {
		throw new Error("tag must labelise to a value starting and ending alphanumeric");
	}
}

/** Validate the candidate before a single field is rendered. Bounded messages. */
function refuseInvalid(request: KanikoJobRequest): void {
	if (!REPOSITORY_PATTERN.test(request.repository)) {
		throw new Error("repository must be <owner>/<repo> of [A-Za-z0-9._-] segments");
	}
	if (request.tag.length > TAG_MAX || !TAG_PATTERN.test(request.tag)) {
		throw new Error(`tag must be [A-Za-z0-9._+-] and at most ${TAG_MAX} characters`);
	}
	// No --allow-unpinned here, ever: see the module header.
	if (!SHA_PATTERN.test(request.commitSha)) {
		throw new Error("commitSha must be a pinned 40-char lowercase hex commit");
	}
	const slash = request.repository.indexOf("/");
	refuseInvalidDerived(
		request.image ?? request.repository.slice(slash + 1),
		request.repository.slice(0, slash),
		request.tag,
	);
}

/** The clone initContainer, whose env carries the split repo URL and ref. */
function cloneInitContainer(repository: string, commitSha: string) {
	return {
		name: "clone",
		image: IMAGE_BUILDS.gitImage,
		command: ["/bin/sh", "-c", CLONE_SCRIPT],
		env: [
			{ name: "GIT_HOST", value: IMAGE_BUILDS.registry },
			// The fleet registry is plain HTTP; the script prefixes it the same way.
			{ name: "GIT_REPO_URL", value: `http://${IMAGE_BUILDS.registry}/${repository}.git` },
			{ name: "GIT_REF", value: commitSha },
			{
				name: "GIT_USERNAME",
				valueFrom: { secretKeyRef: { name: IMAGE_BUILDS.gitSecret, key: "username" } },
			},
			{
				name: "GIT_PASSWORD",
				valueFrom: { secretKeyRef: { name: IMAGE_BUILDS.gitSecret, key: "password" } },
			},
		],
		volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "500m", memory: "512Mi" },
		},
	};
}

/** The kaniko container. The four insecure flags govern the REGISTRY client only. */
function kanikoContainer(dockerfile: string, destination: string) {
	return {
		name: "kaniko",
		image: IMAGE_BUILDS.kanikoImage,
		args: [
			"--context=dir:///workspace/src",
			`--dockerfile=${dockerfile}`,
			`--destination=${destination}`,
			"--cache=true",
			`--cache-repo=${IMAGE_BUILDS.cacheRepo}`,
			// Detect changes from file METADATA -- mtime, size, mode, owner uid and
			// gid -- instead of hashing the CONTENTS of every file in the image after
			// each RUN (kaniko's `full` default, which its own docs call "the least
			// performant option, but also the most robust"). The snapshot is what the
			// build holds in memory, so on a tree with a large node_modules `full` is
			// what exhausts limitMemory. Upstream documents `redo` as up to 50%
			// faster, "particularly if your project has a large number files".
			//
			// Measured: rodaddy/rtech-mcps v0.1.0 was OOMKilled (exit 137) at
			// "Taking snapshot of full filesystem", immediately after its n8n stage
			// installed 2137 packages, against the 4Gi limit below. The failure is in
			// the snapshot, not the image -- that stage already prunes dev
			// dependencies and only its dist/data/node_modules reach the final layer.
			//
			// The trade is real and narrow: `redo` misses a file rewritten in place
			// whose mtime, size, mode and ownership are ALL unchanged. Package
			// installs and compilers write new files with current timestamps, so that
			// case does not arise here; a build that deliberately restores a
			// rewritten file's metadata would need `full`. `time` (mtime only) is the
			// weaker mode and is NOT what this sets.
			"--snapshot-mode=redo",
			"--insecure",
			"--insecure-pull",
			"--skip-tls-verify",
			"--skip-tls-verify-pull",
			"--verbosity=info",
		],
		volumeMounts: [
			{ name: "docker-config", mountPath: "/kaniko/.docker", readOnly: true },
			{ name: "workspace", mountPath: "/workspace" },
		],
		resources: {
			requests: { cpu: IMAGE_BUILDS.requestCpu, memory: IMAGE_BUILDS.requestMemory },
			limits: { cpu: IMAGE_BUILDS.limitCpu, memory: IMAGE_BUILDS.limitMemory },
		},
		securityContext: {
			// Kaniko unpacks base-image layers into the container root filesystem and
			// must chown files owned by arbitrary uids. NOT privileged, no hostPath,
			// every capability dropped except what layer extraction needs.
			runAsUser: 0,
			allowPrivilegeEscalation: false,
			privileged: false,
			readOnlyRootFilesystem: false,
			capabilities: {
				drop: ["ALL"],
				add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
			},
		},
	};
}

/**
 * The Job's own metadata: the generateName prefix and the six labels. The last
 * two are the ADOPTION KEY — without them a force-moved tag adopts the Job that
 * built the old commit, and two owners' identically-named apps collide.
 *
 * @param request - the validated candidate
 * @param app - the repository's short name, already validated as a DNS label
 */
function jobMetadata(request: KanikoJobRequest, app: string): KanikoJobSpec["metadata"] {
	return {
		// Every build is a new object: a fixed name makes the second build of
		// the same tag fail on AlreadyExists.
		generateName: `build-${app}-`,
		namespace: IMAGE_BUILDS.namespace,
		labels: {
			"app.kubernetes.io/name": "image-build",
			"app.kubernetes.io/component": "kaniko",
			"image-builds.rtech/app": app,
			"image-builds.rtech/tag": tagLabel(request.tag),
			"image-builds.rtech/sha": request.commitSha,
			"image-builds.rtech/owner": request.repository.slice(0, request.repository.indexOf("/")),
		},
	};
}

/**
 * Render the batch/v1 Job for one build-bump candidate. Pure: the returned object
 * is JSON-serialisable and depends on nothing but the arguments and the frozen
 * env-map mirror above.
 *
 * @param request - repository, tag, pinned commit, and optional dockerfile/owner
 * @throws Error - bounded refusal when the sha, repository, or tag is invalid
 */
export const renderKanikoJob = traced(
	"imagebuild.renderKanikoJob",
	function renderKanikoJob(request: KanikoJobRequest): KanikoJobSpec {
		refuseInvalid(request);
		// The app is the image name under the owner: the declared image or
		// the repository's short name. The k3s-deploy app_dirs are the BUMP lane's
		// concern, not this one.
		const app = request.image ?? request.repository.slice(request.repository.indexOf("/") + 1);
		const owner = resolveRegistryOwner(app, request.owner);
		const dockerfile = request.dockerfile ?? "Dockerfile";
		const destination = `${IMAGE_BUILDS.registry}/${owner}/${app}:${request.tag}`;
		return {
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: jobMetadata(request, app),
			spec: {
				backoffLimit: IMAGE_BUILDS.backoffLimit,
				ttlSecondsAfterFinished: IMAGE_BUILDS.ttlSeconds,
				activeDeadlineSeconds: IMAGE_BUILDS.activeDeadlineSeconds,
				template: {
					metadata: {
						labels: {
							"app.kubernetes.io/name": "image-build",
							"image-builds.rtech/app": app,
						},
					},
					spec: {
						restartPolicy: "Never",
						automountServiceAccountToken: false,
						initContainers: [cloneInitContainer(request.repository, request.commitSha)],
						containers: [kanikoContainer(dockerfile, destination)],
						volumes: [
							{
								name: "docker-config",
								secret: {
									secretName: IMAGE_BUILDS.regcredSecret,
									items: [{ key: ".dockerconfigjson", path: "config.json" }],
								},
							},
							{ name: "workspace", emptyDir: {} },
						],
					},
				},
			},
		};
	},
);
