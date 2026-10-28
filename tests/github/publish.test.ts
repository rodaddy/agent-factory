import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { GitHubClient, GitHubResponse } from "../../src/github/client";
import { type JobIdentity, RESULT_LABELS } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-07-20T12:00:00.000Z");

/** A recorded write against the fake GitHub API. */
interface WriteCall {
	method: string;
	path: string;
	body?: unknown;
}

/**
 * A fake GitHub client that models labels, comments, and check runs in memory,
 * with GitHub-native dedup: comments carry the marker in their body, check runs
 * carry `external_id`, so the publisher's list-then-upsert recovers a duplicate.
 */
class FakeGitHub {
	writes: WriteCall[] = [];
	comments = new Map<string, Array<{ id: number; body: string }>>();
	checks = new Map<
		string,
		Array<{ id: number; name: string; external_id: string; conclusion: string }>
	>();
	labels = new Map<string, Set<string>>();
	private nextId = 100;
	failFirstComment = false;
	private commentFailArmed = false;
	omitCommentIdOnce = false;
	private commentIdOmissionArmed = false;
	failCheckOnce = false;
	private checkFailArmed = false;
	/** When set, every comment dedupe page reports a truncated (still-`next`) scan. */
	truncateCommentScan = false;
	/** When set, the comment dedupe page returns a non-array (malformed) body. */
	malformCommentBody = false;
	/** When set, the check dedupe page reports a truncated (still-`next`) scan. */
	truncateCheckScan = false;
	/** When set, the check dedupe page returns an invalid-shape body. */
	malformCheckBody = false;
	/** When set, a comment dedupe entry is malformed (bad id / non-string body). */
	malformCommentEntry = false;
	/** When set, a check dedupe entry is malformed (bad id / non-string external_id). */
	malformCheckEntry = false;
	/**
	 * Async gate: when >0, every remote *create* (comment/check POST) awaits this
	 * many event-loop turns before mutating, so two concurrent publishers genuinely
	 * overlap at the write boundary. Row locking must still serialize them.
	 */
	writeYields = 0;

	private async gate(): Promise<void> {
		for (let i = 0; i < this.writeYields; i++) {
			await Promise.resolve();
		}
	}

	arm(): void {
		this.commentFailArmed = this.failFirstComment;
		this.commentIdOmissionArmed = this.omitCommentIdOnce;
		this.checkFailArmed = this.failCheckOnce;
	}

	private commentKey(repo: string, item: number): string {
		return `${repo}#${item}`;
	}
	private checkKey(repo: string, sha: string): string {
		return `${repo}@${sha}`;
	}

