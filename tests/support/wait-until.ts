/**
 * Wait until `done()` holds, polling every 5 ms; throw after `ms`.
 *
 * Use this, never a fixed sleep, when a test must let un-awaited work finish
 * before it asserts. A fixed sleep passes on a quiet machine and fails on a
 * loaded runner, and the prepush check every factory PR must pass runs on a
 * loaded runner (CODING_STANDARDS "Wait on the event, never a fixed sleep").
 */
export async function until(
	done: () => boolean | Promise<boolean>,
	ms = 2_000,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`);
		await new Promise((resolve) => setTimeout(resolve, 5)); // fixed-sleep-ok: the poll interval of until()
	}
}
