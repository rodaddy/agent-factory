/**
 * @module tests/fleet/skill-post-templates
 * @description The post-body templates in `fleet/skills/*\/SKILL.md` (SOF-1726,
 *   SOF-8108), run as written. Every fenced block that composes a body in a
 *   quoted heredoc and hands it to `forge-post` is extracted, its placeholders
 *   filled, and executed by bash against a fake Forge with a stub
 *   `paperclipai`. A template that does not parse, posts the wrong text, or
 *   would post an identity-only comment when `$body` is lost fails here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const ROOT = resolve(import.meta.dir, "../..");
const SKILLS = join(ROOT, "fleet/skills");
const SCRIPT = process.env.FORGE_POST_UNDER_TEST ?? resolve(ROOT, "fleet/bin/forge-post");

/** Skills whose Forge post goes through a heredoc template. */
const EXPECTED = [
	"apple-build-review",
	"ci-red-check",
	"company-conduct",
	"follow-release",
	// review-pr posts with post-verdict, whose suite runs its block.
	"merge-pr",
	"release-propose",
	// open-pr opens its PR with fleet/forge/forge, not forge-post.
	"repo-steward",
	"triage-issue",
];

/** Placeholders a template may use outside its heredoc, and what fills them. */
const FILL: Record<string, string> = {
	"<Run ID>": "run-9",
	"<owner/repo>": "o/r",
	"<n>": "7",
	"<index>": "7",
	"<branch>": "fix/7-x",
	"<head>": "fix/7-x",
	"<default>": "main",
	"<base>": "main",
	"<title>": "t",
	"<issue-id>": "SOF-1",
	"<board issue id>": "SOF-1",
	"<your board issue id>": "SOF-1",
};

interface Seen {
	method: string;
	path: string;
	body: Record<string, string>;
}

