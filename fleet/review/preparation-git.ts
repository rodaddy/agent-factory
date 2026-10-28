/** Isolated Git object reads: no checkout, fetch, inherited config or repository commands. */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";

export class PreparationHold extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}
export function requireInput(path: string, cap: number): void {
	if (!isAbsolute(path)) throw new PreparationHold("input_path");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap)
			throw new PreparationHold("input_bounds_or_type");
	} finally {
		closeSync(fd);
	}
}
export const utf8Order = (a: string, b: string): number =>
	Buffer.compare(Buffer.from(a), Buffer.from(b));
export function decode(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new PreparationHold("invalid_utf8");
	}
}
export class PreparationGit {
	private readonly deadline = Date.now() + 115_000;
	constructor(private readonly cwd: string) {}
	/** The launcher also owns a hard 120-second cgroup deadline. */
	run(args: string[], cap = 1_048_576): Buffer {
		const remaining = this.deadline - Date.now();
		if (remaining <= 0) throw new PreparationHold("preparation_timeout");
		const result = spawnSync(
			"/usr/bin/git",
			[
				"--no-replace-objects",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"protocol.allow=never",
				"-c",
				"core.attributesFile=/dev/null",
				"-c",
				"core.quotePath=true",
				...args,
			],
			{
				cwd: this.cwd,
				timeout: remaining,
				killSignal: "SIGKILL",
				maxBuffer: cap,
				env: {
					PATH: "/usr/bin:/bin",
					LC_ALL: "C",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
					GIT_NO_LAZY_FETCH: "1",
				},
			},
		);
		if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT")
			throw new PreparationHold("preparation_timeout");
		if (result.error && "code" in result.error && result.error.code === "ENOBUFS")
			throw new PreparationHold("git_output_bounds");
		if (result.error || result.status !== 0) throw new PreparationHold("git_rejected");
		return result.stdout;
	}
	import(bundle: string, commits: string[]): void {
		this.run(["init", "--bare", "--template=", "--object-format=sha1", "."]);
		// Verification in an EMPTY store refuses prerequisite/thin bundles.
		this.run(["bundle", "verify", "--quiet", bundle]);
		this.run(["bundle", "unbundle", bundle]);
		this.run(["fsck", "--strict", "--no-reflogs", "--no-dangling"]);
		for (const oid of commits) {
			if (this.run(["cat-file", "-t", oid]).toString().trim() !== "commit")
				throw new PreparationHold("commit_missing");
		}
	}
}
export type TreeEntry = {
	repoPath: string;
	gitMode: "100644" | "100755" | "120000" | "160000";
	objectOid: string;
	bytes: number;
};
/** Includes trees for the entry cap; Git -z preserves the original path bytes. */
export function readTree(git: PreparationGit, commit: string): TreeEntry[] {
	const raw = git.run(["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit], 70_000_000);
	const records = decode(raw).split("\0");
	if (records.pop() !== "" || records.length > 100_000) throw new PreparationHold("tree_bounds");
	const entries: TreeEntry[] = [];
	for (const record of records) {
		const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(record);
		if (!match) throw new PreparationHold("tree_record");
		const [, mode, type, oid, size, path] = match;
		if (!mode || !type || !oid || !size || !path) throw new PreparationHold("tree_record");
		if (mode === "040000" && type === "tree") continue;
		const supported =
			(type === "blob" && ["100644", "100755", "120000"].includes(mode)) ||
			(type === "commit" && mode === "160000");
		if (!supported) throw new PreparationHold("unsupported_git_mode");
		if (type === "blob" && (!Number.isSafeInteger(Number(size)) || Number(size) > 16_777_216))
			throw new PreparationHold("file_bounds");
		entries.push({
			repoPath: path,
			gitMode: mode as TreeEntry["gitMode"],
			objectOid: oid,
			bytes: type === "commit" ? 0 : Number(size),
		});
	}
	return entries;
}
