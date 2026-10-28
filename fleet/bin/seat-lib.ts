/**
 * @module fleet/bin/seat-lib
 * @description Board reads shared by `bulk-cancel` and `pause-preview`:
 *  one seat's agent, its issues by status, and its runs. Auth and
 *   env as `run-sweep`: PAPERCLIP_API_URL (default http://127.0.0.1:3100),
 *   PAPERCLIP_BOARD_TOKEN or PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID. The key
 *   never reaches argv, stdout or stderr.
 */

import { allowWorkTask } from "../plugins/spec-dispatch.js";

export interface Issue {
	id: string;
	identifier?: string;
	title?: string;
	status: string;
	assigneeAgentId?: string | null;
	createdAt?: string;
}

export interface Run {
	id: string;
	status: string;
	issueId?: string | null;
	contextSnapshot?: { issueId?: string } | null;
}

const base = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const token = process.env.PAPERCLIP_BOARD_TOKEN || process.env.PAPERCLIP_API_KEY;
const co = process.env.PAPERCLIP_COMPANY_ID;
const PAGE = 1000;

/** Exit 3 with `usage` when the board env is missing. */
export function requireEnv(name: string, usage: string): void {
	if (token && co) return;
	console.error(
		`${name}: PAPERCLIP_COMPANY_ID and PAPERCLIP_BOARD_TOKEN or PAPERCLIP_API_KEY are required; ${usage}`,
	);
	process.exit(3);
}

/** One board call; a non-2xx status throws `<method> <path> -> <status>`. */
export async function board<T>(
	method: "GET" | "PATCH" | "POST",
	path: string,
	body?: unknown,
): Promise<T> {
	const data = body as
		| { title?: string; description?: string; status?: string; assigneeAgentId?: string | null }
		| undefined;
	const createCompany = method === "POST" && /^\/companies\/([^/]+)\/issues$/.exec(path)?.[1];
	const changingWork =
		method === "PATCH" &&
		/^\/issues\/[^/]+$/.test(path) &&
		(data?.status === "todo" || data?.status === "in_progress" || !!data?.assigneeAgentId);
	const task = createCompany
		? data
		: changingWork
			? { ...(await board<Issue & { description?: string }>("GET", path)), ...data }
			: null;
	if (
		task &&
		!(await allowWorkTask(
			{
				config: { get: async () => null },
				secrets: {
					resolve: async () => {
						throw new Error("no Forge secret reference");
					},
				},
				issues: {
					list: async (query) => {
						const out: { originKind?: string; originId?: string }[] = [];
						for (let offset = 0; ; offset += PAGE) {
							const page = await board<typeof out>(
								"GET",
								`/companies/${query.companyId}/issues?limit=${PAGE}&offset=${offset}`,
							);
							out.push(...page);
							if (page.length < PAGE) return out;
						}
					},
					create: (spec) => board("POST", `/companies/${spec.companyId}/issues`, spec),
				},
			},
			createCompany || co || "",
			task,
		))
	)
		throw new Error("spec-ready held: write-spec queued");
	const r = await fetch(`${base}/api${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
	return (await r.json()) as T;
}

/** The agent id of the seat named `name`; throws when there is none. */
export async function seatId(name: string): Promise<string> {
	const agents = await board<{ id: string; name: string }[]>("GET", `/companies/${co}/agents`);
	const hit = agents.find((a) => a.name === name);
	if (!hit) throw new Error(`no seat named ${name}`);
	return hit.id;
}

/** Every issue assigned to `agentId` in `status`, all pages. */
export async function seatIssues(agentId: string, status: string): Promise<Issue[]> {
	const out: Issue[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const q = `assigneeAgentId=${agentId}&status=${status}&limit=${PAGE}&offset=${offset}`;
		const page = await board<Issue[]>("GET", `/companies/${co}/issues?${q}`);
		out.push(...page);
		if (page.length < PAGE) return out;
	}
}

/**
 * The seat's newest 1000 runs (the server cap; no offset exists). A full page
 * warns: a queued run older than that is not seen.
 */
export async function seatRuns(name: string, agentId: string): Promise<Run[]> {
	const runs = await board<Run[]>(
		"GET",
		`/companies/${co}/heartbeat-runs?agentId=${agentId}&limit=${PAGE}`,
	);
	if (runs.length >= PAGE)
		console.error(`${name}: warning: ${PAGE} runs listed, the cap; older runs are not seen`);
	return runs;
}

export function runIssue(run: Run): string | null {
	return run.issueId ?? run.contextSnapshot?.issueId ?? null;
}
