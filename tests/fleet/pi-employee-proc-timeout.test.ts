/**
 * @module tests/fleet/pi-employee-proc-timeout
 * @description sf#2005: actual Linux reader functions return no partial results
 *   after their total budget, even when one filesystem operation blocks. FIFO
 *   reads exercise real signal interruption; proc paths are mapped to fixtures.
 *   Removing the timeout fails these cases under the subprocess watchdog.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const launcher =
	process.env.PI_EMPLOYEE_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/pi-employee");
const probe = resolve(import.meta.dir, "fixtures/proc-budget/probe.py");
for (const helper of ["list_procs", "env_matches", "live_argv"]) {
	const scenarios =
		helper === "live_argv"
			? ["blocked", "success"]
			: ["blocked", "enumeration", "aggregate", "success"];
	if (helper === "list_procs") scenarios.push("prior-timer", "cleanup-interrupt");
	for (const scenario of scenarios) {
		test(`${helper}: ${scenario} proc filesystem`, () => {
			const scratch = mkdtempSync(join(testTmpBase(), "proc-budget-"));
			try {
				const result = spawnSync("python3", [probe, launcher, scratch, helper, scenario], {
					encoding: "utf8",
					timeout: 2000,
					killSignal: "SIGKILL",
				});
				expect({
					status: result.status,
					stderr: result.stderr,
					error: result.error?.message,
				}).toEqual({
					status: 0,
					stderr: "",
					error: undefined,
				});
				expect(result.stdout).toContain(`${helper} ${scenario}: passed`);
			} finally {
				renameSync(scratch, join(testArchiveDir(), basename(scratch)));
			}
		});
	}
}
