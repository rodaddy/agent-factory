/**
 * @module scripts/actions/render-issue-triage
 * @description Render the cliproxyapi chat-completions request that the
 *   `issue-triage` Forgejo Actions workflow sends for one issue.
 *   Reads the job's bounded metadata from the environment and the raw Forge
 *   issue JSON from stdin, and prints ONE JSON object on stdout. It performs no
 *   network call and writes no file: the workflow pipes stdout into
 *   `curl -d @-`, so this module's whole contract is "environment plus issue
 *   JSON in, request body out", which is what makes it testable without an
 *   engine and without a forge.
 *
 *   The system prompt is NOT authored here. It is
 *   `renderJobBody("issue-triage", ...)` from `src/templates/registry.ts` — the
 *   same fixed, allowlisted packet body the runner-box lane dispatches — so the
 *   two runtimes triage against one reviewed instruction text and cannot drift.
 *   Only one section is appended: the packet body ends by directing the agent
 *   to write `/work/out/watcher-result.json` and an events stream, and in an
 *   Actions job no such path exists. The appended
 *   `## Output (Forgejo Actions context)` section replaces those artifact
 *   instructions with the single-JSON-object contract the poster parses.
 *
 *   The issue title, body, and labels are repository content and therefore
 *   UNTRUSTED input. They are never interpolated into the system prompt; they
 *   arrive only as the user message, with the body inside a fenced block capped
 *   at `MAX_BODY_BYTES` and the title at `MAX_TITLE_BYTES`. Both caps are
 *   applied in BYTES against the raw stdin buffer rather than in characters,
 *   because the thing being bounded is the request the engine receives, and a
 *   multi-byte body would otherwise exceed a character budget silently.
 *
 *   The packet body already commands a `gh issue view` fetch, which an Actions
 *   job has no credential for and no need of — the issue is supplied inline.
 *   The appended section states that explicitly, because sf#359 is the receipt
 *   for what an unpinned fetch instruction costs when the runtime changes
 *   underneath it.
 *
 *   Every metadata value is validated at this boundary and a bad one exits 2
 *   rather than being repaired. The stdin JSON's own `number` is checked
 *   against `ISSUE` for the same reason: a renderer that triaged whichever
 *   issue the pipe happened to carry would build a request around an item the
 *   workflow never selected.
 *
 * @outputs
 *   - `buildRequest` -- the pure builder: environment + issue JSON bytes -> request
 *   - `MAX_BODY_BYTES` / `BODY_TRUNCATION_MARKER` -- the body bound and its marker
 *   - `MAX_TITLE_BYTES` -- the title bound
 *   - `ACTIONS_OUTPUT_SECTION` -- the appended Actions-context output contract
 *   - CLI: exit 0 printing the request JSON; exit 2 with one stderr line when
 *     the environment or the issue JSON is invalid
 *
 * @dependencies
 *   - ../../src/templates/registry -- the fixed issue-triage instruction body
 *   - ./triage-labels -- the fixed label allowlist rendered into that body
 */
import { traced } from "../../src/log";
import { renderJobBody } from "../../src/templates/registry";
import { triageLabelsFor } from "./triage-labels";

/**
 * The byte ceiling on the issue body carried in the user message. An issue
 * longer than this is triaged on its first 64 KB with the truncation stated
 * in-band, which is a bounded degradation; sending the whole thing is not,
 * because the engine's own context is finite and an overflow fails the job.
 */
export const MAX_BODY_BYTES = 65_536;

/** The in-band marker appended when the issue body hits `MAX_BODY_BYTES`. */
export const BODY_TRUNCATION_MARKER = `[issue body truncated at ${MAX_BODY_BYTES} bytes]`;

/**
 * The byte ceiling on the issue title. No marker is appended: a title is a
 * single line the engine reads as a label, and a cut one reads as cut.
 */
export const MAX_TITLE_BYTES = 512;

/** The most existing labels echoed into the user message. */
export const MAX_LABELS = 50;

/** The byte-equivalent character ceiling on each echoed existing label name. */
export const MAX_LABEL_CHARS = 50;

/** The engine model used when `ENGINE_MODEL` is unset. */
export const DEFAULT_ENGINE_MODEL = "gpt-6.1-sol";

/**
 * The Actions-context output contract appended to the fixed issue-triage body.
 * It is fixed author text; nothing from the environment or the issue reaches it.
 */
export const ACTIONS_OUTPUT_SECTION = [
	"",
	"## Output (Forgejo Actions context)",
	"There is no `/work/out` here, no share path, no `hostname`, and no",
	"`events.jsonl`. Write NO file. Run no fetch command: the issue title, body,",
	"and existing labels are supplied to you in the user message below, and you",
	"have no credential and no need to retrieve anything.",
	"",
	"Reply with EXACTLY ONE JSON object and nothing else — no prose before or",
	"after it, and no markdown fence around it. It carries the fields described",
	'under "Expected Output" above, with `result_version` `1`, `repository` and',
	"`item_number` exactly as given in the Context block, `job_type`",
	"`issue-triage`, and `sha` omitted. Any label in `triage.labels` is chosen",
	"only from the triage vocabulary listed above.",
].join("\n");

/** The bounded metadata the renderer accepts, before validation. */
export interface RenderEnv {
	REPO?: string;
	ISSUE?: string;
	ENGINE_MODEL?: string;
}

/** One chat message in the rendered request. */
export interface ChatMessage {
	role: "system" | "user";
	content: string;
}

