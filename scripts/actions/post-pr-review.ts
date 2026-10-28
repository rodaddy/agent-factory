/**
 * @module scripts/actions/post-pr-review
 * @description Publish one `pr-review` engine reply back to Forge as a single
 *   bounded PR comment plus the `factory/pr-review` commit status.
 *   Reads the reply text from stdin and the job's bounded metadata from the
 *   environment, so it never sees the diff and never calls the engine.
 *
 *   The verdict is DERIVED from the reply, not asked for out of band: the
 *   renderer's output contract ends the review with a line reading exactly
 *   `verdict: approve` or `verdict: fix-first`, and this module takes the LAST
 *   such line. Last, not first, because a reply that quotes the instruction
 *   before answering it would otherwise be scored on the quotation. A reply
 *   carrying no verdict line at all maps to the status state `error` rather
 *   than to `success`: an unparseable review is an unknown outcome, and a green
 *   check for an unknown outcome is the failure mode a required check exists to
 *   prevent.
 *
 *   The comment is capped in BYTES. Engine output is untrusted in LENGTH (not
 *   in intent — it never becomes a command here), and Forge rejects an
 *   oversized body, which would turn a long review into a lost one.
 *
 *   The token reaches only the `Authorization` header. It is never written to
 *   stdout, stderr, or a URL, so a failing run's log carries the endpoint and
 *   the HTTP status but no credential.
 *
 *   Both writes go through `postForge`: the forge is stopped nightly
 *   for its backup boundary (~9 min of 502s), and a review that finishes inside
 *   that window must still land, so each write is re-asked on a schedule that
 *   outlasts the quiesce before it counts as failed.
 *
 *   Exit codes are the OUTCOME, deliberately: 0 for a published verdict of
 *   either polarity, 3 for an unusable review or a Forge write that failed.
 *   The workflow gate is the commit status, not this process's code — a
 *   `fix-first` review is a job that did its work, so failing the step would
 *   conflate "the reviewer found problems" with "the reviewer could not run".
 *
 * @outputs
 *   - `parseVerdict` -- reply text -> `approve` | `fix-first` | `error`
 *   - `truncateComment` / `MAX_COMMENT_BYTES` -- the comment bound and its marker
 *   - `buildCommentBody` -- the posted comment, signature and header included,
 *     plus the optional advisory Jev screen line under the heading
 *   - `readAdvisory` -- env -> the validated screen line from `JEV_SCREEN_FILE` then the
 *     advice lines from `JEV_ADVICE_FILE`, joined by newlines, or none
 *   - `statusForVerdict` -- verdict -> Forge commit-status state
 *   - `describeStatus` -- verdict + engine attempts (+ mode) -> the published description
 *   - `StatusMode` -- `enforcing` | `advisory`
 *   - `reviewStatusMode` -- (config, repo) -> the repo's `pr_review_status` mode
 *   - `statusModeFromEnv` -- `PR_REVIEW_STATUS` value -> mode, failing to `enforcing`
 *   - `publishedState` / `skippedStatus` -- advisory mode publishes `success`
 *   - `mergeVerdicts` -- chunk verdicts -> one verdict (error > fix-first > approve; empty -> error)
 *   - `buildChunkedReview` -- chunk replies -> one review body (one part: that review, unchanged)
 *   - `readChunkReplies` -- dir -> per-chunk { index, files, review } from manifest.json + reply-<i>.json
 *   - input `JEV_SCREEN_FILE` -- the advisory screen line; missing/invalid -> no advisory.
 *     It never changes the status state or the verdict
 *   - input `JEV_ADVICE_FILE` -- advisory advice lines (D5); invalid lines dropped
 *   - input `CHUNK_DIR` -- when set (and no skip), replies are read from it, not stdin
 *   - input `CHUNK_DIR/second-pass.json` + refute/checklist replies -- second-pass verdict rules
 *   - CLI `mode <repo>`: print the repo's mode from `config/repos.yml`; exit 2
 *     when the repo ARGUMENT is absent or the config is unreadable. A repo the
 *     config does not list prints `enforcing` and exits 0 by design: a
 *     pull_request run reviews software-factory itself, and enrolment is
 *     assert-enrolled.ts's job, not this lookup's
 *   - CLI: exit 0 when the comment and status were both accepted; exit 3 when
 *     the reply carried no verdict or a Forge write failed
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "../../src/config/load";
import type { WatcherConfig } from "../../src/config/schema";
import { ACTIONS_AGENT, actionsLaneSeat, signatureLine } from "../../src/github/signature";
import { log, traced } from "../../src/log";
import {
	backoffFromEnv,
	type CommentRow,
	hasIdenticalComment,
	hasIdenticalStatus,
	listProbe,
	postForge,
	type StatusRow,
} from "./forge-write";
import { parseAdviceLines } from "./jev-advise";
import { parseScreenLine } from "./jev-screen";
import { applySecondPass, readSecondPass, withSecondPass } from "./second-pass";

/** The byte ceiling on the posted comment body. */
export const MAX_COMMENT_BYTES = 60_000;

