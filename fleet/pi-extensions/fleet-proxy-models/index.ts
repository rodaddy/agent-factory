/**
 * @module fleet/pi-extensions/fleet-proxy-models
 * @description Registers Pi's `fleet-proxy` provider from the LIVE proxy
 *   catalog on every Pi start. The async factory fetches
 *   `${FLEET_PROXY_BASE_URL:-https://subs.example.internal}/v1/models` (10 s bound)
 *   and calls `pi.registerProvider("fleet-proxy", ...)`; Pi waits for it, so the
 *   models are visible to startup model selection and `pi --list-models`. No
 *   file is read or written: there is no seat snapshot to drift from the board.
 *
 *   Every catalog entry is offered to every seat; the board's model is the one
 *   selector. An entry is dropped when `deprecated` or `excluded` is true (the
 *   catalog's own flags), or it lacks a numeric contextWindow and maxTokens and an
 *   input list (Pi cannot list or run it: image, video and embedding entries,
 *   and any chat entry the catalog has not described yet). Each model carries
 *   `id` plus the entry's name,
 *   reasoning, thinkingLevelMap, input, contextWindow and maxTokens, a Pi
 *   `cost` mapped from `price` (USD per Mtok, missing subkey 0; no price or a
 *   non-token `price.unit` is cost 0; the catalog's own `cost` is all zeros and
 *   unused), and `baseUrl`/`api` from its `endpoint` block when present. The
 *   provider default is `<base>/v1` and `openai-completions`; apiKey is "none".
 *
 *   An entry whose numeric `compactAt` (the prompt size above which the price
 *   rises) is positive and below its contextWindow declares `compactAt` as the
 *   Pi contextWindow, so Pi compacts before the price step; the catalog's own
 *   contextWindow stays the true limit. Pi's model has no
 *   `compactAt` field, so it is not copied; any other `compactAt` is ignored.
 *
 *   A fetch or shape failure writes one `fleet-proxy-models: ...` line to
 *   stderr, exits 1 for model discovery, and throws for prompt execution.
 *   There is no cached or built-in list.
 */

export const PROVIDER = "fleet-proxy";
export const DEFAULT_BASE = "https://subs.example.internal";
const TIMEOUT_MS = 10_000;
const PASSTHROUGH = [
	"name",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"contextWindow",
	"maxTokens",
];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

type Entry = Record<string, unknown> & { id: string };
type Cost = Record<(typeof COST_KEYS)[number], number>;
export type PiModel = Record<string, unknown> & { id: string; cost: Cost };
export type ProviderConfig = {
	baseUrl: string;
	api: string;
	apiKey: string;
	models: PiModel[];
};
type PiApi = {
	registerProvider: (name: string, config: ProviderConfig) => void;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function costOf(price: unknown): Cost {
	const priced = isObj(price) && !("unit" in price);
	const out = {} as Cost;
	for (const k of COST_KEYS) {
		const v = priced ? price[k] : 0;
		out[k] = typeof v === "number" ? v : 0;
	}
	return out;
}

function kept(e: Entry): boolean {
	if (e.deprecated === true || e.excluded === true) return false;
	// Pi --list-models crashes on a model without these (probed, Pi 1.0.3).
	const { contextWindow: cw, maxTokens: mt, input } = e;
	return typeof cw === "number" && typeof mt === "number" && Array.isArray(input);
}

function modelOf(e: Entry): PiModel {
	const m: PiModel = { id: e.id, cost: costOf(e.price) };
	for (const k of PASSTHROUGH) if (k in e) m[k] = e[k];
	const { compactAt: at, contextWindow: cw } = e;
	if (typeof at === "number" && typeof cw === "number" && at > 0 && at < cw) m.contextWindow = at;
	const ep = e.endpoint;
	if (isObj(ep) && typeof ep.baseUrl === "string") m.baseUrl = ep.baseUrl;
	if (isObj(ep) && typeof ep.api === "string") m.api = ep.api;
	return m;
}

/** The provider config for a parsed `/v1/models` body; throws on a bad shape. */
export function providerOf(body: unknown, base: string): ProviderConfig {
	if (!isObj(body) || !Array.isArray(body.data)) throw new Error("catalog has no data list");
	const entries = body.data.filter((e): e is Entry => isObj(e) && typeof e.id === "string");
	const models = entries.filter(kept).map(modelOf);
	if (models.length === 0) throw new Error("catalog lists no usable model");
	return {
		baseUrl: `${base}/v1`,
		api: "openai-completions",
		apiKey: "none",
		models,
	};
}

export default async function (pi: PiApi): Promise<void> {
	const base = (process.env.FLEET_PROXY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
	const url = `${base}/v1/models`;
	let config: ProviderConfig;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		config = providerOf(await res.json(), base);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`fleet-proxy-models: ${url}: ${why} seat=${process.env.FLEET_EMPLOYEE || "unknown"}\n`,
		);
		// Pi catches extension errors and explicitly exits 0 after --list-models.
		// A failed live catalog must not turn stale models.json into availability.
		if (process.argv.includes("--list-models")) process.exit(1);
		throw err;
	}
	pi.registerProvider(PROVIDER, config);
}
