/**
 * Functional tests for `hosted-app map` at its two boundaries: the pure
 * `buildMap` model (every disagreement class constructed directly, so each one
 * is proved to fire exactly when its condition holds and not otherwise) and the
 * CLI's exit code against real directories built under the portable test temp
 * base. The registry fixture is the same entry the validator tests use, so a
 * schema change that breaks the documented shape goes red here too.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHostedApp } from "../../src/hostedapp/command";
import {
	buildMap,
	collectMapInputs,
	type MapInputs,
	NO_SNAPSHOT,
	parseArgoSnapshot,
	type RegistryFile,
	type RunningApp,
	shortRef,
} from "../../src/hostedapp/map";
import { renderMapHtml } from "../../src/hostedapp/map-html";
import type { RegistryEntry } from "../../src/hostedapp/schema";
import { validateRegistryEntry } from "../../src/hostedapp/validate";
import { testTmpBase } from "../support/test-temp";

const FIXTURES = "tests/hostedapp/fixtures";
const ENTRY_PATH = `${FIXTURES}/registry-entry.yaml`;
const ARGO_PATH = `${FIXTURES}/argo-applications.json`;
const ACCEPTED =
	"10.0.20.58:3000/rtech/linkedin-automation:v0.3.0@sha256:aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111";

/** A fresh directory beneath the portable test temp base. */
function makeTempDir(prefix: string): string {
	return mkdtempSync(join(testTmpBase(), `${prefix}-`));
}

/** The fixture registry entry, parsed; a fixture that stops validating is a bug. */
async function fixtureEntry(): Promise<RegistryEntry> {
	const result = validateRegistryEntry(await Bun.file(ENTRY_PATH).text());
	if (!result.ok) throw new Error("fixture registry entry is invalid");
	return result.value;
}

/** Inputs carrying one valid entry, with the rendered/running facts supplied. */
function inputsWith(
	entry: RegistryEntry,
	rendered: MapInputs["rendered"],
	running?: MapInputs["running"],
): MapInputs {
	const files: RegistryFile[] = [{ file: "linkedin-automation.yaml", ok: true, entry }];
	return { registry: files, rendered, running, generatedAt: "2026-09-07T00:00:00.000Z" };
}

/** A running Application with the supplied image and a Healthy status. */
function healthy(name: string, image: string): RunningApp {
	return { name, sync: "Synced", health: "Healthy", revision: "578c4667", images: [image] };
}

/** Write a registry checkout holding one `apps/<file>` document. */
function writeRegistryDir(file: string, text: string): string {
	const dir = makeTempDir("map-registry");
	mkdirSync(join(dir, "apps"), { recursive: true });
	writeFileSync(join(dir, "apps", file), text);
	return dir;
}

/** Write a k3s-deploy checkout; an image renders a minimal `deployment.yaml`. */
function writeDeployDir(slug?: string, image?: string): string {
	const dir = makeTempDir("map-deploy");
	mkdirSync(join(dir, "apps"), { recursive: true });
	mkdirSync(join(dir, "manifests", "apps"), { recursive: true });
	if (slug === undefined) return dir;
	writeFileSync(join(dir, "apps", `${slug}.yaml`), "kind: Application\n");
	const manifests = join(dir, "manifests", "apps", slug);
	mkdirSync(manifests, { recursive: true });
	if (image !== undefined) {
		writeFileSync(
			join(manifests, "deployment.yaml"),
			`apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${slug}\nspec:\n` +
				`  template:\n    spec:\n      containers:\n        - name: app\n          image: ${image}\n`,
		);
	}
	return dir;
}

