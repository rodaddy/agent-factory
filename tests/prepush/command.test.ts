import { expect, test } from "bun:test";
import {
	type PrepushIo,
	type PrepushStatus,
	runPrepushCommand,
	VALIDATE_RETIRED,
} from "../../src/prepush/command";

const SHA = "a".repeat(40);

function io(): { io: PrepushIo; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { stdout: (m) => out.push(m), stderr: (m) => err.push(m) }, out, err };
}

test("prepush status maps success to 0, failure to 1, pending and absent to 2", async () => {
	const cases: Array<[PrepushStatus | null, number]> = [
		[{ state: "success", description: "ok (run 7)", targetUrl: "https://x/7" }, 0],
		[{ state: "failure", description: "bad (run 8)", targetUrl: "https://x/8" }, 1],
		[{ state: "pending", description: "running", targetUrl: "https://x/9" }, 2],
		[null, 2],
	];
	for (const [status, code] of cases) {
		const h = io();
		const seen: string[] = [];
		const exit = await runPrepushCommand(["status", SHA], h.io, async (sha) => {
			seen.push(sha);
			return status;
		});
		expect(exit).toBe(code);
		expect(seen).toEqual([SHA]);
		expect(h.out.join("\n")).toContain(status === null ? "absent" : status.targetUrl);
	}
});

test("prepush validate is retired: one pointer line and exit 2, nothing read", async () => {
	const h = io();
	const exit = await runPrepushCommand(["validate"], h.io, async () => {
		throw new Error("must not read");
	});
	expect(exit).toBe(2);
	expect(h.err).toEqual([VALIDATE_RETIRED]);
});
