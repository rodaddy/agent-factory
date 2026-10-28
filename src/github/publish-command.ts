/**
 * @module github/publish-command
 * @description CLI adapter for the explicit failed-check re-drive. This command
 *   changes only durable local posting state; the normal publisher owns the
 *   subsequent forge write.
 */
import { createDb } from "../db/client";
import { errorClass, log, traced } from "../log";
import { isPositiveJobId, type RedriveOutcome, redriveFailedCheck } from "./publish-redrive";

export interface PublishIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

const processIo: PublishIo = {
	stdout: (message) => process.stdout.write(`${message}\n`),
	stderr: (message) => process.stderr.write(`${message}\n`),
};

export const PUBLISH_USAGE = "Usage: software-factory publish redrive-check <positive-job-id>";
export const PUBLISH_NOT_FOUND_EXIT = 3;
export const PUBLISH_NOT_FAILED_EXIT = 4;

export interface PublishExecution {
	redriveCheck(jobId: number): Promise<RedriveOutcome>;
	close(): Promise<void>;
}

function productionExecution(): PublishExecution {
	const { db, client } = createDb();
	return {
		redriveCheck: (jobId) => redriveFailedCheck(db, jobId),
		close: () => client.end(),
	};
}

/** Parse the only supported publish command before opening a database. */
export const parsePublishArgs = traced(
	"github.parsePublishArgs",
	function parsePublishArgs(args: readonly string[]): { ok: true; jobId: number } | { ok: false } {
		const token = args[0];
		if (args.length !== 2 || token !== "redrive-check") return { ok: false };
		const value = args[1];
		if (value === undefined || !isPositiveJobId(value)) return { ok: false };
		return { ok: true, jobId: Number(value) };
	},
);

function printOutcome(io: PublishIo, outcome: RedriveOutcome): number {
	if (outcome.status === "queued") {
		io.stdout("queued for next publisher pass");
		return 0;
	}
	if (outcome.status === "not-found") {
		io.stderr("no failed check posting found for requested job");
		return PUBLISH_NOT_FOUND_EXIT;
	}
	io.stderr("check posting is not failed; nothing queued");
	return PUBLISH_NOT_FAILED_EXIT;
}

/** Run the bounded operator command and always close an opened DB client. */
export const runPublishCommand = traced(
	"github.runPublishCommand",
	async function runPublishCommand(
		args: readonly string[],
		io: PublishIo = processIo,
		createExecution: () => PublishExecution | Promise<PublishExecution> = productionExecution,
	): Promise<number> {
		const parsed = parsePublishArgs(args);
		if (!parsed.ok) {
			io.stderr(PUBLISH_USAGE);
			return 2;
		}

		let execution: PublishExecution | undefined;
		let code = 1;
		try {
			execution = await createExecution();
			const outcome = await execution.redriveCheck(parsed.jobId);
			code = printOutcome(io, outcome);
		} catch (error) {
			log("error", "publish.command.failed", {
				subcommand: "redrive-check",
				error_class: errorClass(error),
			});
			io.stderr("publish redrive-check failed at a local I/O boundary");
			code = 1;
		} finally {
			if (execution) {
				try {
					await execution.close();
				} catch (error) {
					log("error", "publish.command.close_failed", {
						subcommand: "redrive-check",
						error_class: errorClass(error),
					});
					io.stderr("publish redrive-check failed at a local I/O boundary");
					code = 1;
				}
			}
		}
		return code;
	},
);
