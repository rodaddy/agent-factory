import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import { evaluateDoorbell } from "../../src/reconcile/doorbell";

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/open-brain",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
			},
			{
				name: "rtech/rtech-infra",
				provider: "github",
				checks: "static-only",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
		...overrides,
	};
}

describe("evaluateDoorbell", () => {
	test("accepts a configured repository with no item", () => {
		const decision = evaluateDoorbell({ repository: "rodaddy/open-brain" }, config());
		expect(decision.accepted).toBe(true);
		if (decision.accepted) {
			expect(decision.ring.repository).toBe("rodaddy/open-brain");
			expect(decision.ring.item).toBeUndefined();
		}
	});

	test("accepts a configured repository with a positive item number", () => {
		const decision = evaluateDoorbell({ repository: "rodaddy/open-brain", item: 42 }, config());
		expect(decision.accepted).toBe(true);
		if (decision.accepted) {
			expect(decision.ring.item).toBe(42);
		}
	});

	test("rejects an unknown repository", () => {
		const decision = evaluateDoorbell({ repository: "rodaddy/not-managed" }, config());
		expect(decision.accepted).toBe(false);
		if (!decision.accepted) {
			expect(decision.reason).toBe("unknown repository");
		}
	});

	test("rejects a malformed repository name", () => {
		const decision = evaluateDoorbell({ repository: "not-a-repo" }, config());
		expect(decision.accepted).toBe(false);
	});

	test("rejects a zero or negative item number", () => {
		expect(evaluateDoorbell({ repository: "rodaddy/open-brain", item: 0 }, config()).accepted).toBe(
			false,
		);
		expect(
			evaluateDoorbell({ repository: "rodaddy/open-brain", item: -3 }, config()).accepted,
		).toBe(false);
	});

	test("rejects a non-integer item number", () => {
		const decision = evaluateDoorbell({ repository: "rodaddy/open-brain", item: 1.5 }, config());
		expect(decision.accepted).toBe(false);
	});

	test("rejects an out-of-range item number", () => {
		const decision = evaluateDoorbell(
			{ repository: "rodaddy/open-brain", item: 2_000_000 },
			config(),
		);
		expect(decision.accepted).toBe(false);
	});

	test("rejects arbitrary extra fields (no template/command/sha/payload smuggling)", () => {
		for (const extra of [
			{ repository: "rodaddy/open-brain", template: "pr-review" },
			{ repository: "rodaddy/open-brain", command: "rm -rf /" },
			{ repository: "rodaddy/open-brain", sha: "deadbeef" },
			{ repository: "rodaddy/open-brain", job_type: "pr-review" },
			{ repository: "rodaddy/open-brain", label: "urgent" },
		]) {
			const decision = evaluateDoorbell(extra, config());
			expect(decision.accepted).toBe(false);
		}
	});

	test("rejects a non-object body", () => {
		expect(evaluateDoorbell(null, config()).accepted).toBe(false);
		expect(evaluateDoorbell("rodaddy/open-brain", config()).accepted).toBe(false);
		expect(evaluateDoorbell(42, config()).accepted).toBe(false);
	});

	test("rejects a missing repository", () => {
		expect(evaluateDoorbell({ item: 1 }, config()).accepted).toBe(false);
	});
});
