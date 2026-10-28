import type { PullRequestEvent } from "./logic.js";
export function reviewAdmissionFor(
	companyId: string,
	forgeGet: (path: string) => Promise<unknown>,
	invoke: (input: unknown) => Promise<unknown>,
): (event: PullRequestEvent, prior?: unknown) => Promise<unknown>;
