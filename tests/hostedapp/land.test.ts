/**
 * @module tests/hostedapp/land
 * @description Behavioural tests for `hosted-app land`, the registry-to-deploy
 *   step. Every test is offline: the injected `FetchText` serves a map keyed by
 *   the exact URL the command must build, so a change to that URL fails a test
 *   rather than reaching Forge. Fixtures are written under `testTmpBase()` —
 *   the sandbox checkout the receipt runs from is read-only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchText } from "../../src/hostedapp/fetch";
import { LandHarnessError, landRegistry, SUMMARY_FILE, sha256 } from "../../src/hostedapp/land";
import { parseLandArgs, runHostedAppLand } from "../../src/hostedapp/land-cli";
import { testTmpBase } from "../support/test-temp";

const FIXTURES = join(import.meta.dir, "fixtures");
const API = "https://forge.test/api/v1";
const REF = "3f9c2a1e7b0d4c5f8a9b1c2d3e4f5a6b7c8d9e0f";
const DECL_URL = `${API}/repos/rodaddy/linkedin-automation/raw/hosted-app.yaml?ref=${REF}`;
const CONFIG_URL = `${API}/repos/rodaddy/linkedin-automation/raw/deploy/config.yaml?ref=${REF}`;

const declText = readFileSync(join(FIXTURES, "declaration.yaml"), "utf8");
const configText = readFileSync(join(FIXTURES, "deploy", "config.yaml"), "utf8");
const entryText = readFileSync(join(FIXTURES, "registry-entry.yaml"), "utf8");

/** The registry fixture pins a placeholder sha; bind it to the real bytes. */
function entryWithRealSha(overrides = ""): string {
	const bound = entryText.replace(
		/declaration_sha256: [0-9a-f]{64}/,
		`declaration_sha256: ${sha256(declText)}`,
	);
	return `${bound}${overrides}`;
}

/** A fetch seam serving a fixed URL map; anything else is a 404. */
function mapFetch(map: Record<string, string>, seen: string[] = []): FetchText {
	return async (url: string) => {
		seen.push(url);
		const text = map[url];
		return text === undefined ? { ok: false, status: 404, error: "HTTP 404" } : { ok: true, text };
	};
}

const HAPPY = { [DECL_URL]: declText, [CONFIG_URL]: configText };

let root: string;
let registryDir: string;
let deployDir: string;

beforeEach(() => {
	// Under `_scratch/` rather than the temp root itself: the root is shared
	// with every other suite, and one of them (proposal-e2e) names its own
	// directory from `performance.now()`, so keeping fixture churn out of it
	// costs nothing and avoids adding traffic to a busy path.
	const scratch = join(testTmpBase(), "_scratch");
	mkdirSync(scratch, { recursive: true });
	root = mkdtempSync(join(scratch, "land-test-"));
	registryDir = join(root, "registry");
	deployDir = join(root, "deploy");
	mkdirSync(join(registryDir, "apps"), { recursive: true });
	mkdirSync(deployDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write one registry entry file into the fixture registry checkout. */
function writeEntry(name: string, text: string): void {
	writeFileSync(join(registryDir, "apps", `${name}.yaml`), text);
}

/** Standard options for the offline loop, with the happy-path fetch map. */
function options(fetchText: FetchText, app?: string) {
	return {
		registryDir,
		deployDir,
		forgeApi: API,
		token: "t0ken",
		fetchText,
		...(app === undefined ? {} : { app }),
	};
}

describe("landRegistry", () => {
	test("renders every target new, then reports update on a second run", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		const first = await landRegistry(options(mapFetch(HAPPY)));
		expect(first.rendered).toBe(1);
		expect(first.apps[0]?.targets.map((t) => `${t.name}:${t.kind}`)).toEqual([
			"uat:new",
			"prod:new",
		]);
		expect(existsSync(join(deployDir, "apps", "linkedin-automation-uat.yaml"))).toBe(true);
		expect(
			existsSync(join(deployDir, "manifests/apps/linkedin-automation-prod/deployment.yaml")),
		).toBe(true);

		const second = await landRegistry(options(mapFetch(HAPPY)));
		expect(second.apps[0]?.targets.map((t) => t.kind)).toEqual(["update", "update"]);
	});

	test("builds the declaration URL byte-for-byte", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		const seen: string[] = [];
		await landRegistry(options(mapFetch(HAPPY, seen)));
		expect(seen[0]).toBe(
			"https://forge.test/api/v1/repos/rodaddy/linkedin-automation/raw/hosted-app.yaml" +
				"?ref=3f9c2a1e7b0d4c5f8a9b1c2d3e4f5a6b7c8d9e0f",
		);
	});

	test("a drifted declaration fails with the drift line and writes nothing", async () => {
		writeEntry("linkedin-automation", entryText);
		const summary = await landRegistry(options(mapFetch(HAPPY)));
		expect(summary.failed).toBe(1);
		expect(summary.apps[0]?.problems[0]).toBe(
			`declaration drift: accepted 9c1faaaa fetched ${sha256(declText).slice(0, 8)}`,
		);
		expect(existsSync(join(deployDir, "apps"))).toBe(false);
	});

	test("a 404 fails that app and the loop continues to the next", async () => {
		// A different repo, so the URL the loop builds is one the map does NOT serve.
		writeEntry(
			"a-missing",
			entryWithRealSha()
				.replace("name: linkedin-automation", "name: gone")
				.replace("repo: rodaddy/linkedin-automation", "repo: rodaddy/gone"),
		);
		writeEntry("z-good", entryWithRealSha());
		const summary = await landRegistry(options(mapFetch(HAPPY)));
		expect(summary.failed).toBe(1);
		expect(summary.rendered).toBe(1);
		expect(summary.apps[1]?.verdict).toBe("pass");
	});

	test("a retired entry is skipped and never fetched", async () => {
		writeEntry(
			"linkedin-automation",
			entryWithRealSha().replace("state: active", "state: retired"),
		);
		const seen: string[] = [];
		const summary = await landRegistry(options(mapFetch(HAPPY, seen)));
		expect(summary.skipped).toBe(1);
		expect(seen).toEqual([]);
	});

	test("a missing token with a non-empty registry is a harness error", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		const opts = { ...options(mapFetch(HAPPY)), token: "" };
		expect(landRegistry(opts)).rejects.toBeInstanceOf(LandHarnessError);
	});

	test("a transport failure is a harness error, not a per-app failure", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		const dead: FetchText = async () => ({ ok: false, status: 0, error: "ECONNREFUSED" });
		expect(landRegistry(options(dead))).rejects.toBeInstanceOf(LandHarnessError);
	});

	test("--app filters the registry to one entry", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		writeEntry("other", entryWithRealSha());
		const summary = await landRegistry(options(mapFetch(HAPPY), "other"));
		expect(summary.apps).toHaveLength(1);
	});

	test("an unreadable registry directory is a harness error", async () => {
		const opts = { ...options(mapFetch(HAPPY)), registryDir: join(root, "nope") };
		expect(landRegistry(opts)).rejects.toBeInstanceOf(LandHarnessError);
	});
});

