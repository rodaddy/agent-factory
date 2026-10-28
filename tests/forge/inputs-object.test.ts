import { describe, expect, test } from "bun:test";
import { inputsObject } from "../../src/forge/actions-store";

/** sf#911: one unwrap for forge_runs.inputs, object rows and pre-fix JSON-text rows alike. */
describe("inputsObject", () => {
	test("an object comes back as the same object", () => {
		const obj = { repo: "o/r", item: "3" };
		expect(inputsObject(obj)).toBe(obj);
	});
	test("the JSON text of an object parses to that object", () => {
		expect(inputsObject('{"repo":"o/r","item":"3"}')).toEqual({ repo: "o/r", item: "3" });
	});
	test("garbage yields {}", () => {
		for (const raw of ["not json", "[1,2]", '"s"', "42", null, undefined, 7, [1]]) {
			expect(inputsObject(raw)).toEqual({});
		}
	});
});
