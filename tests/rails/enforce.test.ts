import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateRails } from "../../src/rails/enforce";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const CONSTRAINT_IDS = [
	"replicas-default",
	"replicas-spread",
	"cnpg-implies-backup",
	"no-unbounded-ephemeral",
	"storageclass-explicit",
	"pvc-prune-guard",
	"port-bands",
	"no-new-lxc",
	"runner-label",
	"probe-shape",
	"bind-all-interfaces",
] as const;

const scratchDir = join(testTmpBase(), "_scratch");
mkdirSync(scratchDir, { recursive: true });
const manifestPath = join(scratchDir, `rails-${randomUUID()}.yml`);
const stalePath = join(scratchDir, `rails-stale-${randomUUID()}.yml`);
const archivePaths: string[] = [];

const manifestText = [
	"manifest_version: 1",
	"owning_repo: rtech/rtech-infra",
	"constraints:",
	...CONSTRAINT_IDS.flatMap((id) => [`  - id: ${id}`, `    check: check ${id}`]),
	"not_encoded:",
	"  - gotcha: live service location",
	"    why_not: requires a live probe",
	"  - gotcha: wedged entrypoint",
	"    why_not: runtime only",
].join("\n");
writeFileSync(manifestPath, manifestText);
writeFileSync(stalePath, `${manifestText}\n# changed bytes\n`);
archivePaths.push(manifestPath, stalePath);

const expectedSha = createHash("sha256").update(manifestText).digest("hex");

const CLEAN_CNPG = [
	"apiVersion: postgresql.cnpg.io/v1",
	"kind: Cluster",
	"metadata:",
	"  name: press-db",
	"spec:",
	"  instances: 2",
	"  storageClass: longhorn",
	"---",
	"apiVersion: batch/v1",
	"kind: CronJob",
	"metadata:",
	"  name: press-db-backup",
	"spec:",
	"  schedule: '0 3 * * *'",
].join("\n");

const VIOLATIONS: Array<{ id: (typeof CONSTRAINT_IDS)[number]; artifact: string }> = [
	{
		id: "replicas-default",
		artifact: [
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata: { name: one }",
			"spec:",
			"  replicas: 1",
		].join("\n"),
	},
	{
		id: "replicas-spread",
		artifact: [
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata: { name: two }",
			"spec:",
			"  replicas: 2",
			"  template: { spec: { containers: [] } }",
		].join("\n"),
	},
	{
		id: "cnpg-implies-backup",
		artifact: [
			"apiVersion: postgresql.cnpg.io/v1",
			"kind: Cluster",
			"metadata: { name: press-db }",
			"spec: { instances: 2 }",
		].join("\n"),
	},
	{
		id: "no-unbounded-ephemeral",
		artifact: [
			"apiVersion: v1",
			"kind: Pod",
			"metadata: { name: scratch }",
			"spec:",
			"  volumes: [{ name: cache, emptyDir: {} }]",
			"  containers: [{ name: app, image: x, volumeMounts: [{ name: cache, mountPath: /tmp }] }]",
		].join("\n"),
	},
	{
		id: "storageclass-explicit",
		artifact: [
			"apiVersion: v1",
			"kind: PersistentVolumeClaim",
			"metadata: { name: data }",
			"spec: { accessModes: [ReadWriteOnce] }",
		].join("\n"),
	},
	{
		id: "pvc-prune-guard",
		artifact: [
			"apiVersion: v1",
			"kind: PersistentVolumeClaim",
			"metadata: { name: durable }",
			"spec: { storageClassName: longhorn }",
		].join("\n"),
	},
	{
		id: "port-bands",
		artifact: [
			"apiVersion: v1",
			"kind: Service",
			"metadata: { name: web }",
			"spec: { ports: [{ port: 3000 }] }",
		].join("\n"),
	},
	{
		id: "no-new-lxc",
		artifact: ["kind: LXC", "metadata: { name: stray-box }"].join("\n"),
	},
	{
		id: "runner-label",
		artifact: ["jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps: []"].join("\n"),
	},
	{
		id: "probe-shape",
		artifact: [
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata: { name: probes }",
			"spec:",
			"  replicas: 1",
			"  template:",
			"    spec:",
			"      containers:",
			"        - name: app",
			"          image: x",
			"          livenessProbe: { httpGet: { path: /ready, port: 8080 } }",
		].join("\n"),
	},
	{
		id: "bind-all-interfaces",
		artifact: [
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata: { name: loopback }",
			"spec:",
			"  replicas: 1",
			"  template:",
			"    spec:",
			"      containers: [{ name: app, image: x, args: ['--host=127.0.0.1'] }]",
		].join("\n"),
	},
];

afterAll(() => {
	for (const source of archivePaths) {
		const destination = join(testArchiveDir(), `${randomUUID()}-${source.split("/").at(-1)}`);
		renameSync(source, destination);
	}
});

describe("evaluateRails", () => {
	test("consumes manifest ids, names a CNPG backup violation, and announces gaps", async () => {
		const outcome = await evaluateRails({
			manifestPath,
			expectedSha,
			artifact: VIOLATIONS.find((fixture) => fixture.id === "cnpg-implies-backup")?.artifact ?? "",
		});

		expect(outcome.examined).toEqual([...CONSTRAINT_IDS]);
		expect(outcome.violated).toContain("cnpg-implies-backup");
		expect(outcome.hold).toBe(true);
		expect(outcome.report).toContain("rails-violation");
		expect(outcome.report).toContain("cnpg-implies-backup");
		expect(outcome.report).toContain("not-encoded");
		expect(outcome.notEncoded).toEqual(["live service location", "wedged entrypoint"]);
	});

	test("accepts the CNPG cluster when a matching backup CronJob is present", async () => {
		const outcome = await evaluateRails({ manifestPath, expectedSha, artifact: CLEAN_CNPG });

		expect(outcome.hold).toBe(false);
		expect(outcome.violated).toEqual([]);
		expect(outcome.report).not.toContain("rails-violation");
	});

	test("holds with a named manifest failure when the dependency is absent", async () => {
		const outcome = await evaluateRails({
			manifestPath: `${manifestPath}.missing`,
			expectedSha,
			artifact: CLEAN_CNPG,
		});

		expect(outcome.hold).toBe(true);
		expect(outcome.report).toContain("rails-violation");
		expect(outcome.report).toContain("manifest-absent");
		expect(outcome.report).toContain("manifest");
	});

	test("holds with manifest-absent when no manifest path is configured at all", async () => {
		const outcome = await evaluateRails({ artifact: CLEAN_CNPG });

		expect(outcome.hold).toBe(true);
		expect(outcome.violated).toEqual(["manifest-absent"]);
		expect(outcome.report).toContain("rails-violation");
		expect(outcome.report).toContain("manifest-absent");
		expect(outcome.stale).toBe(false);
	});

	test("computes staleness from manifest bytes rather than manifest_version", async () => {
		const outcome = await evaluateRails({
			manifestPath: stalePath,
			expectedSha,
			artifact: CLEAN_CNPG,
		});

		expect(outcome.stale).toBe(true);
		expect(outcome.hold).toBe(true);
		expect(outcome.report).toContain("manifest-stale");
	});

	test.each(VIOLATIONS)("runs and names $id", async ({ id, artifact }) => {
		const outcome = await evaluateRails({ manifestPath, expectedSha, artifact });
		expect(outcome.examined).toContain(id);
		expect(outcome.violated).toContain(id);
		expect(outcome.report).toContain(id);
	});
});
