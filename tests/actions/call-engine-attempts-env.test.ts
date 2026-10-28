import { describe, expect, test } from "bun:test";
import {
	ENGINE_ATTEMPTS,
	MAX_ENGINE_ATTEMPTS,
	parseEngineAttempts,
} from "../../scripts/actions/call-engine";

describe("parseEngineAttempts", () => {
	test("MAX_ENGINE_ATTEMPTS is 5", () => expect(MAX_ENGINE_ATTEMPTS).toBe(5));
	test("huge digit string falls back to default", () =>
		expect(parseEngineAttempts("999999999999999999999")).toBe(ENGINE_ATTEMPTS));
	test("0 falls back to default", () => expect(parseEngineAttempts("0")).toBe(ENGINE_ATTEMPTS));
	test("5 is accepted", () => expect(parseEngineAttempts("5")).toBe(5));
	test("6 falls back to default", () => expect(parseEngineAttempts("6")).toBe(ENGINE_ATTEMPTS));
	test("2 is accepted, unset is default", () => {
		expect(parseEngineAttempts(" 2 ")).toBe(2);
		expect(parseEngineAttempts(undefined)).toBe(ENGINE_ATTEMPTS);
	});
});
