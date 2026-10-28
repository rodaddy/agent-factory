#!/usr/bin/env node
// factoryignore-cli <owner/repo> <pr-number> <head-sha40>:
// merge-check's re-derivation of the non-code fast path. Reads the PR, its
// changed files, modes and first lines from Forge (FORGEJO_API_URL,
// FORGEJO_TOKEN in the header only) and runs the classifier unchanged at the
// PR's base sha. Prints one JSON line {nonCode, refused, base}; exit 0 on a
// decision either way, 3 on any read error or a head that is not <head-sha40>,
// 2 on bad arguments or env. Never prints the token or a response body.
import { nonCodeVerdict } from "./factoryignore.js";
import { pullFiles } from "./preflight.js";
import { getJson } from "./sweep.js";

const fail = (code, msg) => {
	process.stderr.write(`factoryignore-cli: ${msg}\n`);
	process.exit(code);
};

const [repo, number, headSha] = process.argv.slice(2);
if (
	process.argv.length !== 5 ||
	!/^[\w.-]+\/[\w.-]+$/.test(repo) ||
	!/^\d+$/.test(number) ||
	!/^[0-9a-f]{40}$/.test(headSha)
)
	fail(2, "usage: factoryignore-cli <owner/repo> <pr-number> <head-sha40>");
const baseUrl = (process.env.FORGEJO_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.FORGEJO_TOKEN ?? "";
if (!baseUrl || !token) fail(2, "FORGEJO_API_URL and FORGEJO_TOKEN are required");

const counter = { calls: 0 };
const get = (path) => getJson({ fetch, baseUrl, token }, counter, path);
try {
	const pr = await get(`/repos/${repo}/pulls/${number}`);
	if (pr?.head?.sha !== headSha) fail(3, `head is not ${headSha.slice(0, 7)}`);
	const base = pr?.base?.sha;
	if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) fail(3, "PR has no base sha");
	const files = await pullFiles(get, repo, number);
	if (
		files.truncated ||
		files.length >= 1000 ||
		!Number.isInteger(pr.changed_files) ||
		files.length !== pr.changed_files
	)
		fail(3, "file list not whole");
	const current = await get(`/repos/${repo}/pulls/${number}`);
	if (
		current?.head?.sha !== headSha ||
		current?.base?.sha !== base ||
		current?.changed_files !== pr.changed_files
	)
		fail(3, "PR changed while reading files");
	const v = await nonCodeVerdict(get, repo, { baseRef: base, headSha }, files);
	process.stdout.write(
		`${JSON.stringify({ nonCode: v.nonCode === true, refused: v.refused, base })}\n`,
	);
} catch (err) {
	fail(3, `read failed: ${typeof err?.reason === "string" ? err.reason : err?.name || "Error"}`);
}
