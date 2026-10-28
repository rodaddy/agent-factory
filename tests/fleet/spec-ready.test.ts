import { expect, test } from "bun:test";
import { checkSpec, enforceSpec, gateSkill } from "../../fleet/bin/spec-ready-lib.ts";

const complete = `## Files to read
- fleet/bin/seat-lib.ts
## Files to change
- fleet/bin/spec-ready-lib.ts
## Acceptance criteria
\`\`\`sh
bun run check
\`\`\`
Expected: exit 0; all checks pass.
## Non-goals
- Do not change the live board.
`;

test("incomplete issue is held with one gap comment per body and repairs spec queue on retry", async () => {
	const comments: string[] = [];
	const queued: string[] = [];
	const deps = {
		listComments: async () => comments,
		postComment: async (body: string) => {
			comments.push(body);
		},
		queueSpec: async (hash: string) => {
			queued.push(hash);
		},
	};
	const input = {
		issueKey: "rodaddy/software-factory#2102",
		body: "## Non-goals\n- No deployment.",
	};
	const result = await enforceSpec(input, deps);
	expect(result.ready).toBe(false);
	expect(result.missing).toContain("Files to read");
	expect(result.missing).toContain("Files to change");
	expect(result.missing).toContain("Acceptance commands and expected outcomes");
	await Promise.all([enforceSpec(input, deps), enforceSpec(input, deps)]);
	expect(comments).toHaveLength(1);
	expect(comments[0]).toContain("Files to read");
	expect(comments[0]).toContain(`<!-- spec-ready:${result.bodyHash} -->`);
	expect(queued).toEqual([result.bodyHash, result.bodyHash, result.bodyHash]);
});

test("complete issue dispatches without hold writes", async () => {
	const writes: string[] = [];
	const result = await enforceSpec(
		{ issueKey: "complete", body: complete },
		{
			listComments: async () => [],
			postComment: async (body) => {
				writes.push(body);
			},
			queueSpec: async (hash) => {
				writes.push(hash);
			},
		},
	);
	const expected = complete.replace(
		"Expected: exit 0; all checks pass.",
		"Expected: an empty list.",
	);
	expect(checkSpec(expected).ready).toBe(true);
	expect(
		checkSpec(complete.replace("bun run check", "DATABASE_URL=fixture bun run check")).ready,
	).toBe(true);
	expect(result.ready).toBe(true);
	expect(result.missing).toEqual([]);
	expect(writes).toEqual([]);
});

test("NEEDS_SPEC holds a shaped issue until a newer READY advisory, while the label still holds", () => {
	const comments = ["jev issue-implementable v1 (advisory): NEEDS_SPEC 0.95"];
	expect(checkSpec(complete, [], comments).missing).toContain("Jev issue-implementable NEEDS_SPEC");
	expect(checkSpec(complete, ["needs_spec"]).ready).toBe(false);
	comments.push("jev issue-implementable v1 (advisory): READY 0.98");
	expect(checkSpec(complete, [], comments).ready).toBe(true);
	expect(checkSpec(complete, ["NEEDS_SPEC"], comments).ready).toBe(false);
});

test("commented or fenced headings, empty sections and unclosed acceptance fences cannot pass", () => {
	for (const body of [
		`<!-- ${complete} -->`,
		`\`\`\`md\n${complete}\n\`\`\``,
		complete.replace("- fleet/bin/seat-lib.ts", "TODO"),
		complete.replace("- fleet/bin/seat-lib.ts", "```ts\nTODO\n```"),
		complete.replace("- Do not change the live board.", "```\n```"),
		complete.replace("\n```\nExpected", "\nExpected"),
		complete.replace("bun run check", "# bun run check"),
		complete.replace("bun run check", "DATABASE_URL=fixture"),
	])
		expect(checkSpec(body).ready).toBe(false);
});

test("known diagnostic and review skills are exempt; unknown work remains gated", () => {
	for (const skill of "run-audit daily-report apple-build-review k3s-review review-dispatch infra-health harness-check scout-watchdog jev-route ci-red-check".split(
		" ",
	))
		expect(gateSkill(skill)).toBe(false);
	expect(gateSkill("daily-retro")).toBe(true);
	expect(gateSkill("unknown-work")).toBe(true);
});
test("command words cannot substitute for an expected acceptance outcome", () => {
	expect(
		checkSpec(
			complete
				.replace("bun run check", "echo expect foo")
				.replace("Expected: exit 0; all checks pass.", ""),
		).ready,
	).toBe(false);
});
