/**
 * @module tests/observability/build-bump-alert
 * @description The §8 stuck-bump alert, in two halves that are deliberately
 *   tested apart.
 *
 *   `stuckPairs` is the WHOLE decision — the threshold and the status rule — so
 *   it is exercised as a pure table with no database and no forge. The db half
 *   then proves only what the pure half cannot: that the candidate join names the
 *   repository, and that each surviving row reaches `raiseCriticalAlert` with the
 *   exact dedupe class.
 *
 *   NO NETWORK. The target's `client` is a recording fake, per the trap in the
 *   lane brief: `raiseCriticalAlert` never throws and returns `undefined`, so an
 *   assertion on its return value would pass against a completely broken egress.
 *   What is observable is the forge WRITE it performs, so that is what is
 *   asserted.
 */
import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import {
	type BuildBumpCandidateRow,
	buildBumpBumps,
	buildBumpCandidates,
	buildBumpMarkers,
} from "../../src/db/schema";
import type { ForgeClient, ForgePage, ForgeResponse } from "../../src/forge/boundary";
import {
	buildBumpAlertClass,
	buildBumpUnbuiltAlertClass,
	type DesiredScope,
	desiredScope,
	runBuildBumpAlerts,
	type StuckPairRow,
	scopedStuckPairs,
	scopedUnbuiltCandidates,
	stuckPairs,
	type UnbuiltCandidateRow,
	unbuiltCandidates,
} from "../../src/observability/build-bump-alert";
import type { CriticalAlertTarget } from "../../src/observability/critical-alert";
import { CRITICAL_ALERT_TITLE_PREFIX } from "../../src/observability/critical-alert";
import { withTestDb } from "../db/helpers";

/**
 * A recording fake forge client. Only the dedupe scan (`getPage`) and the issue
 * POST (`write`) are reachable from the alert path; every other verb throws, so a
 * change that widened the forge surface would fail loudly here.
 */
function fakeTarget(): { target: CriticalAlertTarget; titles: string[] } {
	const bodies: string[] = [];
	const titles: string[] = [];
	const client = {
		provider: "forgejo",
		get: () => {
			throw new Error("get() must not be called by the alert path");
		},
		getPage: <T>(): Promise<ForgePage<T>> =>
			Promise.resolve({
				body: bodies.map((body, i) => ({ id: i + 1, number: i + 1, body })) as unknown as T,
				next: null,
			}),
		paginate: () => {
			throw new Error("paginate() must not be called by the alert path");
		},
		write: <T>(_method: string, _path: string, body?: unknown): Promise<ForgeResponse<T>> => {
			const payload = body as { title?: string; body?: string };
			titles.push(payload.title ?? "");
			// Record the created issue so a second raise in the same pass dedupes on it.
			bodies.push(payload.body ?? "");
			return Promise.resolve({
				status: 201,
				data: { number: titles.length, id: titles.length } as unknown as T,
				link: null,
				rateRemaining: null,
			});
		},
		postCommitCheck: () => {
			throw new Error("postCommitCheck() must not be called by the alert path");
		},
		findCommitCheck: () => {
			throw new Error("findCommitCheck() must not be called by the alert path");
		},
	} as unknown as ForgeClient;
	return {
		target: { repository: "rodaddy/software-factory", client: () => Promise.resolve(client) },
		titles,
	};
}

function row(overrides: Partial<StuckPairRow>): StuckPairRow {
	return {
		repository: "rodaddy/mcp2cli",
		candidateId: 1,
		appDir: "mcp2cli",
		status: "pending",
		attempts: 3,
		reason: "PUSH_FAILED",
		...overrides,
	};
}

describe("stuckPairs", () => {
	test("the threshold is three: two pending attempts is not yet stuck", () => {
		expect(stuckPairs([row({ attempts: 2 })])).toEqual([]);
	});

	test("three pending attempts is stuck", () => {
		const three = row({ attempts: 3 });
		expect(stuckPairs([three])).toEqual([three]);
	});

	/**
	 * `opened` is convergence and `refused` is the script JUDGING the request —
	 * `ALREADY_AT_TAG` means the manifest is already correct. Neither is a fault,
	 * whatever the attempt count says.
	 */
	test("only `pending` alerts; a terminal pair at any count does not", () => {
		for (const status of ["opened", "refused", "failed"]) {
			expect(stuckPairs([row({ status, attempts: 9 })])).toEqual([]);
		}
	});

	/**
	 * §6 removed harness terminality, so a pair keeps counting past three: `b` at
	 * four must stay stuck. An equality check would go quiet on exactly the pair
	 * failing hardest.
	 */
	test("selects only the qualifying rows from a mixed set, in input order", () => {
		const rows = [
			row({ appDir: "a", attempts: 2 }),
			row({ appDir: "b", attempts: 4 }),
			row({ appDir: "c", status: "opened", attempts: 7 }),
			row({ appDir: "d", attempts: 3 }),
		];
		expect(stuckPairs(rows).map((r) => r.appDir)).toEqual(["b", "d"]);
	});
});

