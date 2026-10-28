import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkLanePacketSync } from "../../src/packets/lane-sync";
import { PACKET_LANE_IDS, packetsDir } from "../../src/packets/registry";
import { renderPacketScaffold } from "../../src/packets/scaffold";
import { PACKET_SCAFFOLD_MARKER } from "../../src/packets/schema";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) {
		await rename(dir, join(testArchiveDir(), `${basename(dir)}-${crypto.randomUUID()}`));
	}
});

/**
 * A scaffold for `lane` with its `runtime` marker replaced by a real runtime.
 * The scaffolder deliberately does not default `runtime`, so
 * choosing it is a separate step from filling the body stubs — blanket-replacing
 * the marker with prose would leave an invalid runtime instead.
 */
function withRuntime(lane: string, runtime: string): string {
	const text = renderPacketScaffold(lane);
	const line = text.split("\n").find((l) => l.startsWith("runtime:"));
	if (line === undefined) throw new Error("scaffold rendered no runtime line");
	return text.replace(line, `runtime: ${runtime}`);
}

/**
 * An AUTHORED packet for `lane`: a scaffold with a runtime chosen and every stub
 * replaced, so it parses. Fixtures must be authored, not scaffolded — the check
 * now parses each file, and a scaffold-stub fixture would make every drift test
 * red for the wrong reason.
 */
function authoredPacket(lane: string): string {
	return withRuntime(lane, "pi").replaceAll(PACKET_SCAFFOLD_MARKER, "Authored");
}

/** A throwaway packets directory containing exactly the named lane files. */
async function fixtureDir(lanes: readonly string[]): Promise<string> {
	const dir = await mkdtemp(join(testTmpBase(), "rw-lane-sync-"));
	created.push(dir);
	for (const lane of lanes) {
		await writeFile(join(dir, `${lane}.md`), authoredPacket(lane), "utf8");
	}
	return dir;
}

