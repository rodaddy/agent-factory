/**
 * @module tests/fleet/fleet-proxy-models
 * @description `fleet/pi-extensions/fleet-proxy-models`: the Pi
 *   extension that registers `fleet-proxy` from the live `/v1/models` catalog
 *   on every Pi start. The factory runs against a `Bun.serve` stub of the
 *   catalog on 127.0.0.1 and a fake `pi` that captures `registerProvider`.
 *   Real Pi on the fleet box was probed first: an entry without
 *   contextWindow, maxTokens and an input list crashes `pi --list-models`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import factory, {
	type ProviderConfig,
	providerOf,
} from "../../fleet/pi-extensions/fleet-proxy-models/index";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const EP = {
	name: "subs-proxy",
	baseUrl: "https://subs.example/v1",
	api: "openai-completions",
};
const CHAT = {
	object: "model",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	input: ["text", "image"],
	contextWindow: 272000,
	maxTokens: 128000,
	cost: ZERO,
	deprecated: false,
	endpoint: EP,
};
// Shapes from the live catalog (2026-10-06), plus fakes for each drop rule.
const chat = (id: string, family: string, price: object, more = {}) => ({
	...CHAT,
	id,
	family,
	price,
	...more,
});
const P1 = { input: 1, output: 5 };
const DATA = [
	chat("gpt-6.1-sol", "gpt-sol", { input: 2, output: 10, cacheRead: 0.1 }, { name: "GPT-6.1-Sol" }),
	chat("claude-opus-5-5", "claude-opus", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
	chat("gpt-sol-image", "gpt-sol", { unit: "image", output: 0.02 }),
	chat("claude-haiku-4-5", "claude-haiku", P1, { excluded: true }),
	chat("claude-haiku-5-5", "claude-haiku", P1),
	chat("gpt-5.9-sol", "gpt-sol", P1, { deprecated: true }),
	{ id: "grok-imagine-video", price: { unit: "second", output: 0.05 }, endpoint: EP },
	{ id: "grok-4.7", family: "grok", contextWindow: 256000, maxTokens: 64000, endpoint: EP },
];

let server: ReturnType<typeof Bun.serve>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/v1/models") return Response.json({ object: "list", data: DATA });
			if (path === "/bad/v1/models") return Response.json({ object: "list" });
			return new Response("no", { status: 503 });
		},
	});
});
afterAll(() => server.stop(true));

async function load(url: string) {
	const calls: [string, ProviderConfig][] = [];
	const errs: string[] = [];
	const write = process.stderr.write;
	const prior = process.env.FLEET_PROXY_BASE_URL;
	process.env.FLEET_PROXY_BASE_URL = url;
	process.stderr.write = ((s: string) => errs.push(String(s)) > 0) as typeof process.stderr.write;
	let error: unknown;
	try {
		await factory({
			registerProvider: (name, config) => calls.push([name, config]),
		});
	} catch (e) {
		error = e;
	} finally {
		process.stderr.write = write;
		if (prior === undefined) delete process.env.FLEET_PROXY_BASE_URL;
		else process.env.FLEET_PROXY_BASE_URL = prior;
	}
	return { calls, errs, error };
}

describe("fleet-proxy-models", () => {
	test("discovery failure cannot be swallowed into a successful host exit", async () => {
		const module = new URL("../../fleet/pi-extensions/fleet-proxy-models/index.ts", import.meta.url)
			.pathname;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import factory from ${JSON.stringify(module)};
			try { await factory({registerProvider() { console.log("registered"); }}); } catch {}
			process.exit(0);`,
				"--",
				"--list-models",
				"fleet-proxy",
			],
			{
				env: { ...process.env, FLEET_PROXY_BASE_URL: `${base()}/unavailable` },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(err).toContain("fleet-proxy-models:");
		expect(err).toContain("HTTP 503");
		expect(code).toBe(1);
		expect(out).toBe("");
	});

	test("registers every live chat model, no family filter; price maps to cost", async () => {
		const { calls, errs, error } = await load(`${base()}/`);
		expect(error).toBeUndefined();
		expect(errs).toEqual([]);
		expect(calls).toHaveLength(1);
		const [name, config] = calls[0] ?? ["", undefined];
		expect(name).toBe("fleet-proxy");
		expect(config).toMatchObject({
			baseUrl: `${base()}/v1`,
			api: "openai-completions",
			apiKey: "none",
		});
		const pi = {
			reasoning: true,
			thinkingLevelMap: CHAT.thinkingLevelMap,
			input: CHAT.input,
		};
		const sized = {
			contextWindow: 272000,
			maxTokens: 128000,
			baseUrl: EP.baseUrl,
			api: EP.api,
		};
		expect(config?.models).toEqual([
			{
				id: "gpt-6.1-sol",
				name: "GPT-6.1-Sol",
				...pi,
				...sized,
				cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
			},
			{
				id: "claude-opus-5-5",
				...pi,
				...sized,
				cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			},
			{ id: "gpt-sol-image", ...pi, ...sized, cost: ZERO },
			{ id: "claude-haiku-5-5", ...pi, ...sized, cost: { ...ZERO, ...P1 } },
		]);
	});

	for (const [what, path] of [
		["catalog down", "/down"],
		["catalog without a data list", "/bad"],
	] as const) {
		test(`${what}: one stderr line, throws, registers nothing`, async () => {
			const { calls, errs, error } = await load(`${base()}${path}`);
			expect(error).toBeInstanceOf(Error);
			expect(calls).toEqual([]);
			expect(errs).toHaveLength(1);
			expect(errs[0]).toStartWith(`fleet-proxy-models: ${base()}${path}/v1/models: `);
			expect(errs[0]).toContain("seat=");
		});
	}

	// compactAt: the prompt size above which the price rises.
	const windowOf = (more: object) => {
		const [m] = providerOf({ data: [chat("m", "f", P1, more)] }, "http://x").models;
		expect(m).not.toHaveProperty("compactAt");
		return m?.contextWindow;
	};
	test("compactAt below contextWindow is the declared Pi window", () => {
		expect(windowOf({ compactAt: 100000 })).toBe(100000);
	});
	test("compactAt absent: contextWindow unchanged", () => {
		expect(windowOf({})).toBe(272000);
	});
	for (const at of [272000, 300000, 0, -1, "100000", null]) {
		test(`compactAt ${JSON.stringify(at)} is ignored`, () => {
			expect(windowOf({ compactAt: at })).toBe(272000);
		});
	}
});
