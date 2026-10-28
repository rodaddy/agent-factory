/**
 * @module imagebuild/kube
 * @description A Kubernetes batch/v1 Jobs client PINNED to the `image-builds`
 *   namespace, for the build-bump Kaniko build. The credential half
 *   lives in `./kubeconfig` and is re-exported here so callers have one import.
 *
 *   THE NAMESPACE IS NOT A PARAMETER. Every request path is built from the module
 *   constant `IMAGE_BUILDS_NAMESPACE`, so no caller — and no repository content
 *   that reaches a caller as input — can aim this client at another namespace.
 *   `createJob` additionally refuses BEFORE the request when the submitted body's
 *   `metadata.namespace` is not `image-builds` or its `kind` is not `Job`: the
 *   path pin alone would let a body naming `kube-system` be POSTed to the pinned
 *   path, where the API server's own namespace-mismatch rejection would be the
 *   only control. Two independent checks, one of which never touches the network.
 *
 *   FAILURE REASONS ARE FIXED STRINGS, NEVER RESPONSE TEXT. A non-2xx maps to one
 *   of `unauthorized` / `not found` / `already exists` / `http <status>`. The API
 *   server's own message is discarded unread — a 401 body from a misconfigured
 *   proxy can echo the request, and the request carries the bearer token.
 *   Similarly a thrown fetch becomes `network error`: Node's connection errors
 *   interpolate the URL and, through some proxies, the credential.
 *
 *   RESPONSES ARE VALIDATED AT THE BOUNDARY. A 2xx body is parsed with zod down to
 *   only the fields later lanes read (name, namespace, the three status counters,
 *   and the condition list). Unknown fields are ignored, not refused, so a cluster
 *   upgrade that ADDS a field does not break the client.
 *
 *   TLS IS THE CLUSTER CA, NEVER DISABLED. Bun's fetch takes `tls: { ca }`
 *   (`bun-types` `BunFetchRequestInitTLS`); the PEM comes from the kubeconfig.
 *   `rejectUnauthorized: false` appears nowhere and must not be introduced.
 *   Every request carries `AbortSignal.timeout(30_000)` so a black-holed cluster
 *   cannot hang a build pass.
 *
 * @outputs
 *   - `KubeJobsFetch` -- the injectable fetch seam (tests pass a fake)
 *   - `KubeJob` -- the validated subset of a batch/v1 Job later lanes read
 *   - `KubeResult` -- ok-with-job, or a bounded status + fixed reason
 *   - `KubeJobsClient` -- createJob / getJob / listJobs, all namespace-pinned
 *   - `createKubeJobsClient` -- build a client for one decoded kubeconfig
 *   - re-exports of the `./kubeconfig` credential seam
 *
 * @dependencies
 *   - zod -- boundary validation of the untrusted API server response
 *   - ./kubeconfig -- the env-only credential resolver and namespace constant
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { z } from "zod";
import { traced } from "../log";
import { type BuildBumpKubeconfig, IMAGE_BUILDS_NAMESPACE } from "./kubeconfig";

export {
	type BuildBumpKubeconfig,
	IMAGE_BUILDS_NAMESPACE,
	type KubeconfigResult,
	resolveBuildBumpKubeconfig,
} from "./kubeconfig";

/** Per-request deadline. A black-holed API server must not hang a pass. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The injectable fetch seam. Tests pass a recorder; production passes `fetch`. */
export type KubeJobsFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The validated subset of a batch/v1 Job. Unknown fields are ignored. */
const jobSchema = z.object({
	metadata: z.object({ name: z.string(), namespace: z.string() }),
	status: z
		.object({
			active: z.number().optional(),
			succeeded: z.number().optional(),
			failed: z.number().optional(),
			conditions: z
				.array(
					z.object({
						type: z.string(),
						status: z.string(),
						reason: z.string().optional(),
						message: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
});

/** A batch/v1 Job as this client exposes it. */
export type KubeJob = z.infer<typeof jobSchema>;

/** A Job list response. Items are validated the same way a single Job is. */
const jobListSchema = z.object({ items: z.array(jobSchema) });

/** Ok-with-payload, or a bounded status plus a FIXED reason string. */
export type KubeResult<T> = { ok: true; job: T } | { ok: false; status: number; reason: string };

/** The three verbs later lanes need. All pinned to `image-builds`. */
export interface KubeJobsClient {
	createJob(body: unknown): Promise<KubeResult<KubeJob>>;
	getJob(name: string): Promise<KubeResult<KubeJob>>;
	listJobs(labelSelector?: string): Promise<KubeResult<KubeJob[]>>;
}

/** Map a status class to a fixed reason. The response body is never read. */
function reasonFor(status: number): string {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not found";
	if (status === 409) return "already exists";
	return `http ${status}`;
}

/** The namespaced Jobs collection URL for one cluster. */
const jobsUrl = (server: string): string =>
	`${server}/apis/batch/v1/namespaces/${IMAGE_BUILDS_NAMESPACE}/jobs`;

/** A submitted body must name this namespace and this kind, or never be sent. */
function bodyRefusal(body: unknown): string | null {
	const shape = body as { kind?: unknown; metadata?: { namespace?: unknown } } | null;
	if (!shape || typeof shape !== "object") return "body is not an object";
	if (shape.kind !== "Job") return "kind is not Job";
	if (shape.metadata?.namespace !== IMAGE_BUILDS_NAMESPACE) {
		return `metadata.namespace is not ${IMAGE_BUILDS_NAMESPACE}`;
	}
	return null;
}

/**
 * Issue one request and validate its 2xx body, or return a bounded failure.
 * Four parameters is the oxlint ceiling; the schema rides in the options object
 * with the body so the signature does not grow a fifth.
 */
async function request<T>(
	config: BuildBumpKubeconfig,
	fetchLike: KubeJobsFetch,
	url: string,
	options: { method: "GET" | "POST"; body?: string; schema: z.ZodType<T> },
): Promise<KubeResult<T>> {
	let response: Response;
	try {
		response = await fetchLike(url, {
			method: options.method,
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			...(options.body === undefined ? {} : { body: options.body }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			tls: { ca: config.caPem },
		} as RequestInit);
	} catch {
		// The caught error is discarded unread: connection errors interpolate the
		// URL and, through a proxy, request headers carrying the bearer token.
		return { ok: false, status: 0, reason: "network error" };
	}
	if (!response.ok) {
		return { ok: false, status: response.status, reason: reasonFor(response.status) };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { ok: false, status: response.status, reason: "invalid response body" };
	}
	const parsed = options.schema.safeParse(payload);
	if (!parsed.success) {
		// zod's issue list quotes received values from an untrusted response.
		return { ok: false, status: response.status, reason: "invalid response body" };
	}
	return { ok: true, job: parsed.data };
}

/**
 * Build a Jobs client for one decoded kubeconfig.
 *
 * @param config - the in-memory credential from `resolveBuildBumpKubeconfig`
 * @param fetchLike - the fetch seam (defaults to the global `fetch`)
 */
export const createKubeJobsClient = traced(
	"imagebuild.createKubeJobsClient",
	function createKubeJobsClient(
		config: BuildBumpKubeconfig,
		fetchLike: KubeJobsFetch = fetch,
	): KubeJobsClient {
		const collection = jobsUrl(config.server);
		return {
			async createJob(body: unknown) {
				const refusal = bodyRefusal(body);
				// Refused BEFORE any request: the fake fetch must record zero calls.
				if (refusal) return { ok: false, status: 0, reason: refusal };
				return request(config, fetchLike, collection, {
					method: "POST",
					body: JSON.stringify(body),
					schema: jobSchema,
				});
			},
			async getJob(name: string) {
				return request(config, fetchLike, `${collection}/${encodeURIComponent(name)}`, {
					method: "GET",
					schema: jobSchema,
				});
			},
			async listJobs(labelSelector?: string) {
				const query =
					labelSelector === undefined ? "" : `?labelSelector=${encodeURIComponent(labelSelector)}`;
				const result = await request(config, fetchLike, `${collection}${query}`, {
					method: "GET",
					schema: jobListSchema,
				});
				return result.ok ? { ok: true, job: result.job.items } : result;
			},
		};
	},
	{ redact: { args: [0] } },
);
