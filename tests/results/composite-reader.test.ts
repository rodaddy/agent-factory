import { describe, expect, test } from "bun:test";
import type { ArtifactReader } from "../../src/results/artifact-reader";
import { CompositeResultReader } from "../../src/results/composite-reader";

/** A scripted ArtifactReader that records every call it received. */
function fakeReader(
	name: string,
	state: {
		hosts?: Record<string, string[]>;
		done?: Record<string, boolean>;
		bodies?: Record<string, string>;
	},
	calls: string[] = [],
): ArtifactReader & { calls: string[] } {
	return {
		calls,
		async listHosts(jobRunnerId, maxHosts) {
			calls.push(`${name}.listHosts(${jobRunnerId},${maxHosts})`);
			return (state.hosts?.[jobRunnerId] ?? []).slice(0, Math.max(0, maxHosts));
		},
		async isDone(jobRunnerId, hostname) {
			calls.push(`${name}.isDone(${jobRunnerId},${hostname})`);
			return state.done?.[`${jobRunnerId}/${hostname}`] ?? false;
		},
		async readResult(jobRunnerId, hostname, maxBytes) {
			calls.push(`${name}.readResult(${jobRunnerId},${hostname})`);
			return this.readNamedResult(jobRunnerId, hostname, "result.json", maxBytes);
		},
		async readNamedResult(jobRunnerId, hostname, fileName, _maxBytes) {
			calls.push(`${name}.readNamedResult(${jobRunnerId},${hostname},${fileName})`);
			return state.bodies?.[`${jobRunnerId}/${hostname}/${fileName}`] ?? null;
		},
		// sf#699: keyed with the `out/` segment the real share reader appends, so a
		// body seeded flat is NOT reachable through this method and vice versa —
		// the fake models the nesting rather than aliasing the two lookups.
		async readOutArtifact(jobRunnerId, hostname, fileName, _maxBytes) {
			calls.push(`${name}.readOutArtifact(${jobRunnerId},${hostname},${fileName})`);
			return state.bodies?.[`${jobRunnerId}/${hostname}/out/${fileName}`] ?? null;
		},
	};
}

describe("CompositeResultReader", () => {
	// sf#699: the out/ delegation is the path the agent event stream travels, and
	// an untested delegation is the shape that drifts back to consulting one
	// source. Both directions are asserted: first-wins, and fall-through on null.
	test("readOutArtifact prefers the first source and falls through on null", async () => {
		const calls: string[] = [];
		const first = fakeReader("first", { bodies: { "j/h/out/events.jsonl": "from-first" } }, calls);
		const second = fakeReader(
			"second",
			{ bodies: { "j/h/out/events.jsonl": "from-second" } },
			calls,
		);
		const composite = new CompositeResultReader({ first, second });

		expect(await composite.readOutArtifact("j", "h", "events.jsonl", 64)).toBe("from-first");
		expect(calls.some((c) => c.startsWith("second."))).toBe(false);

		// Absent in the first source: the second answers, and the first was asked.
		const calls2: string[] = [];
		const empty = fakeReader("first", {}, calls2);
		const backup = fakeReader(
			"second",
			{ bodies: { "j/h/out/events.jsonl": "from-second" } },
			calls2,
		);
		const fallthrough = new CompositeResultReader({ first: empty, second: backup });
		expect(await fallthrough.readOutArtifact("j", "h", "events.jsonl", 64)).toBe("from-second");
		expect(calls2).toEqual([
			"first.readOutArtifact(j,h,events.jsonl)",
			"second.readOutArtifact(j,h,events.jsonl)",
		]);
	});

	test("the first reader's non-null body wins and the second is never consulted", async () => {
		const calls: string[] = [];
		const first = fakeReader("first", { bodies: { "j/h/result.json": "from-first" } }, calls);
		const second = fakeReader("second", { bodies: { "j/h/result.json": "from-second" } }, calls);
		const composite = new CompositeResultReader({ first, second });

		expect(await composite.readResult("j", "h", 64)).toBe("from-first");
		expect(calls.some((c) => c.startsWith("second."))).toBe(false);
	});

	test("a null from the first falls through to the second", async () => {
		const first = fakeReader("first", {});
		const second = fakeReader("second", { bodies: { "j/h/result.json": "from-second" } });
		const composite = new CompositeResultReader({ first, second });

		expect(await composite.readResult("j", "h", 64)).toBe("from-second");
		expect(await composite.readNamedResult("j", "h", "result.json", 64)).toBe("from-second");
	});

	test("an empty-string body from the first is a REAL body, not a fallthrough", async () => {
		const first = fakeReader("first", { bodies: { "j/h/result.json": "" } });
		const second = fakeReader("second", { bodies: { "j/h/result.json": "from-second" } });
		const composite = new CompositeResultReader({ first, second });

		expect(await composite.readResult("j", "h", 64)).toBe("");
	});

	test("both readers return null: the composite returns null", async () => {
		const composite = new CompositeResultReader({
			first: fakeReader("first", {}),
			second: fakeReader("second", {}),
		});
		expect(await composite.readResult("j", "h", 64)).toBeNull();
		expect(await composite.readNamedResult("j", "h", "watcher-result.json", 64)).toBeNull();
	});

	test("isDone is an OR across both readers", async () => {
		const onlyFirst = new CompositeResultReader({
			first: fakeReader("first", { done: { "j/h": true } }),
			second: fakeReader("second", {}),
		});
		const onlySecond = new CompositeResultReader({
			first: fakeReader("first", {}),
			second: fakeReader("second", { done: { "j/h": true } }),
		});
		const neither = new CompositeResultReader({
			first: fakeReader("first", {}),
			second: fakeReader("second", {}),
		});

		expect(await onlyFirst.isDone("j", "h")).toBe(true);
		expect(await onlySecond.isDone("j", "h")).toBe(true);
		expect(await neither.isDone("j", "h")).toBe(false);
	});

	test("listHosts unions both readers, first's order ahead of the second's new hosts", async () => {
		const composite = new CompositeResultReader({
			first: fakeReader("first", { hosts: { j: ["runner-b", "runner-a"] } }),
			second: fakeReader("second", { hosts: { j: ["runner-a", "runner-c"] } }),
		});
		// runner-a is in both: it appears once, in the FIRST reader's position.
		expect(await composite.listHosts("j", 8)).toEqual(["runner-b", "runner-a", "runner-c"]);
	});

	test("listHosts caps the union at maxHosts, truncating the second reader first", async () => {
		const composite = new CompositeResultReader({
			first: fakeReader("first", { hosts: { j: ["runner-b", "runner-a"] } }),
			second: fakeReader("second", { hosts: { j: ["runner-c"] } }),
		});
		expect(await composite.listHosts("j", 2)).toEqual(["runner-b", "runner-a"]);
		expect(await composite.listHosts("j", 1)).toEqual(["runner-b"]);
		expect(await composite.listHosts("j", 0)).toEqual([]);
	});
});
