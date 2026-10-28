/**
 * @module scripts/actions/post-issue-triage
 * @description Publish one `issue-triage` engine reply back to Forge as a set
 *   of allowlisted labels plus a single bounded comment. Reads the
 *   raw chat-completions reply from stdin and the job's bounded metadata from
 *   the environment, so it never sees the issue body and never calls the
 *   engine.
 *
 *   The engine's reply is a RESULT DOCUMENT, not prose: it is parsed, then
 *   validated against the repo's own strict `resultSchema`, then bound to the
 *   job it was dispatched for (`job_type`, `repository`, `item_number`). A
 *   reply failing any of those gates applies NOTHING and posts an error
 *   comment naming the field — an unparseable triage is an unknown outcome,
 *   and applying labels from an unknown outcome is the failure mode this gate
 *   exists to prevent.
 *
 *   Labels are never taken on the engine's word. `allowlistedChosenLabels`
 *   intersects the chosen names with the dispatched repository's FIXED
 *   allowlist (`triageLabelsFor`) and dedupes; a name outside it is dropped and surfaced in the comment. The
 *   workflow never creates a label.
 *
 *   The raw reply NEVER reaches the comment. An error comment echoing the
 *   reply would publish unvalidated engine text into an issue thread under the
 *   factory's name; the reason string is bounded and the reply is discarded.
 *
 *   The comment is capped in BYTES, because the limit being respected is the
 *   forge API's. The token reaches only the `Authorization` header.
 *
 * @outputs
 *   - `planTriage` -- raw reply + env -> `TriagePlan` (labels and comment, or a reason)
 *   - `truncateComment` / `MAX_COMMENT_BYTES` / `COMMENT_TRUNCATION_MARKER` -- the bound
 *   - CLI: exit 0 ONLY when the plan was ok AND every Forge write succeeded;
 *     exit 3 when the plan was not ok OR any write failed. When this process
 *     posted a comment successfully it appends `posted=true` to
 *     `$GITHUB_OUTPUT`; the workflow's failure() step is gated on this output,
 *     so an engine reply or a label failure ends in exactly one comment.
 *
 * @dependencies
 *   - ./post-pr-review -- extractReply, the shared chat-completions unwrapper
 *   - ./triage-labels -- the fixed label allowlist
 *   - ../../src/results/schema -- resultSchema, TRIAGE_JOB_TYPE
 *   - ../../src/github/publication-comment -- allowlistedChosenLabels
 *   - ../../src/github/publication-text -- renderFindings, sanitizeRunnerText
 */
import { allowlistedChosenLabels } from "../../src/github/publication-comment";
import { ACTIONS_AGENT, actionsLaneSeat, signatureLine } from "../../src/github/signature";
import { renderFindings, sanitizeRunnerText } from "../../src/github/publication-text";
import { readFile } from "node:fs/promises";
import { log, traced } from "../../src/log";
import { resultSchema, TRIAGE_JOB_TYPE } from "../../src/results/schema";
import { parseAdviceLines } from "./jev-advise";
import { parseScreenLine } from "./jev-screen";
import { extractReply } from "./post-pr-review";
import { triageLabelsFor } from "./triage-labels";

/** The byte ceiling on the posted comment body. */
export const MAX_COMMENT_BYTES = 60_000;

/** The in-band marker appended when the comment hits `MAX_COMMENT_BYTES`. */
export const COMMENT_TRUNCATION_MARKER = `\n\n[triage comment truncated at ${MAX_COMMENT_BYTES} bytes]`;

/** The deadline on each Forge write; a hung write must not hold the job open. */
export const FORGE_WRITE_TIMEOUT_MS = 30_000;

/** The comment header context. */
export const COMMENT_CONTEXT = "factory/issue-triage";

/** This lane's name, as the signature line's seat names it. */
export const LANE = "issue-triage";

/**
 * The body actually POSTed: the agent signature line, the plan's
 * comment (a triage or an error), then the run link, bounded as ONE string so
 * the cap applies to what Forge receives. Every comment this lane posts goes
 * through here, error comments included — the ruling covers every body. The
 * model is the lane's configured `ENGINE_MODEL`, a workflow literal.
 *
 * `advisory` is the sf#1059 D1 Jev screen line (already validated by
 * `parseScreenLine`). When non-empty it sits on its own paragraph right after
 * the signature; when absent or empty the body is exactly the pre-D1 shape.
 */
