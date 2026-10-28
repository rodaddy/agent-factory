/**
 * Tests for the `enroll --derive` CLI (lane 831c). Offline: the fixture
 * k3s-deploy tree from 831a, a URL-map FetchText, and a fixed token getter.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEnrollCommand } from "../../src/enroll/cli";
import type { HookApi } from "../../src/enroll/webhooks";
import type { FetchText } from "../../src/hostedapp/fetch";
import { testTmpBase } from "../support/test-temp";

const API = "https://forge.test/api/v1";
const TREE = join(import.meta.dir, "fixtures", "k3s-deploy");
const TAGS = "tags?page=1&limit=50";

function tagsJson(names: string[]): string {
	return JSON.stringify(names.map((name, i) => ({ name, commit: { sha: `sha${i}` } })));
}

const MAP: Record<string, string> = {
	[`${API}/repos/acme/web-bb-landing`]: JSON.stringify({
		full_name: "acme/web-bb-landing",
	}),
	[`${API}/repos/acme/web-bb-landing/${TAGS}`]: tagsJson(["v0.18.5", "v0.17.3"]),
	[`${API}/repos/rodaddy/hook-probe`]: JSON.stringify({ full_name: "rodaddy/hook-probe" }),
	[`${API}/repos/rodaddy/hook-probe/${TAGS}`]: tagsJson(["v0.2.2"]),
};

const fakeFetch: FetchText = async (url) => {
	const text = MAP[url];
	return text === undefined ? { ok: false, status: 404, error: "HTTP 404" } : { ok: true, text };
};

async function runWith(args: string[]): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const code = await runEnrollCommand(args, {
		fetchText: fakeFetch,
		token: () => "t",
		api: API,
		out: (line) => lines.push(line),
	});
	return { code, lines };
}

function listTree(): string[] {
	return readdirSync(TREE, { recursive: true }).map(String).sort();
}

describe("enroll --derive", () => {
	test("prints one row per non-infra dir, the infra count, and enroll-app for off-rail found rows", async () => {
		const { code, lines } = await runWith(["--derive", "--dry-run", "--k3s-deploy-dir", TREE]);
		expect(code).toBe(0);
		expect(lines).toEqual([
			"plan: 2 app dirs; 1 infra dirs skipped",
			"bb-landing  image=10.0.20.58:3000/acme/web-bb-landing:v0.17.3  source=acme/web-bb-landing latest=v0.18.5  onRail=false",
			"  _ob/bin/enroll-app enroll web-bb-landing --app bb-landing",
			"rodaddy-hook-probe-uat  image=10.0.20.58:3000/rodaddy/hook-probe:v0.2.2@sha256:854ebaa55b6f1e29324bf594ecf3e27a662bf6dd333829ee8c31b8aa73c76a27  source=rodaddy/hook-probe latest=v0.2.2  onRail=true",
		]);
		expect(lines.join("\n")).not.toContain("bifrost");
	});

	test("a refused resolve prints the reason and no enroll-app command", async () => {
		const lines: string[] = [];
		const code = await runEnrollCommand(["--derive", "--dry-run", "--k3s-deploy-dir", TREE], {
			fetchText: async () => ({ ok: false, status: 404, error: "HTTP 404" }),
			token: () => "t",
			api: API,
			out: (line) => lines.push(line),
		});
		expect(code).toBe(0);
		expect(lines[1]).toContain("source=refused no-repo:");
		expect(lines.some((l) => l.includes("enroll-app"))).toBe(false);
	});

	test("--dry-run writes nothing to the tree", async () => {
		const before = listTree();
		await runWith(["--derive", "--dry-run", "--k3s-deploy-dir", TREE]);
		expect(listTree()).toEqual(before);
	});

	test("an unreadable tree exits 3", async () => {
		const { code, lines } = await runWith([
			"--derive",
			"--k3s-deploy-dir",
			join(TREE, "no-such-dir"),
		]);
		expect(code).toBe(3);
		expect(lines).toEqual([]);
	});

	test("without --derive is a usage error (2)", async () => {
		expect((await runWith(["--dry-run"])).code).toBe(2);
	});
});

const PROBE_IMAGE = "10.0.20.58:3000/rodaddy/hook-probe:v0.2.2";

/** A k3s-deploy tree under the portable test temp base, one hand-written dir per name. */
function treeWith(dirs: string[]): string {
	const root = mkdtempSync(join(testTmpBase(), "rw-enroll-cli-"));
	for (const dir of dirs) {
		const path = join(root, "manifests", "apps", dir);
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(path, "deployment.yaml"),
			`spec:\n  containers:\n    - image: ${PROBE_IMAGE}\n`,
		);
	}
	return root;
}

