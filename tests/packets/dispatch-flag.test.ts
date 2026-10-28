import { describe, expect, test } from "bun:test";
import {
	PACKET_PI_DISPATCH_ENV_VAR,
	packetPiDispatchEnabled,
} from "../../src/packets/dispatch-flag";

/**
 * The kill switch for emitting a packet's pi routing trio. The property
 * that matters is that OFF is unreachable-by-accident-proof: an unconfigured
 * deployment, an empty value, a disabled value, and a MISSPELLED value all resolve
 * to the safe state, because the unsafe state (emitting `runtime: "pi"` at a
 * wrapper that dies on it) burns an allocated box per dispatch.
 */
describe("packetPiDispatchEnabled defaults OFF", () => {
	test("an unconfigured environment is OFF", () => {
		expect(packetPiDispatchEnabled({})).toBe(false);
	});

	test("empty, whitespace, and explicit-disable values are OFF", () => {
		for (const raw of ["", "   ", "0", "false", "no", "off"]) {
			expect(packetPiDispatchEnabled({ [PACKET_PI_DISPATCH_ENV_VAR]: raw })).toBe(false);
		}
	});

	test("a MISSPELLED or unexpected value is OFF, never on", () => {
		// A kill switch that any truthy string opens is not a kill switch.
		for (const raw of ["enabled", "TRUE-ish", "pi", "1;", "y", "enable"]) {
			expect(packetPiDispatchEnabled({ [PACKET_PI_DISPATCH_ENV_VAR]: raw })).toBe(false);
		}
	});
});

describe("packetPiDispatchEnabled opt-in", () => {
	test("the exact opt-in spellings are ON, case- and whitespace-insensitive", () => {
		for (const raw of ["1", "true", "TRUE", " yes ", "on", "On"]) {
			expect(packetPiDispatchEnabled({ [PACKET_PI_DISPATCH_ENV_VAR]: raw })).toBe(true);
		}
	});

	test("another env var carrying an opt-in value does not enable it", () => {
		expect(packetPiDispatchEnabled({ PACKET_PI_DISPATCH: "1", SOMETHING_ELSE: "true" })).toBe(
			false,
		);
	});

	// The param exists so tests can inject an environment; production calls this
	// with NO argument. If the default were ever hardcoded away from `process.env`,
	// every test above would still pass while the real deployment read nothing.
	test("called with no argument, it reads the real process.env", () => {
		const before = process.env[PACKET_PI_DISPATCH_ENV_VAR];
		try {
			process.env[PACKET_PI_DISPATCH_ENV_VAR] = "true";
			expect(packetPiDispatchEnabled()).toBe(true);
			delete process.env[PACKET_PI_DISPATCH_ENV_VAR];
			expect(packetPiDispatchEnabled()).toBe(false);
		} finally {
			if (before === undefined) {
				delete process.env[PACKET_PI_DISPATCH_ENV_VAR];
			} else {
				process.env[PACKET_PI_DISPATCH_ENV_VAR] = before;
			}
		}
	});
});