describe("runHostedAppLand", () => {
	test("writes the summary file and exits 0 when everything lands", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		process.env.FORGE_TOKEN = "t0ken";
		const code = await runHostedAppLand(
			["--registry-dir", registryDir, "--k3s-deploy-dir", deployDir, "--forge-api", API],
			mapFetch(HAPPY),
		);
		expect(code).toBe(0);
		const summary = JSON.parse(readFileSync(join(deployDir, SUMMARY_FILE), "utf8"));
		expect(summary.apps).toEqual([
			{
				name: "linkedin-automation",
				repo: "rodaddy/linkedin-automation",
				ref: REF,
				targets: [
					{ name: "uat", kind: "new", dir: "manifests/apps/linkedin-automation-uat" },
					{ name: "prod", kind: "new", dir: "manifests/apps/linkedin-automation-prod" },
				],
				verdict: "pass",
				problems: [],
			},
		]);
	});

	test("exits 1 when an app fails, and 3 on bad usage", async () => {
		writeEntry("linkedin-automation", entryText);
		process.env.FORGE_TOKEN = "t0ken";
		const failCode = await runHostedAppLand(
			["--registry-dir", registryDir, "--k3s-deploy-dir", deployDir, "--forge-api", API],
			mapFetch(HAPPY),
		);
		expect(failCode).toBe(1);
		expect(await runHostedAppLand(["--registry-dir", registryDir], mapFetch(HAPPY))).toBe(3);
	});
});

describe("landRegistry writes nothing for an app that does not fully land", () => {
	test("a config 404 on the second target leaves no manifest from the first", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		let configServes = 0;
		const fetchText: FetchText = async (url: string) => {
			if (url === CONFIG_URL) {
				configServes++;
				if (configServes > 1) return { ok: false, status: 404, error: "HTTP 404" };
			}
			const text = (HAPPY as Record<string, string>)[url];
			return text === undefined
				? { ok: false, status: 404, error: "HTTP 404" }
				: { ok: true, text };
		};
		const summary = await landRegistry(options(fetchText));
		expect(summary.failed).toBe(1);
		expect(existsSync(join(deployDir, "manifests"))).toBe(false);
		expect(existsSync(join(deployDir, "apps"))).toBe(false);
	});

	test("--app naming an entry the registry does not hold is a harness error", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		await expect(landRegistry(options(mapFetch(HAPPY), "not-there"))).rejects.toBeInstanceOf(
			LandHarnessError,
		);
	});

	test("an unwritable deploy checkout is a harness error, not an uncaught throw", async () => {
		writeEntry("linkedin-automation", entryWithRealSha());
		const notADir = join(root, "deploy-is-a-file");
		writeFileSync(notADir, "x");
		await expect(
			landRegistry({ ...options(mapFetch(HAPPY)), deployDir: notADir }),
		).rejects.toBeInstanceOf(LandHarnessError);
	});
});

describe("parseLandArgs rejects what it does not know", () => {
	test("an unknown option is a usage error, never a silent default", () => {
		const parsed = parseLandArgs([
			"--registry-dir",
			"r",
			"--k3s-deploy-dir",
			"d",
			"--forge-apo",
			"x",
		]);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("--forge-apo");
	});

	test("a repeated option is a usage error", () => {
		const parsed = parseLandArgs([
			"--registry-dir",
			"r",
			"--registry-dir",
			"r2",
			"--k3s-deploy-dir",
			"d",
		]);
		expect(parsed.ok).toBe(false);
	});
});