describe("enroll --derive hardening", () => {
	test("a hostile dir name never becomes an enroll-app command", async () => {
		const tree = treeWith(["evil$(touch pwned)"]);
		const { code, lines } = await runWith(["--derive", "--dry-run", "--k3s-deploy-dir", tree]);
		expect(code).toBe(0);
		expect(lines.some((l) => l.includes("enroll-app"))).toBe(false);
		expect(lines[1]).toContain("source=- (invalid-name)");
	});

	test("a uat/prod pair prints its enroll-app command once", async () => {
		const tree = treeWith(["probe-prod", "probe-uat"]);
		const { code, lines } = await runWith(["--derive", "--dry-run", "--k3s-deploy-dir", tree]);
		expect(code).toBe(0);
		expect(lines.filter((l) => l.includes("enroll-app"))).toEqual([
			"  _ob/bin/enroll-app enroll hook-probe --app probe",
		]);
	});

	test("a uat/prod pair resolving to different checkouts prints one enroll-app command for the app", async () => {
		const root = mkdtempSync(join(testTmpBase(), "rw-enroll-cli-"));
		const images: Record<string, string> = {
			"probe-prod": PROBE_IMAGE,
			"probe-uat": "10.0.20.58:3000/acme/web-bb-landing:v0.18.5",
		};
		for (const [dir, image] of Object.entries(images)) {
			const path = join(root, "manifests", "apps", dir);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "deployment.yaml"), `spec:\n  containers:\n    - image: ${image}\n`);
		}
		const errs: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			errs.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let result: { code: number; lines: string[] };
		try {
			result = await runWith(["--derive", "--dry-run", "--k3s-deploy-dir", root]);
		} finally {
			process.stderr.write = write;
		}
		expect(result.code).toBe(0);
		// derivePlan sorts dirs, so probe-prod wins; the dropped uat checkout is named on stderr.
		expect(result.lines.filter((l) => l.includes("enroll-app"))).toEqual([
			"  _ob/bin/enroll-app enroll hook-probe --app probe",
		]);
		expect(errs.join("")).toContain("probe-uat resolves to web-bb-landing, not hook-probe");
	});

	test("a missing token exits 3", async () => {
		const code = await runEnrollCommand(["--derive", "--dry-run", "--k3s-deploy-dir", TREE], {
			fetchText: fakeFetch,
			token: () => {
				throw new Error("no Forge token");
			},
			api: API,
			out: () => {},
		});
		expect(code).toBe(3);
	});

	test("a thrown Forge read exits 3", async () => {
		const code = await runEnrollCommand(["--derive", "--dry-run", "--k3s-deploy-dir", TREE], {
			fetchText: async () => {
				throw new Error("socket hang up");
			},
			token: () => "t",
			api: API,
			out: () => {},
		});
		expect(code).toBe(3);
	});
});

/** A HookApi with no hooks that records creates; `failOn` repos throw on list. */
function fakeHooks(created: string[][], failOn: string[] = []): HookApi {
	return {
		list: async (repo) => {
			if (failOn.includes(repo)) throw new Error("forge hook list failed: HTTP 500");
			return [];
		},
		create: async (repo, events, secret) => {
			created.push([repo, secret, ...events]);
			return created.length;
		},
		patch: async () => {},
	};
}