function postedBodyImpl(
	comment: string,
	runUrl: string,
	model: string | undefined,
	advisory?: string,
): string {
	const signature = signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat(LANE), model });
	const withRun = runUrl === "" ? comment : `${comment}\n\nrun: ${runUrl}`;
	const head =
		advisory !== undefined && advisory !== "" ? `${signature}\n\n${advisory}` : signature;
	return truncateComment(`${head}\n\n${withRun}`);
}

export const postedBody = traced("actions.postedBody", postedBodyImpl, {
	redact: { args: [0], result: true },
});

/**
 * Read the sf#1059 advisory: the D1 screen line from `JEV_SCREEN_FILE`, then
 * the D6/D2 advice lines from `JEV_ADVICE_FILE` (at most 4), joined by "\n".
 * Each file is read independently: an unset env, a missing or unreadable
 * file, or no matching line drops only that file's lines, with one info line
 * carrying a reason, never the content. Undefined when neither yields a line.
 */
async function readLinesFrom(
	path: string | undefined,
	file: "screen" | "advice",
	parse: (text: string) => string[],
): Promise<string[]> {
	if (path === undefined || path === "") {
		log("info", "actions.jev_screen.absent", { file, reason: "env_unset" });
		return [];
	}
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		log("info", "actions.jev_screen.absent", { file, reason: "unreadable" });
		return [];
	}
	const lines = parse(text);
	if (lines.length === 0) {
		log("info", "actions.jev_screen.absent", { file, reason: "no_match" });
	}
	return lines;
}

async function readAdvisoryImpl(env: {
	JEV_SCREEN_FILE?: string;
	JEV_ADVICE_FILE?: string;
}): Promise<string | undefined> {
	const screen = await readLinesFrom(env.JEV_SCREEN_FILE, "screen", (text) => {
		const line = parseScreenLine(text);
		return line === null ? [] : [line];
	});
	const advice = await readLinesFrom(env.JEV_ADVICE_FILE, "advice", (text) =>
		parseAdviceLines(text, 4),
	);
	const lines = [...screen, ...advice];
	return lines.length === 0 ? undefined : lines.join("\n");
}

export const readAdvisory = traced("actions.readAdvisory", readAdvisoryImpl, {
	redact: { result: true },
});

/** The bound on a rejection reason embedded in the error comment. */
const MAX_REASON_CHARS = 300;

/** What the poster will do: apply these labels with this comment, or neither. */
export type TriagePlan =
	| { ok: true; labels: string[]; comment: string }
	| { ok: false; reason: string; comment: string };

/**
 * Cap `text` at `MAX_COMMENT_BYTES`, appending the marker on its own line when
 * the cap bit. Measured and cut in BYTES: the limit is the API's.
 */
function truncateCommentImpl(text: string): string {
	const encoded = new TextEncoder().encode(text);
	if (encoded.byteLength <= MAX_COMMENT_BYTES) {
		return text;
	}
	// Reserve the marker's bytes so the POSTED body, marker included, stays
	// within the ceiling (review F4 on PR #475).
	const keep = MAX_COMMENT_BYTES - new TextEncoder().encode(COMMENT_TRUNCATION_MARKER).byteLength;
	const decoder = new TextDecoder();
	// Cut on a code-point boundary: slicing the buffer can split a multi-byte
	// sequence, which decodes to one trailing U+FFFD whose 3 bytes push the
	// body back over the ceiling. Dropping it makes the cap byte-exact; a
	// genuine U+FFFD landing at the cut is harmless to drop with it.
	const head = decoder.decode(encoded.slice(0, keep)).replace(/�$/, "");
	return `${head}${COMMENT_TRUNCATION_MARKER}`;
}

export const truncateComment = traced("actions.issueTriage.truncateComment", truncateCommentImpl, {
	redact: { args: [0], result: true },
});

/**
 * The comment posted when the label write did not land. It must never claim
 * the labels were applied (review on PR #475, run on fe9e0a7).
 */
function labelFailureCommentImpl(reason: string): string {
	// Its own wording: the engine reply was fine, the Forge label write was
	// not, and the label state is unknown (review on PR #475, run 30).
	const bounded = sanitizeRunnerText(reason.slice(0, MAX_REASON_CHARS));
	return `triage: error — ${bounded}\nrun: the label write did not land, so the label state is unknown; nothing else was applied`;
}

