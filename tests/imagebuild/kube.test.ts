/**
 * @module tests/imagebuild/kube
 * @description Hermetic tests for the in-memory kubeconfig resolver and the
 *   namespace-pinned Jobs client. Nothing here touches disk or a real
 *   cluster: every kubeconfig is an inline fixture base64-encoded in the test, and
 *   every request goes through a fake `fetchLike` that records its calls.
 *
 *   THE LOAD-BEARING CASES are the refusals. A credential whose context namespace
 *   is not `image-builds` is the WRONG credential — the service account is confined
 *   to that namespace, so anything else means someone wired a cluster-admin config
 *   in — and `createJob` must refuse a foreign `metadata.namespace` BEFORE the
 *   request leaves, which is asserted by the fake never being called. The token and
 *   CA fixtures are deliberately distinctive strings so an assertion that they do
 *   not appear in an error or result is a real assertion and not a tautology.
 */
import { describe, expect, test } from "bun:test";
import {
	createKubeJobsClient,
	type KubeJobsFetch,
	resolveBuildBumpKubeconfig,
} from "../../src/imagebuild/kube";

/**
 * Distinctive enough that finding it in any error string is unambiguous, and
 * ASSEMBLED from parts so no high-entropy literal sits in the file — a
 * token-shaped constant here trips `bun run secrets` (gitleaks generic-api-key)
 * and an allowlist entry for a fixture would blunt the real scan.
 */
const TOKEN_FIXTURE = ["token", "distinctive", "must", "never", "leak"].join("-");
const CA_PEM_FIXTURE =
	"-----BEGIN CERTIFICATE-----\nCA-DISTINCTIVE-must-never-leak\n-----END CERTIFICATE-----\n";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** A minimal but complete scoped kubeconfig, shaped like the real one. */
function kubeconfigYaml(
	options: { server?: string; namespace?: string; token?: string } = {},
): string {
	const server = options.server ?? "https://k3s.invalid:6443";
	const namespace = options.namespace ?? "image-builds";
	const token = options.token ?? TOKEN_FIXTURE;
	return [
		"apiVersion: v1",
		"kind: Config",
		"clusters:",
		"  - name: k3s",
		"    cluster:",
		`      server: ${server}`,
		`      certificate-authority-data: ${b64(CA_PEM_FIXTURE)}`,
		"users:",
		"  - name: build-bump",
		"    user:",
		`      token: ${token}`,
		"contexts:",
		"  - name: build-bump@k3s",
		"    context:",
		"      cluster: k3s",
		"      user: build-bump",
		`      namespace: ${namespace}`,
		"current-context: build-bump@k3s",
	].join("\n");
}

const envWith = (yaml: string): NodeJS.ProcessEnv =>
	({ BUILD_BUMP_KUBECONFIG_B64: b64(yaml) }) as NodeJS.ProcessEnv;

/** A fake fetch that records every call and returns a canned response. */
function fakeFetch(respond: () => { status: number; body: unknown }): {
	fetchLike: KubeJobsFetch;
	calls: { url: string; init: RequestInit }[];
} {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchLike: KubeJobsFetch = async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		const { status, body } = respond();
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetchLike, calls };
}

/** Resolve a config from a fixture, asserting success so tests can use it. */
function config(options: Parameters<typeof kubeconfigYaml>[0] = {}) {
	const result = resolveBuildBumpKubeconfig(envWith(kubeconfigYaml(options)));
	if (!result.ok) throw new Error(`fixture did not resolve: ${result.error}`);
	return result.config;
}

const JOB_BODY = {
	apiVersion: "batch/v1",
	kind: "Job",
	metadata: { name: "build-x", namespace: "image-builds" },
	spec: {},
};

describe("resolveBuildBumpKubeconfig", () => {
	test("(a) absent env fails closed with the fixed message", () => {
		const result = resolveBuildBumpKubeconfig({} as NodeJS.ProcessEnv);
		expect(result).toEqual({
			ok: false,
			error: "no build-bump kubeconfig: set BUILD_BUMP_KUBECONFIG_B64",
		});
	});

	test("(a) an empty env value is treated as absent", () => {
		const result = resolveBuildBumpKubeconfig({
			BUILD_BUMP_KUBECONFIG_B64: "   ",
		} as NodeJS.ProcessEnv);
		expect(result.ok).toBe(false);
	});

	test("(b) a context namespace other than image-builds is refused", () => {
		const result = resolveBuildBumpKubeconfig(envWith(kubeconfigYaml({ namespace: "default" })));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("image-builds");
		expect(result.error).not.toContain(TOKEN_FIXTURE);
	});

	test("(c) a non-https server is refused", () => {
		const result = resolveBuildBumpKubeconfig(
			envWith(kubeconfigYaml({ server: "http://k3s.invalid:6443" })),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).not.toContain(TOKEN_FIXTURE);
	});

	test("an empty token is refused without echoing the config", () => {
		const result = resolveBuildBumpKubeconfig(envWith(kubeconfigYaml({ token: '""' })));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).not.toContain(CA_PEM_FIXTURE);
	});

	test("a good config decodes the CA to PEM and carries the token", () => {
		const result = resolveBuildBumpKubeconfig(envWith(kubeconfigYaml()));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.server).toBe("https://k3s.invalid:6443");
		expect(result.config.caPem).toBe(CA_PEM_FIXTURE);
		expect(result.config.token).toBe(TOKEN_FIXTURE);
	});

	test("a body that is not valid base64 YAML is refused, not thrown", () => {
		const result = resolveBuildBumpKubeconfig({
			BUILD_BUMP_KUBECONFIG_B64: b64("\tnot: [valid: yaml"),
		} as NodeJS.ProcessEnv);
		expect(result.ok).toBe(false);
	});
});

