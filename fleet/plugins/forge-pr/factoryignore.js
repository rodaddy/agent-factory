// The review fast path: a PR whose every
// changed path is non-code gets a scripted verdict and a Merge task, with no
// review task and no seat run. Patterns are gitignore syntax via `ignore`.
import ignore from "ignore";

// With no .factoryignore on the base branch.
export const DEFAULT_FACTORYIGNORE = [
	"_reports/**",
	"README*",
	"*.png",
	"*.jpg",
	"*.svg",
	"_DOCS/**",
];
// Non-code only with one of these, so no pattern can exempt source code.
export const NON_CODE_EXTENSIONS = [".md", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf"];
// No pattern exempts these. A name with no slash matches at any depth;
// matching is case-insensitive, so `skill.md` is refused too.
export const REFUSED = [
	".factoryignore",
	"SKILL.md",
	"AGENTS.md",
	"CLAUDE.md",
	"*prompt*",
	"hooks/",
	".forgejo/",
	".github/",
	"*.json",
	"*.lock",
	"*.lockb",
	"pnpm-lock.yaml",
	"go.sum",
];
const refusedByName = ignore().add(REFUSED);

const patternLines = (text) =>
	String(text ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));

const matches = (ig, path) => {
	try {
		return ig.ignores(path);
	} catch {
		return null; // not a relative path ignore can judge
	}
};

const allowedExt = (path) => {
	const dot = path.lastIndexOf(".");
	return dot > path.lastIndexOf("/") && NON_CODE_EXTENSIONS.includes(path.slice(dot).toLowerCase());
};

// Why a file is refused, or null: its name, its mode, or its first line.
function refusal({ path, mode, firstLine }) {
	const named = matches(refusedByName, path);
	if (named !== false) return named === null ? "invalid path" : "refused name";
	if (typeof mode !== "string" || typeof firstLine !== "string") return "unreadable";
	if (mode === "100755") return "executable bit";
	if (mode !== "100644") return "not a regular file";
	if (firstLine.startsWith("#!")) return "shebang";
	return null;
}

// factoryignore: the BASE branch's .factoryignore text, or null for none.
// files: [{ path, mode, firstLine }]. { nonCode, refused: [{path, reason}],
// code: [path], patterns: the .factoryignore lines matching a refused path }.
export function classify({ factoryignore, files }) {
	const lines = factoryignore == null ? DEFAULT_FACTORYIGNORE : patternLines(factoryignore);
	const user = ignore().add(lines);
	const refused = [];
	const code = [];
	for (const f of Array.isArray(files) ? files : []) {
		const reason = refusal(f);
		if (reason) refused.push({ path: f.path, reason });
		else if (matches(user, f.path) !== true || !allowedExt(f.path)) code.push(f.path);
	}
	const patterns = lines.filter((l) =>
		refused.some((r) => matches(ignore().add(l), r.path) === true),
	);
	const nonCode = files.length > 0 && refused.length === 0 && code.length === 0;
	return { nonCode, refused, code, patterns };
}

