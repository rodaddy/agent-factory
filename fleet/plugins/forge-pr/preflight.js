// The mechanical preflight: a PR a script can refuse never takes a
// reviewer's slot or a review round. review-dispatch step 2 keeps the same checks.

// Big or risky (more added lines than this, or a file under one of these
// directories at any depth) needs a rehearsal receipt in its Backout.
export const BIG_CHANGE_LINES = 400;
export const RISKY_PATHS = ["migrations", "infra", "deploy", ".forgejo", "k8s"];
// a PR is refused only over 1200 added lines; reviewers
// slice it into slices of at most 400 added lines, as many as that takes, one
// reviewer pair per slice. Deletions never count.
const MAX_LINES = 1200;
const SLICE_LINES = 400;
const PAGE = 50;
const MAX_FILES = 1000; // 20 pages of 50, far past the line limit

const FENCE = /^\s*(```|~~~)/;
const lines = (f) => Number(f?.additions) || 0; // added lines only (operator ruling 2026-10-08)

// The bar counts what Development's _ob/bin/forge-pr-open counts.
// LOCKFILES and DOC_FILE mirror forge-pr-open's, verbatim: keep them in step.
export const LOCKFILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"uv.lock",
	"poetry.lock",
	"Cargo.lock",
	"go.sum",
	"Gemfile.lock",
	"composer.lock",
	"Package.resolved",
]);
export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
// Drizzle's generated schema snapshots; the journal counts.
const DRIZZLE_SNAPSHOT = /(^|\/)drizzle\/meta\/[^/]+_snapshot\.json$/;
export const VENDORED = "VENDORED";
export const GENERATED = "GENERATED";

// True when a changed file's added lines stay out of the bar: a lockfile, a
// doc that was not renamed (a renamed doc counts), a drizzle snapshot, or a
// path in `marked` (a VENDORED or GENERATED marker at the head exempts it).
function uncounted(f, marked) {
	const path = String(f?.filename ?? "");
	const name = path.split("/").pop();
	if (LOCKFILES.has(name) || DRIZZLE_SNAPSHOT.test(path) || marked.has(path)) return true;
	return f?.status !== "renamed" && DOC_FILE.test(name);
}

// { counted, left }: added lines the bar counts, and added lines it leaves out.
export function addedLines(files, marked = new Set()) {
	let counted = 0;
	let left = 0;
	for (const f of Array.isArray(files) ? files : []) {
		if (uncounted(f, marked)) left += lines(f);
		else counted += lines(f);
	}
	return { counted, left };
}

const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// The head-tree paths a marker exempts, as forge-pr-open reads them: every file
// in a dir holding a file named exactly VENDORED (its own dir, never an
// ancestor; the marker itself counts), and every existing file a GENERATED
// marker lists by bare name in its own dir (`#` and blank lines skipped; the
// marker counts). A line with `/`, or `.`/`..`, throws: forge-pr-open refuses
// that marker, so the caller must exempt nothing.
// `paths` is the head's file list; `read(markerPath)` the marker's text.
export async function markedPaths(paths, read) {
	const have = new Set(paths);
	const vendored = new Set(paths.filter((p) => p.split("/").pop() === VENDORED).map(dirOf));
	const marked = new Set(
		paths.filter((p) => p.split("/").pop() !== VENDORED && vendored.has(dirOf(p))),
	);
	for (const marker of paths.filter((p) => p.split("/").pop() === GENERATED)) {
		const dir = dirOf(marker);
		for (const raw of String(await read(marker)).split(/\r?\n/)) {
			const l = raw.trim();
			if (!l || l.startsWith("#")) continue;
			if (l.includes("/") || l === "." || l === "..") {
				throw Object.assign(new Error("bad GENERATED line"), {
					reason: `marker ${marker}: '${l}' is not a bare file name`,
				});
			}
			const p = dir ? `${dir}/${l}` : l;
			if (have.has(p) && l !== GENERATED) marked.add(p);
		}
	}
	return marked;
}

// The lines of the `## <name>` section, up to the next # or ## heading outside
// a fence; null when there is no such section outside a fence. HTML comments
// are dropped.
function section(body, name) {
	const all = String(body ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/);
	const heading = new RegExp(`^##\\s+${name}\\b`, "i");
	let out = null;
	let inFence = false;
	for (const l of all) {
		if (!inFence && out === null && heading.test(l)) {
			out = [];
			continue;
		}
		if (!inFence && out !== null && /^#{1,2}\s/.test(l)) break;
		if (FENCE.test(l)) inFence = !inFence;
		if (out !== null) out.push(l);
	}
	return out;
}

// The fenced blocks of a section, each as its non-empty inner lines.
function fences(sec) {
	const blocks = [];
	let cur = null;
	for (const l of sec) {
		if (FENCE.test(l)) {
			if (cur) blocks.push(cur);
			cur = cur ? null : [];
		} else if (cur && l.trim() !== "") cur.push(l);
	}
	if (cur) blocks.push(cur);
	return blocks;
}

const empty = (sec) => sec === null || sec.every((l) => l.trim() === "");

// review-dispatch step 2, "Slicing" (fleet/skills/review-dispatch/SKILL.md step 2):
// whole files in API order, each slice at most 400 added lines, a single file
// over 400 lines is its own slice, as many slices as that takes.
export function sliceCount(files) {
	let slices = 0;
	let open = null; // added lines in the open slice; null before the first
	for (const f of Array.isArray(files) ? files : []) {
		const n = lines(f);
		if (open !== null && open + n <= SLICE_LINES) open += n;
		else {
			slices++;
			open = n;
		}
	}
	return slices;
}

const risky = (name) => RISKY_PATHS.some((d) => `/${name}`.includes(`/${d}/`));

// A receipt: a fenced block with a command and at least one output line, or a URL.
const hasReceipt = (sec) =>
	fences(sec).some((b) => b.length >= 2) || sec.some((l) => /https?:\/\/\S/.test(l));

// { ok: true } or { ok: false, reasons } with one reason per failed rule.
// `marked`: head paths a VENDORED or GENERATED marker exempts (markedPaths);
// empty, every such file counts.
export function preflight({ body, files, marked = new Set() }) {
	const list = Array.isArray(files) ? files : [];
	const reasons = [];
	// A read that hit pullFiles' page cap never saw the rest, so it cannot pass.
	if (files?.truncated) reasons.push(`too large to review: more than ${MAX_FILES} changed files`);
	const backout = section(body, "Backout");
	if (empty(backout)) reasons.push("missing backout plan");
	const plan = section(body, "Test plan");
	if (empty(plan) || fences(plan).some((b) => b.length === 0)) reasons.push("missing test plan");
	const { counted: total, left } = addedLines(list, marked);
	const notCounted = left > 0 ? `; ${left} lockfile, doc or generated lines not counted` : "";
	if (total > MAX_LINES)
		reasons.push(`too large to review: ${total} added lines (at most ${MAX_LINES}${notCounted})`);
	const big = total > BIG_CHANGE_LINES || list.some((f) => risky(f?.filename));
	if (big && !hasReceipt(backout ?? [])) reasons.push("big change without a rehearsal receipt");
	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const FIX = {
	"missing backout plan":
		'add a `## Backout` section on how to undo it ("revert and reinstall the last version" is enough for a small change).',
	"missing test plan": "add a `## Test plan` naming the tests run; no empty code block.",
	"big change without a rehearsal receipt": `over ${BIG_CHANGE_LINES} added lines or under ${RISKY_PATHS.join(", ")}: in \`## Backout\`, add a fenced block with the rehearsed command and its output, or a link to the rehearsal run.`,
};

// The one PR comment for a preflight fail: the verdict line, then each reason with its fix.
export function preflightComment(reasons) {
	return [
		"verdict: fix-first (preflight)",
		"",
		"A script checked this PR before review (sf#1730); no reviewer ran and no review round was used. Fix each item, then edit the PR body or push.",
		"",
		...reasons.map(
			(r) =>
				`- **${r}**: ${FIX[r] ?? `split it into PRs of at most ${MAX_LINES} added lines; deletions do not count.`}`,
		),
	].join("\n");
}

// Every page of a PR's changed files through the caller's Forge read, get(path).
// The read stops at MAX_FILES; a list that reached it is marked `truncated`,
// and preflight fails it rather than judge files it never saw.
export async function pullFiles(get, repo, number) {
	const out = [];
	for (let page = 1; page <= MAX_FILES / PAGE; page++) {
		const items = await get(`/repos/${repo}/pulls/${number}/files?limit=${PAGE}&page=${page}`);
		if (!Array.isArray(items)) return out;
		out.push(...items);
		if (items.length < PAGE) return out;
	}
	out.truncated = true;
	return out;
}
