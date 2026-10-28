import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildIngestionBatch,
	extractSteps,
	parseLogContent,
	redact,
	truncate,
} from "../../fleet/plugins/run-trace/logic.js";
import { traceRun, withRetry } from "../../fleet/plugins/run-trace/trace.js";

const dir = join(import.meta.dir, "..", "fixtures", "run-trace");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

const claudeRun = load("claude_local-run.json");
const claudeLog = load("claude_local-log.json");
const piRun = load("pi_local-run.json");
const piLog = load("pi_local-log.json");

describe("cache-creation tokens", () => {
	test("claude_local generations carry cacheCreation from the fixture", () => {
		const steps = extractSteps("claude_local", parseLogContent(claudeLog.content));
		const gens = steps.filter((s) => s.kind === "generation");
		expect(gens.some((g) => (g.usage?.cacheCreation ?? 0) > 0)).toBe(true);
	});
});

describe("parseLogContent", () => {
	test("parses stdout events and keeps stderr text", () => {
		const entries = parseLogContent(piLog.content);
		expect(entries.length).toBeGreaterThan(0);
		const err = entries.find((e) => e.stream === "stderr");
		expect(err?.event).toBeNull();
		expect(err?.text).toContain("JEV_EVENT");
		expect(entries.every((e) => e.stream !== "stdout" || e.event)).toBe(true);
	});
});

describe("extractSteps claude_local", () => {
	const steps = extractSteps("claude_local", parseLogContent(claudeLog.content));
	const gens = steps.filter((s) => s.kind === "generation");
	const tools = steps.filter((s) => s.kind === "tool");

	test("3 generations (distinct message ids) and 2 tool steps", () => {
		expect(gens.length).toBeGreaterThan(0);
		expect(new Set(gens.map((g) => g.id)).size).toBe(gens.length);
		expect(gens.length).toBe(3);
		expect(tools.length).toBe(2);
	});

	test("tool step closed by its tool_result", () => {
		const tool = tools[0];
		expect(tool?.id).toBe("toolu_01ApMBmpz5t2FRYLnPDQJ5Tc");
		expect(tool?.name).toBe("Bash");
		expect(tool?.output).toBe("sf-cto\n---\nHTTP 200");
		expect(tool?.isError).toBe(false);
		expect(tool?.endTime).toBeTruthy();
	});

	test("generation carries model and usage", () => {
		expect(gens[0]?.model).toBe("claude-opus-5-5");
		expect(typeof gens[0]?.usage?.input).toBe("number");
	});
});

describe("extractSteps pi_local", () => {
	const steps = extractSteps("pi_local", parseLogContent(piLog.content));
	const gens = steps.filter((s) => s.kind === "generation");
	const tools = steps.filter((s) => s.kind === "tool");

	test("3 generations and 2 tool steps", () => {
		expect(gens.length).toBe(3);
		expect(tools.length).toBe(2);
		expect(gens[0]?.model).toBe("claudex/gpt-6-luna");
	});

	test("first tool step is the jev-guard block; second succeeds", () => {
		expect(tools[0]?.isError).toBe(true);
		expect(tools[1]?.isError).toBe(false);
		expect(String(tools[0]?.output)).toContain("jev-guard blocked");
	});
});

test("unknown adapter gives []", () => {
	expect(extractSteps("nope", parseLogContent(piLog.content))).toEqual([]);
});

describe("buildIngestionBatch", () => {
	const build = () =>
		buildIngestionBatch(
			claudeRun,
			extractSteps("claude_local", parseLogContent(claudeLog.content)),
			{},
		);

	test("one trace-create, stable ids prefixed by run id", () => {
		const a = build();
		const b = build();
		expect(a.filter((e) => e.type === "trace-create").length).toBe(1);
		expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		for (const e of a) {
			expect(String(e.body.id).startsWith(claudeRun.id)).toBe(true);
			expect(e.id).toBe(`${e.body.id}-event`);
		}
		expect(a.some((e) => e.type === "span-create")).toBe(true);
		expect(a.some((e) => e.type === "generation-create")).toBe(true);
	});

	test("pi errored tool span is level ERROR", () => {
		const batch = buildIngestionBatch(
			piRun,
			extractSteps("pi_local", parseLogContent(piLog.content)),
			{},
		);
		const spans = batch.filter((e) => e.type === "span-create" && e.body.name !== "assistant");
		expect(spans[0]?.body.level).toBe("ERROR");
		expect(spans[1]?.body.level).toBeUndefined();
	});
});

