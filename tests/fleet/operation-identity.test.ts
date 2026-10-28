import { describe, expect, test } from "bun:test";
import {
	type AdmissionRecord,
	type AdmissionResult,
	type AdmissionStore,
	classifyRunEnd,
	settle,
	type UnmappedRecord,
} from "../../fleet/admission/operation-admission.js";
import {
	admitOperation,
	mapOperation,
	type OperationFacts,
	type OperationRequest,
} from "../../fleet/admission/operation-identity.js";

type Facts = Record<string, unknown>;
type Records = Map<string, AdmissionRecord | UnmappedRecord>;

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const SEATS: Record<string, string> = { claude: "Moebius", gpt: "Druillet" };
const WAKE: OperationRequest = { source: "wake", paid: true };
const map = (facts: Facts) => mapOperation(facts as OperationFacts);

function fakeStore(records: Records): AdmissionStore {
	return {
		read: async (key) => records.get(key),
		compareAndSet: async (key, expectedVersion, next) => {
			if ((records.get(key)?.version ?? 0) !== expectedVersion) return false;
			records.set(key, next);
			return true;
		},
	};
}

function harness() {
	const records: Records = new Map();
	const store = fakeStore(records);
	const provider = {
		starts: 0,
		start() {
			this.starts += 1;
		},
	};
	const announced: AdmissionResult[] = [];
	const dispatch = async (facts: Facts, request: OperationRequest = WAKE) => {
		const got = await admitOperation(store, facts as OperationFacts, request);
		if (got.action === "start") provider.start();
		if (got.announce) announced.push(got);
		return got;
	};
	const end = (facts: Facts, result: Parameters<typeof settle>[1] = { outcome: "succeeded" }) => {
		const op = map(facts);
		if (!op.ok) throw new Error(`facts do not map: ${op.cause}`);
		const record = records.get(op.key);
		if (!record) throw new Error(`no record for ${op.key}`);
		records.set(op.key, settle(record as AdmissionRecord, result));
	};
	return { provider, announced, dispatch, end };
}

// Every helper carries the untrusted fields a live row carries.
const review = (family: string, over: Facts = {}): Facts => ({
	kind: "review",
	companyId: "c1",
	repo: "rodaddy/software-factory",
	pr: 7,
	family,
	headSha: HEAD_A,
	issueId: `i-${family}`,
	agentId: `a-${family}`,
	originKind: "plugin:rodaddy.forge-pr",
	originId: "rodaddy/software-factory#7",
	title: `Review rodaddy/software-factory#7 @ aaaaaaa (${SEATS[family]})`,
	description: `Head SHA: ${HEAD_A}`,
	seat: SEATS[family],
	model: `${family}-model`,
	...over,
});
const merge = (over: Facts = {}): Facts => ({
	kind: "merge",
	companyId: "c1",
	repo: "rodaddy/software-factory",
	pr: 7,
	headSha: HEAD_A,
	issueId: "i-merge",
	originKind: "plugin:rodaddy.forge-pr",
	originId: "rodaddy/software-factory#7",
	title: "Merge rodaddy/software-factory#7 @ aaaaaaa",
	...over,
});
const routine = (over: Facts = {}): Facts => ({
	kind: "routine",
	companyId: "c1",
	routineId: "r1",
	issueId: "i-routine",
	originKind: "routine_execution",
	originId: "r1",
	title: "Daily report",
	...over,
});
const work = (over: Facts = {}): Facts => ({
	kind: "work",
	companyId: "c1",
	workId: "w1",
	subOperation: "execute",
	issueId: "i-w1",
	originKind: "manual",
	title: "Do the thing",
	description: "As written",
	...over,
});