/** This lane's name, as the signature line's seat names it. */
export const LANE = "pr-review";

/** The in-band marker appended when the comment hits `MAX_COMMENT_BYTES`. */
export const COMMENT_TRUNCATION_MARKER = `\n\n[review truncated at ${MAX_COMMENT_BYTES} bytes]`;

/** The commit-status context. Any required-check gate binds to this string. */
export const STATUS_CONTEXT = "factory/pr-review";

/** The three outcomes a reply can carry. */
export type Verdict = "approve" | "fix-first" | "error";

/**
 * How the lane publishes: `enforcing` follows the verdict; `advisory`
 * posts `success` on every terminal state and leaves the findings in the
 * comment, for a repo whose merge rule requires every status to be success.
 */
export type StatusMode = "enforcing" | "advisory";

/** `advisory` iff the repo's enrolled Forgejo entry says so; else `enforcing`. */
function reviewStatusModeImpl(config: WatcherConfig, repo: string): StatusMode {
	const advisory = config.repositories.some(
		(r) => r.name === repo && r.provider === "forgejo" && r.pr_review_status === "advisory",
	);
	return advisory ? "advisory" : "enforcing";
}

export const reviewStatusMode = traced("actions.prReview.reviewStatusMode", reviewStatusModeImpl);

/** Only the exact string `advisory` selects advisory; anything else fails to the default. */
function statusModeFromEnvImpl(value: string | undefined): StatusMode {
	return value === "advisory" ? "advisory" : "enforcing";
}

export const statusModeFromEnv = traced(
	"actions.prReview.statusModeFromEnv",
	statusModeFromEnvImpl,
);

/**
 * Pull the review text out of the engine's raw chat-completions reply.
 *
 * The workflow feeds the proxy's JSON straight in: the forgejo-mvp image
 * (`node:20-bookworm`) carries no jq, and run 1024 on PR #473 died on
 * `jq: command not found` after a successful ten-minute engine call. Anything
 * that is not `{choices:[{message:{content:string}}]}` — a proxy error object,
 * an HTML error page, an empty body — yields `""`, which `parseVerdict` scores
 * as `error`, so a malformed reply can never surface as a pass.
 */
function extractReplyImpl(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "";
	}
	if (typeof parsed !== "object" || parsed === null) return "";
	const choices = (parsed as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return "";
	const first = choices[0] as { message?: { content?: unknown } } | null;
	const content = first?.message?.content;
	return typeof content === "string" ? content : "";
}

/**
 * Both sides are redacted. `raw` is whatever the proxy returned, and a proxy
 * error body is the one place this repo has seen a credential echoed back.
 * The RESULT was originally traced on the argument that review
 * markdown is what a trace exists to show -- but it is model output derived
 * from an untrusted diff, so anything the diff carried can reappear in it.
 * `summarize()` bounds a string to MAX_FIELD (200) and masks secret KEYS; it
 * cannot see a secret sitting in the first 200 characters of free text.
 * Probed: a diff line reading `AWS_SECRET_ACCESS_KEY=...` reaches the log
 * verbatim through a traced string result (P1).
 */
