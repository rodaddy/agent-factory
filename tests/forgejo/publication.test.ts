import { describe, expect, test } from "bun:test";
import { eq, ne } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type {
	CommitCheck,
	CommitCheckLookup,
	ForgeClient,
	ForgePage,
	ForgeResponse,
} from "../../src/forge/boundary";
import { ForgeRegistry } from "../../src/forge/registry";
import type { JobIdentity } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { publishLabel } from "../../src/github/publish-writers";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];
const at = new Date("2026-07-23T12:00:00.000Z");

class FakeForgejo implements ForgeClient {
	readonly provider = "forgejo" as const;
	readonly reads: string[] = [];
	readonly writes: Array<{ method: string; path: string; body?: unknown }> = [];
	readonly checks: CommitCheck[] = [];
	incompleteComments = false;
	missingLabel: string | null = null;
	private nextId = 500;

	async get<T>(): Promise<ForgeResponse<T>> {
		return { status: 200, data: [] as T, link: null, rateRemaining: null };
	}

	async getPage<T>(path: string): Promise<ForgePage<T>> {
		this.reads.push(path);
		if (path.includes("/labels?")) {
			return {
				body: [
					{ id: 1, name: "watcher:passed" },
					{ id: 2, name: "watcher:failed" },
					{ id: 3, name: "watcher:error" },
					{ id: 4, name: "watcher:skipped" },
				].filter((label) => label.name !== this.missingLabel) as T,
				next: null,
			};
		}
		if (path.includes("/comments?")) {
			return {
				body: [] as T,
				next: this.incompleteComments ? "https://invalid.example/page=2" : null,
			};
		}
		if (path.includes("/issues?")) {
			return { body: [] as T, next: null };
		}
		return { body: [] as T, next: null };
	}

	async paginate<T>(): Promise<T[]> {
		return [];
	}

	async write<T>(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<ForgeResponse<T>> {
		this.writes.push({ method, path, body });
		// sf#816 probe: Forgejo answers a DELETE of a label the repo lacks with 422.
		if (
			method === "DELETE" &&
			this.missingLabel !== null &&
			path.endsWith(`/labels/${encodeURIComponent(this.missingLabel)}`)
		) {
			throw new Error("Forgejo request failed: HTTP 422: label does not exist");
		}
		if (path.endsWith("/labels") && method === "POST") {
			return {
				status: 200,
				data: [{ name: "watcher:passed" }] as T,
				link: null,
				rateRemaining: null,
			};
		}
		return {
			status: 200,
			data: (path.endsWith("/comments")
				? { id: this.nextId++ }
				: path.endsWith("/issues")
					? { number: this.nextId++ }
					: {}) as T,
			link: null,
			rateRemaining: null,
		};
	}

	async postCommitCheck(
		_repository: string,
		check: CommitCheck,
	): Promise<{ status: "posted"; externalRef: string }> {
		this.checks.push(check);
		return { status: "posted", externalRef: check.context };
	}

	async findCommitCheck(): Promise<CommitCheckLookup> {
		return { status: "absent" };
	}
}

function registryFor(client: ForgeClient): ForgeRegistry {
	return new ForgeRegistry({
		forgejoDeployment: {
			apiUrl: "https://forge.example.internal/api/v1",
			webUrl: "https://forge.example.internal",
			cloneBase: "https://forge.example.internal",
		},
		resolveForgejoToken: () => ({ ok: true, token: "test" }),
		createForgejoClient: () => client,
	});
}

async function seed(db: TestDb): Promise<JobIdentity> {
	const [repo] = await db
		.insert(repositories)
		.values({ provider: "forgejo", fullName: "rodaddy/x" })
		.onConflictDoUpdate({
			target: [repositories.provider, repositories.fullName],
			set: { checks: "standard" },
		})
		.returning();
	if (!repo) throw new Error("seed failed");
	const sha = "a".repeat(40);
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "pull", number: 7, state: "open", headSha: sha })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha,
			jobType: "pr-review",
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return {
		jobId: job.id,
		repository: "rodaddy/x",
		itemNumber: 7,
		sha,
		jobType: "pr-review",
	};
}

function result(): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: 7,
		sha: "a".repeat(40),
		status: "passed",
		checks: [],
		findings: [],
	};
}

describe("Forgejo provider-aware publication", () => {
	test("records removal of an absent Forgejo label as a posted no-op", async () => {
		const forgejo = new FakeForgejo();
		forgejo.missingLabel = "watcher:skipped";
		const outcome = await publishLabel(
			{
				client: forgejo,
				shadow: false,
				recordShadow: async () => ({ status: "posted" }),
			},
			{
				kind: "label",
				action: "remove",
				target: "watcher:skipped",
				label: "watcher:skipped",
				itemNumber: 7,
			},
			{
				provider: "forgejo",
				repository: "rodaddy/x",
				itemNumber: 7,
				sha: "a".repeat(40),
				jobType: "pr-review",
				itemKind: "pull",
				itemState: "open",
				itemHeadSha: "a".repeat(40),
			},
		);

		expect(outcome).toEqual({ status: "posted" });
		expect(forgejo.writes).toEqual([
			{
				method: "DELETE",
				path: "/repos/rodaddy/x/issues/7/labels/watcher%3Askipped",
				body: undefined,
			},
		]);
	});

	test("uses Forgejo label names, comment params, and commit-status seam", async () => {
		await withTestDb(async (db) => {
			const identity = await seed(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const forgejo = new FakeForgejo();
			const summary = await new GitHubPublisher(db, registryFor(forgejo), {
				now: () => at,
			}).run();

			expect(summary.failed).toBe(0);
			expect(forgejo.reads.some((p) => p.endsWith("/comments?limit=50"))).toBe(true);
			expect(forgejo.reads.some((p) => p.includes("/labels?"))).toBe(false);
			expect(
				forgejo.writes.some(
					(w) =>
						w.path.endsWith("/labels") &&
						JSON.stringify(w.body) === JSON.stringify({ labels: ["watcher:passed"] }),
				),
			).toBe(true);
			expect(forgejo.checks).toHaveLength(1);
			expect(forgejo.checks[0]?.context).toBe("software-factory");
		});
	});

	test("refuses comment creation when X-Total-Count proves the non-pageable set incomplete", async () => {
		await withTestDb(async (db) => {
			const identity = await seed(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			await db.delete(githubPostings).where(ne(githubPostings.kind, "comment"));
			const forgejo = new FakeForgejo();
			forgejo.incompleteComments = true;
			const summary = await new GitHubPublisher(db, registryFor(forgejo), {
				now: () => at,
				backoffMs: 0,
			}).run();

			expect(summary.retryable).toBe(1);
			expect(forgejo.writes.some((w) => w.path.endsWith("/comments"))).toBe(false);
			const [row] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(row?.lastError).toContain("count exceeds");
		});
	});
});