export const labelFailureComment = traced("actions.labelFailureComment", labelFailureCommentImpl, {
	redact: { args: [0], result: true },
});

/** The error comment. It names the reason and never carries the reply. */
function errorComment(reason: string): string {
	// The reason can quote engine-controlled text (a rejected key name), so it
	// is escaped inert like every other engine string (review F6 on PR #475).
	const bounded = sanitizeRunnerText(reason.slice(0, MAX_REASON_CHARS));
	return `triage: error — ${bounded}\nrun: engine reply did not match the result shape; nothing was applied`;
}

function fail(reason: string): TriagePlan {
	return { ok: false, reason: reason.slice(0, MAX_REASON_CHARS), comment: errorComment(reason) };
}

/**
 * Strip ONE optional surrounding markdown fence. One, not all: a reply whose
 * own content contains a fenced block must not be unwrapped repeatedly until
 * something else parses.
 */
function stripFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:[A-Za-z0-9_-]*)\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
	return (match ? (match[1] ?? "") : trimmed).trim();
}

/**
 * Turn the engine's raw reply into the plan the poster executes.
 *
 * Every gate is a REFUSAL, never a repair: a reply naming a different issue is
 * not coerced onto this one, and a schema failure applies no labels at all.
 */
function planTriageImpl(
	replyRaw: string,
	env: { REPO?: string; ISSUE?: string; ENGINE_MODEL?: string },
): TriagePlan {
	const content = stripFence(extractReply(replyRaw));
	if (content === "") {
		return fail("the engine reply carried no content");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return fail("the engine reply was not valid JSON");
	}

	const validated = resultSchema.safeParse(parsed);
	if (!validated.success) {
		const issue = validated.error.issues[0];
		const path = issue?.path.join(".") ?? "";
		const message = issue?.message ?? "did not match the result schema";
		return fail(path === "" ? message : `${path}: ${message}`);
	}
	const result = validated.data;

	if (result.job_type !== TRIAGE_JOB_TYPE) {
		return fail(`job_type is "${result.job_type}", expected "${TRIAGE_JOB_TYPE}"`);
	}
	if (result.repository !== env.REPO) {
		return fail(`repository "${result.repository}" does not match the dispatched repository`);
	}
	if (result.item_number !== Number(env.ISSUE)) {
		return fail(`item_number ${String(result.item_number)} does not match the dispatched issue`);
	}

	// Keyed on the dispatched REPO, which the gate above bound the reply to.
	const allowlist = triageLabelsFor(env.REPO ?? "");
	const labels = allowlistedChosenLabels(result, allowlist);

	const allowed = new Set<string>(allowlist);
	const dropped: string[] = [];
	const seenDropped = new Set<string>();
	for (const name of result.triage?.labels ?? []) {
		if (!allowed.has(name) && !seenDropped.has(name)) {
			seenDropped.add(name);
			dropped.push(sanitizeRunnerText(name));
		}
	}

	const model = env.ENGINE_MODEL ?? "";
	const lines: string[] = [`## ${COMMENT_CONTEXT} — ${model} on #${result.item_number}`, ""];
	const read = result.triage?.read;
	if (read !== undefined && read !== "") {
		lines.push(`**Read:** ${sanitizeRunnerText(read)}`, "");
	}
	lines.push(`**Labels applied:** ${labels.length > 0 ? labels.join(", ") : "(none)"}`, "");
	if (dropped.length > 0) {
		lines.push(`**Labels dropped (not in the allowlist):** ${dropped.join(", ")}`, "");
	}
	const requests = result.triage?.requests ?? [];
	if (requests.length > 0) {
		lines.push("**Label requests:**");
		for (const request of requests) {
			const reason = request.reason ? ` — ${sanitizeRunnerText(request.reason)}` : "";
			lines.push(`- ${sanitizeRunnerText(request.name)}${reason}`);
		}
		lines.push("");
	}
	const gaps = result.triage?.spec_gaps ?? [];
	if (gaps.length > 0) {
		lines.push("**Spec gaps:**");
		for (const gap of gaps) {
			lines.push(`- ${sanitizeRunnerText(gap)}`);
		}
		lines.push("");
	}
	const findings = renderFindings(result);
	if (findings.length > 0) {
		lines.push("**Findings:**", ...findings, "");
	}
	lines.push(
		`_status: ${result.status}; proposed by the engine, applied only from the fixed allowlist_`,
	);

	return { ok: true, labels, comment: truncateComment(lines.join("\n")) };
}