export const extractReply = traced("actions.extractReply", extractReplyImpl, {
	redact: { args: [0], result: true },
});

/**
 * The verdict line, anchored whole: a line that merely mentions a verdict in
 * prose is not a verdict. The trailing `\r?` tolerates a CRLF reply without
 * loosening the anchor.
 */
const VERDICT_LINE = /^verdict:[ \t]*(approve|fix-first)[ \t]*\r?$/;

/** The final non-blank line must be a whole `verdict:` line; else `error`. */
function parseVerdictImpl(text: string): Verdict {
	// The verdict is the reply's FINAL non-blank line: a verdict followed by
	// more findings is content the reviewer kept writing, not an answer (run
	// 1026 review P1). Blank and whitespace-only trailing lines are ignored.
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i] ?? "";
		if (line.trim() === "") continue;
		const match = VERDICT_LINE.exec(line);
		return match ? (match[1] as Verdict) : "error";
	}
	return "error";
}

export const parseVerdict = traced("actions.parseVerdict", parseVerdictImpl, {
	redact: { args: [0] },
});

/** A graded finding entry at the start of a line, under any markdown wrapping. */
const FINDING_ENTRY =
	/^[ \t]*(?:#{1,6}[ \t]+)?(?:\d+[.)][ \t]+|[-*+][ \t]+)?[ \t*_`[(]*P([0-3])\b/m;
/**
 * P0 or P1 written anywhere, in any form. This is what keeps a review
 * fix-first, and it is also what the refuter must answer line by line
 * (render-second-pass.ts): on run 9355 a `1. **P1` line blocked here and was
 * not counted there, so a complete refutation was refused; a grade off
 * line-start (`> P1`, `**Severity: P1**`) blocked here and was not counted
 * there, so a refuter matching the smaller count could approve past it.
 * One rule for both: every line that names P0 or P1 is blocking.
 */
export const ANY_BLOCKING_GRADE = /\bP[01]\b/;

/**
 * the owner's ruling (2026-10-01): only P0 and P1 block. Fail-safe: a reviewer
 * `fix-first` becomes `approve` only when the review names NO P0 or P1
 * anywhere and has at least one P2 or P3 entry. Reviewers are told not to
 * write P0 or P1 at all when there are none (render-pr-review.ts), so a
 * P2-only review does not loop. Applied to a first-pass REVIEW reply only.
 */
function applySeverityRuleImpl(review: string, verdict: Verdict): Verdict {
	if (verdict !== "fix-first" || ANY_BLOCKING_GRADE.test(review)) return verdict;
	return FINDING_ENTRY.test(review) ? "approve" : verdict;
}

export const applySeverityRule = traced("actions.applySeverityRule", applySeverityRuleImpl, {
	redact: { args: [0] },
});

/** A first-pass reviewer reply's verdict with the severity rule applied. */
function reviewVerdictImpl(review: string): Verdict {
	return applySeverityRule(review, parseVerdict(review));
}

export const reviewVerdict = traced("actions.reviewVerdict", reviewVerdictImpl, {
	redact: { args: [0] },
});

const MARKER_BYTES = new TextEncoder().encode(COMMENT_TRUNCATION_MARKER).byteLength;

/**
 * Cap `text` at `limit` bytes, marker INCLUDED: when the cap bites, the text
 * is cut to `limit` minus the marker's length so the string returned never
 * exceeds `limit`. Measured and cut in bytes for the same
 * reason as the diff cap: the limit being respected is the API's, which counts
 * bytes. The default limit is the whole ceiling; `buildCommentBody` passes the
 * ceiling minus its own prefix.
 */
function truncateCommentImpl(text: string, limit: number = MAX_COMMENT_BYTES): string {
	const encoded = new TextEncoder().encode(text);
	if (encoded.byteLength <= limit) {
		return text;
	}
	const decoder = new TextDecoder();
	// A marker that does not fit is OMITTED, never appended over the limit: the
	// limit is the contract, the marker is a courtesy.
	const marker = limit >= MARKER_BYTES ? COMMENT_TRUNCATION_MARKER : "";
	// Never split a multi-byte character: a partial sequence decodes to U+FFFD,
	// which is three bytes and would breach the ceiling by a byte or two.
	let keep = Math.max(0, limit - (marker === "" ? 0 : MARKER_BYTES));
	while (keep > 0 && ((encoded[keep] ?? 0) & 0xc0) === 0x80) keep -= 1;
	return `${decoder.decode(encoded.slice(0, keep))}${marker}`;
}

// Annotated so the optional `limit` survives the wrapper: `traced()` infers the
// parameter tuple from the implementation, where a defaulted parameter is still
// required positionally.
export const truncateComment: (text: string, limit?: number) => string = traced(
	"actions.prReview.truncateComment",
	truncateCommentImpl,
	{
		redact: { args: [0], result: true },
	},
);

/**
 * The posted comment: the agent signature line, the provenance
 * header, then the bounded review. The model in the signature is the lane's
 * configured `ENGINE_MODEL` — a workflow literal, never text from the reply.
 * `MAX_COMMENT_BYTES` bounds the WHOLE body: the prefix's bytes are reserved
 * out of the review's allowance, so signing the comment cannot push it past
 * the ceiling. A non-empty `advisory` (the validated Jev
 * screen line) sits under the heading INSIDE the prefix, so the
 * same ceiling covers it; without one the prefix is unchanged.
 */
function buildCommentBodyImpl(
	review: string,
	model: string,
	sha: string,
	runUrl = "",
	advisory?: string,
): string {
	const signature = signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat(LANE), model });
	// The run URL makes the body unique to THIS run: the
	// dedupe probe matches the body byte for byte, so a rerun on the same SHA,
	// model and output inside the probe window cannot be mistaken for this one.
	const run = runUrl.trim() === "" ? "" : `run: ${runUrl.trim()}\n\n`;
	const adv = advisory === undefined || advisory === "" ? "" : `${advisory}\n\n`;
	const prefix = `${signature}\n\n## ${STATUS_CONTEXT} — ${model} on ${sha}\n\n${adv}${run}`;
	const prefixBytes = new TextEncoder().encode(prefix).byteLength;
	// A prefix that leaves the review no room for even the marker is pathological
	// (a model literal near the ceiling); the ceiling still wins, over the whole
	// body, rather than the prefix being exempt from it.
	if (MAX_COMMENT_BYTES - prefixBytes < MARKER_BYTES) {
		return truncateComment(`${prefix}${review}`, MAX_COMMENT_BYTES);
	}
	return `${prefix}${truncateComment(review, MAX_COMMENT_BYTES - prefixBytes)}`;
}

