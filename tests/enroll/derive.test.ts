/**
 * Functional tests for the `enroll --derive` planner (lane 831a): the
 * pure `derivePlan` model over a k3s-deploy checkout. The committed fixture
 * holds the three shapes the planner must tell apart -- a factory-workflows
 * rendered dir (header copied from a real k3s-deploy render), a hand-written
 * dir, and an infra dir on the fixed exclusion list. uat/prod pairing is proved
 * on a tree built under the portable test temp base.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derivePlan, INFRA_DIRS, isInfraDir } from "../../src/enroll/derive";
import { testTmpBase } from "../support/test-temp";

const FIXTURE = "tests/enroll/fixtures/k3s-deploy";

describe("derivePlan over the committed fixture", () => {
	const rows = derivePlan(FIXTURE);
	const byDir = new Map(rows.map((r) => [r.dir, r]));

	test("returns one row per app dir, sorted by dir", () => {
		expect(rows.map((r) => r.dir)).toEqual(["bb-landing", "bifrost", "rodaddy-hook-probe-uat"]);
	});

	test("a factory-workflows rendered dir is on the rail", () => {
		expect(byDir.get("rodaddy-hook-probe-uat")).toEqual({
			dir: "rodaddy-hook-probe-uat",
			image:
				"10.0.20.58:3000/rodaddy/hook-probe:v0.2.2@sha256:854ebaa55b6f1e29324bf594ecf3e27a662bf6dd333829ee8c31b8aa73c76a27",
			owner: "rodaddy",
			onRail: true,
			envs: { uat: "rodaddy-hook-probe-uat" },
			reason: "rendered",
		});
	});

	test("a hand-written dir is an off-rail candidate with its quoted image unwrapped", () => {
		expect(byDir.get("bb-landing")).toEqual({
			dir: "bb-landing",
			image: "10.0.20.58:3000/acme/web-bb-landing:v0.17.3",
			owner: "acme",
			onRail: false,
			envs: { default: "bb-landing" },
			reason: "hand-written",
		});
	});

	test("an infra dir is excluded and never read", () => {
		expect(byDir.get("bifrost")).toEqual({
			dir: "bifrost",
			image: null,
			owner: null,
			onRail: false,
			envs: { default: "bifrost" },
			reason: "infra",
		});
	});
});

describe("isInfraDir", () => {
	test("matches exact names and trailing-* prefixes from the fixed list", () => {
		expect(INFRA_DIRS).toContain("alertmanager-*");
		expect(isInfraDir("bifrost")).toBe(true);
		expect(isInfraDir("alertmanager-to-gmail")).toBe(true);
		expect(isInfraDir("llama-swap-route")).toBe(true);
		expect(isInfraDir("grafana-dashboards")).toBe(true);
	});

	test("does not match an app whose name merely contains an infra word", () => {
		expect(isInfraDir("bifrost-ui")).toBe(false);
		expect(isInfraDir("rtech-site-prod")).toBe(false);
		expect(isInfraDir("hello-world")).toBe(false);
	});
});

describe("derivePlan pairing and edge shapes", () => {
	const root = mkdtempSync(join(testTmpBase(), "enroll-derive-"));
	const apps = join(root, "manifests", "apps");
	const write = (dir: string, file: string, body: string): void => {
		mkdirSync(join(apps, dir), { recursive: true });
		writeFileSync(join(apps, dir, file), body);
	};
	write(
		"portal-uat",
		"deployment.yaml",
		"        - image: 10.0.20.58:3000/rtech/portal:v1.0.0-uat.1\n",
	);
	write("portal-prod", "deployment.yaml", "          image: 10.0.20.58:3000/rtech/portal:v1.0.0\n");
	write("empty-app", "kustomization.yaml", "resources: []\n");
	writeFileSync(join(apps, "README.md"), "not a dir\n");
	const rows = derivePlan(root);
	const byDir = new Map(rows.map((r) => [r.dir, r]));

	test("uat and prod siblings pair on their shared base", () => {
		const pair = { uat: "portal-uat", prod: "portal-prod" };
		expect(byDir.get("portal-uat")?.envs).toEqual(pair);
		expect(byDir.get("portal-prod")?.envs).toEqual(pair);
		expect(byDir.get("portal-uat")?.image).toBe("10.0.20.58:3000/rtech/portal:v1.0.0-uat.1");
	});

	test("a dir with no image line says so; a plain file is not a row", () => {
		expect(byDir.get("empty-app")).toMatchObject({ image: null, owner: null, reason: "no image" });
		expect(byDir.has("README.md")).toBe(false);
	});

	test("a checkout without manifests/apps throws a bounded error", () => {
		expect(() => derivePlan(join(root, "nope"))).toThrow(/manifests\/apps/);
	});
});

describe("derivePlan name validation", () => {
	test("a dir name that is not a DNS-1123 label is invalid-name with no image", () => {
		const root = mkdtempSync(join(testTmpBase(), "rw-enroll-name-"));
		for (const dir of ["Bad_Name", "ok-app"]) {
			mkdirSync(join(root, "manifests", "apps", dir), { recursive: true });
			writeFileSync(
				join(root, "manifests", "apps", dir, "deployment.yaml"),
				"      - image: 10.0.20.58:3000/rodaddy/x:v1\n",
			);
		}
		const byDir = new Map(derivePlan(root).map((r) => [r.dir, r]));
		expect(byDir.get("Bad_Name")).toMatchObject({
			image: null,
			owner: null,
			reason: "invalid-name",
		});
		expect(byDir.get("ok-app")?.reason).toBe("hand-written");
	});

	test("a dir name over 63 characters is invalid-name; exactly 63 is accepted", () => {
		const root = mkdtempSync(join(testTmpBase(), "rw-enroll-len-"));
		const long = "a".repeat(64);
		const max = "b".repeat(63);
		for (const dir of [long, max]) {
			mkdirSync(join(root, "manifests", "apps", dir), { recursive: true });
			writeFileSync(
				join(root, "manifests", "apps", dir, "deployment.yaml"),
				"      - image: 10.0.20.58:3000/rodaddy/x:v1\n",
			);
		}
		const byDir = new Map(derivePlan(root).map((r) => [r.dir, r]));
		expect(byDir.get(long)?.reason).toBe("invalid-name");
		expect(byDir.get(max)?.reason).toBe("hand-written");
	});
});
