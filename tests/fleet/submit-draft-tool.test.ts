/**
 * @module tests/fleet/submit-draft-tool
 * @description The `submit_draft` tool (SOF-10922) against a recording fetch:
 *   - one PATCH to the run's own issue, with the run id header and the exact
 *     body;
 *   - once per run;
 *   - a refused draft writes nothing;
 *   - a failed write is reported, never claimed;
 *   - it refuses without a run context;
 *   - the issue id is URL-encoded.
 *   The lint rules themselves are tests/fleet/submit-draft-lint.test.ts.
 */
import { describe, expect, test } from "bun:test";
import submitDraft, { makeSubmitDraft } from "../../fleet/pi-extensions/submit-draft/index";
import { render } from "../../fleet/pi-extensions/submit-draft/lint";

const ENV = {
	PAPERCLIP_API_URL: "http://board.test/",
	PAPERCLIP_API_KEY: "k",
	PAPERCLIP_TASK_ID: "issue-1",
	PAPERCLIP_RUN_ID: "run-1",
};

function recorder(status = 200, echo = "done") {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify({ status: echo }), { status });
	};
	return { calls, f };
}

describe("submit_draft", () => {
	test("registers one tool named submit_draft with draft and handoff required", () => {
		const names: string[] = [];
		let required: unknown;
		submitDraft({
			registerTool: (t) => {
				names.push(t.name);
				required = (t.parameters as { required?: unknown }).required;
			},
		});
		expect(names).toEqual(["submit_draft"]);
		expect(required).toEqual(["draft", "handoff"]);
	});

	test("one PATCH to the run's own issue: done, run id header, marked comment", async () => {
		const r = recorder();
		const out = await makeSubmitDraft(ENV, r.f).execute("t1", {
			draft: "Hi Dana.",
			handoff: "none",
		});
		expect(out.details.ok).toBe(true);
		expect(r.calls).toHaveLength(1);
		const [c] = r.calls;
		expect(c?.url).toBe("http://board.test/api/issues/issue-1");
		expect(c?.init.method).toBe("PATCH");
		const headers = c?.init.headers as Record<string, string>;
		expect(headers["X-Paperclip-Run-Id"]).toBe("run-1");
		expect(headers.Authorization).toBe("Bearer k");
		expect(JSON.parse(String(c?.init.body))).toEqual({
			status: "done",
			comment: render("Hi Dana.", "none"),
		});
	});

	test("a second call in the same run is refused and writes nothing", async () => {
		const r = recorder();
		const tool = makeSubmitDraft(ENV, r.f);
		await tool.execute("t1", { draft: "Hi.", handoff: "none" });
		await expect(tool.execute("t2", { draft: "Hi again.", handoff: "none" })).rejects.toThrow(
			"already called",
		);
		expect(r.calls).toHaveLength(1);
	});

	test("a refused draft writes nothing and can be fixed and resent", async () => {
		const r = recorder();
		const tool = makeSubmitDraft(ENV, r.f);
		for (const draft of ["It is $9,000.", "The fee is $  5000.", "It is 2,500 dollars.", ""]) {
			await expect(tool.execute("t1", { draft, handoff: "" })).rejects.toThrow("refused");
		}
		expect(r.calls).toHaveLength(0);
		const out = await tool.execute("t2", {
			draft: "Pricing is quoted in writing.",
			handoff: "none",
		});
		expect(out.details.ok).toBe(true);
		expect(r.calls).toHaveLength(1);
	});

	test("non-string arguments are refused before anything else", async () => {
		const r = recorder();
		const tool = makeSubmitDraft(ENV, r.f);
		await expect(
			tool.execute("t1", { draft: 1, handoff: "none" } as unknown as {
				draft: string;
				handoff: string;
			}),
		).rejects.toThrow("must both be strings");
		expect(r.calls).toHaveLength(0);
	});

	test("a failed board write is reported, never claimed, and not retried", async () => {
		const throwing = async () => {
			throw new Error("network down");
		};
		for (const f of [recorder(500).f, recorder(200, "in_progress").f, throwing]) {
			const tool = makeSubmitDraft(ENV, f);
			await expect(tool.execute("t1", { draft: "Hi.", handoff: "none" })).rejects.toThrow(
				"board write failed",
			);
			await expect(tool.execute("t2", { draft: "Hi.", handoff: "none" })).rejects.toThrow(
				"already called",
			);
		}
	});

	test("no run context: refused, nothing written", async () => {
		const r = recorder();
		const tool = makeSubmitDraft({ ...ENV, PAPERCLIP_TASK_ID: undefined }, r.f);
		await expect(tool.execute("t1", { draft: "Hi.", handoff: "none" })).rejects.toThrow(
			"no Paperclip run context",
		);
		expect(r.calls).toHaveLength(0);
	});

	test("the issue id is encoded into the URL, never a path", async () => {
		const r = recorder();
		await makeSubmitDraft({ ...ENV, PAPERCLIP_TASK_ID: "a/b" }, r.f).execute("t1", {
			draft: "Hi.",
			handoff: "none",
		});
		expect(r.calls[0]?.url).toBe("http://board.test/api/issues/a%2Fb");
	});
});
