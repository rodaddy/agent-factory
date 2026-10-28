import { describe, expect, test } from "bun:test";
import type { DispatchGuardRead, DispatchGuardWrite } from "../../src/hooks/dispatch-guard";
import { DISPATCH_TARGETS } from "../../src/hooks/sop-gate";
import { createVerbDispatcher, VERB_WORKFLOW_FILE } from "../../src/hooks/verb";

const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/verb.yml/dispatches";
const BASE = "c".repeat(40);
const MANIFEST = "e".repeat(64);
const GOOD = {
	verb: "newapp",
	repo: "rtech/some-app",
	item: 295,
	app: "demo",
	manifestSha: MANIFEST,
	baseSha: BASE,
};

/** A fake Forge: records writes, lists no runs. */
function fakeForge(failWrites = false) {
	const posts: { path: string; body: unknown }[] = [];
	const reads: string[] = [];
	const read: DispatchGuardRead = async (path) => {
		reads.push(path);
		return { status: 200, data: { workflow_runs: [] }, link: null, rateRemaining: null };
	};
	const write: DispatchGuardWrite = async (_method, path, body) => {
		if (failWrites) {
			throw new Error("forge down");
		}
		posts.push({ path, body });
		return { status: 204, data: null, link: null, rateRemaining: null };
	};
	return { read, write, posts, reads };
}

describe("verb workflow dispatcher", () => {
	test("dispatches verb.yml with the validated inputs and records it on the host repo", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const dispatch = createVerbDispatcher(forge.write, forge.read, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		expect(await dispatch(GOOD)).toBe(true);
		const inputs = {
			verb: "newapp",
			repo: "rtech/some-app",
			item: "295",
			app: "demo",
			manifest_sha: MANIFEST,
			base_sha: BASE,
			log_level: "info",
		};
		expect(forge.posts).toEqual([{ path: DISPATCH, body: { ref: "main", inputs } }]);
		expect(records).toEqual([
			{
				repo: "rodaddy/software-factory",
				workflow: "verb.yml",
				runId: null,
				targetSha: BASE,
				inputs,
			},
		]);
	});

	test("refuses a non-allowlisted verb or a malformed input and posts nothing", async () => {
		const forge = fakeForge();
		const dispatch = createVerbDispatcher(forge.write, forge.read);
		for (const bad of [
			{ verb: "newsite" },
			{ repo: "rtech" },
			{ item: 0 },
			{ item: 1.5 },
			{ app: "Demo;x" },
			{ manifestSha: BASE },
			{ baseSha: MANIFEST },
		]) {
			expect(await dispatch({ ...GOOD, ...bad })).toBe(false);
		}
		expect(forge.posts).toEqual([]);
	});

	test("refuses the dispatch host repo as the verb's target and posts nothing", async () => {
		const forge = fakeForge();
		const dispatch = createVerbDispatcher(forge.write, forge.read);
		expect(await dispatch({ ...GOOD, repo: "rodaddy/software-factory" })).toBe(false);
		expect(forge.posts).toEqual([]);
	});

	test("a failed write resolves false and never rejects", async () => {
		const forge = fakeForge(true);
		const dispatch = createVerbDispatcher(forge.write, forge.read);
		expect(await dispatch(GOOD)).toBe(false);
	});

	test("verb.yml is a dispatch target whose guard starts no watch (no head_sha input)", async () => {
		const target = DISPATCH_TARGETS[VERB_WORKFLOW_FILE];
		expect(target?.repoInput).toBe("repo");
		const forge = fakeForge();
		const watches: unknown[] = [];
		const dispatch = createVerbDispatcher(forge.write, forge.read, {
			guard: { onWatch: (w) => watches.push(w) },
		});
		expect(await dispatch(GOOD)).toBe(true);
		expect(watches).toEqual([]);
	});
});