	asClient(): GitHubClient {
		const self = this;
		const resp = <T>(data: T): GitHubResponse<T> => ({
			status: 200,
			data,
			link: null,
			rateRemaining: null,
		});
		return {
			async get<T>(path: string): Promise<GitHubResponse<T>> {
				// check-runs listing for the exact SHA
				const m = path.match(/\/repos\/(.+)\/commits\/([^/]+)\/check-runs/);
				if (m) {
					const runs = self.checks.get(self.checkKey(m[1] as string, m[2] as string)) ?? [];
					return resp({ check_runs: runs } as unknown as T);
				}
				return resp([] as unknown as T);
			},
			async getPage<T>(path: string): Promise<{ body: T; next: string | null }> {
				// check-runs listing (object-shaped) for the exact SHA
				const c = path.match(/\/repos\/(.+)\/commits\/([^/?]+)\/check-runs/);
				if (c) {
					if (self.malformCheckBody) {
						// A 200 whose body is not the documented object shape.
						return { body: "not-an-object" as unknown as T, next: null };
					}
					const runs: Array<unknown> = [
						...(self.checks.get(self.checkKey(c[1] as string, c[2] as string)) ?? []),
					];
					if (self.malformCheckEntry) {
						// A well-shaped page whose one entry has an unreadable required field.
						runs.push({ id: "not-a-number", external_id: 42 });
					}
					// A truncated scan always leaves a `next` page unresolved.
					const nextLink = self.truncateCheckScan ? `${path}&page=next` : null;
					return { body: { check_runs: runs } as unknown as T, next: nextLink };
				}
				// comment listing (bare array), newest-first
				const m = path.match(/\/repos\/(.+)\/issues\/(\d+)\/comments/);
				if (m) {
					if (self.malformCommentBody) {
						return { body: { unexpected: true } as unknown as T, next: null };
					}
					const list: Array<unknown> = [
						...(self.comments.get(self.commentKey(m[1] as string, Number(m[2]))) ?? []),
					].reverse();
					if (self.malformCommentEntry) {
						// A well-shaped array page whose one entry has an unreadable required field.
						list.push({ id: 5, body: 12345 });
					}
					const nextLink = self.truncateCommentScan ? `${path}&page=next` : null;
					return { body: list as unknown as T, next: nextLink };
				}
				return { body: [] as unknown as T, next: null };
			},
			async paginate<T>(path: string): Promise<T[]> {
				const m = path.match(/\/repos\/(.+)\/issues\/(\d+)\/comments/);
				if (m) {
					const list = self.comments.get(self.commentKey(m[1] as string, Number(m[2]))) ?? [];
					return list as unknown as T[];
				}
				return [];
			},
			async write<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
				self.writes.push({ method, path, body });

				// Labels: POST add, DELETE remove.
				const labelAdd = path.match(/\/repos\/(.+)\/issues\/(\d+)\/labels$/);
				if (labelAdd && method === "POST") {
					const key = `${labelAdd[1]}#${labelAdd[2]}`;
					const set = self.labels.get(key) ?? new Set<string>();
					for (const l of (body as { labels: string[] }).labels) set.add(l);
					self.labels.set(key, set);
					// GitHub returns the item's full label set; the publisher validates it.
					return resp([...set].map((name) => ({ name })) as unknown as T);
				}
				const labelDel = path.match(/\/repos\/(.+)\/issues\/(\d+)\/labels\/(.+)$/);
				if (labelDel && method === "DELETE") {
					const key = `${labelDel[1]}#${labelDel[2]}`;
					self.labels.get(key)?.delete(decodeURIComponent(labelDel[3] as string));
					return resp(null as unknown as T);
				}

				// Comment create.
				const commentCreate = path.match(/\/repos\/(.+)\/issues\/(\d+)\/comments$/);
				if (commentCreate && method === "POST") {
					// Yield before mutating so a concurrent publisher overlaps this write.
					await self.gate();
					if (self.commentFailArmed) {
						self.commentFailArmed = false;
						// Simulate a crash window: the remote write happened, but the caller
						// never sees success (error thrown after the mutation).
						const key = self.commentKey(commentCreate[1] as string, Number(commentCreate[2]));
						const list = self.comments.get(key) ?? [];
						list.push({ id: self.nextId++, body: (body as { body: string }).body });
						self.comments.set(key, list);
						throw new Error("GitHub request failed: network error");
					}
					const key = self.commentKey(commentCreate[1] as string, Number(commentCreate[2]));
					const list = self.comments.get(key) ?? [];
					const id = self.nextId++;
					list.push({ id, body: (body as { body: string }).body });
					self.comments.set(key, list);
					if (self.commentIdOmissionArmed) {
						self.commentIdOmissionArmed = false;
						return resp({} as T);
					}
					return resp({ id } as unknown as T);
				}
				// Comment update (dedup path).
				const commentPatch = path.match(/\/repos\/(.+)\/issues\/comments\/(\d+)$/);
				if (commentPatch && method === "PATCH") {
					return resp({ id: Number(commentPatch[2]) } as unknown as T);
				}

				// Check create.
				const checkCreate = path.match(/\/repos\/(.+)\/check-runs$/);
				if (checkCreate && method === "POST") {
					// Yield before mutating so a concurrent publisher overlaps this write.
					await self.gate();
					const b = body as {
						head_sha: string;
						name: string;
						external_id: string;
						conclusion: string;
					};
					if (self.checkFailArmed) {
						self.checkFailArmed = false;
						const key = self.checkKey(checkCreate[1] as string, b.head_sha);
						const list = self.checks.get(key) ?? [];
						list.push({
							id: self.nextId++,
							name: b.name,
							external_id: b.external_id,
							conclusion: b.conclusion,
						});
						self.checks.set(key, list);
						throw new Error("GitHub request failed: network error");
					}
					const key = self.checkKey(checkCreate[1] as string, b.head_sha);
					const list = self.checks.get(key) ?? [];
					const id = self.nextId++;
					list.push({ id, name: b.name, external_id: b.external_id, conclusion: b.conclusion });
					self.checks.set(key, list);
					return resp({ id } as unknown as T);
				}
				const checkPatch = path.match(/\/repos\/(.+)\/check-runs\/(\d+)$/);
				if (checkPatch && method === "PATCH") {
					return resp({ id: Number(checkPatch[2]) } as unknown as T);
				}

				return resp(null as unknown as T);
			},
		} as unknown as GitHubClient;
	}
}