function candidate(overrides: Partial<UnbuiltCandidateRow> = {}): UnbuiltCandidateRow {
	return {
		id: 1,
		repository: "rodaddy/mcp2cli",
		tag: "v1.2.3",
		status: "failed",
		requeues: 3,
		buildReason: "BackoffLimitExceeded",
		...overrides,
	};
}

/**
 * The second signal: a marker on a candidate whose build keeps failing. No pair
 * row can exist before the image does, so `stuckPairs` is structurally blind to
 * it and this filter is the only thing standing between that loop and silence.
 */
describe("unbuiltCandidates", () => {
	test("the threshold is three: two requeues is not yet an alert", () => {
		expect(unbuiltCandidates([candidate({ requeues: 2 })])).toEqual([]);
	});

	test("three requeues is an alert", () => {
		const three = candidate({ requeues: 3 });
		expect(unbuiltCandidates([three])).toEqual([three]);
	});

	/**
	 * The pass re-queues `failed` -> `pending`, and the build pass then claims it
	 * as `building`. A scan that only matched `failed` would see the row in a
	 * narrow window and alert or not depending on which pass happened to land
	 * there — the whole cycle except `built` is the same unconverged state.
	 */
	test("every status except `built` alerts once the count is reached", () => {
		for (const status of ["pending", "building", "failed"]) {
			expect(unbuiltCandidates([candidate({ status })])).toHaveLength(1);
		}
	});

	/** `built` is convergence, whatever it cost to get there. */
	test("a candidate that eventually built raises nothing at any count", () => {
		expect(unbuiltCandidates([candidate({ status: "built", requeues: 12 })])).toEqual([]);
	});

	/** The requeue is UNBOUNDED by design (§6): `d` at six must stay an alert. */
	test("selects only the qualifying rows from a mixed set, in input order", () => {
		const rows = [
			candidate({ tag: "a", requeues: 1 }),
			candidate({ tag: "b", requeues: 3 }),
			candidate({ tag: "c", status: "built", requeues: 9 }),
			candidate({ tag: "d", requeues: 6 }),
		];
		expect(unbuiltCandidates(rows).map((r) => r.tag)).toEqual(["b", "d"]);
	});
});

/**
 * A built candidate row, narrowed to what `desiredCandidateFor` reads.
 *
 * Cast rather than fully constructed: the selector touches `id`, `status`, `sha`,
 * `tag`, and `tagCreatedAt`, and spelling out twenty nullable columns would hide
 * which five the decision actually turns on.
 */
function candidateRow(overrides: {
	id: number;
	tag: string;
	sha: string;
	status?: string;
	tagCreatedAt?: Date;
}): BuildBumpCandidateRow {
	return {
		status: "built",
		tagCreatedAt: new Date("2026-09-01T00:00:00.000Z"),
		...overrides,
	} as unknown as BuildBumpCandidateRow;
}

/**
 * THE SCOPING STEP, exercised as a pure table.
 *
 * It is the whole of the new decision, and the db tests below prove only that the
 * queries feed it the right rows. Separated for the same reason `stuckPairs` is
 * separate from the query it serves.
 */
