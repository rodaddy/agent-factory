import { expect, test } from "bun:test";
import {
	PUBLISH_NOT_FAILED_EXIT,
	PUBLISH_NOT_FOUND_EXIT,
	PUBLISH_USAGE,
	type PublishExecution,
	type PublishIo,
	runPublishCommand,
} from "../../src/github/publish-command";
import type { RedriveOutcome } from "../../src/github/publish-redrive";

function capture(): { io: PublishIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		io: {
			stdout: (message) => stdout.push(message),
			stderr: (message) => stderr.push(message),
		},
		stdout,
		stderr,
	};
}

function execution(
	outcome: RedriveOutcome | Error,
	closed: { value: boolean },
	called: number[],
): PublishExecution {
	return {
		redriveCheck: async (jobId) => {
			called.push(jobId);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		close: async () => {
			closed.value = true;
		},
	};
}

test("invalid and unsafe job ids reject before opening the database", async () => {
	const invalid = ["", "0", "-1", "1.5", "1e3", "01", "9007199254740992"];
	for (const value of invalid) {
		const output = capture();
		let created = 0;
		const code = await runPublishCommand(["redrive-check", value], output.io, async () => {
			created++;
			throw new Error("database must not open");
		});
		expect(code).toBe(2);
		expect(created).toBe(0);
		expect(output.stdout).toEqual([]);
		expect(output.stderr).toEqual([PUBLISH_USAGE]);
	}
});

test("queued redrive prints the exact deferred-delivery message and closes", async () => {
	const output = capture();
	const closed = { value: false };
	const called: number[] = [];
	const code = await runPublishCommand(["redrive-check", "42"], output.io, () =>
		execution({ status: "queued", jobId: 42, postingId: 17, previousAttempts: 5 }, closed, called),
	);

	expect(code).toBe(0);
	expect(called).toEqual([42]);
	expect(closed.value).toBe(true);
	expect(output.stdout).toEqual(["queued for next publisher pass"]);
	expect(output.stderr).toEqual([]);
});

test("not-found and not-failed outcomes have distinct bounded exits", async () => {
	const missing = capture();
	const missingClosed = { value: false };
	const missingCode = await runPublishCommand(["redrive-check", "42"], missing.io, () =>
		execution({ status: "not-found", jobId: 42 }, missingClosed, []),
	);
	expect(missingCode).toBe(PUBLISH_NOT_FOUND_EXIT);
	expect(missing.stdout).toEqual([]);
	expect(missing.stderr).toEqual(["no failed check posting found for requested job"]);
	expect(missingClosed.value).toBe(true);

	const notFailed = capture();
	const notFailedClosed = { value: false };
	const notFailedCode = await runPublishCommand(["redrive-check", "42"], notFailed.io, () =>
		execution(
			{ status: "not-failed", jobId: 42, postingId: 17, currentStatus: "posted" },
			notFailedClosed,
			[],
		),
	);
	expect(notFailedCode).toBe(PUBLISH_NOT_FAILED_EXIT);
	expect(notFailed.stdout).toEqual([]);
	expect(notFailed.stderr).toEqual(["check posting is not failed; nothing queued"]);
	expect(notFailedClosed.value).toBe(true);
});

test("execution failures are bounded and still close the connection", async () => {
	const output = capture();
	const closed = { value: false };
	const code = await runPublishCommand(["redrive-check", "42"], output.io, () =>
		execution(new Error("secret connection string must not be printed"), closed, []),
	);

	expect(code).toBe(1);
	expect(closed.value).toBe(true);
	expect(output.stdout).toEqual([]);
	expect(output.stderr).toEqual(["publish redrive-check failed at a local I/O boundary"]);
});

test("a close failure is nonzero even after a successful re-drive", async () => {
	const output = capture();
	const executionWithCloseFailure: PublishExecution = {
		redriveCheck: async () => ({
			status: "queued",
			jobId: 42,
			postingId: 17,
			previousAttempts: 5,
		}),
		close: async () => {
			throw new Error("close failed");
		},
	};

	const code = await runPublishCommand(
		["redrive-check", "42"],
		output.io,
		() => executionWithCloseFailure,
	);

	expect(code).toBe(1);
	expect(output.stdout).toEqual(["queued for next publisher pass"]);
	expect(output.stderr).toEqual(["publish redrive-check failed at a local I/O boundary"]);
});