/** Strict forge fake for the receipt -> state-flip dependency. */
class RejectingReceiptForge {
	writes: WriteCall[] = [];

	private response<T>(data: T): GitHubResponse<T> {
		return { status: 200, data, link: null, rateRemaining: null };
	}

	asClient(): GitHubClient {
		return {
			get: async (path: string) => {
				throw new Error(`unscripted get: ${path}`);
			},
			getPage: async <T>(path: string) => {
				if (path.includes("/comments")) {
					return { body: [] as T, next: null };
				}
				if (path.includes("/check-runs")) {
					return { body: { check_runs: [] } as T, next: null };
				}
				throw new Error(`unscripted getPage: ${path}`);
			},
			paginate: async (path: string) => {
				throw new Error(`unscripted paginate: ${path}`);
			},
			write: async <T>(method: string, path: string, body?: unknown) => {
				this.writes.push({ method, path, body });
				if (method === "POST" && path.endsWith("/comments")) {
					throw new Error("fixture receipt comment POST failed");
				}
				if (method === "DELETE" && path.includes("/labels/")) {
					return this.response(null as T);
				}
				if (method === "POST" && path.endsWith("/labels")) {
					const labels = (body as { labels: string[] }).labels;
					return this.response(labels.map((name) => ({ name })) as T);
				}
				if (method === "POST" && path.endsWith("/check-runs")) {
					return this.response({ id: 901 } as T);
				}
				throw new Error(`unscripted write: ${method} ${path}`);
			},
		} as unknown as GitHubClient;
	}
}

async function seedJob(
	db: TestDb,
	options: {
		itemNumber?: number | null;
		sha?: string;
		jobId?: number;
		/** The repository's DURABLE forge provider; `row.provider` reads from it. */
		provider?: "github" | "forgejo";
	} = {},
): Promise<JobIdentity> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", provider: options.provider ?? "github" })
		.onConflictDoUpdate({
			target: [repositories.provider, repositories.fullName],
			set: { checks: "standard" },
		})
		.returning();
	if (!repo) throw new Error("seed failed");
	const itemNumber = options.itemNumber === undefined ? 7 : options.itemNumber;
	const sha = options.sha === undefined ? "deadbeefcafe" : options.sha;
	const [item] =
		itemNumber === null
			? []
			: await db
					.insert(githubItems)
					.values({
						repositoryId: repo.id,
						kind: "pull",
						number: itemNumber,
						state: "open",
						headSha: sha,
					})
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
	return { jobId: job.id, repository: "rodaddy/x", itemNumber, sha, jobType: "pr-review" };
}

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: 7,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		...overrides,
	};
}

describe("GitHubPublisher — successful publication", () => {
	test("posts labels, comment, and exact-SHA check; stores external ids; not repeated", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.arm();
			const pub = new GitHubPublisher(db, gh.asClient(), { now: () => at });

			const summary = await pub.run();
			expect(summary.failed).toBe(0);
			expect(summary.scanned).toBeGreaterThan(0);

			// Check was bound to the exact trusted SHA.
			const checkWrite = gh.writes.find((w) => w.path.endsWith("/check-runs"));
			expect(checkWrite).toBeDefined();
			const checkBody = checkWrite?.body as { head_sha: string } | undefined;
			expect(checkBody?.head_sha).toBe("deadbeefcafe");

			// Every row is posted with an external ref where the API returns one.
			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			for (const r of rows) {
				expect(r.status).toBe("posted");
			}
			const comment = rows.find((r) => r.kind === "comment");
			const check = rows.find((r) => r.kind === "check");
			expect(comment?.externalRef).toBeTruthy();
			expect(check?.externalRef).toBeTruthy();

			// A second pass posts nothing new (already posted, not re-scanned).
			const writesBefore = gh.writes.length;
			const again = await pub.run();
			expect(again.scanned).toBe(0);
			expect(gh.writes.length).toBe(writesBefore);
		});
	});
});

