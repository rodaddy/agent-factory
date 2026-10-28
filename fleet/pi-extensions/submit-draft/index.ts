/**
 * @module fleet/pi-extensions/submit-draft
 * @description The only write the rTech Inbox seat has (SOF-10922,
 *   rtech/rtech-consulting#835 lane C2): one `submit_draft` tool that puts the
 *   seat's ONE draft reply on the board issue that woke it and closes that
 *   issue. It sends nothing to a lead. The relay reads the comment and the owner
 *   decides what goes out.
 *
 *   - Target: only `PAPERCLIP_TASK_ID`, the run's own issue, through
 *     `PAPERCLIP_API_URL` with the run's `PAPERCLIP_API_KEY` and
 *     `X-Paperclip-Run-Id`. One PATCH `{status: "done", comment}`.
 *   - Once per run: a second call is refused, and so is a call after a failed
 *     one (the run then ends without a disposition and Paperclip surfaces it).
 *   - Before anything is written, `lint` (./lint.ts) refuses an unpublished
 *     price, an hourly rate, the owner's cell number or an empty draft without a
 *     hand-off. A refused draft comes back to the model as an error to fix.
 *     `render` writes the relay's marked comment.
 *
 *   Inert until a profile lists it.
 */
// No package imports (as every fleet extension): Pi accepts a plain JSON
// schema for `parameters`, the shape a TypeBox schema compiles to.
import { lint, render } from "./lint";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Params = { draft: string; handoff: string };
type Result = { content: { type: "text"; text: string }[]; details: { ok: boolean } };
export type DraftTool = {
	name: string;
	label: string;
	description: string;
	parameters: object;
	execute: (id: string, params: Params) => Promise<Result>;
};
type PiApi = { registerTool: (tool: DraftTool) => void };

const PARAMETERS = {
	type: "object",
	properties: {
		draft: { type: "string", description: "The reply text exactly as Rico would send it" },
		handoff: {
			type: "string",
			description: "'none', or one line: what Rico must decide himself and why",
		},
	},
	required: ["draft", "handoff"],
	additionalProperties: false,
};

/** Pi marks a thrown error as a failed tool result the model must act on. */
function fail(text: string): never {
	throw new Error(text);
}

/** The run's board context, or a refusal. */
function runContext(env: Env): { api: string; key: string; task: string; run: string } {
	const {
		PAPERCLIP_API_URL: api,
		PAPERCLIP_API_KEY: key,
		PAPERCLIP_TASK_ID: task,
		PAPERCLIP_RUN_ID: run,
	} = env;
	if (!api || !key || !task || !run) fail("submit_draft: refused, no Paperclip run context");
	return { api: api as string, key: key as string, task: task as string, run: run as string };
}

/** One PATCH: the run's own issue to done, with the marked draft comment. Throws unless the board echoes done. */
async function post(env: Env, doFetch: Fetch, params: Params): Promise<void> {
	const { api, key, task, run } = runContext(env);
	const res = await doFetch(`${api.replace(/\/+$/, "")}/api/issues/${encodeURIComponent(task)}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${key}`,
			"X-Paperclip-Run-Id": run,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ status: "done", comment: render(params.draft, params.handoff) }),
	}).catch(() => undefined);
	const body = res ? ((await res.json().catch(() => ({}))) as { status?: string }) : {};
	if (!res?.ok || body.status !== "done") {
		fail(`submit_draft: the board write failed (HTTP ${res?.status ?? "none"}); stop here.`);
	}
}

export function makeSubmitDraft(env: Env = process.env, doFetch: Fetch = fetch): DraftTool {
	let used = false;
	return {
		name: "submit_draft",
		label: "Submit draft",
		description:
			"Hand your ONE draft reply to Rico. Puts it on this run's board issue and closes the issue. Call it exactly once, at the end. It sends nothing to the lead.",
		parameters: PARAMETERS,
		async execute(_id, params) {
			if (typeof params?.draft !== "string" || typeof params?.handoff !== "string") {
				fail("submit_draft: refused, draft and handoff must both be strings");
			}
			if (used) fail("submit_draft: refused, already called in this run (one draft per wake)");
			const problem = lint(params.draft, params.handoff);
			if (problem) fail(`submit_draft: refused, ${problem}. Fix the draft and call again.`);
			runContext(env);
			used = true;
			await post(env, doFetch, params);
			const text = "submit_draft: draft posted; the issue is done. Stop now.";
			return { content: [{ type: "text", text }], details: { ok: true } };
		},
	};
}

export default function (pi: PiApi) {
	pi.registerTool(makeSubmitDraft());
}
