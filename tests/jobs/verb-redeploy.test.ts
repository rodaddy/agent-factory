import { describe, expect, test } from "bun:test";
import type { ControlSurface, LabelWriteProposal } from "../../src/control-surface/boundary";
import { redeployRequests } from "../../src/control-surface/vocabulary";
import {
	consumeRedeployRequests,
	type RedeployCommenter,
	redeployRunSha,
} from "../../src/jobs/verb-redeploy";

const MANIFEST_SHA = "a".repeat(64);
const NOW = new Date("2026-08-16T12:00:00.000Z");

/**
 * A recording APPLYING surface.
 *
 * `readLabels`/`readColumn` THROW rather than answering a default shape: this
 * module must reach the forge for exactly one operation, and a permissive fake
 * would let a stray read pass unnoticed (done-means README rule 11).
 */
function surface(overrides: { applied?: boolean; error?: string; throws?: boolean } = {}): {
	surface: ControlSurface;
	writes: LabelWriteProposal[];
} {
	const writes: LabelWriteProposal[] = [];
	return {
		writes,
		surface: {
			readLabels: async () => {
				throw new Error("unscripted readLabels");
			},
			readColumn: async () => {
				throw new Error("unscripted readColumn");
			},
			proposeLabelWrite: async (proposal) => {
				writes.push(proposal);
				if (overrides.throws === true) throw new Error("forge refused");
				return {
					applied: overrides.applied ?? true,
					intent: "intent",
					...(overrides.error === undefined ? {} : { error: overrides.error }),
				};
			},
		},
	};
}

function deps(
	s: ControlSurface,
	comment?: RedeployCommenter,
): Parameters<typeof consumeRedeployRequests>[0] {
	return {
		surface: s,
		repository: "rodaddy/x",
		manifestSha: MANIFEST_SHA,
		now: NOW,
		...(comment === undefined ? {} : { comment }),
	};
}

describe("redeployRequests", () => {
	test("returns the label token alongside its app suffix", () => {
		expect(redeployRequests(["deploy:hello", "redeploy:hello"])).toEqual([
			{ label: "redeploy:hello", app: "hello" },
		]);
	});

	test("a bare `redeploy:` with no suffix names no app and is not a request", () => {
		expect(redeployRequests(["redeploy:"])).toEqual([]);
	});

	test("does not confuse `deploy:` with `redeploy:` in either direction", () => {
		// "redeploy:hello".startsWith("deploy:") is false, and this pins it: an
		// overmatching prefix test here would make every deploy label a re-run signal.
		expect(redeployRequests(["deploy:hello"])).toEqual([]);
		expect("redeploy:hello".startsWith("deploy:")).toBe(false);
	});
});

describe("redeployRunSha", () => {
	test("is a 64-hex digest, the shape every existing consumer already handles", () => {
		expect(redeployRunSha(MANIFEST_SHA, "redeploy:hello", NOW)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("differs from the manifest sha, so the terminal tuple is not collided with", () => {
		expect(redeployRunSha(MANIFEST_SHA, "redeploy:hello", NOW)).not.toBe(MANIFEST_SHA);
	});

	test("a LATER consumption of the same label gets its own sha", () => {
		// Without this a second re-run lands on the sha the first re-run's own
		// terminal row now holds, and the label works exactly once per manifest.
		const first = redeployRunSha(MANIFEST_SHA, "redeploy:hello", NOW);
		const later = redeployRunSha(MANIFEST_SHA, "redeploy:hello", new Date(NOW.getTime() + 1000));
		expect(later).not.toBe(first);
	});
});

describe("consumeRedeployRequests", () => {
	test("removes the label on the forge and reports the consumption", async () => {
		const s = surface();
		const consumed = await consumeRedeployRequests(deps(s.surface), 295, [
			"deploy:hello",
			"redeploy:hello",
		]);

		expect(s.writes).toEqual([
			{ repository: "rodaddy/x", item: 295, removeLabels: ["redeploy:hello"] },
		]);
		expect(consumed).toEqual([
			{
				app: "hello",
				label: "redeploy:hello",
				runSha: redeployRunSha(MANIFEST_SHA, "redeploy:hello", NOW),
			},
		]);
	});

	test("an item with no redeploy label touches the forge at all", async () => {
		const s = surface();
		expect(await consumeRedeployRequests(deps(s.surface), 295, ["deploy:hello"])).toEqual([]);
		expect(s.writes).toEqual([]);
	});

	test("an UNAPPLIED write is NOT a consumption, so nothing is reported", async () => {
		// The whole safety property: reporting an unapplied proposal as consumed
		// dispatches a re-run whose signal is still armed on the forge.
		const s = surface({ applied: false, error: "403" });
		const consumed = await consumeRedeployRequests(deps(s.surface), 295, ["redeploy:hello"]);

		expect(s.writes).toHaveLength(1);
		expect(consumed).toEqual([]);
	});

	test("a THROWN write is NOT a consumption either", async () => {
		const s = surface({ throws: true });
		expect(await consumeRedeployRequests(deps(s.surface), 295, ["redeploy:hello"])).toEqual([]);
	});

	test("posts the consumption receipt AFTER the label is gone", async () => {
		const order: string[] = [];
		const writes: LabelWriteProposal[] = [];
		const posts: string[] = [];
		const s: ControlSurface = {
			readLabels: async () => {
				throw new Error("unscripted");
			},
			readColumn: async () => {
				throw new Error("unscripted");
			},
			proposeLabelWrite: async (proposal) => {
				order.push("remove");
				writes.push(proposal);
				return { applied: true, intent: "intent" };
			},
		};
		const comment: RedeployCommenter = async ({ body }) => {
			order.push("comment");
			posts.push(body);
		};

		await consumeRedeployRequests(deps(s, comment), 295, ["redeploy:hello"]);

		expect(order).toEqual(["remove", "comment"]);
		expect(posts[0]).toContain("`redeploy:hello` consumed");
	});

	test("a receipt that FAILS to post does not undo the consumption", async () => {
		// A comment is a receipt, never a gate: undoing a consumption because the
		// note failed leaves the signal reading un-consumed and re-firing.
		const s = surface();
		const comment: RedeployCommenter = async () => {
			throw new Error("comment refused");
		};
		const consumed = await consumeRedeployRequests(deps(s.surface, comment), 295, [
			"redeploy:hello",
		]);
		expect(consumed).toHaveLength(1);
	});

	test("consumes EVERY named app on one item, each as its own signal", async () => {
		const s = surface();
		const consumed = await consumeRedeployRequests(deps(s.surface), 295, [
			"redeploy:hello",
			"redeploy:other",
		]);
		expect(s.writes.map((w) => w.removeLabels)).toEqual([["redeploy:hello"], ["redeploy:other"]]);
		expect(consumed.map((c) => c.app)).toEqual(["hello", "other"]);
	});
});
