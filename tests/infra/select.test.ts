/**
 * @module tests/infra/select
 * @description Tests for the gate-selection wiring seam (HIGH-2 / TOCTOU and
 *   HIGH-2a): `full` mode reads only the PR base, `changed-files` mode derives the
 *   narrow gate set from the IMMUTABLE `base.sha..pinnedSHA` compare (NOT the
 *   mutable PR head, NOT a mutable base branch name), and every fail-closed case
 *   (no client, no item, absent/non-hex base SHA, unreadable base, indeterminate
 *   compare) collapses to a full escalation. Crucially, a PR whose head has
 *   advanced past the pinned SHA still selects from the pinned-SHA compare —
 *   proving a push after dispatch cannot change which gates run — and a PR that
 *   carries only a mutable `base.ref` (no `base.sha`) fails closed rather than
 *   binding the compare to a raceable branch name. Fake client; no I/O, no git.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../src/github/client";
import { STATIC_GATES } from "../../src/infra/gates";
import { resolveGateSelection } from "../../src/infra/select";

const REPO = "rtech/rtech-infra";
const PINNED = "a".repeat(40);
const BASE = "b".repeat(40);

/**
 * A path-aware fake. The PR-detail read (`/pulls/{n}`) returns ONLY a base SHA
 * (the reader never consumes the PR head). The compare read
 * (`/compare/{base}...{sha}`) returns the change set as a compare OBJECT keyed by
 * the pinned SHA present in the path — so a test can prove selection follows the
 * pinned SHA and not any advanced head.
 */
function fakeClient(
	filesForSha: Record<string, unknown>,
	next: string | null = null,
	baseSha: string = BASE,
): GitHubClient {
	return {
		async getPage(path: string) {
			if (path.includes("/compare/")) {
				// The pinned SHA is the compare right side: `.../compare/base...sha?...`.
				const m = path.match(/\/compare\/[^.]+\.\.\.([0-9a-f]+)/);
				const sha = m?.[1] ?? "";
				return { body: { files: filesForSha[sha] ?? [] }, next };
			}
			// PR-object read: base SHA only. Deliberately carries NO head field.
			return { body: { base: { sha: baseSha } }, next: null };
		},
	} as unknown as GitHubClient;
}