describe("operation identity", () => {
	test("one parent survives task recreation, repository rename and recovery without becoming a family slot", async () => {
		const binding = {
			version: 1,
			kind: "review-parent",
			companyId: "c1",
			repositoryId: 42,
			workItemId: "work-7",
			repo: "rodaddy/software-factory",
			pr: 7,
			parentIssueId: "parent-1",
			headSha: HEAD_A,
			baseSha: "c".repeat(40),
			children: {
				gpt: { model: "gpt-6.1-sol", effort: "low" },
				claude: { model: "claude-sonnet-5-5", effort: "medium" },
			},
		};
		const parent = (over: Facts = {}, bind = binding): Facts => ({
			kind: "review-parent",
			companyId: "c1",
			issueId: bind.parentIssueId,
			binding: bind,
			...over,
		});
		const h = harness();
		expect((await h.dispatch(parent())).action).toBe("start");
		h.end(parent());
		const recreated = parent(
			{},
			{ ...binding, parentIssueId: "parent-2", repo: "rodaddy/renamed" },
		);
		expect(map(recreated)).toEqual(map(parent()));
		expect((await h.dispatch(recreated)).cause).toBe("unchanged_after_succeeded");
		const recut = parent({}, { ...binding, parentIssueId: "parent-3", pr: 8 });
		expect(map(recut)).toEqual(map(parent()));
		expect((await h.dispatch(recut)).action).toBe("hold");
		expect(map(parent({ workItemId: "author-selected-new-work", pr: 99 }))).toEqual(map(parent()));
		expect(map(parent({}, { ...binding, baseSha: HEAD_B }))).toEqual(map(parent()));
		expect((await h.dispatch(parent({}, { ...binding, baseSha: HEAD_B }))).action).toBe("hold");
		const recovery = {
			kind: "recovery",
			companyId: "c1",
			issueId: "recovery-1",
			original: parent(),
		};
		expect(map(recovery)).toEqual(map(parent()));
		expect((await h.dispatch(recovery)).action).toBe("hold");
		const op = map(parent());
		const family = map(review("gpt"));
		if (!op.ok || !family.ok) throw new Error("expected mapped parent and family");
		expect(op.key).not.toBe(family.key);
		for (const invalid of [
			parent({ binding: undefined, ...review("gpt"), kind: "review-parent" }),
			parent({ binding: undefined, workItemId: "author-selected-new-work" }),
			parent({ companyId: "c2" }),
			parent({ issueId: "child-1" }),
			parent({ family: "gpt" }),
			parent({}, { ...binding, headSha: "aaaaaaa" }),
		])
			expect(map(invalid).ok).toBe(false);
		expect(h.provider.starts).toBe(1);
		const revised = parent({}, { ...binding, headSha: HEAD_B, pr: 8 });
		const next = await h.dispatch(revised);
		expect(next.action).toBe("start");
		expect((next.next as AdmissionRecord).attempts).toBe(2);
		h.end(revised);
		expect((await h.dispatch(recut)).cause).toBe("input_already_attempted");
		expect(h.provider.starts).toBe(2);
	});

	test("each review slot gets one run per head, and a recreated task cannot buy another", async () => {
		const h = harness();
		const first = [await h.dispatch(review("claude")), await h.dispatch(review("gpt"))];
		expect(first.map((g) => g.action)).toEqual(["start", "start"]);
		expect(h.provider.starts).toBe(2);
		h.end(review("claude"));
		h.end(review("gpt"));
		const recreated = await h.dispatch(
			review("claude", {
				issueId: "i-new",
				seat: "Giraud",
				assigneeAgentId: "x",
				model: "other",
				title: "reworded",
				pr: "7",
				repo: "Rodaddy/Software-Factory",
			}),
		);
		expect([recreated.action, recreated.cause]).toEqual(["hold", "unchanged_after_succeeded"]);
		expect(h.provider.starts).toBe(2);
	});

	test("a new head runs each slot once more, and the old head coming back does not", async () => {
		const h = harness();
		for (const headSha of [HEAD_A, HEAD_B]) {
			for (const family of ["claude", "gpt"]) {
				const got = await h.dispatch(review(family, { headSha }));
				expect([headSha, family, got.action]).toEqual([headSha, family, "start"]);
				h.end(review(family));
			}
		}
		expect(h.provider.starts).toBe(4);
		const back = await h.dispatch(review("claude"));
		expect([back.action, back.cause]).toEqual(["hold", "input_already_attempted"]);
		expect(h.provider.starts).toBe(4);
	});

	test("merge is its own operation and needs complete evidence", async () => {
		const h = harness();
		for (const family of ["claude", "gpt"]) {
			await h.dispatch(review(family));
			h.end(review(family));
		}
		const incomplete = [
			await h.dispatch(merge()),
			await h.dispatch(merge({ evidence: { complete: false, revision: "r1" } })),
			await h.dispatch(merge({ evidence: { complete: "true", revision: "r1" } })),
		];
		expect(incomplete.map((g) => [g.action, g.cause])).toEqual([
			["hold", "merge_evidence_missing"],
			["hold", "merge_evidence_missing"],
			["hold", "merge_evidence_missing"],
		]);
		expect(h.provider.starts).toBe(2);
		expect(h.announced).toHaveLength(1);
		const r1 = merge({ evidence: { complete: true, revision: "r1" } });
		expect((await h.dispatch(r1)).action).toBe("start");
		expect(h.provider.starts).toBe(3);
		h.end(r1);
		const again = await h.dispatch(r1);
		expect([again.action, again.cause]).toEqual(["hold", "unchanged_after_succeeded"]);
		const r2 = await h.dispatch(merge({ evidence: { complete: true, revision: "r2" } }));
		expect([r2.action, r2.cause]).toEqual(["start", "input_changed"]);
		expect(h.provider.starts).toBe(4);
	});

	test("a routine runs once per authorized occurrence", async () => {
		const h = harness();
		const occurrence = (occurrenceId: string, over: Facts = {}) =>
			routine({ periodicAuthorized: true, occurrenceId, ...over });
		const unauthorized = await h.dispatch(routine());
		expect([unauthorized.action, unauthorized.cause]).toEqual(["hold", "routine_not_authorized"]);
		expect(h.provider.starts).toBe(0);
		const noOccurrence = await h.dispatch(routine({ periodicAuthorized: true }));
		expect([noOccurrence.action, noOccurrence.cause]).toEqual(["hold", "occurrence_missing"]);
		expect((await h.dispatch(occurrence("o1"))).action).toBe("start");
		expect(h.provider.starts).toBe(1);
		expect((await h.dispatch(occurrence("o2"))).action).toBe("start");
		expect(h.provider.starts).toBe(2);
		h.end(occurrence("o1"), { uncertain: true });
		expect((await h.dispatch(occurrence("o1"))).action).toBe("reconcile");
		expect((await h.dispatch(occurrence("o3"))).action).toBe("start");
		expect(h.provider.starts).toBe(3);
		h.end(occurrence("o2"));
		const rewoken = await h.dispatch(occurrence("o2", { runId: "run-2", wakeReason: "retry" }));
		expect([rewoken.action, rewoken.cause]).toEqual(["hold", "unchanged_after_succeeded"]);
		expect(h.provider.starts).toBe(3);
	});

	test("a recreated task and a recovery task are the original operation", async () => {
		const h = harness();
		expect((await h.dispatch(work())).action).toBe("start");
		h.end(work(), { outcome: "failed" });
		const recreated = await h.dispatch(work({ issueId: "i-other" }));
		expect([recreated.action, recreated.cause]).toEqual(["hold", "unchanged_after_failed"]);
		const recovery = (original: Facts): Facts => ({
			kind: "recovery",
			companyId: "c1",
			issueId: "i-rec",
			original,
		});
		const recovered = await h.dispatch(recovery(work()));
		expect([recovered.action, recovered.cause]).toEqual(["hold", "unchanged_after_failed"]);
		expect(map(recovery(work()))).toEqual(map(work()));
		const unmappable = [
			recovery(recovery(work())),
			recovery(work({ companyId: "c2" })),
			recovery({ kind: "work", companyId: "c1" }),
		];
		for (const facts of unmappable) {
			expect(map(facts)).toEqual({
				ok: false,
				cause: "identity_missing",
				diagnosticKey: "c1:unmapped:issue:i-rec",
			});
			const got = await h.dispatch(facts);
			expect([got.action, got.cause]).toEqual(["hold", "identity_missing"]);
		}
		expect(h.provider.starts).toBe(1);
	});

	test("rewording the task or marking a child done starts nothing", async () => {
		const h = harness();
		await h.dispatch(work());
		h.end(work());
		const reworded = work({
			title: "reworded",
			description: "new words",
			childStatuses: { c1: "done" },
			doneChildren: ["c1"],
			status: "todo",
			updatedAt: "2026-10-10",
		});
		const got = [await h.dispatch(reworded), await h.dispatch(reworded)];
		expect(got.map((g) => g.cause)).toEqual([
			"unchanged_after_succeeded",
			"unchanged_after_succeeded",
		]);
		expect(h.provider.starts).toBe(1);
		expect(h.announced).toHaveLength(1);
	});

	test("an accepted requirement revision or an accepted dependency revision starts once", async () => {
		const h = harness();
		await h.dispatch(work());
		h.end(work());
		const revised = work({ requirementRevision: "rev-2" });
		expect((await h.dispatch(revised)).cause).toBe("input_changed");
		expect(h.provider.starts).toBe(2);
		h.end(revised);
		expect((await h.dispatch(revised)).cause).toBe("unchanged_after_succeeded");
		const withDeps = work({ requirementRevision: "rev-2", dependencyRevisions: ["a@1", "b@1"] });
		expect((await h.dispatch(withDeps)).cause).toBe("input_changed");
		expect(h.provider.starts).toBe(3);
		h.end(withDeps);
		const sameDeps = await h.dispatch(
			work({ requirementRevision: "rev-2", dependencyRevisions: ["b@1", "a@1", "a@1"] }),
		);
		expect([sameDeps.action, sameDeps.cause]).toEqual(["hold", "unchanged_after_succeeded"]);
		expect(h.provider.starts).toBe(3);
	});

	test("work that loses its accepted revision starts nothing", async () => {
		const h = harness();
		const accepted = work({ requirementRevision: "rev-1" });
		expect((await h.dispatch(accepted)).action).toBe("start");
		h.end(accepted);
		const got = [await h.dispatch(work()), await h.dispatch(work())];
		expect(got.map((g) => [g.action, g.cause, g.announce])).toEqual([
			["hold", "revision_missing", true],
			["hold", "revision_missing", false],
		]);
		expect(h.provider.starts).toBe(1);
	});

	test("a task that cannot be mapped holds once and is reported", async () => {
		const h = harness();
		const unmappable = [
			work({ kind: undefined, issueId: "i-1" }),
			review("sol", { issueId: "i-2" }),
			review("claude", { headSha: "aaaaaaa", issueId: "i-3" }),
			work({ workId: undefined, issueId: "i-4" }),
			work({ companyId: undefined, issueId: "i-5" }),
			review("gpt", { pr: "007", issueId: "i-6" }),
			work({ dependencyRevisions: [""], issueId: "i-7" }),
			work({ requirementRevision: 3, issueId: "i-8" }),
			work({ workId: "a\uD800", issueId: "i-9" }),
			work({ dependencyRevisions: ["a@1"], issueId: "i-10" }),
		];
		const causes: string[] = [];
		for (const facts of unmappable) {
			const got = [await h.dispatch(facts), await h.dispatch(facts)];
			expect(got.map((g) => [g.action, g.announce])).toEqual([
				["hold", true],
				["hold", false],
			]);
			causes.push(got[0]?.cause ?? "");
		}
		expect(causes).toEqual([
			"unknown_kind",
			"review_slot_unknown",
			"input_missing",
			"identity_missing",
			"identity_missing",
			"identity_missing",
			"input_missing",
			"input_missing",
			"identity_missing",
			"input_missing",
		]);
		expect(h.provider.starts).toBe(0);
		expect(h.announced).toHaveLength(10);
		await expect(h.dispatch(work({ issueId: undefined }))).rejects.toThrow();
		expect(h.provider.starts).toBe(0);
	});

	test("an uncertain previous run is held for reconcile, whatever comes next", async () => {
		const h = harness();
		expect((await h.dispatch(review("claude"))).action).toBe("start");
		const ended = classifyRunEnd({
			status: "interrupted",
			errorCode: "lease_released_before_terminal",
		});
		h.end(review("claude"), ended as Parameters<typeof settle>[1]);
		const got = [
			await h.dispatch(review("claude")),
			await h.dispatch(review("claude", { headSha: HEAD_B })),
		];
		expect(got.map((g) => [g.action, g.cause])).toEqual([
			["reconcile", "upstream_uncertain"],
			["reconcile", "upstream_uncertain"],
		]);
		expect(h.provider.starts).toBe(1);
	});

	test("two distinct delegated tasks stay distinct", async () => {
		const h = harness();
		const one = work({ workId: "w1", rootWorkId: "root" });
		const two = work({ workId: "w2", issueId: "i-w2", rootWorkId: "root" });
		const got = [await h.dispatch(one), await h.dispatch(two)];
		expect(got.map((g) => [g.action, g.cause])).toEqual([
			["start", "first_attempt"],
			["start", "first_attempt"],
		]);
		expect(h.provider.starts).toBe(2);
		const [a, b] = [map(one), map(two)];
		if (!a.ok || !b.ok) throw new Error("both tasks must map");
		expect(a.key).not.toBe(b.key);
		expect(a.root).toBe(b.root);
	});

	test("two long pull request numbers stay two pull requests", async () => {
		const h = harness();
		const got = [
			await h.dispatch(review("claude", { pr: "9007199254740992" })),
			await h.dispatch(review("claude", { pr: "9007199254740993", issueId: "i-b" })),
		];
		expect(got.map((g) => g.action)).toEqual(["start", "start"]);
		expect(h.provider.starts).toBe(2);
	});

	test("a caller cannot mark its own release verified", async () => {
		const h = harness();
		await h.dispatch(review("gpt"));
		h.end(review("gpt"), { outcome: "failed" });
		const got = await h.dispatch(review("gpt"), {
			source: "manual",
			paid: true,
			release: { id: "rel-1", verified: true },
		});
		expect([got.action, got.cause]).toEqual(["hold", "release_unverified"]);
		expect(h.provider.starts).toBe(1);
		await expect(h.dispatch(work(), { source: "wake" } as OperationRequest)).rejects.toThrow();
		expect(h.provider.starts).toBe(1);
	});
});