describe("buildMap declared columns", () => {
	test("one row per registry target, carrying the declared facts", async () => {
		const entry = await fixtureEntry();
		const model = buildMap(inputsWith(entry, new Map()));

		expect(model.rows.map((r) => `${r.app}/${r.target}`)).toEqual([
			"linkedin-automation/uat",
			"linkedin-automation/prod",
		]);
		const uat = model.rows[0];
		expect(uat?.declared.repo).toBe("rodaddy/linkedin-automation");
		expect(uat?.declared.ref).toBe(shortRef(entry.accepted.ref));
		expect(uat?.declared.on).toBe("2026-09-07");
		expect(uat?.declared.by).toBe("rico");
		expect(uat?.declared.state).toBe("active");
		expect(uat?.declared.merge).toBe("auto");
		expect(uat?.declared.image).toBe(ACCEPTED);
		expect(model.rows[1]?.declared.merge).toBe("manual");
		expect(model.counts.apps).toBe(1);
		expect(model.counts.targets).toBe(2);
	});

	test("an invalid registry entry is one row carrying its first problem", () => {
		const model = buildMap({
			registry: [{ file: "broken.yaml", ok: false, problem: "name -- must be a DNS-1123 label" }],
			rendered: new Map(),
			generatedAt: "2026-09-07T00:00:00.000Z",
		});

		expect(model.rows).toHaveLength(1);
		expect(model.rows[0]?.verdict).toBe("invalid");
		expect(model.rows[0]?.problem).toBe("name -- must be a DNS-1123 label");
		expect(model.counts.invalid).toBe(1);
		expect(model.counts.apps).toBe(0);
		expect(model.counts.targets).toBe(0);
	});
});

describe("buildMap rendered and running columns", () => {
	test("rendered files and the deployment image are read into the row", async () => {
		const entry = await fixtureEntry();
		const rendered = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: ACCEPTED }],
		]);
		const model = buildMap(inputsWith(entry, rendered));

		expect(model.rows[0]?.rendered).toEqual({
			application: true,
			manifests: true,
			image: ACCEPTED,
		});
		expect(model.rows[1]?.rendered.application).toBe(false);
		expect(model.counts.rendered).toBe(1);
	});

	test("running facts come from the snapshot, and healthy targets are counted", async () => {
		const entry = await fixtureEntry();
		const running = new Map([
			["linkedin-automation-uat", healthy("linkedin-automation-uat", ACCEPTED)],
		]);
		const model = buildMap(inputsWith(entry, new Map(), running));

		expect(model.rows[0]?.running?.health).toBe("Healthy");
		expect(model.rows[0]?.running?.revision).toBe("578c4667");
		expect(model.rows[1]?.running).toBeUndefined();
		expect(model.counts.runningHealthy).toBe(1);
		expect(model.hasSnapshot).toBe(true);
	});

	test("no snapshot leaves Running unknown, and claims no target is not running", async () => {
		const entry = await fixtureEntry();
		const rendered = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: ACCEPTED }],
		]);
		const model = buildMap(inputsWith(entry, rendered));

		expect(model.hasSnapshot).toBe(false);
		expect(model.rows[0]?.disagreements).toEqual([]);
		expect(model.counts.disagreements).toBe(0);
		expect(renderMapHtml(model)).toContain(NO_SNAPSHOT);
	});
});

