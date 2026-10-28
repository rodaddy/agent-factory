/**
 * @module hostedapp/registry
 * @description The image-registry READ seam `hosted-app validate --referential`
 *   uses to prove an accepted image tag exists on the Forge container registry
 *   and resolves to the digest the registry entry accepted (lane 832b).
 *
 *   Probed 2026-09-24 against forge.example.net: the OCI manifest endpoint
 *   answers `HEAD /v2/<owner>/<image>/manifests/<tag>` with 200 and a
 *   `Docker-Content-Digest: sha256:<64 hex>` header, and 404 for an absent tag.
 *   It refuses `Authorization: token <t>` (401, Bearer challenge) but accepts
 *   HTTP Basic with the Forge token as the password -- the username is not
 *   checked. The Forge packages API (`/api/v1/packages/<owner>/container/...`)
 *   lists blob files but carries no manifest digest, so it is not used.
 *
 * @outputs
 *   - `RegistryFetch` / `DigestResult` -- the injected seam and its result
 *   - `DEFAULT_REGISTRY` -- the registry base the live fetch talks to
 *   - `imagePath` -- an image reference -> its `<owner>/<image>` path, pure
 *   - `resolveImageDigest` -- found with digest, missing, or error
 *   - `forgeRegistryFetch` -- the live fetch, Basic auth over global fetch
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** The Forge container registry base the live fetch resolves paths against. */
export const DEFAULT_REGISTRY = "https://forge.example.net";

/** A manifest HEAD answered with a status and (when 200) the digest header. */
export type RegistryResponse = { status: number; digest: string | null };

/** The injected seam: HEAD one registry path (`/v2/...`); throws on transport failure. */
export type RegistryFetch = (path: string) => Promise<RegistryResponse>;

/** A tag resolved to its digest, is absent, or the lookup failed. */
export type DigestResult =
	| { status: "found"; digest: string }
	| { status: "missing" }
	| { status: "error"; error: string };

const DIGEST_HEADER = /^sha256:[0-9a-f]{64}$/;

/**
 * Reduce an image reference to its `<owner>/<image>` registry path.
 *
 * @param ref - `host[:port]/owner/image[:tag][@sha256:...]`
 * @returns the path between the host and the tag/digest
 */
export const imagePath = traced("hostedapp.imagePath", function imagePath(ref: string): string {
	const noDigest = ref.split("@")[0] ?? ref;
	const afterHost = noDigest.slice(noDigest.indexOf("/") + 1);
	const colon = afterHost.lastIndexOf(":");
	return colon === -1 ? afterHost : afterHost.slice(0, colon);
});

/**
 * Resolve one image tag to its manifest digest through the injected fetch.
 *
 * @param fetchHead - the registry HEAD seam; tests inject a fake
 * @param image - the `<owner>/<image>` registry path
 * @param tag - the tag to resolve
 * @returns found with the `sha256:` digest, missing on 404, else an error
 */
export const resolveImageDigest = traced(
	"hostedapp.resolveImageDigest",
	async function resolveImageDigest(
		fetchHead: RegistryFetch,
		image: string,
		tag: string,
	): Promise<DigestResult> {
		let response: RegistryResponse;
		try {
			response = await fetchHead(`/v2/${image}/manifests/${encodeURIComponent(tag)}`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : "fetch failed";
			return { status: "error", error: `registry lookup of ${image}:${tag} failed: ${reason}` };
		}
		if (response.status === 404) return { status: "missing" };
		if (response.status !== 200) {
			return {
				status: "error",
				error: `registry lookup of ${image}:${tag}: HTTP ${response.status}`,
			};
		}
		if (response.digest === null || !DIGEST_HEADER.test(response.digest)) {
			return { status: "error", error: `registry gave no digest for ${image}:${tag}` };
		}
		return { status: "found", digest: response.digest };
	},
	// ARG 0: the fetch closes over the Forge token (forgeRegistryFetch below);
	// summarize() would render the function, and a closure is not worth the risk.
	{ redact: { args: [0] } },
);

const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Build the live registry fetch: HEAD over global fetch with Basic auth.
 *
 * @param token - the Forge token, sent as the Basic password (never in the URL)
 * @param base - the registry base, `DEFAULT_REGISTRY` unless overridden
 * @returns a `RegistryFetch` bound to the token
 */
export const forgeRegistryFetch = traced(
	"hostedapp.forgeRegistryFetch",
	function forgeRegistryFetch(token: string, base: string = DEFAULT_REGISTRY): RegistryFetch {
		const auth = `Basic ${btoa(`token:${token}`)}`;
		return async (path) => {
			const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
				method: "HEAD",
				headers: { Authorization: auth, Accept: MANIFEST_ACCEPT },
			});
			return { status: response.status, digest: response.headers.get("docker-content-digest") };
		};
	},
	// ARG 0 is the bare Forge token as a positional -- summarize() masks by key
	// only, so it would reach the wire verbatim.
	{ redact: { args: [0], result: true } },
);