describe("GitHubPublisher — GitHub-side dedup recovers a crash window", () => {
	test("comment created remotely but never acked is not duplicated on retry", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.failFirstComment = true;
			gh.arm();

			// First pass: the comment write mutates GitHub but throws (crash window),
			// so the local row stays pending/retryable.
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			const key = "rodaddy/x#7";
			expect(gh.comments.get(key)?.length).toBe(1);
			const [afterFail] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterFail?.status).toBe("pending");

			// Second pass: the marker-based dedup finds the existing comment and
			// PATCHes it instead of posting a duplicate.
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			expect(gh.comments.get(key)?.length).toBe(1); // still exactly one
			const [afterRecover] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterRecover?.status).toBe("posted");
		});
	});

	test("a successful create without an external id stays retryable and deduplicates", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.omitCommentIdOnce = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			const [afterMissingId] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterMissingId?.status).toBe("pending");
			expect(gh.comments.get("rodaddy/x#7")?.length).toBe(1);

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			const [afterRecover] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterRecover?.status).toBe("posted");
			expect(afterRecover?.externalRef).toBeTruthy();
			expect(gh.comments.get("rodaddy/x#7")?.length).toBe(1);
		});
	});

	test("check created remotely but never acked is not duplicated on retry", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.failCheckOnce = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			const key = "rodaddy/x@deadbeefcafe";
			expect(gh.checks.get(key)?.length).toBe(1);

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			expect(gh.checks.get(key)?.length).toBe(1); // no duplicate check run
			const patch = gh.writes.find((w) => w.method === "PATCH" && w.path.includes("/check-runs/"));
			expect(patch).toBeDefined();
			expect(patch?.body).not.toHaveProperty("head_sha");
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("posted");
		});
	});
});

describe("GitHubPublisher — provider routing", () => {
	test("a forgejo-provider row resolves its client through the registry, not `unhandled`", async () => {
		await withTestDb(async (db) => {
			// sf#412 (umbrella sf#249): a publisher constructed WITH the registry —
			// which is what production composition always passes — must route a
			// forgejo row through `ForgeRegistry.clientFor(provider)`. The
			// "provider client unavailable" unhandled path is reserved for a provider
			// the registry cannot resolve, never for forgejo simply BEING forgejo.
			const identity = await seedJob(db, { provider: "forgejo" });
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });

			const forge = new FakeGitHub();
			forge.arm();
			const asked: string[] = [];
			const registry = {
				clientFor: async (provider: string) => {
					asked.push(provider);
					return { ok: true as const, client: forge.asClient() };
				},
			};

			await new GitHubPublisher(db, registry as never, {
				now: () => at,
				backoffMs: 0,
			}).run();

			// The registry was asked for the ROW's provider.
			expect(asked).toContain("forgejo");
			// MUTATION TARGET: send forgejo down the unhandled path and this reds —
			// every row stays unposted with "provider client unavailable".
			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			expect(rows.length).toBeGreaterThan(0);
			// NOTHING was refused for lacking a client: the registry resolved one.
			for (const r of rows) {
				expect(r.lastError ?? "").not.toBe("provider client unavailable");
			}
			// And the client was actually USED — the comment and the exact-SHA check
			// both posted through it. (Label rows are not asserted here: this fake
			// does not pre-seed repository labels, so they refuse for an unrelated
			// fixture reason in every test that uses it.)
			const posted = rows.filter((r) => r.kind === "comment" || r.kind === "check");
			expect(posted.length).toBeGreaterThan(0);
			for (const r of posted) expect(r.status).toBe("posted");
		});
	});

	test("a provider the registry CANNOT resolve is still recorded unhandled", async () => {
		await withTestDb(async (db) => {
			// The fail-closed half of the same seam: lifting the forgejo pin must not
			// remove the unhandled path, only narrow it to an unresolvable provider.
			const identity = await seedJob(db, { provider: "forgejo" });
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });

			const registry = {
				clientFor: async () => ({ ok: false as const, error: "forgejo token unavailable" }),
			};

			await new GitHubPublisher(db, registry as never, {
				now: () => at,
				backoffMs: 0,
				maxAttempts: 1,
			}).run();

			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) {
				expect(r.status).toBe("failed");
				expect(r.lastError).toBe("forgejo token unavailable");
			}
		});
	});
});