const contents = (repo, path, ref) =>
	`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
const decoded = (item) =>
	typeof item?.content === "string" ? Buffer.from(item.content, "base64").toString("latin1") : null;

// { modes: path -> mode for every blob read at ref, complete: the tree ended
// within 30 pages }. A path missing from an incomplete tree is unknown, not
// absent, so it is refused as unreadable.
async function treeModes(get, repo, ref) {
	const modes = new Map();
	let complete = false;
	for (let page = 1; page <= 30 && !complete; page++) {
		const t = await get(
			`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=100&page=${page}`,
		);
		for (const e of Array.isArray(t?.tree) ? t.tree : []) modes.set(e?.path, e?.mode);
		complete = t?.truncated !== true;
	}
	return { modes, complete };
}

// The classifier's verdict for one PR from the Forge reads through get(path),
// which throws with .reason on a non-2xx. .factoryignore comes from baseRef,
// never the head; a 2xx that is not a file with string content throws. Modes
// and first lines are read only when every path already passes by name, at
// BOTH base and head wherever the path exists, so clearing an exec bit or
// dropping a shebang is still refused; a path on neither side is unreadable.
export async function nonCodeVerdict(get, repo, refs, files) {
	const text = await baseIgnore(get, repo, refs.baseRef);
	const paths = names(files).flat();
	const byName = classify({ factoryignore: text, files: paths.map(nameOnly) });
	if (!byName.nonCode) return byName;
	return classify({ factoryignore: text, files: await readFacts(get, repo, refs, paths) });
}

// The changed paths of a mixed PR that are non-code by classify's rules,
// sorted (code-only review, the owner 2026-10-07). A rename counts only if both
// names do, and is listed by its new name. Same reads as nonCodeVerdict, for
// the paths that pass by name only; a read error throws.
export async function docPaths(get, repo, refs, files) {
	const text = await baseIgnore(get, repo, refs.baseRef);
	const changed = names(files);
	const docsOf = (v) => (p) => !v.code.includes(p) && !v.refused.some((r) => r.path === p);
	const byName = docsOf(classify({ factoryignore: text, files: changed.flat().map(nameOnly) }));
	const candidates = changed.filter((n) => n.every(byName));
	if (candidates.length === 0) return [];
	const facts = await readFacts(get, repo, refs, candidates.flat());
	const isDoc = docsOf(classify({ factoryignore: text, files: facts }));
	return candidates
		.filter((n) => n.every(isDoc))
		.map((n) => n[n.length - 1])
		.sort();
}

const nameOnly = (path) => ({ path, mode: "100644", firstLine: "" });

// Per changed file, its names: [old, new] for a rename, else [new].
const names = (files) =>
	(Array.isArray(files) ? files : [])
		.map((f) => [f?.previous_filename, f?.filename].filter((p) => typeof p === "string"))
		.filter((n) => n.length > 0);

// The BASE branch's .factoryignore text, or null when it has none.
async function baseIgnore(get, repo, baseRef) {
	try {
		const item = await get(contents(repo, ".factoryignore", baseRef));
		if (item?.type !== "file" || typeof item?.content !== "string")
			throw new Error(".factoryignore at base is not a readable file");
		return decoded(item);
	} catch (err) {
		if (err?.reason !== "404") throw err;
		return null;
	}
}

// { path, mode, firstLine } per path and per side (head, base) it exists on;
// { path } alone for a path on neither side (unreadable).
async function readFacts(get, repo, { baseRef, headSha }, paths) {
	const sides = [
		[headSha, await treeModes(get, repo, headSha)],
		[baseRef, await treeModes(get, repo, baseRef)],
	];
	const facts = [];
	for (const path of paths) {
		let found = false;
		for (const [ref, { modes, complete }] of sides) {
			if (!modes.has(path) && complete) continue; // added or deleted on this side
			found = true;
			if (!modes.has(path)) {
				facts.push({ path }); // missing from a cut-short tree: unreadable
				continue;
			}
			const body = decoded(await get(contents(repo, path, ref)));
			facts.push({ path, mode: modes.get(path), firstLine: body?.split("\n")[0] });
		}
		if (!found) facts.push({ path }); // on neither side: unreadable
	}
	return facts;
}

export const SCRIPTED_VERDICT = "verdict: approve (scripted: non-code)";

// The Forge verdict comment for an all-non-code head.
export function scriptedComment(ev, paths) {
	return [
		SCRIPTED_VERDICT,
		"",
		`Every changed path at ${ev.headSha.slice(0, 7)} is non-code by the base branch's \`.factoryignore\` (or the built-in default), so no reviewer ran (sf#1730 US-002). A Merge task is filed.`,
		"",
		...paths.map((p) => `- \`${p}\``),
	].join("\n");
}

// The Merge task, in the merge sweep's shape, for Chang.
export function scriptedMergeTask(ev, assigneeAgentId) {
	return {
		title: `Merge ${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`,
		description: [
			`PR: [${ev.repo}#${ev.number}](${ev.url})`,
			`Head SHA: \`${ev.headSha}\``,
			`Verdict: \`${SCRIPTED_VERDICT}\` on the Forge PR; no review task (sf#1730 US-002).`,
			"",
			"Run merge-pr: merge-check re-checks everything first; filed by the forge-pr non-code fast path.",
		].join("\n"),
		assigneeAgentId,
		status: "todo",
		priority: "high",
	};
}