/**
 * Both sides are redacted. `replyRaw` is the proxy's raw reply, and a rejected
 * call's body is the one place a proxy has been seen to echo a credential.
 * The RESULT carries the bounded comment, which is model output
 * derived from an untrusted issue body: validation allowlists the LABELS, not
 * the comment text, so anything the issue carried can reappear there.
 * `summarize()` masks secret keys and bounds strings to 200 characters, which
 * does not help when the secret is inside the text (P1).
 */
export const planTriage = traced("actions.planTriage", planTriageImpl, {
	redact: { args: [0], result: true },
});

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		process.stderr.write(`post-issue-triage: ${name} is required\n`);
		process.exit(3);
	}
	return value;
}

if (import.meta.main) {
	const api = required("API");
	const repo = required("REPO");
	const issue = required("ISSUE");
	const token = required("TOKEN");
	const runUrl = process.env.RUN_URL ?? "";

	const plan = planTriage(await Bun.stdin.text(), {
		REPO: repo,
		ISSUE: issue,
		ENGINE_MODEL: process.env.ENGINE_MODEL ?? "",
	});

	// The token travels in this header and nowhere else.
	const headers = {
		Authorization: `token ${token}`,
		"Content-Type": "application/json",
	};

	let failed = false;
	let commentBody = plan.comment;

	if (plan.ok && plan.labels.length > 0) {
		// Forgejo's swagger: "a list of integers representing label IDs or a
		// list of strings representing label names".
		let labelReason: string | null = null;
		try {
			const applied = await fetch(`${api}/repos/${repo}/issues/${issue}/labels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ labels: plan.labels }),
				signal: AbortSignal.timeout(FORGE_WRITE_TIMEOUT_MS),
			});
			if (!applied.ok) {
				labelReason = `label write failed (http ${applied.status})`;
			}
		} catch (error) {
			// Never the body and never the token: only the error's name.
			labelReason = `label write failed (${error instanceof Error ? error.name : "unknown error"})`;
		}
		if (labelReason !== null) {
			process.stderr.write(`post-issue-triage: ${labelReason}\n`);
			failed = true;
			// The comment must not claim labels that were never applied.
			commentBody = labelFailureComment(labelReason);
		}
	}

	// The run link is part of the bounded body, not appended after the cap.
	// sf#1059 D1/D6/D2: the advisory lines ride on every comment this run posts.
	const advisory = await readAdvisory({
		JEV_SCREEN_FILE: process.env.JEV_SCREEN_FILE,
		JEV_ADVICE_FILE: process.env.JEV_ADVICE_FILE,
	});
	const body = postedBody(commentBody, runUrl, process.env.ENGINE_MODEL, advisory);
	let posted = false;
	try {
		const comment = await fetch(`${api}/repos/${repo}/issues/${issue}/comments`, {
			method: "POST",
			headers,
			body: JSON.stringify({ body }),
			signal: AbortSignal.timeout(FORGE_WRITE_TIMEOUT_MS),
		});
		if (comment.ok) {
			posted = true;
		} else {
			process.stderr.write(`post-issue-triage: comment POST failed with ${comment.status}\n`);
			failed = true;
		}
	} catch (error) {
		process.stderr.write(
			`post-issue-triage: comment POST threw ${error instanceof Error ? error.name : "unknown error"}\n`,
		);
		failed = true;
	}

	// The workflow's failure() step is gated on this output, so a run that
	// already carries this process's own comment does not get a second one.
	const outputPath = process.env.GITHUB_OUTPUT;
	if (posted && outputPath !== undefined && outputPath !== "") {
		const existing = await Bun.file(outputPath)
			.text()
			.catch(() => "");
		await Bun.write(outputPath, `${existing}posted=true\n`);
	}

	// Honest exit: 0 only when the plan was ok AND every write landed. A plan
	// that was not ok is a failed triage even though its error comment posted.
	if (failed || !plan.ok) {
		process.exitCode = 3;
	}
}