describe("GitHubPublisher — isolation and safety", () => {
	test("a failed receipt comment POST blocks the later state-flip label write", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const forge = new RejectingReceiptForge();

			await new GitHubPublisher(db, forge.asClient(), {
				now: () => at,
				backoffMs: 0,
				maxAttempts: 1,
			}).run();

			const commentPosts = forge.writes.filter(
				(call) => call.method === "POST" && call.path.endsWith("/comments"),
			);
			expect(commentPosts).toHaveLength(1);
			const states = new Set<string>(Object.values(RESULT_LABELS));
			const stateWrites = forge.writes.filter((call) => {
				if (call.method === "POST" && call.path.endsWith("/labels")) {
					const labels = (call.body as { labels?: unknown[] } | undefined)?.labels ?? [];
					return labels.some((label) => states.has(String(label)));
				}
				if (call.method !== "DELETE" || !call.path.includes("/labels/")) return false;
				const label = decodeURIComponent(call.path.split("/").at(-1) ?? "");
				return states.has(label);
			});
			expect(stateWrites).toEqual([]);
		});
	});

	test("one failing plan does not prevent another from posting", async () => {
		await withTestDb(async (db) => {
			const a = await seedJob(db, { itemNumber: 7 });
			const b = await seedJob(db, { itemNumber: 8 });
			await persistPublicationPlans({ tx: db, identity: a, result: result(), now: at });
			await persistPublicationPlans({
				tx: db,
				identity: b,
				result: result({ item_number: 8 }),
				now: at,
			});

			// Corrupt job A's comment payload so its publish path throws when decoded.
			await db
				.update(githubPostings)
				.set({ payload: "{not-json" })
				.where(eq(githubPostings.jobId, a.jobId));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			// Job B still fully posts.
			const bRows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, b.jobId));
			for (const r of bRows) expect(r.status).toBe("posted");
			// Job A's corrupt rows are marked failed, not left blocking.
			const aRows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, a.jobId));
			for (const r of aRows) expect(r.status).toBe("failed");
		});
	});

	test("a throwing onError sink does not abort the batch: the second job still posts", async () => {
		await withTestDb(async (db) => {
			// Two jobs queue plans. The FIRST row processed throws out of its transaction
			// (via the row-locked seam), driving run()'s per-row catch, and the operator's
			// error sink itself THROWS on that error. A faulty monitoring sink must not
			// escape the per-row loop: the summary must complete and the second job's plans
			// must still post. No row is wrongly advanced — the thrown row rolls back to
			// pending and a later cycle retries it.
			const a = await seedJob(db, { itemNumber: 7 });
			const b = await seedJob(db, { itemNumber: 8 });
			await persistPublicationPlans({ tx: db, identity: a, result: result(), now: at });
			await persistPublicationPlans({
				tx: db,
				identity: b,
				result: result({ item_number: 8 }),
				now: at,
			});

			// The lowest posting id (processed first) belongs to job A; force its
			// transaction to throw so run()'s catch calls the error sink.
			const [firstRow] = await db
				.select({ id: githubPostings.id })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, a.jobId))
				.orderBy(githubPostings.id)
				.limit(1);
			if (!firstRow) throw new Error("seed failed");

			let onErrorCalls = 0;
			const gh = new FakeGitHub();
			gh.arm();
			// The summary must resolve (the throwing sink never escapes the loop).
			const summary = await new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				backoffMs: 0,
				onRowLocked: async (id) => {
					if (id === firstRow.id) throw new Error("simulated mid-publish crash");
				},
				onError: () => {
					onErrorCalls++;
					throw new Error("faulty logging sink");
				},
			}).run();

			// The sink threw on job A's first row but did not abort the batch.
			expect(onErrorCalls).toBeGreaterThan(0);
			// Job B's plans still fully posted despite the throwing sink.
			const bRows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, b.jobId));
			expect(bRows.length).toBeGreaterThan(0);
			for (const r of bRows) expect(r.status).toBe("posted");
			// Job A's first row rolled back to pending (not wrongly advanced/lost); a later
			// cycle retries it. summary.scanned counts only the rows that reached the lock.
			const [firstAfter] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.id, firstRow.id));
			expect(firstAfter?.status).toBe("pending");
			expect(summary.posted).toBeGreaterThan(0);
		});
	});

	test("corrupt stored plans cannot select arbitrary labels, checks, or conclusions", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			await db
				.update(githubPostings)
				.set({
					payload: JSON.stringify({
						kind: "label",
						action: "add",
						target: "attacker-label",
						label: "attacker-label",
						itemNumber: 7,
					}),
				})
				.where(eq(githubPostings.target, "watcher:passed"));
			await db
				.update(githubPostings)
				.set({
					payload: JSON.stringify({
						kind: "check",
						action: "upsert",
						target: "check",
						name: "attacker-check",
						sha: "deadbeefcafe",
						conclusion: "action_required",
						title: "pwned",
						summary: "pwned",
						dedupeKey: "attacker-key",
					}),
				})
				.where(eq(githubPostings.kind, "check"));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at }).run();

			expect(gh.writes.some((w) => JSON.stringify(w).includes("attacker"))).toBe(false);
			expect(gh.writes.some((w) => w.path.endsWith("/check-runs"))).toBe(false);
			const failed = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.status, "failed"));
			expect(failed.some((row) => row.target === "watcher:passed")).toBe(true);
			expect(failed.some((row) => row.kind === "check")).toBe(true);
		});
	});

	test("a plan whose SHA no longer matches the trusted job is not published", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			// The authoritative job SHA changes out from under the queued check plan.
			await db.update(jobs).set({ sha: "0000000newsha" }).where(eq(jobs.id, identity.jobId));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			// No check run was written for the stale SHA.
			expect(gh.writes.some((w) => w.path.endsWith("/check-runs"))).toBe(false);
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("failed");
		});
	});
});

