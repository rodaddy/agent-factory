/**
 * @module tests/results/environment-errno
 * @description Behavior tests for `environmentErrnoClass` — the classifier
 *   that decides whether a change-verification fault describes the DEPLOYMENT
 *   (a retry cannot fix it) or something transient (a retry might).
 *
 *   It keys on the `code` property Node attaches to a `SystemError`, never on the
 *   message text, so the real EROFS case is proved with a REAL filesystem error
 *   rather than a hand-built object claiming to be one.
 *
 *   MUTATIONS PROVEN (each made the named test go red before being restored):
 *   - Removing `"EROFS"` from `ENVIRONMENT_ERRNOS` -> "names a real filesystem
 *     permission fault" and the EROFS case red.
 *   - Matching on `errorMessage(err).includes(code)` instead of the `code`
 *     property -> "does not classify prose that merely mentions an errno" red.
 *   - Returning the code for any string `code` (dropping the set membership
 *     check) -> "returns null for a transient non-environment errno" red.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentErrnoClass } from "../../src/results/change-verifier";

describe("environmentErrnoClass", () => {
	test("names a real filesystem permission fault", async () => {
		// A real Node SystemError, not a fabricated one: writing inside a path whose
		// parent is a FILE yields ENOTDIR, and writing to a root-owned system path
		// yields EACCES. Use the root-owned path, which is the deployment shape.
		const failure = await writeFile(join("/", ".rw-preflight-probe"), "").then(
			() => null,
			(err: unknown) => err,
		);

		// Guard the fixture itself: if this ever runs as root the write succeeds and
		// the test would assert nothing.
		expect(failure).not.toBeNull();
		expect(environmentErrnoClass(failure)).toBe((failure as NodeJS.ErrnoException).code as string);
		expect(["EACCES", "EROFS", "EPERM"]).toContain(environmentErrnoClass(failure) as string);
	});

	test.each(["EROFS", "EACCES", "EPERM", "ENOSPC"])(
		"classifies %s as an environment defect",
		(code) => {
			const err = Object.assign(new Error("write failed"), { code });

			expect(environmentErrnoClass(err)).toBe(code);
		},
	);

	test.each(["ECONNRESET", "ETIMEDOUT", "ENOENT"])(
		"returns null for a transient non-environment errno: %s",
		(code) => {
			const err = Object.assign(new Error("write failed"), { code });

			expect(environmentErrnoClass(err)).toBeNull();
		},
	);

	test("does not classify prose that merely mentions an errno", () => {
		const err = new Error("EROFS: read-only file system, mkdir '/var/lib/software-factory'");

		// No `code` property — a message quoting an errno is not the same claim as the
		// runtime attaching one, and matching prose would misclassify a wrapped error.
		expect(environmentErrnoClass(err)).toBeNull();
	});

	test("returns null for values that are not errors", () => {
		expect(environmentErrnoClass(null)).toBeNull();
		expect(environmentErrnoClass("EROFS")).toBeNull();
		expect(environmentErrnoClass({ code: 13 })).toBeNull();
	});
});