describe("resolveGateSelection", () => {
	test("full mode escalates to all gates, reads only the PR base, and carries it", async () => {
		// The full mode reads the PR object ONCE for the immutable base SHA so the
		// runner body can render a base-relative verdict; it never reads the compare.
		const paths: string[] = [];
		const client = {
			async getPage(path: string) {
				paths.push(path);
				return { body: { base: { sha: BASE } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "full",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
		expect(s.baseSha).toBe(BASE);
		expect(paths).toEqual([`/repos/${REPO}/pulls/7`]);
	});

	test("full mode with no client or no item escalates with no base and no read", async () => {
		let called = false;
		const client = {
			async getPage() {
				called = true;
				return { body: {}, next: null };
			},
		} as unknown as GitHubClient;
		const noClient = await resolveGateSelection({
			mode: "full",
			client: null,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		const noItem = await resolveGateSelection({
			mode: "full",
			client: client,
			repository: REPO,
			itemNumber: null,
			sha: PINNED,
		});
		for (const s of [noClient, noItem]) {
			expect(s.fullEscalation).toBe(true);
			expect(s.gates).toEqual([...STATIC_GATES]);
			expect(s.baseSha).toBeUndefined();
		}
		expect(called).toBe(false);
	});

	test("changed-files mode narrows to the mapped gates from the pinned-SHA compare", async () => {
		const client = fakeClient({ [PINNED]: [{ filename: "scripts/x.sh" }] });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["scripts"]);
	});

	test("Forgejo changed-files conservatively escalates without a completeness proof", async () => {
		const client = fakeClient({ [PINNED]: [{ filename: "scripts/x.sh" }] });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
			provider: "forgejo",
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	});

	test("changed-files with no client fails closed to full escalation", async () => {
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: null,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
	});

	test("changed-files with no item number fails closed to full escalation", async () => {
		const client = fakeClient({ [PINNED]: [{ filename: "scripts/x.sh" }] });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: null,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
	});

	test("an indeterminate (truncated at 300-cap) compare escalates to all gates", async () => {
		// A compare `files` array at the documented 300-file cap is possibly
		// truncated => indeterminate => full escalation.
		const truncated = Array.from({ length: 300 }, (_, i) => ({ filename: `scripts/s${i}.sh` }));
		const client = fakeClient({ [PINNED]: truncated });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	});

	test("an over-cap / non-object / missing-files compare fails closed to full escalation", async () => {
		// The compare for the pinned SHA yields no `files` array (wrong shape) =>
		// indeterminate => full escalation.
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					return { body: { message: "Not Found" }, next: null };
				}
				return { body: { base: { sha: BASE } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	});

	test("an errored compare read fails closed to full escalation", async () => {
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					throw new Error("GitHub request failed: HTTP 404");
				}
				return { body: { base: { sha: BASE } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	});

	test("an unreadable PR base fails closed to full escalation", async () => {
		// The PR-object read throws, so the base SHA cannot be obtained and no
		// pinned-SHA compare can be built. Fail closed to full escalation.
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					return { body: { files: [{ filename: "scripts/x.sh" }] }, next: null };
				}
				throw new Error("GitHub request failed: HTTP 500");
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	});

	test("a PR head advanced past the pinned SHA still selects from the pinned-SHA compare (TOCTOU closed)", async () => {
		// The mutable PR head has advanced to a DIFFERENT commit that touches a
		// workflow (which would force a FULL escalation). But the job is pinned to
		// PINNED, whose compare touches only `scripts/`. The reader is bound to the
		// pinned-SHA compare, so it must narrow to `scripts` from the pinned commit —
		// NOT escalate from the advanced head. This is the direct TOCTOU proof: a
		// push after dispatch cannot change the selected gates.
		const advanced = "c".repeat(40);
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					const m = path.match(/\/compare\/[^.]+\.\.\.([0-9a-f]+)/);
					const sha = m?.[1] ?? "";
					// Pinned SHA => only a script changed (narrow to `scripts`).
					// Advanced head => a workflow changed (would force full escalation).
					const files =
						sha === PINNED
							? [{ filename: "scripts/x.sh" }]
							: [{ filename: ".github/workflows/ci.yml" }];
					return { body: { files }, next: null };
				}
				// The PR object even reports the advanced head — but the reader never
				// consumes head; it consumes only base.sha. Selection ignores the head.
				return { body: { base: { sha: BASE }, head: { sha: advanced } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["scripts"]);
	});

	test("a PR carrying only a mutable base.ref (no base.sha) fails closed to full (HIGH-2a)", async () => {
		// base.ref is a MUTABLE branch name — binding the compare to it would reopen
		// a (smaller) TOCTOU race. With base.sha absent, the reader must fail closed
		// to full escalation rather than bind the compare to a branch name. The
		// compare must never even be attempted.
		let compareAttempted = false;
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					compareAttempted = true;
					return { body: { files: [{ filename: "scripts/x.sh" }] }, next: null };
				}
				return { body: { base: { ref: "main" } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
		expect(compareAttempted).toBe(false);
	});

	test("a malformed (non-hex) base.sha fails closed to full (HIGH-2a)", async () => {
		// A base.sha that is not strict-hex is not an immutable commit we can trust;
		// there is no base.ref fallback, so the reader fails closed to full and never
		// attempts the compare.
		let compareAttempted = false;
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					compareAttempted = true;
					return { body: { files: [{ filename: "scripts/x.sh" }] }, next: null };
				}
				return { body: { base: { sha: "not-a-real-sha", ref: "main" } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
		expect(compareAttempted).toBe(false);
	});

	test("a valid strict-hex base.sha narrows correctly and binds the compare left side (HIGH-2a)", async () => {
		// The immutable base.sha is threaded into the compare left side and the set
		// narrows to the mapped gate.
		let comparePath = "";
		const client = {
			async getPage(path: string) {
				if (path.includes("/compare/")) {
					comparePath = path;
					return { body: { files: [{ filename: "scripts/x.sh" }] }, next: null };
				}
				return { body: { base: { sha: BASE } }, next: null };
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["scripts"]);
		expect(comparePath).toContain(`/compare/${BASE}...${PINNED}`);
	});
});

describe("resolveGateSelection carries the immutable base SHA", () => {
	test("a narrow selection carries the base SHA the PR object served", async () => {
		const client = fakeClient({ [PINNED]: [{ filename: "scripts/x.sh" }] });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(false);
		expect(s.baseSha).toBe(BASE);
	});

	test("an escalated (indeterminate compare) selection still carries the base SHA", async () => {
		// A compare `files` array at the documented 300-file cap is indeterminate.
		const truncated = Array.from({ length: 300 }, (_, i) => ({ filename: `scripts/s${i}.sh` }));
		const client = fakeClient({ [PINNED]: truncated });
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.baseSha).toBe(BASE);
	});

	test("an unreadable PR base carries no base SHA", async () => {
		const client = {
			async getPage() {
				throw new Error("boom");
			},
		} as unknown as GitHubClient;
		const s = await resolveGateSelection({
			mode: "changed-files",
			client: client,
			repository: REPO,
			itemNumber: 7,
			sha: PINNED,
		});
		expect(s.fullEscalation).toBe(true);
		expect(s.baseSha).toBeUndefined();
	});
});