describe("redact and truncate", () => {
	test("redact replaces sk- keys and JWTs", () => {
		const out = redact("key sk-abcdefghijklmnop1234 jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl");
		expect(out).not.toContain("sk-abcdefghijklmnop1234");
		expect(out).not.toContain("eyJhbGciOi");
		expect(out).toContain("REDACTED");
	});

	test("redact replaces pcp_ keys and token= values", () => {
		const key = `pcp_${"a1B2c3D4e5F6g7H8i9J0"}`;
		const tok = `token=${"Zy9Xw8Vu7Ts6Rq5Po4Nm"}`;
		const out = redact(`key ${key} url ?${tok}`);
		expect(out).not.toContain(key);
		expect(out).not.toContain("Zy9Xw8Vu7Ts6Rq5Po4Nm");
		expect(out).toContain("REDACTED");
	});

	test("truncate caps length", () => {
		const out = truncate("x".repeat(5000), 100);
		expect(out.startsWith("x".repeat(100))).toBe(true);
		expect(out).toContain("[truncated 4900 chars]");
		expect(out.length).toBeLessThan(130);
		expect(truncate("short", 100)).toBe("short");
	});
});

describe("redact: credentials the review found leaking (PR 1200, P1)", () => {
	const hex = "0123456789abcdef0123456789abcdef01234567";
	test("a bare 40-hex Forge token after `token ` or `Bearer ` is redacted", () => {
		expect(redact(`-H "Authorization: token ${hex}"`)).not.toContain(hex);
		expect(redact(`Authorization: Bearer ${hex}`)).not.toContain(hex);
	});
	test("a short password value is redacted", () => {
		expect(redact('{"password":"hunter2"}')).not.toContain("hunter2");
		expect(redact("secret=abc")).not.toContain("=abc");
	});
	test("any bare 40-hex value is redacted: a Forge token and a full sha look the same (PR 1200, P1 round 10)", () => {
		const out = redact(`token value ${hex}\ncommit ${hex.slice(0, 7)} short sha kept`);
		expect(out).not.toContain(hex);
		expect(out).toContain(hex.slice(0, 7));
	});
});

test("a credential inside JSON escaped a second time is redacted (PR 1200, P1)", () => {
	const twice = JSON.stringify(JSON.stringify({ password: "hunter2", api_key: "abc123" }));
	const out = redact(twice);
	expect(out).not.toContain("hunter2");
	expect(out).not.toContain("abc123");
});

test("a quoted secret with spaces is redacted whole (PR 1200, P1 round 3)", () => {
	expect(redact('{"password":"correct horse battery"}')).not.toMatch(/correct|horse|battery/);
	expect(redact(JSON.stringify(JSON.stringify({ secret: "two words" })))).not.toMatch(/two|words/);
	const quoted = redact("token = 'a b c'");
	expect(quoted).not.toMatch(/\ba\b|\bb\b|\bc\b/);
	expect(quoted).toContain("REDACTED");
});

describe("redaction is structural for data and fail-safe for text (PR 1200, P1 round 4)", () => {
	test("a credential with an escaped quote inside leaks nothing, object or string", () => {
		const input = { command: "login", password: 'a"remaining-secret', nested: { api_key: "k1" } };
		const batch = buildIngestionBatch(
			{ id: "r", agentId: "a", startedAt: "t", contextSnapshot: {}, usageJson: {} },
			[
				{
					kind: "tool",
					id: "s",
					name: "Bash",
					model: null,
					input,
					output: JSON.stringify(JSON.stringify(input)),
					startTime: "t",
					endTime: "t",
					usage: null,
					isError: false,
				},
			],
		);
		const text = JSON.stringify(batch);
		expect(text).not.toContain("remaining-secret");
		expect(text).not.toContain("k1");
		expect(text).toContain('"args"');
	});
	test("free text after a credential key is redacted to the end of the line", () => {
		const out = redact('password: a\\"remaining-secret and more\nnext line kept');
		expect(out).not.toContain("remaining-secret");
		expect(out).toMatch(/^REDACTED/);
	});
});

test("credential header spellings are redacted (PR 1200, P1 round 5)", () => {
	const hex = "0123456789abcdef0123456789abcdef01234567";
	for (const line of [
		`x-api-key: ${hex}`,
		`Api-Key=${hex}`,
		`Private-Token: ${hex}`,
		`X-Access-Key: ${hex}`,
		`Cookie: sid=${hex}`,
		`authorization: ${hex}`,
	]) {
		expect(redact(line)).not.toContain(hex);
	}
});

test("credential-keyed text is withheld whole: multiline values cannot survive (PR 1200, P1 round 6)", () => {
	const yaml = "db:\n  password: |\n    correct-horse-battery-staple\n  host: x";
	const out = redact(yaml);
	expect(out).not.toContain("correct-horse-battery-staple");
	expect(out).toMatch(/^REDACTED/);
	expect(redact("plain tool output with 12 tokens used")).toBe(
		"plain tool output with 12 tokens used",
	);
});