describe("desiredScope", () => {
	test("an environment with no enrolment contributes nothing", () => {
		const scope = desiredScope([]);
		expect(scope.pairs.size).toBe(0);
		expect(scope.unbuilt.size).toBe(0);
	});

	/**
	 * EVERY app directory, not just the first. `/status.json` reports a
	 * representative pair; an alert must not, because a pair wedged on the second
	 * directory is exactly as wedged as one on the first.
	 */
	test("a tag environment wants its newest built candidate, for every app_dir it lists", () => {
		const scope = desiredScope([
			{
				environments: [{ name: "live", app_dirs: ["one", "two"] }],
				candidates: [
					candidateRow({ id: 1, tag: "v1", sha: "a", tagCreatedAt: new Date("2026-01-01") }),
					candidateRow({ id: 2, tag: "v2", sha: "b", tagCreatedAt: new Date("2026-06-01") }),
				],
				markers: [],
				tagPattern: "v*",
			},
		]);
		expect([...scope.pairs].sort()).toEqual(["2\tone", "2\ttwo"].sort());
	});

	/** The marker's candidate, not the newest: the whole point of a marker. */
	test("a marker environment wants the candidate sharing the marker's commit", () => {
		const scope = desiredScope([
			{
				environments: [
					{ name: "live", app_dirs: ["one"] },
					{ name: "prod", app_dirs: ["two"], promote: "marker", marker: "prod" },
				],
				candidates: [
					candidateRow({ id: 1, tag: "v1", sha: "a", tagCreatedAt: new Date("2026-01-01") }),
					candidateRow({ id: 2, tag: "v2", sha: "b", tagCreatedAt: new Date("2026-06-01") }),
				],
				markers: [{ repository: "r", marker: "prod", sha: "a" } as never],
				tagPattern: "v*",
			},
		]);
		expect([...scope.pairs].sort()).toEqual(["1\ttwo", "2\tone"].sort());
	});

	/**
	 * `marker-unbuilt` contributes to the OTHER set: no pair row can exist before
	 * the image does, so keying it as a pair would make the unbuilt signal
	 * permanently unreachable.
	 */
	test("a marker on an unbuilt candidate contributes a candidate id, not a pair", () => {
		const scope = desiredScope([
			{
				environments: [
					{ name: "live", app_dirs: ["one"] },
					{ name: "prod", app_dirs: ["two"], promote: "marker", marker: "prod" },
				],
				candidates: [candidateRow({ id: 7, tag: "v7", sha: "z", status: "failed" })],
				markers: [{ repository: "r", marker: "prod", sha: "z" } as never],
				tagPattern: "v*",
			},
		]);
		expect([...scope.unbuilt]).toEqual([7]);
		expect(scope.pairs.size).toBe(0);
	});

	/** A marker pointing at a commit no candidate carries desires nothing at all. */
	test("a marker matching no candidate contributes nothing", () => {
		const scope = desiredScope([
			{
				environments: [
					{ name: "live", app_dirs: ["one"] },
					{ name: "prod", app_dirs: ["two"], promote: "marker", marker: "prod" },
				],
				candidates: [candidateRow({ id: 1, tag: "v1", sha: "a" })],
				markers: [{ repository: "r", marker: "prod", sha: "gone" } as never],
				tagPattern: "v*",
			},
		]);
		expect(scope.unbuilt.size).toBe(0);
		expect([...scope.pairs]).toEqual(["1\tone"]);
	});
});

describe("scopedStuckPairs", () => {
	const scope: DesiredScope = { pairs: new Set(["4\tmcp2cli"]), unbuilt: new Set() };

	test("a counted pair the scope wants survives", () => {
		expect(scopedStuckPairs([row({ candidateId: 4 })], scope)).toHaveLength(1);
	});

	/** The un-enrolled / superseded case: identical row, absent from the scope. */
	test("a counted pair for a candidate nothing wants is dropped", () => {
		expect(scopedStuckPairs([row({ candidateId: 9 })], scope)).toEqual([]);
	});

	/** The pair identity is BOTH halves: the right candidate on the wrong directory is not it. */
	test("the right candidate on a directory no environment lists is dropped", () => {
		expect(scopedStuckPairs([row({ candidateId: 4, appDir: "other" })], scope)).toEqual([]);
	});
});

describe("scopedUnbuiltCandidates", () => {
	const scope: DesiredScope = { pairs: new Set(), unbuilt: new Set([4]) };

	test("a counted candidate a marker still points at survives", () => {
		expect(scopedUnbuiltCandidates([candidate({ id: 4 })], scope)).toHaveLength(1);
	});

	/** The moved-marker case: `requeues` is never reset, so only the scope can drop it. */
	test("a counted candidate no marker points at any more is dropped", () => {
		expect(scopedUnbuiltCandidates([candidate({ id: 9 })], scope)).toEqual([]);
	});
});

