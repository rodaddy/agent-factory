/**
 * @module done-means/lib/git-writes
 * @description Token-aware scan for the git WRITES a workflow file must never
 *   contain: a merge, a force/mirror push, or a `+`-prefixed refspec. Every
 *   `git` invocation on a non-comment line is tokenised, git's GLOBAL options
 *   are skipped (`-c k=v`, `-C dir`, `--git-dir=x`, `--work-tree x`, `-p`,
 *   `--no-pager`, ...), and the first remaining word is the verb. A regex on
 *   `git\s+push` misses `git -C dir push --force`; this does not.
 *
 *   Prints `line: text` for every offending invocation and always exits 0;
 *   the calling done-means check decides the verdict from the output.
 *
 * @outputs
 *   - `offendingGitWrites` -- pure: lines in -> offending `N: line` strings
 *
 * @dependencies
 *   - none
 */
import { readFileSync } from "node:fs";

/** Global options that consume the NEXT token when not written as `--opt=value`. */
const VALUED = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
	"--list-cmds",
	"--attr-source",
]);

/** The verb after git's global options, plus the arguments that follow it. */
export function gitVerb(tokens: readonly string[]): { verb: string; args: string[] } | undefined {
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i] as string;
		if (!t.startsWith("-")) return { verb: t, args: tokens.slice(i + 1) };
		const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
		i += VALUED.has(name) && !t.includes("=") ? 2 : 1;
	}
	return undefined;
}

/** True when the push's arguments make it a rewrite rather than a fast-forward. */
function forcefulPush(args: readonly string[]): boolean {
	return args.some(
		(a) =>
			a === "--force" ||
			a.startsWith("--force-with-lease") ||
			a.startsWith("--force-if-includes") ||
			a === "-f" ||
			a === "--mirror" ||
			a.startsWith("+"),
	);
}

/**
 * Split one logical shell line into simple commands, then each command into
 * whitespace tokens. Separators (`;`, `&&`, `||`, `|`, `&`) are cut whether
 * or not they touch a word, so `git push --force;` and `git push --mirror|cat`
 * classify the same as their spaced spellings. Quote marks are dropped from
 * token ends; a token's shell-quoted interior is not otherwise interpreted.
 */
function commands(line: string): string[][] {
	return line
		.split(/\s*(?:;|&&|\|\||\||&)\s*/)
		.map((cmd) =>
			cmd
				.trim()
				.split(/\s+/)
				.map((t) => t.replace(/^["']|["']$/g, ""))
				.filter((t) => t.length > 0),
		)
		.filter((cmd) => cmd.length > 0);
}

/** Every `git` invocation on the line: the tokens after each `git` word. */
function gitInvocations(line: string): string[][] {
	const out: string[][] = [];
	for (const cmd of commands(line)) {
		for (let i = 0; i < cmd.length; i++) {
			if (cmd[i] !== "git") continue;
			out.push(cmd.slice(i + 1));
			break;
		}
	}
	return out;
}

/**
 * Join backslash-continued lines into one logical line per entry, keeping the
 * FIRST physical line's number so a finding points where the command starts.
 * Comment lines never continue.
 */
function logicalLines(lines: readonly string[]): { n: number; text: string }[] {
	const out: { n: number; text: string }[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = i;
		let text = lines[i] as string;
		while (/\\\s*$/.test(text) && !/^\s*#/.test(text) && i + 1 < lines.length) {
			i++;
			text = `${text.replace(/\\\s*$/, "")} ${(lines[i] as string).trim()}`;
		}
		out.push({ n: start + 1, text });
		i++;
	}
	return out;
}

/**
 * The offending git writes in a file's lines.
 *
 * @param lines - the file, one entry per line, comments already dropped or not
 * @returns `N: line` for every merge, force/mirror push, or `+refspec` push
 */
export function offendingGitWrites(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const { n, text } of logicalLines(lines)) {
		if (/^\s*#/.test(text)) continue;
		for (const inv of gitInvocations(text)) {
			const v = gitVerb(inv);
			if (v === undefined) continue;
			if (v.verb === "merge" || (v.verb === "push" && forcefulPush(v.args))) {
				out.push(`${n}: ${text}`);
				break;
			}
		}
	}
	return out;
}

if (import.meta.main) {
	const path = process.argv[2];
	if (path === undefined) {
		process.stderr.write("usage: bun scripts/done-means/lib/git-writes.ts <file>\n");
		process.exit(3);
	}
	const found = offendingGitWrites(readFileSync(path, "utf8").split("\n"));
	if (found.length > 0) process.stdout.write(`${found.join("\n")}\n`);
}