test("a PEM private key block is withheld whole (PR 1200, P1 round 7)", () => {
	for (const kind of ["OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "PRIVATE KEY", "EC PRIVATE KEY"]) {
		const out = redact(
			`cat id\n-----BEGIN ${kind}-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END ${kind}-----`,
		);
		expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
	}
});

test("whitespace-separated passwords (.netrc) are withheld (PR 1200, P1 round 8)", () => {
	const netrc = "machine forge.example.internal login sf-x password s3cr3t-netrc-value";
	expect(redact(netrc)).not.toContain("s3cr3t-netrc-value");
	expect(redact("the token was refreshed and 12 tokens used")).toBe(
		"the token was refreshed and 12 tokens used",
	);
});

test("credentials in a URL or a GitHub-style token are not exported (PR 1200, P1 round 9)", () => {
	const ghp = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
	expect(redact(`git clone https://oauth2:${ghp}@github.com/org/repo`)).not.toContain(ghp);
	expect(redact("remote https://sf-x:plainpass123@forge.example.internal/a/b.git")).not.toContain(
		"plainpass123",
	);
	expect(redact(`echo ${ghp}`)).not.toContain(ghp);
	expect(redact("see https://forge.example.internal/a/b/pulls/1")).toBe(
		"see https://forge.example.internal/a/b/pulls/1",
	);
});

test("tool spans export no content: only argument names and output size (PR 1200, P1 round 11)", () => {
	const batch = buildIngestionBatch(
		{ id: "r", agentId: "a", startedAt: "t", contextSnapshot: {}, usageJson: {} },
		[
			{
				kind: "tool",
				id: "s",
				name: "Bash",
				model: null,
				input: {
					command: [
						"curl",
						"-u",
						["admin", "correct-horse-battery-staple"].join(":"),
						"https://example.com",
					].join(" "),
					description: "probe",
				},
				output: "HTTP 200 admin:correct-horse-battery-staple",
				startTime: "t",
				endTime: "t",
				usage: null,
				isError: false,
			},
		],
	);
	const span = batch.find((e) => e.type === "span-create");
	const text = JSON.stringify(span);
	expect(text).not.toContain("correct-horse-battery-staple");
	expect(span?.body.input).toEqual({ args: ["command", "description"] });
	expect(span?.body.output).toEqual({ chars: 43 });
});

describe("traceRun resilience", () => {
	const config = { boardUrl: "http://board.test", langfuseHost: "https://lf.test" };
	const secrets = { boardApiKey: "bk", langfusePublicKey: "pk", langfuseSecretKey: "sk" };
	const noSleep = async () => {};
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	function fake(opts: { logStatus?: number; lfStatuses?: number[]; throwFirst?: number } = {}) {
		const calls: { url: string; init?: RequestInit }[] = [];
		let thrown = 0;
		let lf = 0;
		const impl = async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (thrown < (opts.throwFirst ?? 0)) {
				thrown++;
				throw new TypeError("fetch failed");
			}
			if (url === `${config.boardUrl}/api/heartbeat-runs/${claudeRun.id}`) return json(claudeRun);
			if (url.endsWith("/log"))
				return opts.logStatus
					? new Response("not found", { status: opts.logStatus })
					: json(claudeLog);
			if (url.includes("/api/agents/")) return json({ name: "sf-cto" });
			const status = opts.lfStatuses?.[lf++] ?? 207;
			if (status >= 300) return new Response("err", { status });
			return json({ successes: [], errors: [] }, 207);
		};
		return { calls, impl };
	}
	const run = (impl: (u: string, i?: RequestInit) => Promise<Response>) =>
		traceRun({
			runId: claudeRun.id,
			companyId: "c",
			config,
			fetchImpl: impl,
			secrets,
			sleep: noSleep,
		});
	const posts = (calls: { url: string; init?: RequestInit }[]) =>
		calls.filter((c) => c.url === `${config.langfuseHost}/api/public/ingestion`);

	test("a 404 run log still sends the trace", async () => {
		const f = fake({ logStatus: 404 });
		await run(f.impl);
		const p = posts(f.calls);
		expect(p.length).toBe(1);
		const batch = JSON.parse(String(p[0]?.init?.body)).batch;
		expect(batch.some((e: { type: string }) => e.type === "trace-create")).toBe(true);
	});

	test("fetch failed is retried", async () => {
		let n = 0;
		const out = await withRetry(
			async () => {
				n++;
				if (n <= 2) throw new TypeError("fetch failed");
				return "ok";
			},
			{ sleep: noSleep },
		);
		expect(out).toBe("ok");
		expect(n).toBe(3);
		const f = fake({ throwFirst: 2 });
		await run(f.impl);
		expect(posts(f.calls).length).toBe(1);
	});

	test("a 429 from Langfuse is retried and a 400 is not", async () => {
		const a = fake({ lfStatuses: [429] });
		await run(a.impl);
		expect(posts(a.calls).length).toBe(2);
		const b = fake({ lfStatuses: [400] });
		let msg = "";
		try {
			await run(b.impl);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain("400");
		expect(posts(b.calls).length).toBe(1);
	});

	test("generations carry usageDetails and costDetails", () => {
		const gen = (id: string, input: number, output: number) => ({
			kind: "generation" as const,
			id,
			name: "g",
			model: null,
			input: "i",
			output: "o",
			startTime: "t",
			endTime: "t",
			usage: { input, output, cacheRead: 5, cacheCreation: 7 },
			isError: false,
		});
		const batch = buildIngestionBatch(
			{
				id: "r",
				agentId: "a",
				startedAt: "t",
				contextSnapshot: {},
				usageJson: { costUsd: 1.0, model: "m1" },
			},
			[gen("a", 200, 100), gen("b", 50, 50)],
		);
		const gens = batch.filter((e) => e.type === "generation-create");
		expect(gens.map((g) => (g.body.costDetails as { total: number }).total)).toEqual([0.75, 0.25]);
		expect(gens[0]?.body.usageDetails).toEqual({
			input: 200,
			output: 100,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 7,
		});
		expect(gens[0]?.body.model).toBe("m1");
	});

	test("no costDetails when costUsd is 0", () => {
		const batch = buildIngestionBatch(
			{ id: "r", agentId: "a", startedAt: "t", contextSnapshot: {}, usageJson: { costUsd: 0 } },
			extractSteps("claude_local", parseLogContent(claudeLog.content)),
		);
		for (const g of batch.filter((e) => e.type === "generation-create"))
			expect(g.body.costDetails).toBeUndefined();
	});

	test("every trace carries userId (the agent) and sessionId (the issue)", () => {
		const batch = buildIngestionBatch(
			{
				id: "r",
				agentId: "a1",
				agentName: "Smythe",
				startedAt: "t",
				contextSnapshot: { issueId: "i1" },
				usageJson: {},
			},
			[],
		);
		const trace = batch.find((e) => e.type === "trace-create");
		expect(trace?.body.userId).toBe("Smythe");
		expect(trace?.body.sessionId).toBe("i1");
	});

	test("one name per model: routing prefixes are stripped", () => {
		const gen = (model: string) => ({
			kind: "generation" as const,
			id: model,
			name: "g",
			model,
			input: "",
			output: "",
			startTime: "t",
			endTime: "t",
			usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
			isError: false,
		});
		const batch = buildIngestionBatch(
			{
				id: "r",
				agentId: "a",
				startedAt: "t",
				contextSnapshot: {},
				usageJson: { model: "bifrost/claudex/gpt-6-luna" },
			},
			[gen("claudex/gpt-6-luna"), gen("gpt-6-luna"), gen("bifrost/claudex/gpt-6.1-sol")],
		);
		const gens = batch.filter((e) => e.type === "generation-create");
		expect(gens.map((g) => g.body.model)).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"]);
		const trace = batch.find((e) => e.type === "trace-create");
		expect((trace?.body.metadata as { model?: string } | undefined)?.model).toBe("gpt-6-luna");
	});
});

describe("cached tokens through Bifrost (SOF-5117)", () => {
	const piEnd = (provider: string, model: string) => ({
		ts: "2026-10-05T00:56:29.355Z",
		stream: "stdout",
		event: {
			type: "message_end",
			message: {
				role: "assistant",
				provider,
				model,
				content: [{ type: "text", text: "ok" }],
				usage: { input: 88959, output: 549, cacheRead: 81920, cacheWrite: 0 },
			},
		},
	});

	test("pi via bifrost: input excludes the cached tokens", () => {
		const [gen] = extractSteps("pi_local", [piEnd("bifrost", "claudex/gpt-6.1-sol")]);
		expect(gen?.usage).toEqual({ input: 7039, output: 549, cacheRead: 81920, cacheCreation: 0 });
	});

	test("pi via another provider: input is left as pi reports it", () => {
		const [gen] = extractSteps("pi_local", [piEnd("anthropic", "claude-opus-5-5")]);
		expect(gen?.usage).toEqual({ input: 88959, output: 549, cacheRead: 81920, cacheCreation: 0 });
	});

	test("gpt generations name the cache input_cached_tokens", () => {
		const batch = buildIngestionBatch(
			{ id: "r", agentId: "a", startedAt: "t", contextSnapshot: {}, usageJson: {} },
			extractSteps("pi_local", [piEnd("bifrost", "claudex/gpt-6.1-sol")]),
		);
		const gen = batch.find((e) => e.type === "generation-create");
		expect(gen?.body.model).toBe("gpt-6.1-sol");
		expect(gen?.body.usageDetails).toEqual({
			input: 7039,
			output: 549,
			input_cached_tokens: 81920,
			cache_creation_input_tokens: 0,
		});
	});
});
