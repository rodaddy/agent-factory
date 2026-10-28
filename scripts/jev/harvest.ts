/**
 * @module scripts/jev/harvest
 * @description Harvest labelled review findings from a repo's "Fix round"
 *   tables on Forge into Jev example files. Read-only against Forge.
 *   Usage: `bun scripts/jev/harvest.ts fix-rounds --repo <owner/name> --out <dir> [--limit <n>]`.
 *   Env: `FORGEJO_API_URL`, `FORGEJO_TOKEN` (both required; the token is never logged).
 *   Exit 0 on success; 3 on bad arguments, missing env, or a failed read.
 *
 * @outputs
 *   - `<out>/finding-kind.tuning.json`: examples from PRs that are not held out
 *   - `<out>/finding-kind.heldout.json`: examples from held-out PRs
 *   - stdout: one JSON line of counts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Example, examplesFrom, isHeldOut, parseFixRounds } from "../../src/jev/harvest";

const USAGE =
	"usage: bun scripts/jev/harvest.ts fix-rounds --repo <owner/name> --out <dir> [--limit <n>]";
const PAGE = 50;
const DEFAULT_LIMIT = 300;

interface Args {
	repo: string;
	out: string;
	limit: number;
}

function parseArgs(argv: string[]): Args | null {
	const [command, ...rest] = argv;
	if (command !== "fix-rounds" || rest.length % 2 !== 0) return null;
	const flags = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i] ?? "";
		const value = rest[i + 1] ?? "";
		if (!["--repo", "--out", "--limit"].includes(flag) || value === "" || flags.has(flag)) {
			return null;
		}
		flags.set(flag, value);
	}
	const repo = flags.get("--repo");
	const out = flags.get("--out");
	const rawLimit = flags.get("--limit");
	if (repo === undefined || out === undefined) return null;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
	if (rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) return null;
	return { repo, out, limit: rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit) };
}

/** GET one Forge API path as a JSON array; any failure names the status and path. */
async function getArray(apiUrl: string, token: string, path: string): Promise<unknown[]> {
	let res: Response;
	try {
		res = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
			headers: { Authorization: `token ${token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		const why = err instanceof Error ? err.name : "error";
		throw new Error(`read failed (${why}) for ${path}`);
	}
	if (!res.ok) throw new Error(`read failed (HTTP ${res.status}) for ${path}`);
	const data: unknown = await res.json();
	if (!Array.isArray(data)) throw new Error(`read failed (not a JSON array) for ${path}`);
	return data;
}

function field(item: unknown, key: string): unknown {
	return typeof item === "object" && item !== null
		? (item as Record<string, unknown>)[key]
		: undefined;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args === null) {
		console.error(USAGE);
		return 3;
	}
	const apiUrl = process.env.FORGEJO_API_URL;
	const token = process.env.FORGEJO_TOKEN;
	if (apiUrl === undefined || apiUrl === "") {
		console.error("harvest: FORGEJO_API_URL is not set");
		return 3;
	}
	if (token === undefined || token === "") {
		console.error("harvest: FORGEJO_TOKEN is not set");
		return 3;
	}
	try {
		const tuning: Example[] = [];
		const heldout: Example[] = [];
		const counts = { prs: 0, comments: 0, rows: 0, harvested: 0, skipped: 0, held_out: 0 };
		for (let page = 1; counts.prs < args.limit; page++) {
			const pulls = await getArray(
				apiUrl,
				token,
				`/repos/${args.repo}/pulls?state=closed&sort=recentupdate&limit=${PAGE}&page=${page}`,
			);
			for (const pull of pulls.slice(0, args.limit - counts.prs)) {
				const number = field(pull, "number");
				const title = field(pull, "title");
				if (typeof number !== "number" || !Number.isInteger(number)) {
					throw new Error(`read failed (pull without a number) on page ${page}`);
				}
				counts.prs++;
				// ONE call. Forge's issue-comments endpoint ignores `page` and `limit` and
				// returns the whole list every time (probed 2026-10-01: page 1 and page 2
				// with limit=2 returned the same six ids). A paging loop here re-read the
				// same 50 forever once a PR had 50 comments (PR 1151 review, P1).
				const comments = await getArray(
					apiUrl,
					token,
					`/repos/${args.repo}/issues/${number}/comments`,
				);
				counts.comments += comments.length;
				for (const comment of comments) {
					const body = field(comment, "body");
					if (typeof body !== "string") continue;
					const rows = parseFixRounds(body);
					const { examples, skipped } = examplesFrom(typeof title === "string" ? title : "", rows);
					counts.rows += rows.length;
					counts.harvested += examples.length;
					counts.skipped += skipped;
					(isHeldOut(number) ? heldout : tuning).push(...examples);
				}
			}
			if (pulls.length < PAGE) break;
		}
		counts.held_out = heldout.length;
		await mkdir(args.out, { recursive: true });
		// Tab-indented, the repo's biome JSON style, so a committed file passes format:check.
		await writeFile(
			join(args.out, "finding-kind.tuning.json"),
			`${JSON.stringify(tuning, null, "\t")}\n`,
		);
		await writeFile(
			join(args.out, "finding-kind.heldout.json"),
			`${JSON.stringify(heldout, null, "\t")}\n`,
		);
		process.stdout.write(`${JSON.stringify(counts)}\n`);
		return 0;
	} catch (err) {
		console.error(`harvest: ${err instanceof Error ? err.message : String(err)}`);
		return 3;
	}
}

process.exitCode = await main(process.argv.slice(2));
