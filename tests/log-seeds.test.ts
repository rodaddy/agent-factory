/**
 * @module tests/log-seeds
 * @description Covers the sf#526 boundary seeds and the JSON-only service
 *   output: the default reconcile result sink emits one parseable
 *   `reconcile.pass` JSON line; a pass scope stamps a fresh `pass_id` on every
 *   line of the pass and hands it to the result sink; a webhook delivery stamps
 *   `delivery_id` on lines inside its scope but NOT on the wake, which rings the
 *   scheduler and must not leak the delivery into a pass.
 *
 *   pino writes straight to fd 2, so lines are observed from a child `bun -e`
 *   with `LOG_LEVEL=debug`, its stderr parsed as NDJSON (the mechanism of
 *   `tests/log-context.test.ts`).
 */

import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Run a snippet in a child bun at debug; return its stderr NDJSON and raw text. */
async function emitted(
	snippet: string,
): Promise<{ raw: string; lines: Record<string, unknown>[] }> {
	const proc = Bun.spawn(["bun", "-e", snippet], {
		cwd: REPO_ROOT,
		env: { ...process.env, LOG_LEVEL: "debug" },
		stderr: "pipe",
		stdout: "pipe",
	});
	const raw = await new Response(proc.stderr).text();
	await proc.exited;
	const lines = raw
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	return { raw, lines };
}

/** The single line whose `msg` is `event`. */
function line(lines: Record<string, unknown>[], event: string): Record<string, unknown> {
	const found = lines.filter((entry) => entry.msg === event);
	expect(found).toHaveLength(1);
	return found[0] as Record<string, unknown>;
}

const PASS = `{ startedAt: "2026-09-24T00:00:00Z", durationMs: 12, okCount: 1, failCount: 1,
	repositories: [{ repository: "o/r", error: "forge 500" }] }`;

describe("reconcile pass output", () => {
	test("the default result sink emits one parseable reconcile.pass JSON line", async () => {
		const { raw, lines } = await emitted(`
			import { logPassResult } from "./src/service-pass-log.ts";
			logPassResult(${PASS});
		`);
		for (const text of raw.split("\n").filter((t) => t.trim() !== "")) {
			expect(() => JSON.parse(text)).not.toThrow();
		}
		const pass = line(lines, "reconcile.pass");
		expect(pass.ok).toBe("1");
		expect(pass.failed).toBe("1");
		expect(pass.ms).toBe("12");
		expect(pass.failures).toBe("o/r: forge 500");
	});

	test("each pass gets a fresh pass_id on its lines and on its result sink", async () => {
		const { lines } = await emitted(`
			import { log, withLogFields } from "./src/log.ts";
			import { logPassResult, passScoped } from "./src/service-pass-log.ts";
			const pass = passScoped(async () => { log("info", "t.in_pass"); return ${PASS}; });
			const first = await pass.run();
			withLogFields(pass.fields(), () => logPassResult(first));
			log("info", "t.after");
			await pass.run();
		`);
		const inPass = lines.filter((entry) => entry.msg === "t.in_pass");
		expect(inPass).toHaveLength(2);
		expect(typeof inPass[0]?.pass_id).toBe("string");
		expect(inPass[1]?.pass_id).not.toBe(inPass[0]?.pass_id);
		expect(line(lines, "reconcile.pass").pass_id).toBe(inPass[0]?.pass_id);
		expect(line(lines, "t.after").pass_id).toBeUndefined();
	});
});

describe("webhook delivery seed", () => {
	test("lines inside the delivery carry delivery_id; the wake does not", async () => {
		const { lines } = await emitted(`
			import { createHmac } from "node:crypto";
			import { handleForgejoHook } from "./src/hooks/forgejo.ts";
			import { withTestDb } from "./tests/db/helpers.ts";
			const body = JSON.stringify({ action: "opened", repository: { full_name: "rodaddy/software-factory" } });
			const sig = createHmac("sha256", "k").update(body).digest("hex");
			await withTestDb(async (db) => {
				await handleForgejoHook(new Request("http://h/hooks/forgejo", { method: "POST", body, headers: {
					"content-type": "application/json", "x-forgejo-signature": sig,
					"x-forgejo-event": "issues", "x-forgejo-delivery": "d-526" } }), {
					secret: "k", db,
					config: { poll_interval_minutes: 15, job_templates: [],
						doorbell_enabled: true, shadow_publish: false,
						repositories: [{ name: "rodaddy/software-factory", provider: "forgejo", checks: "standard", gate_selection: "full" }] },
					sopGate: () => { throw new Error("gate down"); },
					wake: () => { throw new Error("wake down"); },
				});
			});
		`);
		const gate = line(lines, "hooks.forgejo.sop_gate_failed");
		expect(gate.delivery_id).toBe("d-526");
		expect(gate.repository).toBe("rodaddy/software-factory");
		expect(line(lines, "hooks.forgejo.wake_failed").delivery_id).toBeUndefined();
	});
});