describe("GitHubPublisher — row-locked posting", () => {
	test("two publishers racing the same rows with Promise.all never double-post", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.arm();
			// Force real overlap: every remote create yields several event-loop turns,
			// so both publishers reach the write path together. Only the `FOR UPDATE`
			// row lock — one transaction per row, held across the create — prevents the
			// second publisher from re-reading a still-`pending` row and creating a
			// duplicate. Without the lock this races and produces two comments/checks.
			gh.writeYields = 5;
			const client = gh.asClient();

			const a = new GitHubPublisher(db, client, { now: () => at });
			const b = new GitHubPublisher(db, client, { now: () => at });
			const [sa, sb] = await Promise.all([a.run(), b.run()]);

			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			// Each row is published by exactly one publisher (scans do not double-count).
			expect(sa.scanned + sb.scanned).toBe(rows.length);
			// Each singleton remote object was created exactly once, not twice.
			expect(gh.comments.get("rodaddy/x#7")?.length).toBe(1);
			expect(gh.checks.get("rodaddy/x@deadbeefcafe")?.length).toBe(1);
			// No POST was issued twice for either singleton.
			const commentPosts = gh.writes.filter(
				(w) => w.method === "POST" && /\/issues\/\d+\/comments$/.test(w.path),
			);
			const checkPosts = gh.writes.filter(
				(w) => w.method === "POST" && w.path.endsWith("/check-runs"),
			);
			expect(commentPosts.length).toBe(1);
			expect(checkPosts.length).toBe(1);
			for (const r of rows) expect(r.status).toBe("posted");
		});
	});

	test("holds a PostgreSQL row lock across the remote operation", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const [first] = await db
				.select({ id: githubPostings.id })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId))
				.orderBy(githubPostings.id)
				.limit(1);
			if (!first) throw new Error("seed failed");

			let signalLocked: () => void = () => {};
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			let releaseLock: () => void = () => {};
			const release = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			let paused = false;
			const gh = new FakeGitHub();
			gh.arm();
			const publisher = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				onRowLocked: async (id) => {
					if (!paused && id === first.id) {
						paused = true;
						signalLocked();
						await release;
					}
				},
			});

			const publishing = publisher.run();
			await locked;
			let contenderError: unknown;
			try {
				await db.transaction(async (tx) => {
					await tx.execute(sql.raw("SET LOCAL lock_timeout = '100ms'"));
					await tx
						.select({ id: githubPostings.id })
						.from(githubPostings)
						.where(eq(githubPostings.id, first.id))
						.for("update");
				});
			} catch (error) {
				contenderError = error;
			} finally {
				releaseLock();
			}
			await publishing;

			expect((contenderError as { cause?: { errno?: string } } | undefined)?.cause?.errno).toBe(
				"55P03",
			);
			const [posted] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.id, first.id));
			expect(posted?.status).toBe("posted");
		});
	});

	test("each row is published in its own transaction, not one for the whole batch", async () => {
		await withTestDb(async (db) => {
			// Two independent jobs queue plans. Corrupting job A's comment payload makes
			// that single row throw when decoded; if the whole batch shared one
			// transaction, that error would roll back job B's writes too. Per-row
			// transactions isolate the failure so job B still fully posts.
			const a = await seedJob(db, { itemNumber: 7 });
			const b = await seedJob(db, { itemNumber: 8 });
			await persistPublicationPlans({ tx: db, identity: a, result: result(), now: at });
			await persistPublicationPlans({
				tx: db,
				identity: b,
				result: result({ item_number: 8 }),
				now: at,
			});
			await db
				.update(githubPostings)
				.set({ payload: "{not-json" })
				.where(and(eq(githubPostings.jobId, a.jobId), eq(githubPostings.kind, "comment")));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			const bRows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, b.jobId));
			for (const r of bRows) expect(r.status).toBe("posted");
			// Job A's other (well-formed) rows still posted — only the corrupt one failed.
			const aComment = await db
				.select()
				.from(githubPostings)
				.where(and(eq(githubPostings.jobId, a.jobId), eq(githubPostings.kind, "comment")));
			expect(aComment[0]?.status).toBe("failed");
		});
	});

	test("a crash mid-publish rolls back to pending and the remote marker recovers", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			// The comment create mutates GitHub but then throws (a crash window between
			// the remote write and the local commit). The transaction rolls back, so the
			// row is left `pending`, not stamped posted.
			gh.failFirstComment = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			const key = "rodaddy/x#7";
			expect(gh.comments.get(key)?.length).toBe(1);
			const [afterCrash] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterCrash?.status).toBe("pending");

			// A later pass re-locks the row, the marker-based dedupe finds the existing
			// comment and PATCHes it — no duplicate, and the row reaches posted.
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();
			expect(gh.comments.get(key)?.length).toBe(1);
			const [afterRecover] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(afterRecover?.status).toBe("posted");
		});
	});
});

