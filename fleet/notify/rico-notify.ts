/**
 * @module fleet/notify/rico-notify
 * @description The job that tells the owner when the board needs him. One
 *   pass: read-only GETs to the fleet board, the rules in `./rules.ts`, the
 *   send plan in `./plan.ts`, then each text through `imsg send ... --json`
 *   with no shell, and the state file written after every text that went out.
 *   It never writes to the board or to Forge. Runs on host01 under launchd
 *   with Node 24 type stripping, and under bun in tests, so it imports
 *   siblings with the `.ts` extension and uses no `Bun.*`.
 *
 *   Usage: rico-notify.ts [--dry-run]   (--dry-run prints, sends and writes nothing)
 *   Exit: 0 ok, 1 board or send failure, 2 config.
 *
 *   Config (process environment, then the `KEY=VALUE` lines of the mode 600
 *   file named by RICO_NOTIFY_ENV_FILE, which win):
 *     PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_BOARD_TOKEN,
 *     RICO_NOTIFY_TO            required; the last two are never printed
 *     RICO_NOTIFY_DIR           where the job's files live
 *                               (default /opt/factory-notify)
 *     RICO_NOTIFY_STATE         state file (default <dir>/state.json)
 *     RICO_NOTIFY_SEND          sender (default /opt/homebrew/bin/imsg)
 *     RICO_NOTIFY_BOARD_LINK    board address a phone can open (default the API URL)
 *     RICO_NOTIFY_BOARD_PREFIX  the company's URL prefix on the board, when it needs one
 *     RICO_NOTIFY_HEARTBEAT     `1` sends one "alive" text a day; OFF by default
 *     RICO_NOTIFY_HEARTBEAT_HOUR  local hour it may go from (default 8)
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	boardPass,
	budget,
	emptyState,
	forget,
	type Message,
	markSent,
	plan,
	remember,
	type State,
	scrub,
	withPending,
} from "./plan.ts";
import {
	type AgentRow,
	type ApprovalRow,
	approvalItems,
	badAgents,
	blockedItems,
	type CommentRow,
	type IssueRow,
	type Item,
	issuesToScan,
	type RunRow,
	tellItems,
} from "./rules.ts";

const DEFAULT_DIR = "/opt/factory-notify";
const DEFAULT_SEND = "/opt/homebrew/bin/imsg";
const GET_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 20_000;
const BOARD_DOWN_KEY = "board:down";
const DEFAULT_HEARTBEAT_HOUR = 8;
const REQUIRED = [
	"PAPERCLIP_API_URL",
	"PAPERCLIP_COMPANY_ID",
	"PAPERCLIP_BOARD_TOKEN",
	"RICO_NOTIFY_TO",
] as const;

interface Config {
	api: string;
	company: string;
	token: string;
	to: string;
	statePath: string;
	send: string;
	boardLink: string;
	heartbeat: boolean;
	heartbeatHour: number;
}

/** A refusal with its exit code; the message never carries a config value. */
class Exit extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** The board did not answer one GET; the whole pass is a board failure. */
class BoardError extends Error {}

/** Values that must never reach stdout, stderr or a log line. */
const secrets: string[] = [];

function readEnvFile(path: string): Record<string, string> {
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		throw new Exit(2, "env file is not readable");
	}
	if ((mode & 0o077) !== 0) throw new Exit(2, "env file must be mode 600");
	const values: Record<string, string> = {};
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		const eq = line.indexOf("=");
		if (line === "" || line.startsWith("#") || eq < 1) continue;
		values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return values;
}

function loadConfig(): Config {
	const env: Record<string, string | undefined> = { ...process.env };
	const file = env.RICO_NOTIFY_ENV_FILE;
	if (file) Object.assign(env, readEnvFile(file));
	for (const name of REQUIRED) {
		if (!env[name]) throw new Exit(2, `${name} is required`);
	}
	const api = (env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "");
	const token = env.PAPERCLIP_BOARD_TOKEN ?? "";
	const to = env.RICO_NOTIFY_TO ?? "";
	secrets.push(token, to);
	const base = (env.RICO_NOTIFY_BOARD_LINK || api).replace(/\/+$/, "");
	const prefix = (env.RICO_NOTIFY_BOARD_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
	const hour = Number(env.RICO_NOTIFY_HEARTBEAT_HOUR || DEFAULT_HEARTBEAT_HOUR);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
		throw new Exit(2, "RICO_NOTIFY_HEARTBEAT_HOUR must be 0 to 23");
	}
	return {
		heartbeat: env.RICO_NOTIFY_HEARTBEAT === "1",
		heartbeatHour: hour,
		api,
		company: env.PAPERCLIP_COMPANY_ID ?? "",
		token,
		to,
		statePath: env.RICO_NOTIFY_STATE || join(env.RICO_NOTIFY_DIR || DEFAULT_DIR, "state.json"),
		send: env.RICO_NOTIFY_SEND || DEFAULT_SEND,
		boardLink: prefix === "" ? base : `${base}/${prefix}`,
	};
}

