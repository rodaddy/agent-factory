import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ignoreIncomingRequest } from "../../fleet/paperclip-otel/ignore.mjs";

// The two off-switches the README's Backout relies on, run under real
// `node --import` exactly as the systemd drop-in loads the preload.
// PAPERCLIP_OTEL_PRELOAD_UNDER_TEST points the suite at a mutated copy (RED proof).
const preload = resolve(
	process.env.PAPERCLIP_OTEL_PRELOAD_UNDER_TEST ??
		join(import.meta.dir, "../../fleet/paperclip-otel/preload.mjs"),
);
// No @opentelemetry packages live here, so resolving the ESM hook throws.
const NO_MODULES = "/nonexistent/paperclip-otel-modules/";

function runWithPreload(env: Record<string, string>) {
	const clean: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("OTEL_") && !k.startsWith("PAPERCLIP_OTEL_")) clean[k] = v;
	}
	return spawnSync("node", ["--import", preload, "-e", "process.stdout.write('server-ran')"], {
		env: { ...clean, ...env },
		encoding: "utf8",
		timeout: 20_000,
	});
}

describe("paperclip-otel preload off-switches", () => {
	test("no OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: the preload does nothing and the server runs", () => {
		const r = runWithPreload({ PAPERCLIP_OTEL_MODULES: NO_MODULES });
		expect(r.error).toBeUndefined();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("server-ran");
		expect(r.stderr).not.toContain("[paperclip-otel]");
	});

	test("a startup error prints one [paperclip-otel] line and the server runs untraced", () => {
		const r = runWithPreload({
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9/v1/traces",
			PAPERCLIP_OTEL_MODULES: NO_MODULES,
		});
		expect(r.error).toBeUndefined();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("server-ran");
		const lines = r.stderr.split("\n").filter((l) => l.includes("[paperclip-otel]"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("[paperclip-otel] tracing not started:");
	});
});

describe("paperclip-otel ignored requests", () => {
	test("the health probe and better-auth's session check are not traced", () => {
		for (const url of [
			"/api/health",
			"/api/health/db",
			"/api/auth/get-session",
			"/api/auth/get-session?disableCookieCache=true",
		]) {
			expect(ignoreIncomingRequest(url)).toBe(true);
		}
	});

	test("other requests are traced", () => {
		for (const url of ["/api/issues", "/api/auth/sign-in", "/get-session-history", undefined]) {
			expect(ignoreIncomingRequest(url)).toBe(false);
		}
	});
});
