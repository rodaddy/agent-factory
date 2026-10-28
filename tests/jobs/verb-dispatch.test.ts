import { describe, expect, test } from "bun:test";
import {
	isVerbId,
	runVerbJob,
	VERB_IDS,
	VERB_TARGET_REPOSITORY,
	type VerbJobDeps,
} from "../../src/jobs/verb-dispatch";
import { JOB_TEMPLATE_IDS, RECEIPT_SPECS, renderJobDispatch } from "../../src/templates/registry";

interface HarnessOptions {
	engineCode?: number;
	holdRails?: boolean;
	forgeOk?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const calls: Array<{ channel: "exec" | "rails" | "forge"; value: unknown }> = [];
	const deps: VerbJobDeps = {
		exec: async (argv) => {
			calls.push({ channel: "exec", value: [...argv] });
			return { code: options.engineCode ?? 0, stdout: '{"ok":true}' };
		},
		evaluateRails: async (input) => {
			calls.push({ channel: "rails", value: input });
			return options.holdRails
				? { hold: true, report: "rails-violation: replicas-default" }
				: { hold: false, report: "not-encoded: none" };
		},
		forge: async (call) => {
			calls.push({ channel: "forge", value: call });
			return { ok: options.forgeOk ?? true };
		},
	};
	return { calls, deps };
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		verb: "newroute",
		repository: VERB_TARGET_REPOSITORY,
		itemNumber: 255,
		catalogEntry: { name: "probe-svc" },
		enginePath: "/opt/rtech-infra",
		...overrides,
	};
}

describe("the fixed k3s verb registry", () => {
	test("contains exactly the six reviewed verb ids and rejects a verb-shaped unknown", () => {
		expect([...VERB_IDS]).toEqual([
			"newroute",
			"newapp",
			"newdb",
			"newroute-down",
			"newapp-down",
			"newdb-down",
		]);
		for (const verb of VERB_IDS) {
			expect(isVerbId(verb)).toBe(true);
			expect(JOB_TEMPLATE_IDS as readonly string[]).toContain(verb);
			expect(RECEIPT_SPECS[verb].describes.trim().length).toBeGreaterThan(0);
			expect(renderJobDispatch(verb, { repository: "rtech/rtech-infra" })).not.toBeNull();
		}
		expect(isVerbId("newvolume")).toBe(false);
		expect(renderJobDispatch("newvolume", { repository: "rtech/rtech-infra" })).toBeNull();
	});
});

describe("runVerbJob", () => {
	test("invokes the wrapper to contract, rails before forge, then opens the fixed-target PR", async () => {
		const h = harness();
		const result = await runVerbJob(input(), h.deps);

		expect(result).toEqual({ outcome: "pr-opened", class: "ok" });
		expect(h.calls.map(({ channel }) => channel)).toEqual(["exec", "rails", "forge"]);
		expect(h.calls[0]?.value).toEqual([
			"/opt/rtech-infra/scripts/service-catalog",
			"compile",
			"--all",
			"--repo",
			"/opt/rtech-infra",
		]);
		expect(h.calls[2]?.value).toEqual({
			op: "pr-open",
			repo: VERB_TARGET_REPOSITORY,
			head: "verb/newroute-255",
			base: "main",
		});
	});

	test("a rails violation HOLDs with no forge write or silent recompile", async () => {
		const h = harness({ holdRails: true });
		const result = await runVerbJob(input(), h.deps);

		expect(result).toEqual({ outcome: "hold", class: "rails-violation" });
		expect(h.calls.map(({ channel }) => channel)).toEqual(["exec", "rails"]);
	});

	test("keeps engine validation and usage exits distinct and correctly oriented", async () => {
		const content = harness({ engineCode: 1 });
		const usage = harness({ engineCode: 2 });

		expect(await runVerbJob(input(), content.deps)).toEqual({
			outcome: "hold",
			class: "content-invalid",
		});
		expect(await runVerbJob(input(), usage.deps)).toEqual({
			outcome: "factory-bug",
			class: "engine-usage",
		});
		expect(content.calls.map(({ channel }) => channel)).toEqual(["exec"]);
		expect(usage.calls.map(({ channel }) => channel)).toEqual(["exec"]);
	});

	test("refuses an unallowlisted verb or forge target before any boundary call", async () => {
		const unknown = harness();
		const wrongRepo = harness();

		expect(await runVerbJob(input({ verb: "newvolume" }), unknown.deps)).toEqual({
			outcome: "factory-bug",
			class: "verb-not-allowlisted",
		});
		expect(await runVerbJob(input({ repository: "rodaddy/other" }), wrongRepo.deps)).toEqual({
			outcome: "factory-bug",
			class: "repository-not-allowlisted",
		});
		expect(unknown.calls).toEqual([]);
		expect(wrongRepo.calls).toEqual([]);
	});

	test("reports a Forgejo proposal refusal as a factory bug", async () => {
		const h = harness({ forgeOk: false });
		expect(await runVerbJob(input(), h.deps)).toEqual({
			outcome: "factory-bug",
			class: "forge-pr-open",
		});
	});
});