function readState(path: string): State {
	if (!existsSync(path)) return emptyState();
	try {
		return { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<State>) };
	} catch {
		throw new Exit(1, "state file is not valid JSON");
	}
}

async function get(cfg: Config, path: string): Promise<unknown> {
	const refuse = (what: string) => new BoardError(`board GET ${path} -> ${what}`);
	let res: Response;
	try {
		res = await fetch(`${cfg.api}/api${path}`, {
			headers: { Authorization: `Bearer ${cfg.token}` },
			signal: AbortSignal.timeout(GET_TIMEOUT_MS),
		});
	} catch (err) {
		throw refuse(err instanceof Error ? err.name : "error");
	}
	if (!res.ok) throw refuse(String(res.status));
	try {
		return await res.json();
	} catch {
		throw refuse("not JSON");
	}
}

async function list<T>(cfg: Config, path: string): Promise<T[]> {
	const body = await get(cfg, path);
	if (!Array.isArray(body)) throw new BoardError(`board GET ${path} -> not a list`);
	return body as T[];
}

/**
 * Every text carries a direct link to the one thing it is about: the Forge
 * link the rule found, else that issue's, approval's or agent's own board page.
 */
function linked(items: Item[], boardPage: string): Item[] {
	return items.map((item) => ({ ...item, link: item.link ?? boardPage }));
}

/** One read-only pass over the board. The rules filter again client-side. */
async function collect(
	cfg: Config,
	state: State,
	nowMs: number,
): Promise<{ items: Item[]; errorPasses: Record<string, number> }> {
	const co = `/companies/${cfg.company}`;
	const page = (kind: string, id: string) => `${cfg.boardLink}/${kind}/${encodeURIComponent(id)}`;
	const issuePage = (issue: IssueRow) => page("issues", issue.identifier || issue.id);

	const issues = await list<IssueRow>(cfg, `${co}/issues?status=blocked&limit=1000`);
	const approvals = await list<ApprovalRow>(cfg, `${co}/approvals?status=pending`);
	const agents = await list<AgentRow>(cfg, `${co}/agents`);
	const runs = await list<RunRow>(cfg, `${co}/heartbeat-runs?limit=400`);

	const items: Item[] = [];
	for (const issue of issues) items.push(...linked(blockedItems([issue]), issuePage(issue)));
	for (const approval of approvals) {
		items.push(...linked(approvalItems([approval]), page("approvals", approval.id)));
	}
	for (const id of issuesToScan(runs, nowMs)) {
		const issue = (await get(cfg, `/issues/${id}`)) as IssueRow;
		const comments = await list<CommentRow>(cfg, `/issues/${id}/comments`);
		items.push(...linked(tellItems(issue, comments, nowMs), issuePage(issue)));
	}
	const bad = badAgents(agents, runs, state.errorPasses, nowMs);
	for (const item of bad.items) {
		items.push(...linked([item], page("agents", item.key.slice("agent:".length))));
	}
	return { items, errorPasses: bad.errorPasses };
}

function printPlanned(messages: Message[]): void {
	for (const message of messages) {
		process.stdout.write(`--- ${message.keys.join(" ")}\n${scrub(message.text, secrets)}\n`);
	}
}

function firstLine(text: string | null | undefined): string {
	return (text ?? "").trim().split("\n", 1)[0] ?? "";
}

/** True when imsg's `--json` output reports status `sent`, whole or on any line. */
function reportsSent(stdout: string): boolean {
	for (const chunk of [stdout, ...stdout.split("\n")]) {
		try {
			if ((JSON.parse(chunk) as { status?: unknown } | null)?.status === "sent") return true;
		} catch {
			// Not JSON: try the next line.
		}
	}
	return false;
}

/**
 * Hands one text to imsg: one argv element, no shell. Returns null when imsg
 * exits 0 and reports status `sent`, else why not. Sent means handed to
 * Messages, never proof of delivery.
 */