describe("lane/packet sync check", () => {
	test("the REAL repo is in sync — every declared lane has its file and vice versa", async () => {
		const report = await checkLanePacketSync(packetsDir(), PACKET_LANE_IDS);
		expect(report.violations).toEqual([]);
		expect(report.passed).toBe(true);
		// And it actually looked at something: an empty report must never read green.
		expect(report.checkedNothing).toBe(false);
	});

	test("RED when a declared lane has no packet file", async () => {
		// The mutation the acceptance criteria name: remove a lane's file and the
		// check must go red rather than boot-fail later.
		const dir = await fixtureDir(["kept"]);
		const report = await checkLanePacketSync(dir, ["kept", "removed"]);
		expect(report.passed).toBe(false);
		expect(report.violations).toHaveLength(1);
		expect(report.violations[0]).toContain("declared lane 'removed' has no packets/removed.md");
	});

	test("RED on an ORPHAN packet file no lane declares — the direction boot cannot see", async () => {
		const dir = await fixtureDir(["kept", "orphan"]);
		const report = await checkLanePacketSync(dir, ["kept"]);
		expect(report.passed).toBe(false);
		expect(report.violations).toHaveLength(1);
		expect(report.violations[0]).toContain("packets/orphan.md is not a declared lane");
	});

	test("reports BOTH directions in one run rather than stopping at the first", async () => {
		const dir = await fixtureDir(["orphan"]);
		const report = await checkLanePacketSync(dir, ["missing"]);
		expect(report.violations).toHaveLength(2);
		expect(report.violations.join("\n")).toContain("declared lane 'missing'");
		expect(report.violations.join("\n")).toContain("packets/orphan.md");
	});

	test("a PASSING check records what it matched, not silence", async () => {
		const dir = await fixtureDir(["alpha", "beta"]);
		const report = await checkLanePacketSync(dir, ["alpha", "beta"]);
		expect(report.passed).toBe(true);
		// One check per lane, per file, and per file's CONTENT: six notes.
		expect(report.checks).toHaveLength(6);
		for (const check of report.checks) {
			expect(check.note.length).toBeGreaterThan(0);
		}
	});

	test("RED on a packet that is present and declared but does NOT parse", async () => {
		// The filename-only hole: the lane and the file agree perfectly, so every
		// name-level check passes, and the file still fails the boot.
		const dir = await fixtureDir(["alpha"]);
		// Runtime chosen, body stubs left: the refusal under test is the STUB scan,
		// not the frontmatter runtime marker (which has its own test in scaffold.test.ts).
		await writeFile(join(dir, "alpha.md"), withRuntime("alpha", "pi"), "utf8");
		const report = await checkLanePacketSync(dir, ["alpha"]);
		expect(report.passed).toBe(false);
		expect(report.violations).toHaveLength(1);
		expect(report.violations[0]).toContain("scaffold stub");
		// And the name-level checks are still green — proving the content check is
		// what went red, not a drift check catching it by accident.
		const named = report.checks.filter((c) => !c.item.startsWith("content:"));
		expect(named.every((c) => c.ok)).toBe(true);
	});

	test("RED on a packet whose FRONTMATTER is invalid", async () => {
		const dir = await fixtureDir(["alpha"]);
		await writeFile(join(dir, "alpha.md"), "---\nid: alpha\n---\n\n# Identity\n\nx\n", "utf8");
		const report = await checkLanePacketSync(dir, ["alpha"]);
		expect(report.passed).toBe(false);
		expect(report.violations.join("\n")).toContain("invalid frontmatter");
	});

	// The two holes #185's review found. Both files are named exactly right, so
	// every name-level check is green; the fault is in what the frontmatter
	// DECLARES. Before the parser bound id/lane to the packet name, the id case
	// passed this check and failed the boot after merge, and the lane case passed
	// this check AND the boot, loading with a silently false lane.
	test("RED on a packet whose frontmatter ID disagrees with its filename", async () => {
		const dir = await fixtureDir(["alpha"]);
		await writeFile(
			join(dir, "alpha.md"),
			authoredPacket("alpha").replace("id: alpha", "id: beta"),
			"utf8",
		);
		const report = await checkLanePacketSync(dir, ["alpha"]);
		expect(report.passed).toBe(false);
		expect(report.violations).toEqual([
			"packet alpha: frontmatter id 'beta' does not match filename",
		]);
		// Name-level checks stayed green: the CONTENT check is what caught it.
		expect(report.checks.filter((c) => !c.item.startsWith("content:")).every((c) => c.ok)).toBe(
			true,
		);
	});

	test("RED on a packet whose frontmatter LANE disagrees with its filename", async () => {
		const dir = await fixtureDir(["alpha"]);
		await writeFile(
			join(dir, "alpha.md"),
			authoredPacket("alpha").replace("lane: alpha", "lane: beta"),
			"utf8",
		);
		const report = await checkLanePacketSync(dir, ["alpha"]);
		expect(report.passed).toBe(false);
		expect(report.violations).toEqual([
			"packet alpha: frontmatter lane 'beta' does not match filename",
		]);
		expect(report.checks.filter((c) => !c.item.startsWith("content:")).every((c) => c.ok)).toBe(
			true,
		);
	});

	test("a PASSING content check names what it verified, not just the filename", async () => {
		const dir = await fixtureDir(["alpha"]);
		const report = await checkLanePacketSync(dir, ["alpha"]);
		const content = report.checks.find((c) => c.item === "content:alpha.md");
		expect(content?.ok).toBe(true);
		expect(content?.note).toContain("parses");
	});

	test("an unreadable packets directory is a recorded failure, never a throw", async () => {
		const report = await checkLanePacketSync(join(testTmpBase(), "rw-does-not-exist-xyz"), ["a"]);
		expect(report.passed).toBe(false);
		expect(report.violations[0]).toContain("packets directory could not be read");
	});

	test("no declared lanes and no files verifies NOTHING — not a pass", async () => {
		const dir = await fixtureDir([]);
		const report = await checkLanePacketSync(dir, []);
		expect(report.checkedNothing).toBe(true);
		expect(report.passed).toBe(false);
	});
});