describe("buildMap disagreements", () => {
	test("rendered image != accepted image fires only on a mismatch", async () => {
		const entry = await fixtureEntry();
		const match = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: ACCEPTED }],
		]);
		const drift = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: "other:v1" }],
		]);
		const running = new Map([
			["linkedin-automation-uat", healthy("linkedin-automation-uat", ACCEPTED)],
			["linkedin-automation-prod", healthy("linkedin-automation-prod", ACCEPTED)],
		]);

		expect(buildMap(inputsWith(entry, match, running)).rows[0]?.disagreements).toEqual([]);
		expect(buildMap(inputsWith(entry, drift, running)).rows[0]?.disagreements).toContain(
			"rendered image != accepted image",
		);
	});

	test("running image != rendered image fires only when the two differ", async () => {
		const entry = await fixtureEntry();
		const rendered = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: ACCEPTED }],
		]);
		const same = new Map([
			["linkedin-automation-uat", healthy("linkedin-automation-uat", ACCEPTED)],
			["linkedin-automation-prod", healthy("linkedin-automation-prod", ACCEPTED)],
		]);
		const stale = new Map([
			["linkedin-automation-uat", healthy("linkedin-automation-uat", "other:v1")],
			["linkedin-automation-prod", healthy("linkedin-automation-prod", ACCEPTED)],
		]);

		expect(buildMap(inputsWith(entry, rendered, same)).rows[0]?.disagreements).toEqual([]);
		expect(buildMap(inputsWith(entry, rendered, stale)).rows[0]?.disagreements).toEqual([
			"running image != rendered image",
		]);
	});

	test("rendered but not running needs a snapshot to be a claim", async () => {
		const entry = await fixtureEntry();
		const rendered = new Map([
			["linkedin-automation-uat", { application: true, manifests: true, image: ACCEPTED }],
		]);

		expect(buildMap(inputsWith(entry, rendered, new Map())).rows[0]?.disagreements).toEqual([
			"rendered but not running",
		]);
		expect(buildMap(inputsWith(entry, rendered)).rows[0]?.disagreements).toEqual([]);
	});

	test("running but not in registry lists a dropped target, and counts it", async () => {
		const entry = await fixtureEntry();
		const running = new Map([
			["linkedin-automation-uat", healthy("linkedin-automation-uat", ACCEPTED)],
			["linkedin-automation-prod", healthy("linkedin-automation-prod", ACCEPTED)],
			["linkedin-automation-ghost", healthy("linkedin-automation-ghost", "other:v1")],
			["someone-elses-app", healthy("someone-elses-app", "other:v1")],
		]);
		const model = buildMap(inputsWith(entry, new Map(), running));

		expect(model.unregistered).toHaveLength(1);
		expect(model.unregistered[0]?.app.name).toBe("linkedin-automation-ghost");
		expect(model.unregistered[0]?.matchedApp).toBe("linkedin-automation");
		expect(model.unregistered[0]?.target).toBe("ghost");
		expect(model.counts.disagreements).toBe(1);
		expect(renderMapHtml(model)).toContain("running but not in registry");
	});
});

describe("parseArgoSnapshot", () => {
	test("reduces the kubectl payload to name, sync, health, revision, images", async () => {
		const running = parseArgoSnapshot(await Bun.file(ARGO_PATH).text());

		expect([...running.keys()].sort()).toEqual([
			"linkedin-automation-ghost",
			"linkedin-automation-uat",
		]);
		const uat = running.get("linkedin-automation-uat");
		expect(uat?.sync).toBe("Synced");
		expect(uat?.health).toBe("Healthy");
		expect(uat?.revision).toBe("578c4667");
		expect(uat?.images).toEqual([ACCEPTED]);
	});
});

