/**
 * @module fleet/pi-extensions/seam-probe
 * @description A throwaway probe for the four Pi seams the fleet builds on.
 *  Loaded with `-e` in a run started the way Paperclip's
 *   `pi_local` adapter starts Pi, it appends one JSON line per observation to
 *   the file named by `PI_SEAM_PROBE_OUT`: `loaded`, `input` (the prompt's
 *   length, never its text), `tools` (the active tool names), and `header`
 *   (after setting `x-bf-paperclip-run-id`). With `PI_SEAM_PROBE_OUT` unset it
 *   registers nothing. A failed write is swallowed: the probe never breaks a run.
 *   `scripts/done-means/pi-seams-probe.sh` judges the file; `RUN.md` is the run.
 */
import { appendFileSync } from "node:fs";

type Handler = (event: Record<string, unknown>) => unknown;
type PiApi = { on: (name: string, handler: Handler) => void; getActiveTools: () => string[] };

const HEADER = "x-bf-paperclip-run-id";
/** Pi aliases its own package for extensions; a variable keeps tsc from resolving it here. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export default function (pi: PiApi) {
	const out = process.env.PI_SEAM_PROBE_OUT;
	if (!out) return;
	const note = (line: Record<string, unknown>) => {
		try {
			appendFileSync(out, `${JSON.stringify({ ...line, ts: new Date().toISOString() })}\n`);
		} catch {
			// the probe must never break a run
		}
	};

	import(PI_PACKAGE)
		.then((m: { VERSION?: unknown }) => (typeof m.VERSION === "string" ? m.VERSION : null))
		.catch(() => null)
		.then((version) => note({ seam: "loaded", pi: version }));

	pi.on("input", (event) => {
		const text = typeof event.text === "string" ? event.text : "";
		note({ seam: "input", source: event.source ?? null, chars: text.length });
	});

	// before_agent_start fires after the prompt is submitted and before the agent
	// loop, with the system prompt already rendered from the active tools: the
	// earliest point the types promise the list is final. session_start only says
	// why a session started, and the tool set can still change after it.
	pi.on("before_agent_start", () => {
		try {
			note({ seam: "tools", active: pi.getActiveTools() });
		} catch {
			note({ seam: "tools", active: null });
		}
	});

	// Handlers edit headers in place; the return value is ignored.
	pi.on("before_provider_headers", (event) => {
		const headers = event.headers as Record<string, string | null> | undefined;
		if (!headers) return;
		headers[HEADER] = process.env.PAPERCLIP_RUN_ID || "probe";
		note({ seam: "header", name: HEADER });
	});
}
