/**
 * @module tests/fleet/infra-health
 * @description `fleet/skills/infra-health/bin/infra-health` run as a
 *   real child process against a tiny fake Prometheus that answers each query
 *   from a fixture keyed on the exact PromQL string. Pins: a healthy fixture is
 *   ok, every rule fires with its key and severity, `fit` counts nodes with
 *   headroom, a Prometheus 500 is a harness error, bad usage exits 2, and the
 *   request queries count only pods that still hold a node (SOF-2712).
 *   `INFRA_HEALTH_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.INFRA_HEALTH_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/infra-health/bin/infra-health");

const PVE = 'job="proxmox-nodes"';
const FS = 'job="proxmox-nodes",fstype!~"tmpfs|overlay|squashfs|ramfs"';
const Q = {
	up: `up{${PVE}}`,
	load: `node_load1{${PVE}}`,
	cores: `count by (instance) (node_cpu_seconds_total{${PVE},mode="idle"})`,
	mem: `node_memory_MemAvailable_bytes{${PVE}} / node_memory_MemTotal_bytes{${PVE}}`,
	disk: `node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}}`,
	ready: 'kube_node_status_condition{condition="Ready",status="true"}',
	reqCpu:
		'sum by (node) (kube_pod_container_resource_requests{resource="cpu"} * on (namespace, pod, uid) group_left () max by (namespace, pod, uid) (kube_pod_status_phase{phase=~"Pending|Running|Unknown"} == 1))',
	reqMem:
		'sum by (node) (kube_pod_container_resource_requests{resource="memory"} * on (namespace, pod, uid) group_left () max by (namespace, pod, uid) (kube_pod_status_phase{phase=~"Pending|Running|Unknown"} == 1))',
	allocCpu: 'kube_node_status_allocatable{resource="cpu"}',
	allocMem: 'kube_node_status_allocatable{resource="memory"}',
	pods: 'kube_pod_status_phase{phase=~"Pending|Failed|Unknown"} == 1',
	wait: 'kube_pod_container_status_waiting_reason{reason=~"CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError"} == 1',
	pvc: 'kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1',
	argo: "argocd_app_info",
	targets: "up == 0",
	alerts: 'ALERTS{alertstate="firing",alertname!="Watchdog"}',
};

type Sample = { metric: Record<string, string>; value: [number, string] };
const s = (metric: Record<string, string>, v: number): Sample => ({
	metric,
	value: [1, String(v)],
});
const GiB = 1024 ** 3;

function healthy(): Record<string, Sample[]> {
	const pve = ["node01", "node04"];
	const k = ["k3s-a", "k3s-b", "k3s-c"];
	return {
		[Q.up]: pve.map((i) => s({ instance: i }, 1)),
		[Q.load]: pve.map((i) => s({ instance: i }, 2)),
		[Q.cores]: pve.map((i) => s({ instance: i }, 8)),
		[Q.mem]: pve.map((i) => s({ instance: i }, 0.5)),
		[Q.disk]: pve.map((i) => s({ instance: i, mountpoint: "/" }, 0.6)),
		[Q.ready]: k.map((n) => s({ node: n }, 1)),
		// a: 4000m alloc, 1000m used; b: 4000m, 500m; c: 4000m, 3900m
		[Q.reqCpu]: [s({ node: "k3s-a" }, 1), s({ node: "k3s-b" }, 0.5), s({ node: "k3s-c" }, 3.5)],
		[Q.allocCpu]: k.map((n) => s({ node: n }, 4)),
		[Q.reqMem]: [
			s({ node: "k3s-a" }, 2 * GiB),
			s({ node: "k3s-b" }, 1 * GiB),
			s({ node: "k3s-c" }, 7 * GiB),
		],
		[Q.allocMem]: k.map((n) => s({ node: n }, 8 * GiB)),
		[Q.pods]: [],
		[Q.wait]: [],
		[Q.pvc]: [],
		[Q.argo]: [s({ name: "web", health_status: "Healthy", sync_status: "Synced" }, 1)],
		[Q.targets]: [],
		[Q.alerts]: [],
	};
}

let fixture = healthy();
let fail500 = false;
const unknown: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			if (fail500) return new Response("boom", { status: 500 });
			const url = new URL(req.url);
			const q = url.searchParams.get("query") ?? "";
			if (req.method !== "GET" || url.pathname !== "/api/v1/query" || !(q in fixture)) {
				unknown.push(q);
				return Response.json({ status: "error", error: `unknown query ${q}` }, { status: 400 });
			}
			return Response.json({
				status: "success",
				data: { resultType: "vector", result: fixture[q] },
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
	fixture = healthy();
	fail500 = false;
	unknown.length = 0;
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["python3", SCRIPT, ...args, "--base-url", base], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PROMETHEUS_URL: "http://127.0.0.1:1" },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

interface Finding {
	key: string;
	severity: string;
	evidence: string;
}
async function check(): Promise<{ ok: boolean; findings: Finding[]; [k: string]: unknown }> {
	const r = await run(["check"]);
	expect(r.err).toBe("");
	expect(r.code).toBe(0);
	expect(unknown).toEqual([]);
	return JSON.parse(r.out);
}
async function expectOnly(key: string, severity: string) {
	const res = await check();
	expect(res.ok).toBe(false);
	expect(res.findings.map((f) => [f.key, f.severity])).toEqual([[key, severity]]);
	expect(res.findings[0]?.evidence.length).toBeGreaterThan(0);
}

describe("infra-health check", () => {
	test("healthy fixture is ok with no findings", async () => {
		const res = await check();
		expect(res.ok).toBe(true);
		expect(res.findings).toEqual([]);
		expect(res.pve).toEqual([
			{ instance: "node01", up: true, loadPerCore: 0.25, memAvailableRatio: 0.5 },
			{ instance: "node04", up: true, loadPerCore: 0.25, memAvailableRatio: 0.5 },
		]);
		expect(res.k3s).toMatchObject({ argoApps: 1, argoUnhealthy: 0 });
	});

	test("PVE node down is crit", async () => {
		fixture[Q.up] = [s({ instance: "node01" }, 1), s({ instance: "node04" }, 0)];
		await expectOnly("pve-down:node04", "crit");
	});
	test("PVE load per core > 1.5 is warn", async () => {
		fixture[Q.load] = [s({ instance: "node01" }, 2), s({ instance: "node04" }, 13)];
		await expectOnly("pve-load:node04", "warn");
	});
	test("PVE memory available < 0.10 is crit", async () => {
		fixture[Q.mem] = [s({ instance: "node01" }, 0.5), s({ instance: "node04" }, 0.05)];
		await expectOnly("pve-mem:node04", "crit");
	});
	test("PVE disk < 0.10 is warn, < 0.05 is crit", async () => {
		fixture[Q.disk] = [s({ instance: "node01", mountpoint: "/" }, 0.08)];
		await expectOnly("pve-disk:node01:/", "warn");
		fixture[Q.disk] = [s({ instance: "node01", mountpoint: "/" }, 0.03)];
		await expectOnly("pve-disk:node01:/", "crit");
	});
	test("k3s node not Ready is crit", async () => {
		fixture[Q.ready] = [s({ node: "k3s-a" }, 1), s({ node: "k3s-b" }, 0), s({ node: "k3s-c" }, 1)];
		await expectOnly("k3s-node:k3s-b", "crit");
	});
	test("k3s commit > 0.90 is warn per resource", async () => {
		fixture[Q.reqCpu] = [s({ node: "k3s-c" }, 3.8)];
		await expectOnly("k3s-commit:k3s-c:cpu", "warn");
		fixture = healthy();
		fixture[Q.reqMem] = [s({ node: "k3s-a" }, 7.5 * GiB)];
		await expectOnly("k3s-commit:k3s-a:memory", "warn");
	});
	test("pod not running is warn", async () => {
		fixture[Q.pods] = [s({ namespace: "apps", pod: "web-1", phase: "Pending" }, 1)];
		await expectOnly("k3s-pod:apps/web-1", "warn");
	});
	test("container stuck is crit", async () => {
		fixture[Q.wait] = [
			s({ namespace: "apps", pod: "web-2", container: "c", reason: "CrashLoopBackOff" }, 1),
		];
		await expectOnly("k3s-wait:apps/web-2", "crit");
	});
	test("PVC not bound is warn", async () => {
		fixture[Q.pvc] = [s({ namespace: "db", persistentvolumeclaim: "data", phase: "Pending" }, 1)];
		await expectOnly("k3s-pvc:db/data", "warn");
	});
	test("Argo app unhealthy or out of sync is warn", async () => {
		fixture[Q.argo] = [
			s({ name: "web", health_status: "Healthy", sync_status: "Synced" }, 1),
			s({ name: "api", health_status: "Healthy", sync_status: "OutOfSync" }, 1),
		];
		await expectOnly("argo:api", "warn");
	});
	test("target down is warn, proxmox-nodes job excluded", async () => {
		fixture[Q.targets] = [
			s({ job: "proxmox-nodes", instance: "node09" }, 0),
			s({ job: "blackbox", instance: "x:9115" }, 0),
		];
		await expectOnly("target:blackbox:x:9115", "warn");
	});
	test("a firing critical alert is crit, keyed by alert and namespace", async () => {
		fixture[Q.alerts] = [
			s({ alertname: "CNPGBackupStale", namespace: "databases", severity: "critical" }, 1),
		];
		await expectOnly("alert:CNPGBackupStale:databases", "crit");
	});
	test("a firing warning alert is warn", async () => {
		fixture[Q.alerts] = [
			s({ alertname: "DiskSpaceWarning", instance: "ct105", severity: "warning" }, 1),
		];
		await expectOnly("alert:DiskSpaceWarning:ct105", "warn");
	});
	test("empty vectors are not a clean run", async () => {
		for (const q of Object.keys(fixture)) fixture[q] = [];
		const res = await check();
		expect(res.ok).toBe(false);
		const keys = res.findings.map((f) => f.key);
		expect(keys).toContain("pve-nodata");
		expect(keys).toContain("k3s-nodata");
	});
	test("a node with allocatable but no Ready sample is a finding", async () => {
		fixture[Q.ready] = [s({ node: "k3s-a" }, 1), s({ node: "k3s-c" }, 1)];
		const res = await check();
		expect(res.ok).toBe(false);
		expect(res.findings.map((f) => [f.key, f.severity])).toEqual([
			["k3s-node-nodata:k3s-b", "crit"],
		]);
	});
	test("counts come from the data", async () => {
		const res = await check();
		expect(res.pveUp).toBe(2);
		expect(res.pveTotal).toBe(2);
		const k3s = res.k3s as { ready: number; total: number };
		expect(k3s.ready).toBe(3);
		expect(k3s.total).toBe(3);
	});
});

describe("infra-health fit", () => {
	test("a size that fits two nodes", async () => {
		const r = await run(["fit", "--cpu", "1000", "--memory", "2048", "--replicas", "2"]);
		expect(r.code).toBe(0);
		const res = JSON.parse(r.out);
		expect(res.request).toEqual({ cpu: 1000, memory: 2048, replicas: 2 });
		expect(res.fits).toBe(true);
		expect(res.nodes).toEqual([
			{ node: "k3s-b", freeCpu: 3500, freeMemory: 7168, fits: true, slots: 3 },
			{ node: "k3s-a", freeCpu: 3000, freeMemory: 6144, fits: true, slots: 2 },
			{ node: "k3s-c", freeCpu: 500, freeMemory: 1024, fits: false, slots: 0 },
		]);
	});
	function oneNode() {
		fixture[Q.ready] = [s({ node: "k3s-a" }, 1)];
		fixture[Q.reqCpu] = [s({ node: "k3s-a" }, 1)];
		fixture[Q.allocCpu] = [s({ node: "k3s-a" }, 4)];
		fixture[Q.reqMem] = [s({ node: "k3s-a" }, 1 * GiB)];
		fixture[Q.allocMem] = [s({ node: "k3s-a" }, 8 * GiB)];
	}
	test("two replicas fit on one node", async () => {
		oneNode();
		const r = await run(["fit", "--cpu", "500", "--memory", "512", "--replicas", "2"]);
		expect(r.code).toBe(0);
		const res = JSON.parse(r.out);
		expect(res.fits).toBe(true);
		expect(res.nodes[0].slots).toBeGreaterThanOrEqual(2);
	});
	test("replicas beyond total slots do not fit", async () => {
		oneNode();
		// usable cpu 3000 - 400 = 2600 -> 5 slots; usable mem 7168 - 819.2 -> 12 slots
		const r = await run(["fit", "--cpu", "500", "--memory", "512", "--replicas", "6"]);
		expect(r.code).toBe(0);
		const res = JSON.parse(r.out);
		expect(res.slots).toBe(5);
		expect(res.fits).toBe(false);
	});
	test("a size that fits no node", async () => {
		const r = await run(["fit", "--cpu", "3600", "--memory", "512"]);
		expect(r.code).toBe(0);
		const res = JSON.parse(r.out);
		expect(res.fits).toBe(false);
		expect(res.nodes.every((n: { fits: boolean }) => !n.fits)).toBe(true);
	});
});

describe("infra-health errors", () => {
	test("Prometheus 500 exits 1 with empty stdout", async () => {
		fail500 = true;
		const r = await run(["check"]);
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err.trim().split("\n")).toHaveLength(1);
	});
	test("bad usage exits 2", async () => {
		expect((await run(["fit", "--cpu", "100"])).code).toBe(2);
		expect((await run(["bogus"])).code).toBe(2);
	});
});
