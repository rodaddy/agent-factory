/**
 * `isRunTimeout` classifies by the transport's own timeout shapes, never by
 * free-form "timed out" text. A verb that RAN and failed
 * with timeout wording in its output is a failed verb: it must take the
 * reap-and-release path, not the hold path.
 */
import { describe, expect, test } from "bun:test";
import { isRunTimeout } from "../../src/runner/run-timeout";

describe("isRunTimeout", () => {
	test("the HTTP transport's AbortSignal.timeout rejection is a timeout", () => {
		// The REAL shape (probed on Bun 2026-09-03, PR #575 second review P1): a
		// `DOMException` named `TimeoutError`, which IS an `instanceof Error`.
		const real = new DOMException("The operation timed out.", "TimeoutError");
		expect(real instanceof Error).toBe(true);
		expect(isRunTimeout(real)).toBe(true);
		// A plain Error carrying the name classifies the same way.
		const renamed = new Error("The operation timed out.");
		renamed.name = "TimeoutError";
		expect(isRunTimeout(renamed)).toBe(true);
	});

	test("the CLI transport's own invoke timer is a timeout", () => {
		expect(isRunTimeout(new Error("runner-boxes runner_run timed out after 90000ms"))).toBe(true);
	});

	test("the CLI client-to-daemon hop fault keeps its own reap-then-hold path", () => {
		expect(
			isRunTimeout(
				new Error(
					'runner_run failed (exit 1) -- {"error":true,"code":"CONNECTION_ERROR","message":"Failed to communicate with local daemon: The operation timed out."}',
				),
			),
		).toBe(false);
		expect(
			isRunTimeout(new Error("CONNECTION_ERROR: failed to communicate with local daemon")),
		).toBe(false);
	});

	test("a verb that RAN and failed with timeout wording is NOT a timeout", () => {
		expect(
			isRunTimeout(new Error("runner_run failed (exit 1) -- ssh: connect to host timed out")),
		).toBe(false);
		expect(isRunTimeout(new Error("request timed out"))).toBe(false);
	});

	test("a non-Error is never a timeout", () => {
		expect(isRunTimeout("timed out")).toBe(false);
	});
});
