/**
 * @module tests/support/receipt-clock
 * @description A test-owned clock for the v1 receipt scripts.
 *
 *   Each `scripts/done-means/v1-receipt-*.sh` reads its clock from
 *   `RECEIPT_CLOCK_FILE` when set (fractional seconds, one line). The clock
 *   moves only when the test moves it or when the script runs `sleep`: the
 *   PATH shim from `sleepShim` logs the argument and ADVANCES the clock by it
 *   instead of waiting. A budget is then spent in milliseconds of wall time and
 *   scheduling delay on a loaded runner cannot spend it, so a test reaches the
 *   step a budget guards every time.
 *
 *   Real-time bounds stay real: a curl `--max-time` or a coreutils `timeout`
 *   still waits on the wall clock, so a test of a cut call keeps its true wait.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReceiptClock {
	/** The file the script reads (`RECEIPT_CLOCK_FILE`). */
	file: string;
	/** Set the clock to `t` seconds; replaced whole, so a reader never sees half a write. */
	set(t: number): Promise<void>;
	/** The clock now, in seconds. */
	read(): Promise<number>;
	/** Move the clock forward by `s` seconds. */
	advance(s: number): Promise<void>;
	/** A `sleep` shim that appends its argv to `log` and advances the clock by `$1`. */
	sleepShim(log: string): string;
}

/** A clock in `dir`, starting at `start` seconds (default: the wall clock now). */
export async function receiptClock(dir: string, start = Date.now() / 1000): Promise<ReceiptClock> {
	const file = join(dir, "clock");
	const set = async (t: number) => {
		await writeFile(`${file}.set`, `${t.toFixed(6)}\n`);
		await rename(`${file}.set`, file);
	};
	const read = async () => Number((await readFile(file, "utf8")).trim());
	await set(start);
	return {
		file,
		set,
		read,
		advance: async (s) => set((await read()) + s),
		sleepShim: (log) =>
			`#!/bin/sh\necho "$*" >> '${log}'\nawk -v a="$1" '{ printf "%.6f\\n", $1 + a }' '${file}' > '${file}.next' && mv '${file}.next' '${file}'\n`,
	};
}
