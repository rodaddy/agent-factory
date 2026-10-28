/**
 * @module tests/support/fake-seat-board
 * @description One fake Paperclip board plus fake Forge on loopback, for the
 *   seat tools `fleet/bin/bulk-cancel` and `fleet/bin/pause-preview`.
 *   Routes mirror @paperclipai/server 2026.916.1: GET /companies/:co/agents,
 *   GET /companies/:co/issues (assigneeAgentId, status, limit, offset),
 *   GET /companies/:co/heartbeat-runs (agentId, limit, newest first),
 *   PATCH /issues/:id, POST /heartbeat-runs/:id/cancel; Forge
 *   GET /api/v1/repos/:o/:r/pulls/:n. Every request is logged in order.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:net";

export interface Call {
	method: string;
	path: string;
	body: unknown;
	authorization: string | null;
	/** Whether `state.watch` existed when this request arrived. */
	watched: boolean;
}

export interface FakeState {
	agents: { id: string; name: string }[];
	issues: Record<string, unknown>[];
	runs: Record<string, unknown>[];
	/** "owner/repo#n" -> PR state. */
	prs: Record<string, string>;
	/** A file path whose existence each request records. */
	watch?: string;
}

function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** Start the fake on the first free port in [lo, hi]. */
export async function startFakeSeatBoard(lo: number, hi: number) {
	const calls: Call[] = [];
	const state: FakeState = { agents: [], issues: [], runs: [], prs: {} };
	let port = 0;
	for (let p = lo; p <= hi && !port; p++) if (await isFree(p)) port = p;
	if (!port) throw new Error(`no free port in ${lo}-${hi}`);
	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			const q = (k: string) => url.searchParams.get(k);
			const text = await request.text();
			calls.push({
				method: request.method,
				path,
				body: text ? JSON.parse(text) : null,
				authorization: request.headers.get("authorization"),
				watched: state.watch ? existsSync(state.watch) : false,
			});
			if (path === "/api/companies/co-1/agents") return Response.json(state.agents);
			if (path === "/api/companies/co-1/issues") {
				const hits = state.issues.filter(
					(i) => i.assigneeAgentId === q("assigneeAgentId") && i.status === q("status"),
				);
				const off = Number(q("offset") ?? 0);
				return Response.json(hits.slice(off, off + Number(q("limit") ?? 500)));
			}
			if (path === "/api/companies/co-1/heartbeat-runs") {
				return Response.json(state.runs.filter((r) => r.agentId === q("agentId")));
			}
			const issue = path.match(/^\/api\/issues\/([^/]+)$/);
			if (request.method === "PATCH" && issue) return Response.json({ id: issue[1] });
			if (request.method === "POST" && /^\/api\/heartbeat-runs\/[^/]+\/cancel$/.test(path)) {
				return Response.json({ ok: true });
			}
			const pr = path.match(/^\/forge\/api\/v1\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
			const prState = pr ? state.prs[`${pr[1]}#${pr[2]}`] : undefined;
			if (prState) return Response.json({ state: prState });
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${port}`;

	/** Run a fleet tool as a child process against this fake. */
	async function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
		const child = Bun.spawn([process.execPath, script, ...args], {
			env: {
				PATH: process.env.PATH ?? "",
				PAPERCLIP_API_URL: base,
				PAPERCLIP_API_KEY: "k-1",
				PAPERCLIP_COMPANY_ID: "co-1",
				FORGEJO_API_URL: `${base}/forge/api/v1`,
				FORGEJO_TOKEN: "t-1",
				...extraEnv,
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

	return { calls, state, run, stop: () => server.stop(true) };
}