// Annotated for the same reason as `truncateComment`: `runUrl` is optional.
export const buildCommentBody: (
	review: string,
	model: string,
	sha: string,
	runUrl?: string,
	advisory?: string,
) => string = traced("actions.buildCommentBody", buildCommentBodyImpl, {
	redact: { args: [0], result: true },
});

/**
 * The advisory Jev screen line from `JEV_SCREEN_FILE`: only a
 * line `parseScreenLine` accepts is returned. Unset, unreadable, or anything
 * else is no advisory, logged once with a reason and never the content.
 */
function readAdvisoryFile(
	env: Record<string, string | undefined>,
	name: "JEV_SCREEN_FILE" | "JEV_ADVICE_FILE",
	parse: (raw: string) => string[],
): string[] {
	const path = env[name] ?? "";
	if (path === "") {
		log("info", "actions.jev_screen.absent", { file: name, reason: "unset" });
		return [];
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		log("info", "actions.jev_screen.absent", { file: name, reason: "unreadable" });
		return [];
	}
	const lines = parse(raw);
	if (lines.length === 0) {
		log("info", "actions.jev_screen.absent", { file: name, reason: "invalid" });
	}
	return lines;
}

function readAdvisoryImpl(env: Record<string, string | undefined>): string | undefined {
	const lines = [
		...readAdvisoryFile(env, "JEV_SCREEN_FILE", (raw) => {
			const line = parseScreenLine(raw);
			return line === null ? [] : [line];
		}),
		// sf#1059 D5: advice lines follow the screen line, each file independent.
		...readAdvisoryFile(env, "JEV_ADVICE_FILE", (raw) => parseAdviceLines(raw, 4)),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
}

export const readAdvisory = traced("actions.prReview.readAdvisory", readAdvisoryImpl, {
	redact: { args: [0] },
});

/** The Forge commit-status state for a verdict. */
function statusForVerdictImpl(verdict: Verdict): "success" | "failure" | "error" {
	if (verdict === "approve") {
		return "success";
	}
	if (verdict === "fix-first") {
		return "failure";
	}
	return "error";
}

export const statusForVerdict = traced("actions.statusForVerdict", statusForVerdictImpl);

/**
 * The state actually published. The comment IS the review: when it did not
 * land, a `success` status would certify findings nobody can read, so the
 * status is `error` regardless of the verdict (review F4 on PR #473).
 */
function publishedStateImpl(
	verdict: Verdict,
	commentPosted: boolean,
	mode: StatusMode = "enforcing",
): "success" | "failure" | "error" {
	// sf#988: advisory never blocks; the description says what happened.
	if (mode === "advisory") {
		return "success";
	}
	return commentPosted ? statusForVerdict(verdict) : "error";
}

// Annotated so the optional `mode` survives the wrapper.
export const publishedState: (
	verdict: Verdict,
	commentPosted: boolean,
	mode?: StatusMode,
) => "success" | "failure" | "error" = traced("actions.publishedState", publishedStateImpl);

/** The comment-did-not-post description, per mode. */
function commentFailedDescription(mode: StatusMode): string {
	return mode === "advisory"
		? "pr-review advisory: the comment did not post"
		: "pr-review: the comment did not post";
}

/** The advisory base description for a verdict. */
function describeAdvisoryVerdict(verdict: Verdict): string {
	const text =
		verdict === "approve"
			? "pr-review advisory: no blocking findings"
			: verdict === "fix-first"
				? "pr-review advisory: blocking findings in the comment"
				: "pr-review advisory: the reviewer returned no verdict line";
	return text.slice(0, 100);
}

/** The status description, bounded to the 100 characters Forge accepts. */
function describeVerdictImpl(verdict: Verdict): string {
	const text =
		verdict === "approve"
			? "pr-review: no blocking findings"
			: verdict === "fix-first"
				? "pr-review: blocking findings, fix first"
				: "pr-review: the reviewer returned no verdict line";
	return text.slice(0, 100);
}

export const describeVerdict = traced("actions.describeVerdict", describeVerdictImpl);

/**
 * The published description: the verdict, plus how many times the engine had to
 * be asked.
 *
 * The commit status is the ONLY durable, API-queryable thing this job writes
 * besides a comment -- Forgejo 16 exposes no job-log API -- so the attempt
 * count rides here or it is not queryable at all. `attempts` arrives as an
 * environment string read from a file the engine step wrote; anything that is
 * not a positive integer (absent, empty, `0`, `abc`, `2.5`) yields the bare
 * verdict rather than a suffix asserting a count nobody measured.
 *
 * The 100-char cap is re-applied AFTER the suffix, not before: Forge counts the
 * string it receives, so a slice that happens before concatenation bounds the
 * wrong string.
 */
function describeStatusImpl(
	verdict: Verdict,
	attempts: string | undefined,
	mode: StatusMode = "enforcing",
): string {
	const base = mode === "advisory" ? describeAdvisoryVerdict(verdict) : describeVerdict(verdict);
	if (attempts === undefined || attempts.trim() === "") {
		return base;
	}
	const n = Number(attempts);
	if (!Number.isInteger(n) || n < 1) {
		return base;
	}
	return `${base} (attempts=${n})`.slice(0, 100);
}

// Annotated so the optional `mode` survives the wrapper.
export const describeStatus: (
	verdict: Verdict,
	attempts: string | undefined,
	mode?: StatusMode,
) => string = traced("actions.describeStatus", describeStatusImpl);

/**
 * The status for a lane that did not review: `warning`, so a reader
 * cannot mistake "could not run" (a size refusal) for `failure` (fix-first)
 * or `error` (the job broke). The description is the renderer's size reason.
 */
type SkippedStatus = {
	state: "warning" | "success";
	context: string;
	description: string;
	target_url: string;
};

function skippedStatusImpl(
	description: string,
	runUrl: string,
	mode: StatusMode = "enforcing",
): SkippedStatus {
	// sf#988: advisory reports the skip as `success`, named in the description.
	if (mode === "advisory") {
		return {
			state: "success",
			context: STATUS_CONTEXT,
			description: `pr-review advisory: ${description}`.slice(0, 100),
			target_url: runUrl,
		};
	}
	return {
		state: "warning",
		context: STATUS_CONTEXT,
		description: description.slice(0, 100),
		target_url: runUrl,
	};
}

// Annotated so the optional `mode` survives the wrapper.
export const skippedStatus: (
	description: string,
	runUrl: string,
	mode?: StatusMode,
) => SkippedStatus = traced("actions.prReview.skippedStatus", skippedStatusImpl);

/** One verdict for a chunked review: any error wins, then fix-first; none is error. */
function mergeVerdictsImpl(verdicts: Verdict[]): Verdict {
	if (verdicts.length === 0 || verdicts.includes("error")) return "error";
	return verdicts.includes("fix-first") ? "fix-first" : "approve";
}

export const mergeVerdicts = traced("actions.prReview.mergeVerdicts", mergeVerdictsImpl);

/** One chunk's reply, as the publish step reads it. */
export type ChunkPart = { index: number; files: string[]; review: string };

/** One part is that review byte for byte; more are headed sections. */
function buildChunkedReviewImpl(parts: ChunkPart[]): string {
	if (parts.length === 1) return parts[0]?.review ?? "";
	const n = parts.length;
	return parts
		.map(
			(p) =>
				`### Chunk ${p.index} of ${n}: ${p.files.join(", ")}\n\n${p.review === "" ? "(no reply from the engine)" : p.review}`,
		)
		.join("\n\n---\n\n");
}

// Redacted like buildCommentBody: the reviews are model output from an untrusted diff.
export const buildChunkedReview = traced(
	"actions.prReview.buildChunkedReview",
	buildChunkedReviewImpl,
	{ redact: { args: [0], result: true } },
);

/** Read manifest.json and each reply-<i>.json (missing -> ""); a bad manifest throws. */
async function readChunkRepliesImpl(dir: string): Promise<ChunkPart[]> {
	const manifest = JSON.parse(await Bun.file(`${dir}/manifest.json`).text()) as {
		chunks?: { index: number; files: string[] }[];
	};
	if (!Array.isArray(manifest.chunks)) throw new Error("manifest.json has no chunks array");
	const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
	const parts: ChunkPart[] = [];
	for (const c of chunks) {
		const file = Bun.file(`${dir}/reply-${c.index}.json`);
		const raw = (await file.exists()) ? await file.text() : "";
		parts.push({ index: c.index, files: c.files, review: extractReply(raw) });
	}
	return parts;
}

// The result carries engine output derived from an untrusted diff: redacted,
// like extractReply's.
export const readChunkReplies = traced("actions.prReview.readChunkReplies", readChunkRepliesImpl, {
	redact: { result: true },
});

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		process.stderr.write(`post-pr-review: ${name} is required\n`);
		process.exit(3);
	}
	return value;
}