describe("buildBumpUnbuiltAlertClass", () => {
	/**
	 * (repository, tag), never the app directory: one image failed to build, and
	 * keying on the directory would report one fault as one issue per environment
	 * that wanted it. The climbing count stays out for the usual reason.
	 */
	test("is repository and tag, and carries neither reason nor count", () => {
		const cls = buildBumpUnbuiltAlertClass("rodaddy/mcp2cli", "v1.2.3");
		expect(cls).toBe("build-bump unbuilt rodaddy/mcp2cli v1.2.3");
		expect(cls).not.toContain("BackoffLimitExceeded");
		expect(cls).not.toContain(" 3");
	});
});

describe("buildBumpAlertClass", () => {
	/**
	 * The class IS the dedupe identity. Pinned exactly, because anything varying
	 * that leaked into it — the attempt count, the reason — would open a fresh
	 * issue every pass rather than reusing one.
	 */
	test("is repository and app_dir, and carries neither reason nor count", () => {
		const cls = buildBumpAlertClass("rodaddy/mcp2cli", "mcp2cli");
		expect(cls).toBe("build-bump stuck rodaddy/mcp2cli mcp2cli");
		expect(cls).not.toContain("PUSH_FAILED");
		expect(cls).not.toContain("3");
	});
});

/**
 * A config enrolling each named repository with one `live` environment owning the
 * given app directories.
 *
 * THE ENROLMENT IS NOW PART OF EVERY DB TEST, because the pass reads it: a row
 * whose repository is absent here is exactly the historical row the scoping step
 * exists to drop, so a fixture that omitted it would test nothing.
 */
function enrolment(
	entries: Array<{
		repository: string;
		environments: Array<{ name: string; app_dirs: string[]; promote?: string; marker?: string }>;
	}>,
): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: entries.map((entry) => ({
			name: entry.repository,
			provider: "forgejo",
			checks: "static-only",
			gate_selection: "full",
			build_bump: { environments: entry.environments, tag_pattern: "v*" },
		})),
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	} as unknown as WatcherConfig;
}

/** The two live enrolments the pair tests seed against. */
function pairEnrolment(): WatcherConfig {
	return enrolment([
		{ repository: "rodaddy/mcp2cli", environments: [{ name: "live", app_dirs: ["mcp2cli"] }] },
		{
			repository: "acme/acme-ai",
			environments: [{ name: "live", app_dirs: ["acme-portal-uat"] }],
		},
	]);
}

/** Seed one candidate and one pair, returning the candidate id the pair bumps. */
async function seedPair(
	db: Parameters<Parameters<typeof withTestDb>[0]>[0],
	opts: {
		repository: string;
		appDir: string;
		status: string;
		attempts: number;
		reason: string;
		/** Varied only where one test seeds two candidates on one repository. */
		tag?: string;
	},
): Promise<number> {
	const tag = opts.tag ?? "v1.2.3";
	const [candidate] = await db
		.insert(buildBumpCandidates)
		.values({
			repository: opts.repository,
			tag,
			sha: tag.padEnd(40, "0"),
			image: opts.repository.slice(opts.repository.indexOf("/") + 1),
			status: "built",
		})
		.returning();
	if (!candidate) throw new Error("seed failed");
	const candidateId = candidate.id;
	await db.insert(buildBumpBumps).values({
		candidateId,
		appDir: opts.appDir,
		status: opts.status,
		attempts: opts.attempts,
		reason: opts.reason,
	});
	return candidateId;
}

/**
 * Seed one unbuilt candidate and, optionally, the marker pointing at it.
 *
 * The marker is what makes the candidate DESIRED: `desiredCandidateFor` answers
 * `marker-unbuilt` only for the row sharing the marker's commit, so a test that
 * seeds the candidate and no marker is seeding the moved-marker case.
 */
async function seedUnbuilt(
	db: Parameters<Parameters<typeof withTestDb>[0]>[0],
	opts: { repository: string; tag: string; requeues: number; markerSha?: string },
): Promise<void> {
	const sha = opts.tag.padEnd(40, "0");
	await db.insert(buildBumpCandidates).values({
		repository: opts.repository,
		tag: opts.tag,
		sha,
		image: opts.repository.slice(opts.repository.indexOf("/") + 1),
		status: "failed",
		requeues: opts.requeues,
		buildReason: "BackoffLimitExceeded",
	});
	if (opts.markerSha !== undefined) {
		await db
			.insert(buildBumpMarkers)
			.values({ repository: opts.repository, marker: "prod", sha: opts.markerSha });
	}
}