describe("enroll --derive apply (lane 831d)", () => {
	type Calls = string[][];
	function runner(codes: number[], calls: Calls): (argv: readonly string[]) => Promise<number> {
		return async (argv) => {
			calls.push([...argv]);
			return codes[calls.length - 1] ?? 0;
		};
	}

	async function apply(
		args: string[],
		run: (argv: readonly string[]) => Promise<number>,
		hooks: HookApi = fakeHooks([]),
	): Promise<{ code: number; lines: string[] }> {
		const lines: string[] = [];
		const code = await runEnrollCommand(args, {
			fetchText: fakeFetch,
			token: () => "t",
			api: API,
			out: (line) => lines.push(line),
			run,
			hooks,
			secret: () => "s3cret",
		});
		return { code, lines };
	}

	test("without --dry-run runs each enroll-app argv in plan order and prints enrolled per app", async () => {
		const tree = treeWith(["alpha-prod", "alpha-uat", "beta"]);
		const calls: Calls = [];
		const { code, lines } = await apply(
			["--derive", "--k3s-deploy-dir", tree],
			runner([0, 0], calls),
		);
		expect(code).toBe(0);
		expect(calls).toEqual([
			["enroll", "hook-probe", "--app", "alpha"],
			["enroll", "hook-probe", "--app", "beta"],
		]);
		expect(lines.filter((l) => l.startsWith("enrolled "))).toEqual([
			"enrolled alpha",
			"enrolled beta",
		]);
	});

	test("stops at the first non-zero exit, names the app, exits 1", async () => {
		const tree = treeWith(["alpha", "beta", "gamma"]);
		const calls: Calls = [];
		const { code, lines } = await apply(
			["--derive", "--k3s-deploy-dir", tree],
			runner([0, 4, 0], calls),
		);
		expect(code).toBe(1);
		expect(calls.map((c) => c[3])).toEqual(["alpha", "beta"]);
		expect(lines.join("\n")).toContain("enroll-app failed for beta (exit 4)");
		expect(lines.join("\n")).not.toContain("enrolled beta");
	});

	test("a runner that throws (enroll-app missing) exits 1 on stderr, naming the app, later apps not run", async () => {
		const tree = treeWith(["alpha", "beta", "gamma"]);
		const calls: Calls = [];
		const errs: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			errs.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let result: { code: number; lines: string[] };
		try {
			result = await apply(["--derive", "--k3s-deploy-dir", tree], async (argv) => {
				calls.push([...argv]);
				if (argv[3] === "beta") throw new Error("ENOENT: no such file or directory, posix_spawn");
				return 0;
			});
		} finally {
			process.stderr.write = write;
		}
		expect(result.code).toBe(1);
		expect(calls.map((c) => c[3])).toEqual(["alpha", "beta"]);
		expect(result.lines).toContain("enrolled alpha");
		expect(errs.join("")).toContain("enroll-app could not start for beta");
		expect(errs.join("")).toContain("later apps not run");
	});

	test("a checkout name with a leading dash never becomes an enroll-app command", async () => {
		const tree = treeWith(["probe"]);
		const seen: string[] = [];
		const code = await runEnrollCommand(["--derive", "--dry-run", "--k3s-deploy-dir", tree], {
			fetchText: async (url) =>
				url === `${API}/repos/rodaddy/hook-probe`
					? { ok: true, text: JSON.stringify({ full_name: "rodaddy/-x" }) }
					: url === `${API}/repos/rodaddy/-x/${TAGS}`
						? { ok: true, text: tagsJson(["v0.2.2"]) }
						: { ok: false, status: 404, error: "HTTP 404" },
			token: () => "t",
			api: API,
			out: (line) => seen.push(line),
		});
		expect(code).toBe(0);
		expect(seen.join("\n")).toContain("rodaddy/-x");
		expect(seen.some((l) => l.includes("enroll-app"))).toBe(false);
	});

	test("--dry-run never calls the runner", async () => {
		const tree = treeWith(["alpha", "beta"]);
		const calls: Calls = [];
		const { code } = await apply(
			["--derive", "--dry-run", "--k3s-deploy-dir", tree],
			runner([], calls),
		);
		expect(code).toBe(0);
		expect(calls).toEqual([]);
	});

	test("after each enroll-app, the resolved source repo gets its rail webhook, printed under enrolled", async () => {
		const tree = treeWith(["alpha", "beta"]);
		const created: string[][] = [];
		const { code, lines } = await apply(
			["--derive", "--k3s-deploy-dir", tree],
			runner([0, 0], [] as Calls),
			fakeHooks(created),
		);
		expect(code).toBe(0);
		expect(created[0]).toEqual([
			"rodaddy/hook-probe",
			"s3cret",
			"create",
			"pull_request",
			"pull_request_sync",
			"push",
		]);
		const i = lines.indexOf("enrolled alpha");
		expect(lines[i + 1]).toBe(
			"  rodaddy/hook-probe: created hook 1 events=create,pull_request,pull_request_sync,push",
		);
	});

	test("a hook failure exits 1 but every app is still enrolled", async () => {
		const tree = treeWith(["alpha", "beta"]);
		const calls: Calls = [];
		const { code, lines } = await apply(
			["--derive", "--k3s-deploy-dir", tree],
			runner([0, 0], calls),
			fakeHooks([], ["rodaddy/hook-probe"]),
		);
		expect(code).toBe(1);
		expect(calls.map((c) => c[3])).toEqual(["alpha", "beta"]);
		expect(lines.filter((l) => l.startsWith("enrolled "))).toEqual([
			"enrolled alpha",
			"enrolled beta",
		]);
		expect(lines).toContain("  rodaddy/hook-probe: failed: forge hook list failed: HTTP 500");
	});
});