describe("renderMapHtml", () => {
	test("escapes every value: a notes field carrying markup renders inert", async () => {
		const base = await fixtureEntry();
		const entry: RegistryEntry = { ...base, name: "evil<script>alert(1)</script>" };
		const html = renderMapHtml(buildMap(inputsWith(entry, new Map())));

		expect(html).not.toContain("<script>");
		expect(html).toContain("evil&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	test("carries the title, the counts, the shas and no JavaScript", async () => {
		const entry = await fixtureEntry();
		const model = buildMap({
			...inputsWith(entry, new Map()),
			registrySha: "abc12345",
			k3sDeploySha: "def67890",
		});
		const html = renderMapHtml(model);

		expect(html).toContain("<title>Hosted apps</title>");
		expect(html).toContain("2026-09-07T00:00:00.000Z");
		expect(html).toContain("abc12345");
		expect(html).toContain("def67890");
		expect(html).not.toContain("<script");
	});

	test("an empty registry still renders the counts and says so", () => {
		const html = renderMapHtml(
			buildMap({ registry: [], rendered: new Map(), generatedAt: "2026-09-07T00:00:00.000Z" }),
		);

		expect(html).toContain("The registry declares no applications.");
		expect(html).toContain("apps");
	});
});

describe("hosted-app map CLI", () => {
	test("reads both checkouts and the snapshot, and writes the page (exit 0)", async () => {
		const registryDir = writeRegistryDir(
			"linkedin-automation.yaml",
			await Bun.file(ENTRY_PATH).text(),
		);
		const deployDir = writeDeployDir("linkedin-automation-uat", ACCEPTED);
		const out = join(makeTempDir("map-out"), "map.html");
		const argo = join(makeTempDir("map-argo"), "applications.json");
		cpSync(ARGO_PATH, argo);

		const code = await runHostedApp([
			"map",
			"--registry-dir",
			registryDir,
			"--k3s-deploy-dir",
			deployDir,
			"--argo",
			argo,
			"--out",
			out,
		]);
		const html = await Bun.file(out).text();

		expect(code).toBe(0);
		expect(html).toContain("<title>Hosted apps</title>");
		expect(html).toContain("linkedin-automation");
		// prod is rendered nowhere and running nowhere, uat agrees everywhere.
		expect(html).toContain("not rendered");
	});

	test("collectMapInputs reads the rendered image from deployment.yaml", async () => {
		const registryDir = writeRegistryDir(
			"linkedin-automation.yaml",
			await Bun.file(ENTRY_PATH).text(),
		);
		const deployDir = writeDeployDir("linkedin-automation-uat", ACCEPTED);

		const inputs = await collectMapInputs({ registryDir, k3sDeployDir: deployDir });

		expect(inputs.rendered.get("linkedin-automation-uat")).toEqual({
			application: true,
			manifests: true,
			image: ACCEPTED,
		});
		expect(inputs.running).toBeUndefined();
	});

	test("an unreadable registry directory is a harness error (exit 3)", async () => {
		const out = join(makeTempDir("map-out"), "map.html");
		const code = await runHostedApp([
			"map",
			"--registry-dir",
			join(testTmpBase(), "map-does-not-exist-9f3c"),
			"--k3s-deploy-dir",
			writeDeployDir(),
			"--out",
			out,
		]);

		expect(code).toBe(3);
	});

	test("an unparsable argo snapshot is a harness error (exit 3)", async () => {
		const registryDir = writeRegistryDir(
			"linkedin-automation.yaml",
			await Bun.file(ENTRY_PATH).text(),
		);
		const argo = join(makeTempDir("map-argo"), "applications.json");
		writeFileSync(argo, "{ not json");

		const code = await runHostedApp([
			"map",
			"--registry-dir",
			registryDir,
			"--k3s-deploy-dir",
			writeDeployDir(),
			"--argo",
			argo,
			"--out",
			join(makeTempDir("map-out"), "map.html"),
		]);

		expect(code).toBe(3);
	});
});

describe("harness errors are not empty inputs", () => {
	test("a missing k3s-deploy checkout is a harness error (exit 3), not zero renders", async () => {
		const registryDir = writeRegistryDir(
			"linkedin-automation.yaml",
			await Bun.file(ENTRY_PATH).text(),
		);
		const code = await runHostedApp([
			"map",
			"--registry-dir",
			registryDir,
			"--k3s-deploy-dir",
			join(testTmpBase(), "map-deploy-does-not-exist-2b71"),
			"--out",
			join(makeTempDir("map-out"), "map.html"),
		]);

		expect(code).toBe(3);
	});

	test("a snapshot that is valid JSON but not a kubectl List is rejected", () => {
		expect(() => parseArgoSnapshot("{}")).toThrow(/items/);
		expect(() => parseArgoSnapshot("[]")).toThrow(/items/);
		expect(() => parseArgoSnapshot('{"items":{}}')).toThrow(/items/);
	});

	test("an invalid row spans exactly the remaining columns of the 13-column table", () => {
		const html = renderMapHtml(
			buildMap({
				registry: [{ file: "bad.yaml", ok: false, problem: "name: missing" }],
				rendered: new Map(),
				generatedAt: "2026-09-07T00:00:00.000Z",
			}),
		);
		expect(html).toContain('colspan="11"');
		expect(html).not.toContain('colspan="10"');
	});
});