interface Template {
	skill: string;
	script: string;
	firstLine: string;
	posts: number;
	boardComments: number;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let api = "";
const work = mkdtempSync(join(testTmpBase(), "skill-post-templates-"));
const bin = join(work, "bin");
const boardOut = join(work, "board.txt");

function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7150-7179, clear of forge-post.test.ts's 7120-7149. */
async function freePort(): Promise<number> {
	for (let port = 7150; port <= 7179; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7150-7179");
}

/**
 * Every fenced block in a skill that assigns `body` from a quoted heredoc and
 * calls forge-post, dedented by its fence's indent (what Markdown renders and
 * what a reader copies), with placeholders outside the heredoc filled.
 */
function templates(skill: string): Template[] {
	const lines = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8").split("\n");
	const out: Template[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^( *)```/.exec(lines[i] ?? "");
		if (!open) continue;
		const indent = open[1]?.length ?? 0;
		const block: string[] = [];
		let j = i + 1;
		for (; j < lines.length && !/^ *```/.test(lines[j] ?? ""); j++) {
			block.push(
				(lines[j] ?? "").slice(Math.min(indent, /^ */.exec(lines[j] ?? "")?.[0].length ?? 0)),
			);
		}
		i = j;
		const text = block.join("\n");
		const heredoc = /^body=\$\(cat <<'([A-Z]+)'$/m.exec(text);
		if (!heredoc || !text.includes("forge-post")) continue;
		const delimiter = heredoc[1] ?? "";
		const start = block.findIndex((line) => line.startsWith("body=$(cat <<'"));
		const end = block.indexOf(delimiter, start + 1);
		const filled = block.map((line, k) => {
			if (k > start && k < end) return line;
			let result = line;
			for (const [key, value] of Object.entries(FILL)) result = result.split(key).join(value);
			return result;
		});
		out.push({
			skill,
			script: filled.join("\n"),
			firstLine: block[start + 1] ?? "",
			posts: (text.match(/forge-post /g) ?? []).length,
			boardComments: (text.match(/paperclipai issue comment /g) ?? []).length,
		});
	}
	return out;
}

function allSkills(): string[] {
	return readdirSync(SKILLS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

async function bash(script: string) {
	const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", "-c", script], {
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			FORGEJO_API_URL: api,
			FORGEJO_TOKEN: "t-1",
			FLEET_EMPLOYEE: "bishop",
			FLEET_HARNESS: "pi",
			FLEET_MODEL: "m-1",
			PAPERCLIP_RUN_ID: "run-9",
			BOARD_OUT: boardOut,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

beforeAll(async () => {
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		async fetch(request) {
			seen.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: JSON.parse(await request.text()),
			});
			return Response.json({ html_url: "http://fake/x" }, { status: 201 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
	Bun.spawnSync(["mkdir", "-p", bin]);
	symlinkSync(SCRIPT, join(bin, "forge-post"));
	// Stub board CLI: records each --body value, one per call.
	writeFileSync(
		join(bin, "paperclipai"),
		'#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do\n\tif [ "$1" = --body ]; then printf \'%s\\0\' "$2" >>"$BOARD_OUT"; fi\n\tshift\ndone\n',
	);
	chmodSync(join(bin, "paperclipai"), 0o755);
});

afterAll(() => {
	server.stop(true);
	rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	rmSync(boardOut, { force: true });
});

describe("skill post templates", () => {
	test("no skill tells anyone to post a body from a file or with a trailing newline", () => {
		const offenders: string[] = [];
		for (const skill of allSkills()) {
			const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
			text.split("\n").forEach((line, k) => {
				if (/forge-post [a-z-]+ .*<(body-)?file>/.test(line))
					offenders.push(`${skill}:${k + 1}: ${line.trim()}`);
				if (line.includes(`printf '%s\\n' "$body"`))
					offenders.push(`${skill}:${k + 1}: ${line.trim()}`);
				if (/\bWrite the (body|verdict|receipt|pull request body) to a file\b/.test(line))
					offenders.push(`${skill}:${k + 1}: ${line.trim()}`);
			});
		}
		expect(offenders).toEqual([]);
	});

	test("every expected skill carries at least one executable post template", () => {
		const found = allSkills().filter((skill) => templates(skill).length > 0);
		for (const skill of EXPECTED) expect(found).toContain(skill);
	});

	for (const skill of EXPECTED) {
		test(`${skill}: each template runs as one block and posts the heredoc text unchanged`, async () => {
			const list = templates(skill);
			expect(list.length).toBeGreaterThan(0);
			for (const template of list) {
				seen.length = 0;
				rmSync(boardOut, { force: true });
				const result = await bash(template.script);
				expect({ skill, code: result.code, stderr: result.stderr }).toEqual({
					skill,
					code: 0,
					stderr: "",
				});
				expect(seen).toHaveLength(template.posts);
				for (const request of seen) {
					expect(request.body.body).toContain(template.firstLine);
					expect(request.body.body).toContain("run run-9");
				}
				if (template.boardComments > 0) {
					const bodies = readFileSync(boardOut, "utf8").split("\0").filter(Boolean);
					expect(bodies).toHaveLength(template.boardComments);
					for (const body of bodies) {
						expect(body.split("\n")[0]).toBe(template.firstLine);
						for (const request of seen) expect(request.body.body).toContain(body);
					}
				}
			}
		});
	}

	describe("release-propose reads every page and never reuses a build tag (PR 1704 review)", () => {
		const text = readFileSync(join(SKILLS, "release-propose", "SKILL.md"), "utf8");
		const reads = text.match(/forge api GET "[^"]*"/g) ?? [];

		test("enrollment comes from kustomization and shipped PRs are decided by ancestry", () => {
			expect(text).toContain("For each dir, read its `kustomization.yaml`");
			expect(text).toContain("there is no deployment header fallback");
			expect(text).toContain("/compare/<tag>...<merge_commit_sha>");
			expect(text).toContain("a successful compare with `total_commits` equal to 0");
			expect(text).toContain("Keep only candidates with\n   `total_commits` greater than 0");
			expect(text).toContain("skip proposal updates for this app");
		});

		test("proposal closure uses the reason supplied by the calling step", () => {
			expect(text).toContain("step 5 supplies `Duplicate of <link to the kept issue>.`");
			expect(text).toContain("step 6 supplies\n   `Released as <newest tag>.`");
			expect(text).toContain("printf '%s' \"<closing comment>\"");
		});

		test("follow-release requires this app's rollout failure and hands post-check failures to Nagatha", () => {
			const follow = readFileSync(join(SKILLS, "follow-release", "SKILL.md"), "utf8");
			expect(follow).toContain("revert only when this app failed to become Synced+Healthy");
			expect(follow).toContain("(`argo:` exit 1)");
			expect(follow).toContain("never proves a rollout failure");
			expect(follow).toContain("hand it to Nagatha");
			expect(follow).toContain("stop without opening a revert");
		});

		test("the proposed version is above the highest existing build tag, and the owner checks it is unused", () => {
			expect(text).toContain("version is the highest existing build tag version from step 3");
			expect(text).toContain("patch raised by one (the running version may be older;");
			expect(text).toContain("git ls-remote --tags origin refs/tags/<app>-v<X.Y.Z>");
			const tags = reads.find((read) => read.includes("/tags?"));
			expect(tags).toContain("page=<p>");
		});

		test("closed pull requests are read on every page before filtering", () => {
			const pulls = reads.find((read) => read.includes("/pulls?state=closed"));
			expect(pulls).toContain("page=<p>");
			expect(text).toContain("read them all before you filter");
			expect(text).toContain("Keep candidates with `merged_at` set and `base.ref`");
		});

		test("open issues are read on every page before create or dedupe", () => {
			const issues = reads.find((read) => read.includes("/issues?state=open"));
			expect(issues).toContain("page=<p>");
			expect(text).toContain("Two or more: keep the oldest, close the rest with");
		});
	});
	// PR 1944 round 4: bash-guard keeps the heredoc exemption for every publish
	// compatible template, so a review that quotes a dangerous command can still be posted.
	// Current main adds release-propose with a literal quoted title and parentheses;
	// that shape intentionally keeps its body checked under the fail-closed rules.
	const GUARD = resolve(ROOT, "fleet/hooks/bash-guard");
	for (const skill of EXPECTED) {
		test(`${skill}: bash-guard checks each template with a body quoting rm -rf /`, () => {
			for (const template of templates(skill)) {
				const command = template.script.replace(
					/^(body=\$\(cat <<'([A-Z]+)'\n)[\s\S]*?\n\2$/m,
					"$1rm -rf /\n$2",
				);
				expect(command).toContain("\nrm -rf /\n");
				const r = Bun.spawnSync(["python3", GUARD], {
					stdin: Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command } })),
					env: { PATH: process.env.PATH ?? "", FLEET_EMPLOYEE: "czajka", HOME: "/home/operator" },
				});
				if (skill === "release-propose") {
					expect(r.exitCode).toBe(2);
					expect(r.stderr.toString()).toContain("bash-guard: refused (rm-recursive):");
					continue;
				}
				expect({ skill, code: r.exitCode, stderr: r.stderr.toString() }).toEqual({
					skill,
					code: 0,
					stderr: "",
				});
			}
		});
	}

	test("a lost $body reaches forge-post as zero bytes and is refused; nothing is sent", async () => {
		const result = await bash(`printf '%s' "$body" | forge-post comment o/r 7 -`);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("forge-post: body is empty");
		expect(seen).toHaveLength(0);
	});

	test("the old printf '%s\\n' form posts an identity-only comment when $body is lost", async () => {
		// Pins why the templates use '%s': this is the SOF-1738 round-2 P2.
		const result = await bash(`printf '%s\\n' "$body" | forge-post comment o/r 7 -`);
		expect(result.code).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.body.body?.trim().startsWith("**agent:**")).toBe(true);
	});
});

describe("flat dispatch closes parents without another wake", () => {
	const text = readFileSync(join(SKILLS, "review-dispatch", "SKILL.md"), "utf8");
	test("class A and fix-first close with status and comment in one write, then end the turn", () => {
		const closes = [
			...text.matchAll(
				/`paperclipai issue update <parent id> --status done --run-id "\$PAPERCLIP_RUN_ID" --comment "[^"`]+"`/g,
			),
		];
		expect(closes).toHaveLength(2);
		expect(text).not.toContain("paperclipai issue comment <parent id>");
		expect(text).toContain("Then end your turn and post nothing.");
		expect(text).toMatch(
			/A parent that is `done` or `cancelled`[\s\S]*end your turn and post nothing/,
		);
	});
});