/** The marker enrolment the unbuilt tests seed against: a tag stream, then `prod`. */
function markerEnrolment(): WatcherConfig {
	return enrolment([
		{
			repository: "rodaddy/mcp2cli",
			environments: [
				{ name: "live", app_dirs: ["mcp2cli"] },
				{ name: "prod", app_dirs: ["mcp2cli-prod"], promote: "marker", marker: "prod" },
			],
		},
	]);
}

describe("runBuildBumpAlerts", () => {
	test("raises one alert per stuck pair, titled by the dedupe class", async () => {
		await withTestDb(async (db) => {
			await seedPair(db, {
				repository: "rodaddy/mcp2cli",
				appDir: "mcp2cli",
				status: "pending",
				attempts: 3,
				reason: "PUSH_FAILED",
			});
			await seedPair(db, {
				repository: "acme/acme-ai",
				appDir: "acme-portal-uat",
				status: "pending",
				attempts: 5,
				reason: "UNKNOWN_ARGUMENT",
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(db, fake.target, pairEnrolment());

			expect([...fake.titles].sort()).toEqual(
				[
					`${CRITICAL_ALERT_TITLE_PREFIX}build-bump stuck acme/acme-ai acme-portal-uat`,
					`${CRITICAL_ALERT_TITLE_PREFIX}build-bump stuck rodaddy/mcp2cli mcp2cli`,
				].sort(),
			);
		});
	});

	test("a pair below the threshold, and a terminal one above it, raise nothing", async () => {
		await withTestDb(async (db) => {
			await seedPair(db, {
				repository: "rodaddy/mcp2cli",
				appDir: "mcp2cli",
				status: "pending",
				attempts: 2,
				reason: "PUSH_FAILED",
			});
			await seedPair(db, {
				repository: "rodaddy/rtech-mcps",
				appDir: "mcp-unifi",
				status: "opened",
				attempts: 8,
				reason: null as unknown as string,
			});

			// BOTH repositories enrolled, so the scoping step cannot be what makes
			// this pass: the threshold and the status rule are still the only reasons
			// either row is rejected.
			const fake = fakeTarget();
			await runBuildBumpAlerts(
				db,
				fake.target,
				enrolment([
					{
						repository: "rodaddy/mcp2cli",
						environments: [{ name: "live", app_dirs: ["mcp2cli"] }],
					},
					{
						repository: "rodaddy/rtech-mcps",
						environments: [{ name: "live", app_dirs: ["mcp-unifi"] }],
					},
				]),
			);

			expect(fake.titles).toEqual([]);
		});
	});

	/**
	 * OFF BY DEFAULT: with no target the pass still reads, and makes not one forge
	 * call. The fake would throw on any verb it does not expect, so "no target, no
	 * throw" is the whole assertion available — and it is the one that matters,
	 * since this runs inside the reconcile cycle.
	 */
	test("an unconfigured target raises nothing and does not throw", async () => {
		await withTestDb(async (db) => {
			await seedPair(db, {
				repository: "rodaddy/mcp2cli",
				appDir: "mcp2cli",
				status: "pending",
				attempts: 4,
				reason: "CLONE_FAILED",
			});
			expect(await runBuildBumpAlerts(db, undefined, pairEnrolment())).toBeUndefined();
		});
	});

	/**
	 * The dedupe is `raiseCriticalAlert`'s, not this module's, but the property
	 * §8 promises is end-to-end: two stuck rows on ONE (repository, app_dir) must
	 * not become two issues.
	 *
	 * TWO CANDIDATES, BOTH DESIRED, ON ONE APP DIRECTORY. `(candidate_id, app_dir)`
	 * is unique, so two rows for one pair require two candidates — and both must
	 * survive the scoping step or the dedupe would not be what collapsed them.
	 * The tag environment wants the newest; a marker environment placed on the
	 * OLDER one, sharing the same `app_dirs`, wants that. Two qualifying rows, one
	 * dedupe class, one issue.
	 */
	test("two stuck rows for one (repository, app_dir) open a single issue", async () => {
		await withTestDb(async (db) => {
			for (const [index, attempts] of [3, 4].entries()) {
				await seedPair(db, {
					repository: "rodaddy/mcp2cli",
					appDir: "mcp2cli",
					status: "pending",
					attempts,
					reason: "PUSH_FAILED",
					tag: `v1.2.${index}`,
				});
			}
			await db.insert(buildBumpMarkers).values({
				repository: "rodaddy/mcp2cli",
				marker: "prod",
				sha: "v1.2.0".padEnd(40, "0"),
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(
				db,
				fake.target,
				enrolment([
					{
						repository: "rodaddy/mcp2cli",
						environments: [
							{ name: "live", app_dirs: ["mcp2cli"] },
							{ name: "prod", app_dirs: ["mcp2cli"], promote: "marker", marker: "prod" },
						],
					},
				]),
			);

			expect(fake.titles).toHaveLength(1);
		});
	});

	/**
	 * THE CASE WITH NO PAIR ROW AT ALL. A marker on a candidate whose build fails
	 * permanently is re-queued every pass forever; nothing reaches
	 * `build_bump_bumps`, so the pair scan sees an empty table and the lane was
	 * spending one Kaniko Job per cycle in complete silence.
	 */
	test("a candidate re-queued three times with no pair row raises the unbuilt alert", async () => {
		await withTestDb(async (db) => {
			await seedUnbuilt(db, {
				repository: "rodaddy/mcp2cli",
				tag: "v9.9.9",
				requeues: 3,
				markerSha: "v9.9.9".padEnd(40, "0"),
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(db, fake.target, markerEnrolment());

			expect(fake.titles).toEqual([
				`${CRITICAL_ALERT_TITLE_PREFIX}build-bump unbuilt rodaddy/mcp2cli v9.9.9`,
			]);
		});
	});

	test("a candidate re-queued twice raises nothing", async () => {
		await withTestDb(async (db) => {
			await seedUnbuilt(db, {
				repository: "rodaddy/mcp2cli",
				tag: "v9.9.8",
				requeues: 2,
				markerSha: "v9.9.8".padEnd(40, "0"),
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(db, fake.target, markerEnrolment());

			expect(fake.titles).toEqual([]);
		});
	});

	/**
	 * THE DEFECT (a). Both alert queries read history, and nothing in
	 * `build_bump_bumps` records that a repository was un-enrolled: the row keeps
	 * its `pending` status and its attempt count forever, satisfies the threshold
	 * on every pass, and the dedupe then makes the resulting issue look like one
	 * live incident rather than a permanent false signal.
	 */
	test("a stuck pair for a repository no longer enrolled raises nothing", async () => {
		await withTestDb(async (db) => {
			await seedPair(db, {
				repository: "rodaddy/mcp2cli",
				appDir: "mcp2cli",
				status: "pending",
				attempts: 3,
				reason: "PUSH_FAILED",
			});

			const fake = fakeTarget();
			// A config enrolling a DIFFERENT repository: the rows are untouched and
			// still qualify on every field the pure filter reads.
			await runBuildBumpAlerts(
				db,
				fake.target,
				enrolment([
					{
						repository: "rodaddy/rtech-mcps",
						environments: [{ name: "live", app_dirs: ["mcp-unifi"] }],
					},
				]),
			);

			expect(fake.titles).toEqual([]);
		});
	});

	/**
	 * THE OTHER HALF OF (a)/(b): the SAME seeded rows, with the enrolment present.
	 * Paired with the test above so the difference between raising and not raising
	 * is exactly the enrolment, never the row data.
	 */
	test("the same pair, for an environment that currently wants that candidate, raises once", async () => {
		await withTestDb(async (db) => {
			await seedPair(db, {
				repository: "rodaddy/mcp2cli",
				appDir: "mcp2cli",
				status: "pending",
				attempts: 3,
				reason: "PUSH_FAILED",
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(db, fake.target, pairEnrolment());

			expect(fake.titles).toEqual([
				`${CRITICAL_ALERT_TITLE_PREFIX}build-bump stuck rodaddy/mcp2cli mcp2cli`,
			]);
		});
	});

	/**
	 * THE DEFECT (c). `requeues` is never reset, so a candidate a marker has since
	 * moved away from keeps its count for the life of the row — the first
	 * permanently failing build a repository ever had would alert forever, for an
	 * image nothing is waiting on.
	 */
	test("an unbuilt candidate whose marker has moved to another sha raises nothing", async () => {
		await withTestDb(async (db) => {
			await seedUnbuilt(db, {
				repository: "rodaddy/mcp2cli",
				tag: "v9.9.9",
				requeues: 3,
				// The marker now points somewhere else entirely.
				markerSha: "a".repeat(40),
			});

			const fake = fakeTarget();
			await runBuildBumpAlerts(db, fake.target, markerEnrolment());

			expect(fake.titles).toEqual([]);
			// (d), the same candidate with the marker still on it, raising once, is
			// "a candidate re-queued three times with no pair row" above: same seed.
		});
	});
});
