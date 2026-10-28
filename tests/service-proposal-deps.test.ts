import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../src/config/schema";
import type { WatcherDb } from "../src/db/client";
import { githubItems, jobs, repositories } from "../src/db/schema";
import type { GitRunner } from "../src/results/branch-publisher";
import { createProposalDeps, createValidationEnqueuer } from "../src/service-proposal-deps";
import { VALIDATE_TEMPLATE_ID } from "../src/templates/ids";
import { withTestDb } from "./db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const MANIFEST_PATH = "/etc/rodaddy-watcher/rails/factory-rails.yml";

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
		...overrides,
	};
}

/** Only the collaborators the wiring stores verbatim need to be real here. */
function inputs(cfg: WatcherConfig, railsManifestPath?: string) {
	return {
		db: {} as WatcherDb,
		config: cfg,
		git: {} as GitRunner,
		changeWorkRoot: "/var/lib/rodaddy-watcher/change-work",
		clientFor: async () => null,
		remoteFor: () => null,
		credentialFor: async () => null,
		...(railsManifestPath === undefined ? {} : { railsManifestPath }),
		onError: () => {},
	};
}

describe("createProposalDeps rails manifest path", () => {
	test("defaults to the operator's own config.railsManifestPath", () => {
		const deps = createProposalDeps(inputs(config({ railsManifestPath: MANIFEST_PATH })));

		expect(deps.railsManifestPath).toBe(MANIFEST_PATH);
	});

	test("leaves the path undefined when the operator configured none", () => {
		const deps = createProposalDeps(inputs(config()));

		expect(deps.railsManifestPath).toBeUndefined();
	});

	test("an explicit input still wins over the configured path", () => {
		const deps = createProposalDeps(
			inputs(config({ railsManifestPath: MANIFEST_PATH }), "/srv/explicit-rails.yml"),
		);

		expect(deps.railsManifestPath).toBe("/srv/explicit-rails.yml");
	});

	test("the wiring supplies an enqueueValidation dep", () => {
		const deps = createProposalDeps(inputs(config()));

		expect(deps.enqueueValidation).toBeDefined();
	});
});

const HEAD_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

/** Seed one repository and one issue, returning the ids a job row is keyed on. */
async function seedItem(db: TestDb) {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", provider: "github", checks: "standard" })
		.returning();
	if (repo === undefined) throw new Error("repository seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: 42, state: "open" })
		.returning();
	if (item === undefined) throw new Error("item seed failed");
	return { repositoryId: repo.id, itemId: item.id };
}

/** Every `repo-validate` row, oldest first. */
async function validateJobs(db: TestDb) {
	return await db
		.select({ id: jobs.id, sha: jobs.sha, repositoryId: jobs.repositoryId, itemId: jobs.itemId })
		.from(jobs)
		.where(eq(jobs.jobType, VALIDATE_TEMPLATE_ID))
		.orderBy(jobs.id);
}

/**
 * sf#173 — the enqueuer against the REAL uniqueness key.
 *
 * Dedup here is not asserted against a fake that was told to return false: it is
 * the actual `(repository_id, item_id, sha, job_type)` unique index doing the
 * work, which is the only thing that proves "idempotency is free" rather than
 * merely claimed.
 *
 * PROVEN TO FAIL: dropping `onConflictDoNothing`'s effect by keying the second
 * call at a different sha turns the dedup test red (2 rows), and mutating the
 * enqueuer to pass `candidate.dispatchedBaseSha` turns the head-sha test red.
 */
describe("createValidationEnqueuer", () => {
	test("enqueues one pending repo-validate job at the PUSHED head sha", async () => {
		await withTestDb(async (db) => {
			const { repositoryId, itemId } = await seedItem(db);
			const enqueue = createValidationEnqueuer(db);

			const created = await enqueue?.(
				{ repositoryId, itemId, dispatchedBaseSha: OTHER_SHA } as never,
				HEAD_SHA,
			);

			expect(created).toBe(true);
			const rows = await validateJobs(db);
			expect(rows).toHaveLength(1);
			// The sha is the PUSHED head, never the dispatched base.
			expect(rows[0]?.sha).toBe(HEAD_SHA);
			expect(rows[0]?.repositoryId).toBe(repositoryId);
			expect(rows[0]?.itemId).toBe(itemId);
		});
	});

	test("a second enqueue at the same head writes NOTHING and reports false", async () => {
		await withTestDb(async (db) => {
			const { repositoryId, itemId } = await seedItem(db);
			const enqueue = createValidationEnqueuer(db);
			const candidate = { repositoryId, itemId } as never;

			const first = await enqueue?.(candidate, HEAD_SHA);
			const second = await enqueue?.(candidate, HEAD_SHA);

			expect(first).toBe(true);
			// The unique key already held the row — this is the re-run of a proposal
			// pass over a candidate that stayed eligible.
			expect(second).toBe(false);
			expect(await validateJobs(db)).toHaveLength(1);
		});
	});

	test("a re-push at a NEW head is a different key and gets its own validation", async () => {
		await withTestDb(async (db) => {
			const { repositoryId, itemId } = await seedItem(db);
			const enqueue = createValidationEnqueuer(db);
			const candidate = { repositoryId, itemId } as never;

			await enqueue?.(candidate, HEAD_SHA);
			const second = await enqueue?.(candidate, OTHER_SHA);

			// The verdict belongs to a TREE, not to a branch name.
			expect(second).toBe(true);
			expect((await validateJobs(db)).map((r) => r.sha)).toEqual([HEAD_SHA, OTHER_SHA]);
		});
	});
});