describe("GitHubPublisher — publish-time item eligibility", () => {
	test("a PR whose head moved after queuing gets no label/comment written", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			// After queuing, the PR's live head moves off the job SHA (a new push).
			await db
				.update(githubItems)
				.set({ headSha: "feed0000feed" })
				.where(eq(githubItems.number, 7));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			// No label or comment write hit the stale item.
			expect(gh.writes.some((w) => w.path.includes("/labels"))).toBe(false);
			expect(gh.writes.some((w) => w.path.includes("/comments"))).toBe(false);
			const items = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			for (const r of items.filter((r) => r.kind === "label" || r.kind === "comment")) {
				expect(r.status).toBe("failed");
			}
		});
	});

	test("a closed item gets no label/comment written", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			await db.update(githubItems).set({ state: "closed" }).where(eq(githubItems.number, 7));

			const gh = new FakeGitHub();
			gh.arm();
			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.path.includes("/labels"))).toBe(false);
			expect(gh.writes.some((w) => w.path.includes("/comments"))).toBe(false);
		});
	});
});

describe("GitHubPublisher — queue-time item eligibility", () => {
	test("a stale PR head queues only the exact-SHA check, no label/comment", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			// The item's live head is not the job SHA at queue time.
			await db
				.update(githubItems)
				.set({ headSha: "feed0000feed" })
				.where(eq(githubItems.number, 7));

			// itemEligible=false: only the SHA-bound check plan is queued.
			await persistPublicationPlans({
				tx: db,
				identity,
				result: result(),
				now: at,
				itemEligible: false,
			});

			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			expect(rows.some((r) => r.kind === "check")).toBe(true);
			expect(rows.some((r) => r.kind === "label")).toBe(false);
			expect(rows.some((r) => r.kind === "comment")).toBe(false);
		});
	});
});

