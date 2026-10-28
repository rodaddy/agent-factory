/**
 * @module tests/fleet/wayfinder-render
 * @description `fleet/skills/milestone-engineer/bin/wayfinder-render`,
 *   run as a real child process on a two-milestone fixture.
 *   `WAYFINDER_RENDER_UNDER_TEST` points the suite at a mutated copy.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.WAYFINDER_RENDER_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/milestone-engineer/bin/wayfinder-render");

const FIXTURE = {
	repo: "rtech/demo",
	milestones: [
		{
			title: "M1 Foundations",
			goal: "Base works",
			doneWhen: "Both closed",
			issues: [
				{ number: 5, title: "Schema", state: "closed", blockedBy: [] },
				{ number: 6, title: "Loader", state: "open", blockedBy: [] },
			],
		},
		{
			title: "M2 Surface",
			goal: "UI ships",
			doneWhen: "Both closed",
			issues: [
				{ number: 7, title: "Page", state: "open", blockedBy: [5] },
				{ number: 8, title: "Docs", state: "closed", blockedBy: [] },
			],
		},
	],
};

function render(): string {
	const r = Bun.spawnSync(["python3", SCRIPT], { stdin: Buffer.from(JSON.stringify(FIXTURE)) });
	expect(r.exitCode).toBe(0);
	return r.stdout.toString();
}

describe("wayfinder-render", () => {
	test("phase headings carry completion state", () => {
		const out = render();
		expect(out).toContain("## M1 Foundations (1/2 done)");
		expect(out).toContain("## M2 Surface (1/2 done)");
		expect(out).toContain("## Destination");
		expect(out).toContain("## Not yet specified");
		expect(out).toContain("## Out of scope");
	});

	test("checkbox state follows issue state, rows link to Forge", () => {
		const out = render();
		expect(out).toContain("- [x] [#5 Schema](https://forge.example.internal/rtech/demo/issues/5)");
		expect(out).toContain("- [ ] [#6 Loader](https://forge.example.internal/rtech/demo/issues/6)");
		expect(out).toContain("- [ ] [#7 Page](https://forge.example.internal/rtech/demo/issues/7)");
		expect(out).toContain("- [x] [#8 Docs](https://forge.example.internal/rtech/demo/issues/8)");
	});

	test("mermaid block carries the blocking edge", () => {
		const out = render();
		const m = out.match(/```mermaid\ngraph LR\n([\s\S]*?)```/);
		expect(m).not.toBeNull();
		expect(m?.[1]).toContain("5 --> 7");
		expect(m?.[1]).not.toContain("7 --> 5");
	});

	test("deterministic across two runs", () => {
		expect(render()).toBe(render());
	});
});