function send(cfg: Config, text: string): string | null {
	const args = ["send", "--to", cfg.to, "--service", "imessage", "--text", text, "--json"];
	const done = spawnSync(cfg.send, args, { timeout: SEND_TIMEOUT_MS, encoding: "utf8" });
	if (done.error) return done.error.message;
	if (done.status !== 0) return firstLine(done.stderr) || `sender exit ${done.status}`;
	if (reportsSent(done.stdout)) return null;
	return firstLine(done.stderr) || firstLine(done.stdout) || "sender did not report status sent";
}

function sendFailed(why: string): void {
	process.stderr.write(`rico-notify: send failed: ${scrub(why, secrets)}\n`);
}

/** Same directory, then rename: a reader never sees half a state file. */
function writeState(path: string, state: State): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** One "alive" text a day from the configured local hour. OFF unless switched on. */
function heartbeat(cfg: Config, state: State, waiting: number, nowMs: number): Message | null {
	const now = new Date(nowMs);
	if (!cfg.heartbeat || !state.primed || now.getHours() < cfg.heartbeatHour) return null;
	const key = `heartbeat:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
	if (key in state.sent) return null;
	return {
		text: `Factory notifier is alive. ${waiting} waiting on you.\n${cfg.boardLink}`,
		keys: [key],
	};
}

/** The board did not answer: count it, and say so once on the 3rd pass in a row. */
function boardFailed(cfg: Config, before: State, nowMs: number): State {
	const failed = boardPass(before, false);
	if (!failed.down) return failed.state;
	// The alert spends the shared hourly budget; with none left it waits for the next failed pass.
	if (budget(failed.state, nowMs) <= 0)
		return { ...failed.state, boardFails: failed.state.boardFails - 1 };
	const why = send(cfg, `Board unreachable from host01 for 3 checks in a row.\n${cfg.boardLink}`);
	if (why !== null) {
		sendFailed(why);
		// Not told yet: the next failed pass is the 3rd again.
		return { ...failed.state, boardFails: failed.state.boardFails - 1 };
	}
	process.stdout.write(`rico-notify: sent ${BOARD_DOWN_KEY}\n`);
	// The first-pass summary is still owed, so this text does not prime the state.
	return { ...markSent(failed.state, [BOARD_DOWN_KEY], nowMs), primed: before.primed };
}

async function main(args: string[]): Promise<number> {
	const dryRun = args.length === 1 && args[0] === "--dry-run";
	if (args.length > 0 && !dryRun) throw new Exit(2, "usage: rico-notify.ts [--dry-run]");
	const cfg = loadConfig();
	let state = readState(cfg.statePath);
	const nowMs = Date.now();

	let got: Awaited<ReturnType<typeof collect>>;
	try {
		got = await collect(cfg, state, nowMs);
	} catch (err) {
		if (!(err instanceof BoardError) || dryRun) throw err;
		process.stderr.write(`rico-notify: ${err.message}\n`);
		writeState(cfg.statePath, boardFailed(cfg, state, nowMs));
		return 1;
	}

	state = { ...boardPass(state, true).state, errorPasses: got.errorPasses };
	state = forget(
		state,
		got.items.map((item) => item.key),
		nowMs,
	);
	const items = withPending(state, got.items);
	state = remember(state, items, nowMs);
	const { messages } = plan(items, state, nowMs, cfg.boardLink);
	const beat = heartbeat(cfg, state, items.length, nowMs);
	// The heartbeat spends the same hourly budget as the planned texts.
	if (beat && messages.length < budget(state, nowMs)) messages.push(beat);
	if (dryRun) {
		printPlanned(messages);
		return 0;
	}

	let code = 0;
	for (const message of messages) {
		const why = send(cfg, message.text);
		if (why !== null) {
			// The unsent keys stay unsent and go on the next pass.
			sendFailed(why);
			code = 1;
			break;
		}
		state = markSent(state, message.keys, nowMs);
		writeState(cfg.statePath, state);
		process.stdout.write(`rico-notify: sent ${message.keys.join(" ")}\n`);
	}
	writeState(cfg.statePath, state);
	return code;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		const message = err instanceof Error ? err.message : "unexpected failure";
		process.stderr.write(`rico-notify: ${scrub(message, secrets)}\n`);
		process.exitCode = err instanceof Exit ? err.code : 1;
	},
);