describe("GitHubPublisher — dedupe robustness", () => {
	test("a truncated comment scan refuses to create and stays retryable", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.truncateCommentScan = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			// No comment was posted, and the row is back to pending (retryable).
			expect(gh.writes.some((w) => w.method === "POST" && w.path.includes("/comments"))).toBe(
				false,
			);
			const [comment] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(comment?.status).toBe("pending");
			expect(comment?.lastError).toContain("indeterminate");
		});
	});

	test("a malformed comment body refuses to create and stays retryable", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.malformCommentBody = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.method === "POST" && w.path.includes("/comments"))).toBe(
				false,
			);
			const [comment] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(comment?.status).toBe("pending");
		});
	});

	test("a truncated check scan refuses to create and stays retryable", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.truncateCheckScan = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.path.endsWith("/check-runs"))).toBe(false);
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("pending");
			expect(check?.lastError).toContain("indeterminate");
		});
	});

	test("a malformed check body refuses to create and stays retryable", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.malformCheckBody = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.path.endsWith("/check-runs"))).toBe(false);
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("pending");
		});
	});

	test("a malformed comment entry (bad id/body) makes absence indeterminate, not create", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			// The page body is a well-formed array, but one entry has an unreadable
			// required field. Absence cannot be proven — the publisher must not skip it
			// and then POST a (possibly duplicate) comment.
			gh.malformCommentEntry = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.method === "POST" && w.path.includes("/comments"))).toBe(
				false,
			);
			const [comment] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(comment?.status).toBe("pending");
			expect(comment?.lastError).toContain("indeterminate");
		});
	});

	test("a check entry with nullable external_id is a valid non-match", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.checks.set("rodaddy/x@deadbeefcafe", [
				{
					id: 99,
					name: "software-factory",
					external_id: null as unknown as string,
					conclusion: "success",
				},
			]);
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at }).run();

			expect(
				gh.writes.filter((w) => w.method === "POST" && w.path.endsWith("/check-runs")),
			).toHaveLength(1);
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("posted");
		});
	});

	test("a malformed check entry (bad id/external_id) makes absence indeterminate, not create", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.malformCheckEntry = true;
			gh.arm();

			await new GitHubPublisher(db, gh.asClient(), { now: () => at, backoffMs: 0 }).run();

			expect(gh.writes.some((w) => w.method === "POST" && w.path.endsWith("/check-runs"))).toBe(
				false,
			);
			const [check] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "check"));
			expect(check?.status).toBe("pending");
			expect(check?.lastError).toContain("indeterminate");
		});
	});
});

describe("GitHubPublisher — bounded retry backoff", () => {
	test("a huge configured base backoff caps the next retry within the ceiling", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			// Force every comment/check dedupe scan to be truncated so the plans fail
			// transiently and get rescheduled with backoff.
			gh.truncateCommentScan = true;
			gh.truncateCheckScan = true;
			gh.arm();

			// A wildly oversized base backoff must not schedule a multi-hour retry.
			await new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				backoffMs: 24 * 60 * 60_000,
			}).run();

			const retryable = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.status, "pending"));
			expect(retryable.length).toBeGreaterThan(0);
			for (const r of retryable) {
				expect(r.nextAttemptAt).not.toBeNull();
				// The scheduled retry is never more than the 60s ceiling in the future.
				const delayMs = (r.nextAttemptAt as Date).getTime() - at.getTime();
				expect(delayMs).toBeLessThanOrEqual(60_000);
				expect(delayMs).toBeGreaterThan(0);
			}
		});
	});
});

describe("GitHubPublisher — add-label response validation", () => {
	test("an add-label response that omits the label stays retryable", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new FakeGitHub();
			gh.arm();

			// Wrap the client so add-label POSTs return an array WITHOUT the label.
			const inner = gh.asClient();
			const client = {
				...inner,
				async write<T>(method: string, path: string, body?: unknown) {
					if (method === "POST" && /\/labels$/.test(path)) {
						gh.writes.push({ method, path, body });
						return { status: 200, data: [] as unknown as T, link: null, rateRemaining: null };
					}
					return inner.write<T>(method as "POST", path, body);
				},
			} as unknown as GitHubClient;

			await new GitHubPublisher(db, client, { now: () => at, backoffMs: 0 }).run();

			// The `add` label row is not marked posted (its add was never confirmed).
			const wanted = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.target, "watcher:passed"));
			expect(wanted[0]?.status).toBe("pending");
		});
	});
});