/** The cliproxyapi chat-completions request body this module emits. */
export interface EngineRequest {
	model: string;
	reasoning_effort: "high";
	max_completion_tokens: number;
	messages: ChatMessage[];
}

/** Thrown for an invalid environment or issue JSON; the CLI turns it into exit 2. */
export class RenderEnvError extends Error {}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ITEM_PATTERN = /^[1-9][0-9]*$/;

/**
 * Cap `text` at `limit` bytes, appending `marker` on its own line when the cap
 * bit. Slicing the buffer can split a multi-byte sequence; the decoder is
 * non-fatal, so the tail would become a 3-byte replacement character and push
 * the result back over `limit`. Cutting on a code-point boundary — dropping a
 * trailing U+FFFD — is what makes the cap byte-exact.
 */
function capBytes(text: string, limit: number, marker: string | null): string {
	const encoded = new TextEncoder().encode(text);
	if (encoded.byteLength <= limit) {
		return text;
	}
	// Reserve the newline and marker so the EMITTED text, marker included, stays
	// within `limit` (review on PR #475, run 28).
	const tail = marker === null ? "" : `\n${marker}`;
	const keep = limit - new TextEncoder().encode(tail).byteLength;
	const decoder = new TextDecoder();
	const head = decoder.decode(encoded.slice(0, keep)).replace(/�$/, "");
	return `${head}${tail}`;
}

/** The fields this renderer takes from the raw Forge issue JSON. */
interface ParsedIssue {
	number: number;
	title: string;
	body: string;
	labels: string[];
}

/**
 * Parse the raw Forge issue JSON, keeping only the four fields the user message
 * needs and coercing nothing: a non-string title or a null body becomes the
 * empty string, and a label entry that is not an object with a string `name` is
 * DROPPED rather than stringified. Forge is trusted to be Forge; the CONTENT it
 * returns is not, so anything unexpected is discarded at this boundary instead
 * of reaching the engine in a shape the prompt does not describe.
 */
function parseIssue(issueJson: Uint8Array): ParsedIssue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(issueJson));
	} catch {
		throw new RenderEnvError("stdin is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new RenderEnvError("the issue JSON is not an object");
	}
	const record = parsed as Record<string, unknown>;
	const number = record.number;
	if (typeof number !== "number" || !Number.isInteger(number)) {
		throw new RenderEnvError("the issue JSON carries no integer number");
	}
	const title = typeof record.title === "string" ? record.title : "";
	const body = typeof record.body === "string" ? record.body : "";
	const rawLabels = Array.isArray(record.labels) ? record.labels : [];
	const labels: string[] = [];
	for (const entry of rawLabels) {
		if (labels.length >= MAX_LABELS) {
			break;
		}
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const name = (entry as Record<string, unknown>).name;
		if (typeof name !== "string") {
			continue;
		}
		labels.push(name.slice(0, MAX_LABEL_CHARS));
	}
	return { number, title, body, labels };
}

/**
 * Build the engine request from the job's environment and the raw issue JSON
 * bytes. Throws `RenderEnvError` naming the offending variable or field when
 * any bounded value fails its pattern.
 */
function buildRequestImpl(env: RenderEnv, issueJsonBytes: Uint8Array): EngineRequest {
	const repository = env.REPO ?? "";
	if (!REPO_PATTERN.test(repository)) {
		throw new RenderEnvError("REPO must be owner/repo");
	}
	const item = env.ISSUE ?? "";
	if (!ITEM_PATTERN.test(item)) {
		throw new RenderEnvError("ISSUE must be a positive integer");
	}
	const itemNumber = Number(item);
	const model =
		env.ENGINE_MODEL && env.ENGINE_MODEL !== "" ? env.ENGINE_MODEL : DEFAULT_ENGINE_MODEL;

	const issue = parseIssue(issueJsonBytes);
	if (issue.number !== itemNumber) {
		throw new RenderEnvError("issue JSON number does not match ISSUE");
	}

	const body = renderJobBody("issue-triage", {
		repository,
		itemNumber,
		triageLabels: triageLabelsFor(repository),
	});
	if (body === null) {
		throw new RenderEnvError("the issue-triage template rendered no body");
	}

	const existing = issue.labels.length > 0 ? issue.labels.join(", ") : "(none)";
	const user = [
		`Issue #${itemNumber}: ${capBytes(issue.title, MAX_TITLE_BYTES, null)}`,
		"",
		`Existing labels: ${existing}`,
		"",
		"```markdown",
		capBytes(issue.body, MAX_BODY_BYTES, BODY_TRUNCATION_MARKER),
		"```",
	].join("\n");

	return {
		model,
		reasoning_effort: "high",
		max_completion_tokens: 4000,
		messages: [
			{ role: "system", content: `${body}${ACTIONS_OUTPUT_SECTION}` },
			{ role: "user", content: user },
		],
	};
}

export const buildRequest = traced("actions.issueTriage.buildRequest", buildRequestImpl, {
	redact: { args: [0], result: true },
});

if (import.meta.main) {
	const issueJson = new Uint8Array(await Bun.stdin.arrayBuffer());
	try {
		process.stdout.write(JSON.stringify(buildRequest(process.env as RenderEnv, issueJson)));
	} catch (error) {
		if (error instanceof RenderEnvError) {
			process.stderr.write(`render-issue-triage: ${error.message}\n`);
			process.exitCode = 2;
		} else {
			throw error;
		}
	}
}
