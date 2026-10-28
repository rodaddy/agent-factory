/**
 * @module imagebuild/kubeconfig
 * @description Resolve the build-bump cluster credential from the environment
 *   ONLY, never from disk and never logged. The scoped kubeconfig
 *   reaches the watcher as `BUILD_BUMP_KUBECONFIG_B64` — base64 of a plain YAML
 *   kubeconfig — mirroring the seam `.forgejo/workflows/sop-verify.yml` already
 *   uses for `SOP_VERIFY_KUBECONFIG_B64`, and mirroring the env-only,
 *   secret-free-error contract of `src/forgejo/credentials.ts`.
 *
 *   IT IS DECODED INTO MEMORY AND NEVER WRITTEN. Nothing here touches the
 *   filesystem: the CA is handed to Bun's `fetch` as a `tls.ca` PEM string and
 *   the token as a bearer header, so no kubeconfig, CA file, or token ever lands
 *   on a disk a later process could read.
 *
 *   THE NAMESPACE IS AN AUTHENTICATION CHECK, NOT A CONVENIENCE. The service
 *   account behind this credential is confined to `image-builds`. A kubeconfig
 *   whose context names any other namespace is therefore the WRONG credential —
 *   most likely a broad one — so it is REFUSED rather than used against the
 *   pinned namespace. Likewise a `http://` server would send the bearer token in
 *   clear text and is refused; `rejectUnauthorized: false` is never an option,
 *   the cluster CA from the config is what validates the endpoint.
 *
 *   ERRORS ARE BOUNDED AND SECRET-FREE. No failure path interpolates the decoded
 *   YAML, the token, or the CA into its message, and the resolver is `traced()`
 *   with its env argument redacted so the trace stream cannot carry it either.
 *
 * @outputs
 *   - `IMAGE_BUILDS_NAMESPACE` -- the one namespace this credential may address
 *   - `BuildBumpKubeconfig` -- the decoded server / CA PEM / token triple
 *   - `KubeconfigResult` -- ok-or-bounded-error result shape
 *   - `resolveBuildBumpKubeconfig` -- read and validate the env credential
 *
 * @dependencies
 *   - yaml -- parse the decoded kubeconfig document
 *   - zod -- boundary validation of the parsed document
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { traced } from "../log";

/**
 * The ONLY namespace this credential addresses. A module constant, never a
 * parameter: making it callable would let a caller aim a confined credential at
 * another namespace and turn a 403 into the security boundary.
 */
export const IMAGE_BUILDS_NAMESPACE = "image-builds";

/** The env var carrying base64 of the scoped kubeconfig YAML. */
const KUBECONFIG_ENV = "BUILD_BUMP_KUBECONFIG_B64";

/** The decoded credential, held in memory only. */
export interface BuildBumpKubeconfig {
	/** `clusters[0].cluster.server`, always `https://`. */
	server: string;
	/** `certificate-authority-data` decoded to a PEM string for `tls.ca`. */
	caPem: string;
	/** `users[0].user.token` — the bearer token. Never logged. */
	token: string;
}

/** Ok-or-bounded-error. The error never carries secret material. */
export type KubeconfigResult =
	| { ok: true; config: BuildBumpKubeconfig }
	| { ok: false; error: string };

/**
 * The kubeconfig shape at the boundary. Only the fields this client uses are
 * required; anything else the config carries is ignored rather than refused.
 * Token auth ONLY — there is deliberately no client-certificate branch, so a
 * cert-auth kubeconfig fails the `token` requirement instead of half-working.
 */
const kubeconfigSchema = z.object({
	clusters: z
		.array(
			z.object({
				cluster: z.object({
					server: z.string(),
					"certificate-authority-data": z.string(),
				}),
			}),
		)
		.min(1),
	users: z.array(z.object({ user: z.object({ token: z.string() }) })).min(1),
	contexts: z.array(z.object({ context: z.object({ namespace: z.string() }) })).min(1),
});

/** Decode base64 to UTF-8 and parse as YAML, or `null` on any malformation. */
function decodeDocument(encoded: string): unknown {
	try {
		return parseYaml(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		// The cause deliberately does not propagate: a YAML parse error quotes the
		// offending source line, which here is credential material.
		return null;
	}
}

/** A bounded refusal. Callers never see the config, the token, or the CA. */
const refuse = (reason: string): KubeconfigResult => ({
	ok: false,
	error: `invalid build-bump kubeconfig: ${reason}`,
});

/** Validate the three security-bearing fields of an already-parsed config. */
function validate(parsed: z.infer<typeof kubeconfigSchema>): KubeconfigResult {
	const cluster = parsed.clusters[0]?.cluster;
	const token = parsed.users[0]?.user.token.trim() ?? "";
	const namespace = parsed.contexts[0]?.context.namespace.trim() ?? "";
	if (!cluster) return refuse("no cluster entry");
	if (!cluster.server.startsWith("https://")) {
		return refuse("cluster server is not https");
	}
	if (token.length === 0) return refuse("empty user token");
	if (namespace !== IMAGE_BUILDS_NAMESPACE) {
		// Named, because the operator needs to know WHICH credential was wired in;
		// the namespace is not a secret, the token and CA it came with are.
		return refuse(`context namespace is not ${IMAGE_BUILDS_NAMESPACE}`);
	}
	const caPem = Buffer.from(cluster["certificate-authority-data"], "base64").toString("utf8");
	if (caPem.trim().length === 0) return refuse("empty certificate-authority-data");
	return { ok: true, config: { server: cluster.server, caPem, token } };
}

/**
 * Resolve the build-bump kubeconfig from `BUILD_BUMP_KUBECONFIG_B64`.
 *
 * @param env - environment to read (defaults to `process.env`)
 * @returns the decoded credential, or a bounded secret-free failure
 */
export const resolveBuildBumpKubeconfig = traced(
	"imagebuild.resolveBuildBumpKubeconfig",
	function resolveBuildBumpKubeconfig(env: NodeJS.ProcessEnv = process.env): KubeconfigResult {
		const encoded = env[KUBECONFIG_ENV]?.trim();
		if (!encoded || encoded.length === 0) {
			return { ok: false, error: `no build-bump kubeconfig: set ${KUBECONFIG_ENV}` };
		}
		const document = decodeDocument(encoded);
		if (document === null || typeof document !== "object") {
			return refuse("not a base64 YAML document");
		}
		const parsed = kubeconfigSchema.safeParse(document);
		if (!parsed.success) {
			// The zod issue list quotes received values; only the paths are safe, and
			// even those are omitted rather than risk a value riding along.
			return refuse("missing required cluster, user, or context fields");
		}
		return validate(parsed.data);
	},
	{ redact: { args: [0], result: true } },
);
