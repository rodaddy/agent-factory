/**
 * @module prepush/command
 * @description CLI adapter for `prepush status <sha>`: a READ-ONLY view of the
 *   `factory/prepush` commit status Forge holds for one commit (L-114).
 *   The runner-box receipt and `prepush validate` are retired; the one full
 *   check per head is `.forgejo/workflows/prepush.yml`, which posts that status.
 *
 * @outputs
 *   - `runPrepushCommand` -- exit 0 success, 1 failure/error, 2 pending, absent,
 *     usage, or the retired `validate`
 *   - `PrepushStatusReader` -- injectable read boundary
 */

import { errorClass, log, traced } from "../log";

export interface PrepushIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

const processIo: PrepushIo = {
	stdout: (message) => process.stdout.write(`${message}\n`),
	stderr: (message) => process.stderr.write(`${message}\n`),
};

export const PREPUSH_CONTEXT = "factory/prepush";
const REPOSITORY = "rodaddy/software-factory";
const API_URL = "https://forge.example.internal/api/v1";
const PREPUSH_USAGE = "Usage: software-factory prepush status <sha>";
export const VALIDATE_RETIRED =
	"prepush validate is retired (sf#828): the full check runs as factory/prepush on the PR head; read it with 'prepush status <sha>'";

/** One commit status as Forge reports it. */
export interface PrepushStatus {
	readonly state: string;
	readonly description: string;
	readonly targetUrl: string;
}

/** Returns the newest `factory/prepush` status for `sha`, or null when absent. */
export type PrepushStatusReader = (sha: string) => Promise<PrepushStatus | null>;

/** Read the combined status for `sha` and pick the `factory/prepush` entry. */
const forgeStatusReader: PrepushStatusReader = async (sha) => {
	const headers: Record<string, string> = { accept: "application/json" };
	const token = process.env.FORGEJO_TOKEN;
	if (token) headers.authorization = `token ${token}`;
	const response = await fetch(`${API_URL}/repos/${REPOSITORY}/commits/${sha}/status`, {
		headers,
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Forge status read answered ${response.status}`);
	const body = (await response.json()) as { statuses?: unknown };
	const statuses = Array.isArray(body.statuses) ? body.statuses : [];
	for (const entry of statuses as Array<Record<string, unknown>>) {
		if (entry.context !== PREPUSH_CONTEXT) continue;
		return {
			state: String(entry.status ?? entry.state ?? ""),
			description: String(entry.description ?? ""),
			targetUrl: String(entry.target_url ?? ""),
		};
	}
	return null;
};

/** Run one pre-push subcommand and return its process exit code. */
export const runPrepushCommand = traced(
	"prepush.runPrepushCommand",
	async function runPrepushCommand(
		args: readonly string[],
		io: PrepushIo = processIo,
		read: PrepushStatusReader = forgeStatusReader,
	): Promise<number> {
		if (args[0] === "validate") {
			io.stderr(VALIDATE_RETIRED);
			return 2;
		}
		const sha = args[1] ?? "";
		if (args[0] !== "status" || args.length !== 2 || !/^[0-9a-f]{40,64}$/.test(sha)) {
			io.stderr(PREPUSH_USAGE);
			return 2;
		}
		let status: PrepushStatus | null;
		try {
			status = await read(sha);
		} catch (err) {
			log("error", "prepush.status.failed", { error_class: errorClass(err) });
			io.stderr("prepush status: the Forge status read failed");
			return 1;
		}
		if (status === null) {
			io.stdout(`${PREPUSH_CONTEXT} ${sha}: absent`);
			return 2;
		}
		io.stdout(
			`${PREPUSH_CONTEXT} ${sha}: ${status.state} -- ${status.description} ${status.targetUrl}`.trim(),
		);
		if (status.state === "success") return 0;
		if (status.state === "pending") return 2;
		return 1;
	},
	// Argument 0 is raw argv; a mistyped invocation can carry a credentialed URL.
	{ redact: { args: [0] } },
);
