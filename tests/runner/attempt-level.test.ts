/**
 * sf#708 (708b) — DISPATCH-TIME log-level escalation.
 *
 * The level is decided where the attempt row is written and the job's prior
 * attempt count is known: a job's first attempt runs at `info`, any respawn at
 * `debug`. It lands on `job_attempts.level` and rides the render context as
 * `logLevel`, so a workflow dispatch can pass it to the lane as `log_level`.
 * This is dispatch-time escalation, NOT tail-based sampling (D15).
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import type { JobTemplateConfig } from "../../src/config/schema";
import { jobAttempts, jobs, repositories } from "../../src/db/schema";
import { attemptLevelFor } from "../../src/reconcile/attempt-level";
import { type DispatchRenderer, dispatchJob } from "../../src/runner/dispatch";
import type { RunnerAllocation, RunnerTransport } from "../../src/runner/transport";
import { renderJobDispatch } from "../../src/templates/registry";
import { withTestDb } from "../db/helpers";

const template: JobTemplateConfig = {
	id: "pr-review",
	label: "PR review",
	runner_size: "medium",
	return_mode: "patch",
};

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

function transportPlacing(vmids: number[]): RunnerTransport {
	return {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async () => {
			throw new Error("not implemented");
		},
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid: vmids.shift() ?? 9999, size: "medium" }],
		}),
		run: async () => {},
		list: async () => [],
		done: async () => {},
	};
}

async function seedJob(db: Db) {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({ repositoryId: repo.id, sha: "abc123", jobType: "pr-review", status: "pending" })
		.returning();
	if (!job) throw new Error("seed failed");
	return { ...job, repository: "rodaddy/x", provider: "github" as const, itemNumber: 42 };
}

describe("sf#708 dispatch-time attempt level", () => {
	test("the level rule: first attempt info, any respawn debug", () => {
		expect(attemptLevelFor(0)).toBe("info");
		expect(attemptLevelFor(1)).toBe("debug");
		expect(attemptLevelFor(5)).toBe("debug");
	});

	test("a job's first attempt records info and its respawn records debug, on the row and the render context", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const transport = transportPlacing([9001, 9002]);
			const seen: unknown[] = [];
			const renderDispatch: DispatchRenderer = (jobType, context) => {
				seen.push(context.logLevel);
				return renderJobDispatch(jobType, context);
			};

			const first = await dispatchJob({ db, transport, job, template, renderDispatch });
			expect(first.status).toBe("dispatched");
			// The respawn: the reclaimer re-pends the job, the next pass dispatches it again.
			await db.update(jobs).set({ status: "pending" }).where(eq(jobs.id, job.id));
			const second = await dispatchJob({ db, transport, job, template, renderDispatch });
			expect(second.status).toBe("dispatched");

			const rows = await db
				.select({ level: jobAttempts.level })
				.from(jobAttempts)
				.where(eq(jobAttempts.jobId, job.id))
				.orderBy(asc(jobAttempts.id));
			expect(rows.map((r) => r.level)).toEqual(["info", "debug"]);
			expect(seen).toEqual(["info", "debug"]);
		});
	});
});