if (import.meta.main && process.argv[2] === "mode") {
	// sf#988: `mode <repo>` needs no forge env; the workflow reads the mode
	// from config/repos.yml of the trusted checkout.
	const repoArg = process.argv[3] ?? "";
	if (repoArg === "") {
		process.stderr.write("usage: post-pr-review.ts mode <repo>\n");
		process.exit(2);
	}
	const loaded = await loadConfig("config/repos.yml");
	if (!loaded.ok) {
		process.stderr.write(`config unreadable: ${loaded.error}\n`);
		process.exit(2);
	}
	process.stdout.write(`${reviewStatusMode(loaded.config, repoArg)}\n`);
	process.exit(0);
}

if (import.meta.main) {
	const api = required("API");
	const repo = required("REPO");
	const pr = required("PR");
	const sha = required("HEAD_SHA");
	const token = required("TOKEN");
	const runUrl = process.env.RUN_URL ?? "";
	const model = process.env.ENGINE_MODEL ?? "";
	const skipDescription = process.env.SKIP_DESCRIPTION ?? "";
	const mode = statusModeFromEnv(process.env.PR_REVIEW_STATUS);

	// The token travels in this header and nowhere else.
	const headers = {
		Authorization: `token ${token}`,
		"Content-Type": "application/json",
	};

	let failed = false;
	const backoffMs = backoffFromEnv();
	let verdict: Verdict = "error";
	let statusBody:
		| ReturnType<typeof skippedStatus>
		| {
				state: "success" | "failure" | "error";
				context: string;
				description: string;
				target_url: string;
		  };

	if (skipDescription !== "") {
		// sf#697: the renderer refused the diff for size, so there is no reply
		// and no comment -- ONE status write naming the size, state `warning`.
		statusBody = skippedStatus(skipDescription, runUrl, mode);
	} else {
		const chunkDir = process.env.CHUNK_DIR ?? "";
		let review = "";
		if (chunkDir !== "") {
			// sf#979: one reply per chunk, merged into one comment and one verdict.
			try {
				const parts = await readChunkReplies(chunkDir);
				verdict = mergeVerdicts(parts.map((p) => reviewVerdict(p.review)));
				review = buildChunkedReview(parts);
				const sp = await readSecondPass(chunkDir);
				const applied = applySecondPass(verdict, sp.plan, sp.refute, sp.checklist);
				verdict = applied.verdict;
				review = withSecondPass(review, applied.sections);
			} catch (err) {
				process.stderr.write(`post-pr-review: chunk manifest unreadable: ${String(err)}\n`);
				verdict = "error";
				review = "";
			}
		} else {
			// stdin is the engine's raw reply JSON, not the review text.
			review = extractReply(await Bun.stdin.text());
			verdict = reviewVerdict(review);
		}

		// A retry must not post the comment twice: before every
		// re-ask the lane lists the PR's comments updated since this run began and
		// looks for THIS body, byte for byte.
		const commentBody = buildCommentBody(review, model, sha, runUrl, readAdvisory(process.env));
		const since = new Date(Date.now() - 60_000).toISOString();
		const comment = await postForge(
			`${api}/repos/${repo}/issues/${pr}/comments`,
			{ method: "POST", headers, body: JSON.stringify({ body: commentBody }) },
			{
				backoffMs,
				alreadyApplied: listProbe<CommentRow>(
					`${api}/repos/${repo}/issues/${pr}/comments?since=${encodeURIComponent(since)}`,
					{ headers },
					(rows) => hasIdenticalComment(rows, commentBody),
				),
			},
		);
		if (!comment.ok) {
			process.stderr.write(`post-pr-review: comment POST failed with ${comment.status}\n`);
			failed = true;
		}

		statusBody = {
			state: publishedState(verdict, comment.ok, mode),
			context: STATUS_CONTEXT,
			description: comment.ok
				? describeStatus(verdict, process.env.ENGINE_ATTEMPTS, mode)
				: commentFailedDescription(mode),
			target_url: runUrl,
		};
	}
	const status = await postForge(
		`${api}/repos/${repo}/statuses/${sha}`,
		{ method: "POST", headers, body: JSON.stringify(statusBody) },
		{
			backoffMs,
			alreadyApplied: listProbe<StatusRow>(
				`${api}/repos/${repo}/statuses/${sha}?limit=50`,
				{ headers },
				(rows) => hasIdenticalStatus(rows, statusBody),
			),
		},
	);
	if (!status.ok) {
		process.stderr.write(`post-pr-review: status POST failed with ${status.status}\n`);
		failed = true;
	}

	// A size skip is a published outcome, not an unusable review: exit 0.
	if (failed || (skipDescription === "" && verdict === "error")) {
		process.exitCode = 3;
	}
}
