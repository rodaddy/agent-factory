import { describe, expect, test } from "bun:test";
import { ENGINE_ENDPOINTS, resolveRuntimeRoute } from "../../src/runner/route";
import { Mcp2cliRunnerTransport } from "../../src/runner/transport";
import { renderJobDispatch } from "../../src/templates/registry";

const CONTEXT = {
	repository: "rodaddy/software-factory",
	itemNumber: 283,
	sha: "d".repeat(40),
	staticOnly: true,
	returnMode: "patch" as const,
	triageLabels: ["enhancement"],
};

const EXPECTED_ROUTES = {
	"pr-review": { model: "gpt-6.1-sol", effort: "low" },
	"issue-triage": { model: "gpt-6.1-sol", effort: "low" },
	"implement-issue": { model: "gpt-6.1-sol", effort: "low" },
	"infra-static": { model: "gpt-6.1-sol", effort: "medium" },
} as const;

class StrictTransport extends Mcp2cliRunnerTransport {
	readonly calls: Array<{ verb: string; params: Record<string, unknown> }> = [];
	private replies = [{ code: 0, stdout: "", stderr: "" }];

	protected async invoke(
		verb: string,
		params: Record<string, unknown>,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const reply = this.replies.shift();
		if (reply === undefined) {
			throw new Error(`unscripted invoke: ${verb}`);
		}
		this.calls.push({ verb, params });
		return reply;
	}

	assertScriptConsumed(): void {
		expect(this.replies).toEqual([]);
	}
}

function rendered(jobType: string) {
	const result = renderJobDispatch(jobType, CONTEXT);
	if (result === null) throw new Error(`render failed for ${jobType}`);
	return result;
}

describe("issue #283 runtime defaults", () => {
	test("all four agent jobs resolve and submit the reviewed Codex route", async () => {
		for (const [jobType, expected] of Object.entries(EXPECTED_ROUTES)) {
			const resolved = resolveRuntimeRoute(jobType, rendered(jobType), {
				PACKET_PI_DISPATCH_ENABLED: "1",
			});
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) throw new Error(resolved.reason);
			expect(resolved.submission).toMatchObject({
				runtime: "codex",
				model: expected.model,
				effort: expected.effort,
				engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
			});

			const transport = new StrictTransport();
			const { body, ...route } = resolved.submission;
			await transport.run({
				vmid: 9001,
				jobId: `rw-${jobType}-283`,
				job: body,
				maxTurns: 40,
				...route,
			});
			expect(transport.calls).toHaveLength(1);
			expect(transport.calls[0]?.params).toMatchObject({
				runtime: "codex",
				model: expected.model,
				effort: expected.effort,
				engine_base_url: ENGINE_ENDPOINTS.cliproxyapi.baseUrl,
				engine_auth_header_name: ENGINE_ENDPOINTS.cliproxyapi.authHeaderName,
			});
			transport.assertScriptConsumed();
		}
	});

	test("an explicit Claude packet route remains selectable", () => {
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{
				body: "optional claude body",
				routing: { runtime: "claude", model: "claude-opus-5", effort: "medium" },
			},
			{},
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error(resolved.reason);
		expect(resolved.submission).toEqual({
			body: "optional claude body",
			runtime: "claude",
			model: "claude-opus-5",
			effort: "medium",
			engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
		});
	});

	test("Bifrost keeps its x-bf-vk header name on the transport wire", async () => {
		const transport = new StrictTransport();
		await transport.run({
			vmid: 9001,
			jobId: "rw-bifrost-283",
			job: "probe",
			runtime: "codex",
			model: "deepseek-v4-flash-0731",
			effort: "low",
			engineEndpoint: ENGINE_ENDPOINTS.bifrost,
		});
		expect(transport.calls[0]?.params).toMatchObject({
			engine_base_url: "http://10.0.20.158:8080",
			engine_auth_header_name: "x-bf-vk",
		});
		transport.assertScriptConsumed();
	});

	test("the agentless script route submits the reviewed luna/max route and the cliproxyapi endpoint", async () => {
		const resolved = resolveRuntimeRoute(
			"infra-static-agentless",
			{ body: "actionlint", runtime: "script" },
			{},
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error(resolved.reason);
		expect(resolved.submission).toEqual({
			body: "actionlint",
			runtime: "script",
			model: "gpt-6-luna",
			effort: "max",
			engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
		});

		const transport = new StrictTransport();
		const { body, ...route } = resolved.submission;
		await transport.run({
			vmid: 9001,
			jobId: "rw-script-283",
			job: body,
			...route,
		});
		expect(transport.calls[0]?.params).toMatchObject({
			runtime: "script",
			model: "gpt-6-luna",
			effort: "max",
			engine_base_url: ENGINE_ENDPOINTS.cliproxyapi.baseUrl,
			engine_auth_header_name: ENGINE_ENDPOINTS.cliproxyapi.authHeaderName,
		});
		transport.assertScriptConsumed();
	});
});