describe("createKubeJobsClient", () => {
	test("(d) createJob POSTs the pinned path with bearer auth, JSON body, and the CA", async () => {
		const { fetchLike, calls } = fakeFetch(() => ({
			status: 201,
			body: { metadata: { name: "build-x", namespace: "image-builds" } },
		}));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.createJob(JOB_BODY);

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("no call recorded");
		expect(call.url).toBe("https://k3s.invalid:6443/apis/batch/v1/namespaces/image-builds/jobs");
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN_FIXTURE}`);
		expect(headers["Content-Type"]).toBe("application/json");
		expect(call.init.body).toBe(JSON.stringify(JOB_BODY));
		expect((call.init as { tls?: { ca?: string } }).tls?.ca).toBe(CA_PEM_FIXTURE);
	});

	test("(e) a foreign metadata.namespace is refused before any request", async () => {
		const { fetchLike, calls } = fakeFetch(() => ({ status: 201, body: {} }));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.createJob({
			...JOB_BODY,
			metadata: { name: "build-x", namespace: "kube-system" },
		});

		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("(e) a non-Job kind is refused before any request", async () => {
		const { fetchLike, calls } = fakeFetch(() => ({ status: 201, body: {} }));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.createJob({ ...JOB_BODY, kind: "Pod" });

		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("(f) a 404 reports 'not found' and never the response body text", async () => {
		const leak = "SECRET-BODY-TEXT-from-the-apiserver";
		const { fetchLike } = fakeFetch(() => ({ status: 404, body: { message: leak } }));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.getJob("build-x");

		expect(result).toEqual({ ok: false, status: 404, reason: "not found" });
		expect(JSON.stringify(result)).not.toContain(leak);
	});

	test("(g) a 401 result carries neither the token nor the CA", async () => {
		const { fetchLike } = fakeFetch(() => ({
			status: 401,
			body: { message: "Unauthorized" },
		}));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.getJob("build-x");

		expect(result).toEqual({ ok: false, status: 401, reason: "unauthorized" });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(TOKEN_FIXTURE);
		expect(serialized).not.toContain("CA-DISTINCTIVE");
	});

	test("a 409 reports 'already exists' and an unclassified status reports http <status>", async () => {
		const conflict = createKubeJobsClient(
			config(),
			fakeFetch(() => ({ status: 409, body: {} })).fetchLike,
		);
		expect(await conflict.createJob(JOB_BODY)).toEqual({
			ok: false,
			status: 409,
			reason: "already exists",
		});

		const teapot = createKubeJobsClient(
			config(),
			fakeFetch(() => ({ status: 418, body: {} })).fetchLike,
		);
		expect(await teapot.getJob("build-x")).toEqual({
			ok: false,
			status: 418,
			reason: "http 418",
		});
	});

	test("a thrown fetch becomes a bounded network error, not an exception", async () => {
		const client = createKubeJobsClient(config(), async () => {
			throw new Error(`connect ECONNREFUSED carrying ${TOKEN_FIXTURE}`);
		});

		const result = await client.getJob("build-x");

		expect(result).toEqual({ ok: false, status: 0, reason: "network error" });
		expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
	});

	test("(h) listJobs encodes the labelSelector as a query parameter", async () => {
		const { fetchLike, calls } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
		const client = createKubeJobsClient(config(), fetchLike);

		await client.listJobs("app=build-bump,tag=v1.2.3");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://k3s.invalid:6443/apis/batch/v1/namespaces/image-builds/jobs" +
				`?labelSelector=${encodeURIComponent("app=build-bump,tag=v1.2.3")}`,
		);
	});

	test("(i) a 200 body with unknown extra fields parses and exposes status.conditions", async () => {
		const { fetchLike } = fakeFetch(() => ({
			status: 200,
			body: {
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: { name: "build-x", namespace: "image-builds", uid: "unknown-extra" },
				spec: { backoffLimit: 0, unknownExtra: true },
				status: {
					active: 0,
					succeeded: 1,
					conditions: [
						{
							type: "Complete",
							status: "True",
							reason: "Done",
							message: "job finished",
							lastProbeTime: "2026-09-01T00:00:00Z",
						},
					],
				},
			},
		}));
		const client = createKubeJobsClient(config(), fetchLike);

		const result = await client.getJob("build-x");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.job.metadata.name).toBe("build-x");
		expect(result.job.metadata.namespace).toBe("image-builds");
		expect(result.job.status?.succeeded).toBe(1);
		expect(result.job.status?.conditions?.[0]?.type).toBe("Complete");
		expect(result.job.status?.conditions?.[0]?.status).toBe("True");
	});

	test("getJob pins the job name into the namespaced path", async () => {
		const { fetchLike, calls } = fakeFetch(() => ({
			status: 200,
			body: { metadata: { name: "build-x", namespace: "image-builds" } },
		}));
		const client = createKubeJobsClient(config(), fetchLike);

		await client.getJob("build-x");

		expect(calls[0]?.url).toBe(
			"https://k3s.invalid:6443/apis/batch/v1/namespaces/image-builds/jobs/build-x",
		);
	});
});
