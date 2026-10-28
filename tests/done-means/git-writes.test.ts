/**
 * @module tests/done-means/git-writes
 * @description The token-aware git-writes scanner behind clause (g) of the
 *   workflow done-means checks. Pins that git's global options are skipped
 *   before the verb is read, that fast-forward pushes and
 *   `merge-base` are not writes, and that comments never count.
 */
import { describe, expect, test } from "bun:test";
import { gitVerb, offendingGitWrites } from "../../scripts/done-means/lib/git-writes";

describe("gitVerb", () => {
	test("skips valued and flag global options in every spelling", () => {
		expect(gitVerb(["-C", "d", "push", "--force"])?.verb).toBe("push");
		expect(gitVerb(["-c", "user.name=x", "push"])?.verb).toBe("push");
		expect(gitVerb(["--git-dir=/srv/r", "push"])?.verb).toBe("push");
		expect(gitVerb(["--git-dir", "/srv/r", "--work-tree", "/w", "merge"])?.verb).toBe("merge");
		expect(gitVerb(["-p", "--no-pager", "log"])?.verb).toBe("log");
		expect(gitVerb(["-C", "d"])).toBeUndefined();
	});
});

describe("offendingGitWrites", () => {
	test("catches force, -f, --mirror, +refspec pushes and merges behind global options", () => {
		const lines = [
			"git -C k3s-deploy push --force origin refs/heads/x:refs/heads/x",
			"git --git-dir=/srv/r push -f origin main",
			"git -c user.name=x push origin +refs/heads/x:refs/heads/x",
			"git -C d merge --no-ff topic",
			"echo done || git -C d push --mirror",
			'git -C "$PWD/k3s-deploy" push --force-with-lease=main:abc origin main',
		];
		expect(offendingGitWrites(lines).map((l) => Number(l.split(":")[0]))).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
	});

	test("a fast-forward push, merge-base, and a comment are not writes", () => {
		expect(
			offendingGitWrites([
				"git -C d push origin refs/heads/x:refs/heads/x",
				"git -C d merge-base a b",
				"# git push --force in a comment",
				"          # git -C d merge topic (prose)",
				"git -C d fetch --force origin",
			]),
		).toEqual([]);
	});
});

describe("offendingGitWrites reads shell syntax, not whitespace", () => {
	test("separators attached to a word and a pipe still expose the push flags", () => {
		expect(
			offendingGitWrites([
				"git push --force;",
				"git -C d push --mirror|cat",
				"true&&git -C d push -f origin main&&echo ok",
				"git -C d push origin main; git -C d merge topic",
			]).map((l) => Number(l.split(":")[0])),
		).toEqual([1, 2, 3, 4]);
	});

	test("a backslash-continued push is read whole: a force flag on the next line is reported at its first line, no flag is a fast-forward", () => {
		const found = offendingGitWrites([
			"echo start",
			"git -C k3s-deploy push \\",
			"  --force origin refs/heads/x:refs/heads/x",
			"echo end",
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.startsWith("2: ")).toBe(true);
		expect(offendingGitWrites(["git -C d push \\", "  origin refs/heads/x:refs/heads/x"])).toEqual(
			[],
		);
	});
});
