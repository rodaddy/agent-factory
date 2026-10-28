/**
 * Probe for D25: a job that holds a credential runs no repository
 * code. A shrinking ratchet over every `.forgejo/workflows/*.yml` job.
 *
 * CREDENTIAL: any `secrets.<NAME>` except the engine keys CLIPROXY_API_KEY and
 *   TYPESAFE_API_KEY; inside `${{ }}`, any `secrets` occurrence that is not
 *   exactly an engine-key reference (dot or quoted-bracket form; any other
 *   shape, e.g. `toJSON(secrets)`, fails closed); `github.token`, `gitea.token`, `forgejo.token` or their
 *   quoted-bracket forms; `fetch-jwt`; `ACTIONS_ID_TOKEN`; a
 *   `steps.<id>.outputs.jwt` reference; or OIDC on (the job sets
 *   `enable-openid-connect: true`, or does not set it and the workflow does). A
 *   workflow-level `env:` credential counts for every job. The credential scan
 *   reads raw text: the runner expands `${{ }}` inside shell comments too.
 * CODE (fail closed; shell comments are not code): `actions/checkout`; any
 *   `uses:` except the two pinned forgejo artifact data movers; a run step
 *   whose EFFECTIVE shell (step `shell:`, else job, else workflow
 *   `defaults.run.shell`, else bash) is not an allowlisted runner shell,
 *   or cannot be read; `./scripts/`, `./bin/`, `./specs/` anywhere; and in each
 *   `run:` command word: bun/bunx/npm/npx/pnpm/yarn/deno/python/python3/uv/
 *   pip/make; `node` unless only --no-warnings/--input-type/
 *   --max-old-space-size precede -e/--eval/-p/--print, the program is one
 *   single-quoted word without `${{`, and no later argument can expand
 *   (`SINGLE_QUOTED`); bash/sh/zsh with a file
 *   or stdin (a `-c` program is scanned recursively); source/`.`; a word with
 *   `/` outside `/usr/` and `/bin/`; a `$`-expanded command. A `run:` the
 *   probe cannot parse is CODE. `$(`, backtick and `${` expansions are
 *   followed into `${...}`, `$((...))` and unquoted heredoc bodies; the whole
 *   `node` argument list is checked.
 * CODE, second layer (quote-agnostic, no parsing): any word or substring of
 *   the fixed vocabulary (`vocabulary()`) anywhere in the RAW `run:` text,
 *   comments, strings, heredoc bodies and node programs included. Module
 *   loading: every static module specifier (`import "x"`, `import ... from
 *   "x"`, `export ... from "x"`), `require(...)` and `import(...)` are allowed only
 *   for the fixed Node built-in list (`NODE_IMPORTS`), named by a plain string
 *   literal; any other module argument is CODE.
 * MIXED: CREDENTIAL and CODE in one job.
 *
 * THREAT MODEL: the gate stops repository code or a dependency from running
 *   in a job that holds a credential (no checkout, no package manager, no
 *   repo file, a fixed vocabulary scanned fail closed). It is a ratchet
 *   against that class of drift, not a sandbox. Workflow text written on
 *   purpose to evade it is out of scope: the workflow file is the trusted
 *   definition, anyone who can edit it can edit the gate, and the PR review
 *   grades every workflow diff.
 *
 * The LEGACY file lists `<workflow file>:<job>` per line (`#` comments). A
 * MIXED job not listed fails; a listed entry whose job is not MIXED or does
 * not exist fails, so the list only shrinks.
 *
 * USAGE: bun scripts/done-means/credential-split.probe.ts [workflowsDir] [legacyFile]
 * EXIT:  0 every MIXED job is listed and every listed job is MIXED
 *        1 a finding (named on stdout)
 *        3 harness error (unreadable dir/file, YAML parse error, no jobs)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const ENGINE_KEYS = new Set(["CLIPROXY_API_KEY", "TYPESAFE_API_KEY"]);

/**
 * Flatten a YAML value to scan text. `stripComments` drops full-line shell
 * comments from `run:` values and is for the CODE scan only: the runner expands
 * `${{ }}` everywhere in `run:`, comments included, so the CREDENTIAL scan
 * reads the raw text.
 */
function flatten(v: unknown, stripComments: boolean, key = ""): string {
	if (typeof v === "string") {
		if (!stripComments || key !== "run") return v;
		return v
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"))
			.join("\n");
	}
	if (Array.isArray(v)) return v.map((x) => flatten(x, stripComments, key)).join("\n");
	if (isRec(v))
		return Object.entries(v)
			.map(([k, x]) => `${k}: ${flatten(x, stripComments, k)}`)
			.join("\n");
	return v == null ? "" : String(v);
}

/** Quoted strings can contain delimiters; incomplete expressions consume the remainder. */
function expressions(text: string) {
	return text.matchAll(/\$\{\{((?:'(?:[^']|'')*(?:'|$)|(?!\}\}|')[\s\S])*)(?:\}\}|$)/g);
}

/** Credential references in scan text, by name. */
export function credentials(text: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
		const name = m[1] ?? "";
		if (!ENGINE_KEYS.has(name)) found.add(`secrets.${name}`);
	}
	for (const e of expressions(text)) {
		const expr = e[1] ?? "";
		// Every `secrets` identifier in an expression is a credential unless it is
		// exactly an engine-key reference; an unknown shape fails closed.
		for (const m of expr.matchAll(/(?<![A-Za-z0-9_])secrets(?![A-Za-z0-9_])/gi)) {
			const rest = expr.slice((m.index ?? 0) + m[0].length);
			const ref =
				/^(?:\.([A-Za-z0-9_]+)(?![A-Za-z0-9_])|\[\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)")\s*\])/.exec(
					rest,
				);
			const name = ref ? (ref[1] ?? ref[2] ?? ref[3] ?? "") : "";
			if (!ENGINE_KEYS.has(name.toUpperCase()))
				found.add(name ? `secrets.${name}` : "secrets(unknown shape)");
		}
		for (const context of ["github", "gitea", "forgejo"]) {
			const bracket = new RegExp(
				`(?<![A-Za-z0-9_])${context}\\s*\\[\\s*(?:'token'|"token")\\s*\\]`,
				"i",
			);
			if (bracket.test(expr)) found.add(`${context}.token`);
		}
	}
	for (const m of text.matchAll(/(?:github|gitea|forgejo)\.token\b/gi))
		found.add(m[0].toLowerCase());
	if (/fetch-jwt/.test(text)) found.add("fetch-jwt");
	if (/ACTIONS_ID_TOKEN/.test(text)) found.add("ACTIONS_ID_TOKEN");
	if (/steps\.[A-Za-z0-9_-]+\.outputs\.jwt\b/.test(text)) found.add("steps.*.outputs.jwt");
	return [...found];
}

/** The pinned forgejo artifact actions: data movers, not code. */
const DATA_MOVERS = new Set([
	"https://code.forgejo.org/forgejo/download-artifact@d8d0a99033603453ad2255e58720b460a0555e1e",
	"https://code.forgejo.org/forgejo/upload-artifact@16871d9e8cfcf27ff31822cac382bbb5450f1e1e",
]);
const RUNTIMES = new Set([
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"deno",
	"python",
	"python3",
	"uv",
	"pip",
	"make",
]);
/** Words after which the next word is still in command position. */
const PREFIXES = new Set([
	"then",
	"do",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"!",
	"{",
	"}",
	"time",
	"exec",
	"command",
	"builtin",
]);
const NODE_OK = /^(?:--no-warnings|--input-type=\S+|--max-old-space-size=\d+)$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/**
 * A word carrying a shell or runner expansion: `$SUB` stands for `${...}`,
 * `$(...)`, backticks and `${{ }}` outside single quotes, and a bare `$NAME`,
 * `$1` or `$@` survives as itself. A single-quoted `${{` still counts: the
 * runner substitutes it before the shell sees the quotes.
 */
const EXPANDED = /\$SUB|\$\{\{|\$[A-Za-z_0-9@*#?!$-]/;
/** Brace and glob characters: an unquoted argument carrying one can expand into option words. */
const GLOB = /[{*?[]/;
/**
 * For each command scan() emits, the indexes of words that were exactly one
 * single-quoted span. Quotes are removed from the words, so this is the only
 * record that a word cannot expand. A `node -e` program is readable source
 * only when it is such a word; any other program (double-quoted, unquoted,
 * brace, glob, mixed quoting) is CODE (D25: ratchet). A command behind an
 * exec wrapper or rebuilt from words (watch, parallel) has no entry, so its
 * program fails closed.
 */
const SINGLE_QUOTED = new WeakMap<string[], Set<number>>();

/**
 * Split a shell script into simple commands (word lists, quotes removed),
 * dropping comments and heredoc bodies; `$( )` and backtick bodies are
 * commands of their own. Returns null when the script cannot be parsed.
 */
export function commands(s: string): string[][] | null {
	const out: string[][] = [];
	const end = scan(s, 0, "", out);
	return end < 0 ? null : out;
}

/** Word `k` of `cmdWords` was one single-quoted span without a runner `${{ }}`. */
function literalWord(cmdWords: string[], k: number): boolean {
	return (SINGLE_QUOTED.get(cmdWords)?.has(k) ?? false) && !(cmdWords[k] ?? "").includes("${{");
}

/**
 * Re-parse a word as a script. The outer shell expands a word that was not
 * one single-quoted span before the inner shell parses it, so quotes inside it
 * earn no SINGLE_QUOTED entry: `bash -c "node -e '$P'"` runs `$P`'s value.
 */
function reparse(text: string, literal: boolean): string[][] | null {
	const sub = commands(text);
	if (sub !== null && !literal) for (const c of sub) SINGLE_QUOTED.delete(c);
	return sub;
}

/**
 * The body of a `${...}` (close `}`) or `$((...))` (close `))`) starting at
 * `i`: index after the close, with every nested substitution collected into
 * `out`; -1 when unbalanced (fail closed). Quotes are not honoured inside, so
 * a substitution in a quoted default still counts.
 */
function nested(s: string, i: number, out: string[][], close: "}" | "))"): number {
	let depth = 0;
	while (i < s.length) {
		if (depth === 0 && s.startsWith(close, i)) return i + close.length;
		const x = expansion(s, i, out);
		if (x !== null) {
			if (x < 0) return -1;
			i = x;
			continue;
		}
		const ch = s[i];
		if (ch === "\\") i += 2;
		else {
			if (ch === (close === "}" ? "{" : "(")) depth++;
			else if (ch === (close === "}" ? "}" : ")") && depth > 0) depth--;
			i++;
		}
	}
	return -1;
}

/** A `$(`, `$((`, backtick or `${` at `i`: index after it (subcommands into `out`), -1 on failure, or null when none. */
function expansion(s: string, i: number, out: string[][]): number | null {
	if (s.startsWith("${{", i)) {
		// A `${{ }}` runner expression: substituted before the shell runs.
		const j = s.indexOf("}}", i + 3);
		return j < 0 ? -1 : j + 2;
	}
	if (s.startsWith("$((", i)) return nested(s, i + 3, out, "))");
	if (s.startsWith("$(", i)) return scan(s, i + 2, ")", out);
	if (s[i] === "`") return scan(s, i + 1, "`", out);
	if (s.startsWith("${", i)) return nested(s, i + 2, out, "}");
	return null;
}

/**
 * One line of an unquoted heredoc body from `i`: its `$(`, backtick and `${`
 * expansions are collected into `out` (bash runs them). Index after the line,
 * or -1 on failure.
 */
function heredocLine(s: string, i: number, out: string[][]): number {
	while (i < s.length && s[i] !== "\n") {
		const x = expansion(s, i, out);
		if (x !== null) {
			if (x < 0) return -1;
			i = x;
		} else i += s[i] === "\\" ? 2 : 1;
	}
	return i + 1;
}

function scan(s: string, start: number, closer: string, out: string[][]): number {
	let i = start;
	let words: string[] = [];
	let word = "";
	let inWord = false;
	// The word so far is exactly one single-quoted span, and `lits` holds the
	// indexes of such words in the current command (see SINGLE_QUOTED).
	let single = false;
	let lits = new Set<number>();
	let redirect = false;
	let depth = 0;
	const heredocs: { delim: string; literal: boolean }[] = [];
	const endWord = (): void => {
		if (inWord && !redirect) {
			if (single) lits.add(words.length);
			words.push(word);
		}
		if (inWord) redirect = false;
		word = "";
		inWord = false;
		single = false;
	};
	const endSeg = (): void => {
		endWord();
		redirect = false;
		if (words.length > 0) {
			out.push(words);
			if (lits.size > 0) SINGLE_QUOTED.set(words, lits);
		}
		words = [];
		lits = new Set();
	};
	while (i < s.length) {
		const ch = s[i] ?? "";
		if (closer !== "" && ch === closer && (closer === "`" || depth === 0)) {
			endSeg();
			return heredocs.length > 0 ? -1 : i + 1;
		}
		const x = expansion(s, i, out);
		if (x !== null) {
			if (x < 0) return -1;
			word += "$SUB";
			inWord = true;
			single = false;
			i = x;
			continue;
		}
		if (ch === "\\") {
			if (s[i + 1] !== "\n") {
				word += s[i + 1] ?? "";
				inWord = true;
				single = false;
			}
			i += 2;
			continue;
		}
		if (ch === "'") {
			const j = s.indexOf("'", i + 1);
			if (j < 0) return -1;
			word += s.slice(i + 1, j);
			single = !inWord;
			inWord = true;
			i = j + 1;
			continue;
		}
		if (ch === '"') {
			i++;
			for (;;) {
				if (i >= s.length) return -1;
				if (s[i] === '"') break;
				const y = expansion(s, i, out);
				if (y !== null) {
					if (y < 0) return -1;
					word += "$SUB";
					i = y;
				} else if (s[i] === "\\") {
					word += s[i + 1] ?? "";
					i += 2;
				} else word += s[i++];
			}
			inWord = true;
			single = false;
			i++;
			continue;
		}
		if (ch === "#" && !inWord) {
			while (i < s.length && s[i] !== "\n") i++;
			continue;
		}
		if (ch === "\n") {
			endSeg();
			i++;
			for (const { delim, literal } of heredocs.splice(0)) {
				for (;;) {
					if (i >= s.length) return -1;
					const e = s.indexOf("\n", i);
					const line = s.slice(i, e < 0 ? s.length : e);
					const next = e < 0 ? s.length : e + 1;
					if (line.replace(/^\t+/, "").trimEnd() === delim) {
						i = next;
						break;
					}
					i = literal ? next : heredocLine(s, i, out);
					if (i < 0) return -1;
				}
			}
			continue;
		}
		if (s.startsWith("<<", i) && s[i + 2] !== "<") {
			endWord();
			i += 2;
			if (s[i] === "-") i++;
			while (s[i] === " " || s[i] === "\t") i++;
			const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(s.slice(i));
			const delim = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
			if (!m || delim === "") return -1;
			// Any quoting of the delimiter makes the body literal; otherwise bash expands it.
			const literal = m[3] === undefined || /['"\\]/.test(m[3]);
			heredocs.push({ delim: delim.replace(/['"\\]/g, ""), literal });
			i += m[0].length;
			continue;
		}
		if (ch === "<" || ch === ">") {
			endWord();
			i++;
			while (s[i] === ">" || s[i] === "&" || s[i] === "|") i++;
			redirect = true;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|") {
			endSeg();
			i++;
			continue;
		}
		if (ch === "(" && inWord && word.endsWith("=")) {
			// Array assignment `name=( ... )`: the last segment is values, not a
			// command; nested `$( )` bodies (pushed before it) still count.
			const sub: string[][] = [];
			const j = scan(s, i + 1, ")", sub);
			if (j < 0) return -1;
			out.push(...sub.slice(0, -1));
			word += "()";
			single = false;
			i = j;
			continue;
		}
		if (ch === ")" && depth === 0) {
			// An unmatched `)` closes a `case` pattern: the words are not a command.
			endWord();
			words = [];
			lits = new Set();
			redirect = false;
			i++;
			continue;
		}
		if (ch === "(" || ch === ")") {
			endSeg();
			depth += ch === "(" ? 1 : -1;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
			i++;
			continue;
		}
		word += ch;
		inWord = true;
		single = false;
		i++;
	}
	if (closer !== "" || heredocs.length > 0) return -1;
	endSeg();
	return i;
}

const EXEC_WRAPPERS = new Set([
	"env",
	"xargs",
	"sudo",
	"timeout",
	"setsid",
	"flock",
	"stdbuf",
	"ionice",
	"nice",
	"nohup",
	"taskset",
	"chrt",
	"unshare",
	"nsenter",
	"strace",
	"script",
	"watch",
	"parallel",
]);

/** Unknown wrapper options fail closed rather than hiding the wrapped command. */
function wrappedMarker(wrapper: string, args: string[]): string | null {
	const valueOptions: Record<string, string[]> = {
		env: ["-u", "-C"],
		xargs: ["-I", "-n", "-d", "-P", "-L", "-s", "-E"],
		sudo: ["-u", "-g", "-C", "-D", "-p", "-R", "-r", "-T", "-U"],
		timeout: [],
		flock: ["-w", "--wait", "-E", "--conflict-exit-code"],
		stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
		ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"],
		nice: ["-n", "--adjustment"],
		taskset: ["-c", "--cpu-list"],
		chrt: ["-T", "-P", "-D"],
		unshare: ["--map-user", "--map-group", "--root", "--wd"],
		nsenter: ["-t", "--target", "--wd", "--root"],
		strace: ["-o", "-e", "-s", "-p", "--output", "--trace"],
		script: ["-c", "--command"],
		watch: ["-n", "--interval"],
		parallel: ["-j", "--jobs"],
	};
	let i = 0;
	let tasksetList = false;
	while (args[i]?.startsWith("-")) {
		const option = args[i++] ?? "";
		if (option === "--") break;
		if (valueOptions[wrapper]?.includes(option)) {
			const value = args[i++];
			if (value === undefined) return `${wrapper} (unparsed)`;
			if (wrapper === "script") {
				if (i !== args.length) return "script (unparsed)";
				const nested = reparse(value, false);
				return nested === null
					? "script -c (unparsed)"
					: (nested.map(marker).find((m) => m !== null) ?? null);
			}
			if (wrapper === "taskset") tasksetList = true;
		} else if (!/^(?:-[A-Za-z]|--[a-z-]+(?:=.*)?)$/.test(option)) {
			return `${wrapper} (unparsed)`;
		} else {
			// No-argument switches are intentionally narrow; anything else may
			// consume a file or command and must not be guessed.
			const flags: Record<string, string[]> = {
				env: [],
				xargs: [],
				sudo: [],
				timeout: [],
				setsid: ["-f", "-w", "-c"],
				flock: ["-n", "-s", "-x", "-u", "-o", "-F"],
				nohup: [],
				ionice: ["-t"],
				taskset: ["-a"],
				chrt: ["-f", "-r", "-o", "-b", "-i", "-d", "-R"],
				unshare: ["-m", "-u", "-i", "-n", "-p", "-U", "-C", "-f", "-r"],
				nsenter: ["-a", "-m", "-u", "-i", "-n", "-p", "-U", "-C"],
				strace: ["-f", "-ff", "-q"],
				watch: ["-t", "-d", "-x"],
				parallel: [],
			};
			if (!flags[wrapper]?.includes(option)) return `${wrapper} (unparsed)`;
		}
	}
	if (wrapper === "flock" || wrapper === "chrt" || (wrapper === "taskset" && !tasksetList)) i++;
	if (wrapper === "env") while (ASSIGN.test(args[i] ?? "")) i++;
	if (wrapper === "timeout") {
		if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[i] ?? "")) return "timeout (unparsed)";
		i++;
	}
	const child = args.slice(i);
	if (child.length === 0) return `${wrapper} (unparsed)`;
	if (wrapper === "script") return "script (unparsed)";
	if (wrapper === "watch" || wrapper === "parallel") {
		const nested = reparse(child.join(" "), false);
		return nested === null
			? `${wrapper} (unparsed)`
			: (nested.map(marker).find((m) => m !== null) ?? null);
	}
	return marker(child);
}

/** The CODE marker for one simple command, or null. */
function marker(cmdWords: string[]): string | null {
	const words = [...cmdWords];
	let i = 0;
	for (;;) {
		const w = words[i];
		if (w === undefined) return null;
		if (/^\/(?:usr|bin)\//.test(w)) {
			words[i] = w.slice(w.lastIndexOf("/") + 1);
			continue;
		}
		if (PREFIXES.has(w) || ASSIGN.test(w)) {
			i++;
			continue;
		}
		if (EXEC_WRAPPERS.has(w)) return wrappedMarker(w, words.slice(i + 1));
		break;
	}
	const cmd = words[i] ?? "";
	const args = words.slice(i + 1);
	if (cmd.includes("/")) return cmd;
	if (cmd.startsWith("$")) return `dynamic command ${cmd}`;
	if (RUNTIMES.has(cmd)) return cmd;
	if (cmd === "node") {
		// A word that was one single-quoted span cannot expand, except a runner `${{ }}`.
		const literal = (k: number): boolean => literalWord(cmdWords, i + 1 + k);
		// The whole argument list: node honours options after the inline program too.
		let program = false;
		for (let k = 0; k < args.length; k++) {
			const a = args[k] ?? "";
			if (program && a === "--") break;
			if (!program && /^(?:-e|--eval|-p|--print)$/.test(a)) {
				program = true;
				k++;
				if (!literal(k)) return `node ${a} (program not single-quoted)`;
				continue;
			}
			// `--eval=` joins the program to the flag, so it is never one quoted span.
			if (!program && /^--(?:eval|print)=/.test(a)) {
				return `node ${a.slice(0, a.indexOf("="))} (program not single-quoted)`;
			}
			// node parses options before and after the program; an expanded word can be one.
			if (!literal(k) && (EXPANDED.test(a) || GLOB.test(a))) return `node ${a} (expanded argument)`;
			if (NODE_OK.test(a)) continue;
			if (program && !a.startsWith("-")) continue;
			return `node ${a}`;
		}
		return program ? null : "node (stdin)";
	}
	if (cmd === "bash" || cmd === "sh" || cmd === "zsh") {
		let inline = false;
		for (let k = 0; k < args.length; k++) {
			const a = args[k] ?? "";
			if (a.length > 1 && (a.startsWith("-") || a.startsWith("+")) && a !== "--") {
				if (a.startsWith("--")) continue;
				if (a.includes("c")) inline = true;
				if (/[oO]$/.test(a)) k++;
				continue;
			}
			if (!inline) return `${cmd} <file>`;
			const sub = reparse(a, literalWord(cmdWords, i + 1 + k));
			if (sub === null) return `${cmd} -c (unparsed)`;
			for (const c of sub) {
				const m = marker(c);
				if (m !== null) return m;
			}
			return null;
		}
		return inline ? null : `${cmd} (stdin)`;
	}
	if (cmd === "source" || cmd === ".") return `${cmd} <file>`;
	return null;
}

/** Whole words (case-sensitive) that make a `run:` CODE wherever they appear. */
const VOCAB_WORDS = [
	// interpreters and package managers
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"deno",
	"python",
	"python2",
	"python3",
	"pip",
	"pip3",
	"uv",
	"uvx",
	"ruby",
	"perl",
	"php",
	"lua",
	"make",
	"cmake",
	"go",
	"cargo",
	"java",
	// shells and exec wrappers
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"source",
	"eval",
	"exec",
	"xargs",
	"nohup",
	"sudo",
	"chroot",
	"busybox",
	// other code paths
	"awk",
	"gawk",
	"mawk",
];
/** Literal substrings that make a `run:` CODE wherever they appear. */
const VOCAB_SUBSTRINGS = [
	// node module loading
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"NODE_OPTIONS",
	"child_process",
	"worker_threads",
	"node:vm",
	"process.binding",
	"process.dlopen",
	"new Function",
	// git code paths
	"alias.",
	"sshCommand",
	"fsmonitor",
	"upload-pack",
	"receive-pack",
	"ext::",
];
const VOCAB_WORD_RE = new RegExp(`\\b(?:${VOCAB_WORDS.join("|")})\\b`, "g");
/** Node built-ins a node program may load: a static specifier, `require()` or `import()`. */
const NODE_IMPORTS = new Set([
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:crypto",
	"node:buffer",
	"node:url",
]);

/**
 * The quote-agnostic layer: vocabulary hits in the RAW `run:` text, comments,
 * strings, heredoc bodies and node programs included. No parsing, so no shell
 * construct can hide a listed word from it.
 */
export function vocabulary(script: string): string[] {
	const hits = new Set<string>();
	for (const m of script.matchAll(VOCAB_WORD_RE)) hits.add(m[0]);
	for (const sub of VOCAB_SUBSTRINGS) if (script.includes(sub)) hits.add(sub);
	if (/\bnode\s+-r(?![\w-])/.test(script)) hits.add("node -r");
	if (/\bfind\b/.test(script) && /-exec(?:dir)?\b/.test(script)) hits.add("find -exec");
	for (const line of script.split("\n")) {
		const sed = /\bsed\b(.*)/.exec(line)?.[1];
		// A sed `e` command, or an `s` command whose flags carry `e`.
		if (
			sed !== undefined &&
			/(?:^|[\s;'"{])e(?:$|[\s;'"}])|\bs(\W)(?:(?!\1).)*\1(?:(?!\1).)*\1[A-Za-z0-9]*e/.test(sed)
		)
			hits.add("sed e");
	}
	// Every static module specifier: `import "x"`, `import ... from "x"`, `export ... from "x"`.
	for (const m of script.matchAll(/\b(?:from|import)\s*(["'])([^"'\n]*)\1/g))
		if (!NODE_IMPORTS.has(m[2] ?? "")) hits.add(`import "${m[2]}"`);
	// Every require( / import( is a hit unless its argument is one plain string
	// literal naming an allowed built-in, closed by `)` straight after.
	for (const m of script.matchAll(/(require|import)\s*\(/g)) {
		const rest = script.slice((m.index ?? 0) + m[0].length);
		const lit = /^(["'])([^"'`\\\n]*)\1\)/.exec(rest);
		if (lit && NODE_IMPORTS.has(lit[2] ?? "")) continue;
		const arg = rest.split(")")[0]?.trim().slice(0, 40) ?? "";
		hits.add(`${m[1]}(${arg})`);
	}
	return [...hits].map((h) => `vocabulary: ${h}`);
}

/** CODE markers of one `run:` script; an unparsable script fails closed. */
export function runMarkers(script: string): string[] {
	const cmds = commands(script);
	if (cmds === null) return ["run: (unparsed)"];
	return cmds.map(marker).filter((m): m is string => m !== null);
}

/** `defaults.run.shell` of a job or workflow; a malformed `defaults` is unparseable (fail closed). */
function defaultShell(o: Rec): unknown {
	const d = o.defaults;
	if (d === undefined) return undefined;
	if (!isRec(d) || (d.run !== undefined && !isRec(d.run))) return { unparsed: true };
	return isRec(d.run) ? d.run.shell : undefined;
}

/** The shell a run step executes under: step, then job, then workflow `defaults.run.shell`, then bash. */
export function effectiveShell(step: Rec, job: Rec, workflow: unknown): unknown {
	return (
		step.shell ??
		defaultShell(job) ??
		(isRec(workflow) ? defaultShell(workflow) : undefined) ??
		"bash"
	);
}

/** Only the runner's standard shell forms avoid a CODE marker. */
function shellMarker(shell: unknown): string | null {
	if (typeof shell !== "string") return "shell: (unparsed)";
	return new Set([
		"bash",
		"sh",
		"bash -e {0}",
		"bash --noprofile --norc -eo pipefail {0}",
		"sh -e {0}",
	]).has(shell)
		? null
		: `shell: ${shell}`;
}

const STARTUP_ENV = new Set([
	"NODE_OPTIONS",
	"BASH_ENV",
	"ENV",
	"PYTHONSTARTUP",
	"PYTHONPATH",
	"PERL5OPT",
	"PERL5LIB",
	"RUBYOPT",
	"RUBYLIB",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"NODE_PATH",
]);

function envMarkers(env: unknown): string[] {
	if (env === undefined) return [];
	if (!isRec(env)) return ["env: (unparsed)"];
	return (
		Object.entries(env)
			// An env-map PATH can point a bare command at downloaded or checked-out
			// code, and an empty PATH searches the working directory. Script
			// `export PATH=...` lines are not scanned (D25: ratchet).
			.filter(([name, value]) => name === "PATH" || (STARTUP_ENV.has(name) && value !== ""))
			.map(([name]) => `env: ${name}`)
	);
}

/** Only literal printf/echo assignment text can establish safe ENV-file output. */
function literalEnvLine(line: string): boolean {
	const match = /^\s*(printf|echo)\s+(['"])(.*?)\2(.*)$/.exec(line);
	if (!match) return false;
	const [, command, quote, format = "", args = ""] = match;
	// Shell substitutions and runner expressions can replace literal format text.
	if (format.includes("`") || format.includes("$(") || format.includes("${{")) return false;
	const lines = command === "printf" ? format.split(/\\n/) : [format];
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return false;
	for (const text of lines) {
		const name = /^([A-Z_][A-Z0-9_]*)=/.exec(text)?.[1];
		if (!name || name === "PATH" || STARTUP_ENV.has(name)) return false;
		if (command === "printf" && !/^[A-Z_][A-Z0-9_]*=%s$/.test(text)) return false;
		if (command === "echo" && /[$\\\r\n]/.test(text)) return false;
	}
	if (command === "echo") return args.trim() === "";
	// A deliberately small allowlist: one quoted value per printf output line.
	// Anything more complicated stays code rather than guessing shell output.
	const values = args.match(/"[^"`]*"|'[^']*'/g) ?? [];
	return (
		quote === "'" &&
		values.length === lines.length &&
		// A value carrying a shell expansion can carry a newline that sets a startup
		// variable; it is code, whatever the script validated first (D25: ratchet).
		values.every((value) => !(value.startsWith('"') && value.includes("$"))) &&
		args.replace(/"[^"`]*"|'[^']*'/g, "").trim() === "" &&
		!args.includes("$(") &&
		!args.includes("${{")
	);
}

/** Fail closed for unknown redirections and writers; PATH writes are always code. */
function runnerFileMarkers(script: string): string[] {
	const hits = new Set<string>();
	const lines = script.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const ref of line.matchAll(/\b(?:GITHUB|FORGEJO|GITEA)_(?:ENV|PATH)\b/g)) {
			const name = ref[0];
			const write = new RegExp(`^(.*?)\\s*>>?\\s*["']?\\$\\{?${name}\\}?["']?\\s*$`).exec(line);
			if (name.endsWith("_PATH") || !write) {
				hits.add(`runner env: ${name}`);
				continue;
			}
			let output = [write[1] ?? ""];
			if (output[0]?.trim() === "}") {
				output = [];
				let j = i - 1;
				for (; j >= 0 && lines[j]?.trim() !== "{"; j--) output.unshift(lines[j] ?? "");
				if (j < 0) output = ["(unparsed block)"];
			}
			if (output.length === 0 || !output.every(literalEnvLine)) hits.add(`runner env: ${name}`);
		}
	}
	return [...hits];
}

/** Raw text fails closed across inline assignments, comments and env-file writes. */
function startupRunMarkers(script: string): string[] {
	const hits: string[] = [];
	for (const name of STARTUP_ENV) if (script.includes(`${name}=`)) hits.push(`run env: ${name}`);
	return [...hits, ...runnerFileMarkers(script)];
}

/** Repository-code markers of one job body (shell comments are not code). */
export function code(job: unknown, workflow?: unknown): string[] {
	const found = new Set<string>();
	const text = flatten(job, true);
	if (/actions\/checkout/.test(text)) found.add("actions/checkout");
	if (/(^|[\s;&|(`]|\$\()(bun|bunx|npm|npx)(\s|$)/m.test(text)) found.add("bun/npm");
	for (const dir of ["./scripts/", "./bin/", "./specs/"]) if (text.includes(dir)) found.add(dir);
	for (const m of envMarkers(isRec(workflow) ? workflow.env : undefined)) found.add(m);
	if (!isRec(job)) return [...found];
	for (const m of envMarkers(job.env)) found.add(m);
	if (job.uses !== undefined) found.add(`uses: ${String(job.uses)}`);
	if (job.steps !== undefined && !Array.isArray(job.steps)) found.add("steps: (unparsed)");
	for (const step of Array.isArray(job.steps) ? job.steps : []) {
		if (!isRec(step)) {
			found.add("step: (unparsed)");
			continue;
		}
		for (const m of envMarkers(step.env)) found.add(m);
		if (step.uses !== undefined) {
			const uses = String(step.uses).trim();
			if (uses.includes("actions/checkout")) found.add("actions/checkout");
			else if (!DATA_MOVERS.has(uses)) found.add(`uses: ${uses}`);
		}
		if (step.run !== undefined) {
			const shell = shellMarker(effectiveShell(step, job, workflow));
			if (shell !== null) found.add(shell);
			for (const m of startupRunMarkers(String(step.run))) found.add(m);
			for (const m of runMarkers(String(step.run))) found.add(m);
			for (const m of vocabulary(String(step.run))) found.add(m);
		}
	}
	return [...found];
}

export interface JobVerdict {
	id: string;
	credentials: string[];
	code: string[];
	mixed: boolean;
}

/** Literal accessor name, or null for a computed/unknown accessor. */
function accessorName(accessor: string): string | null {
	const match = /^(?:\.\s*([A-Za-z0-9_-]+)|\[\s*(?:'([^']+)'|"([^"]+)")\s*\])$/.exec(accessor);
	return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/** Literal outputs stay precise; whole or computed needs access fails closed. */
function outputReferences(text: string): { job: string | null; reference: string }[] {
	const refs: { job: string | null; reference: string }[] = [];
	const accessor = /\.\s*[A-Za-z0-9_-]+|\[[\s\S]*?\]/g;
	const pattern = /'(?:[^']|'')*'|\bneeds\b((?:\s*(?:\.\s*[A-Za-z0-9_-]+|\[[\s\S]*?\]))*)/gi;
	for (const expression of expressions(text)) {
		for (const match of (expression[1] ?? "").matchAll(pattern)) {
			if (match[1] === undefined) continue;
			const parts = [...(match[1] ?? "").matchAll(accessor)].map((part) => accessorName(part[0]));
			const job = parts[0]?.toLowerCase() ?? null;
			const precise = parts.length === 3 && parts[1]?.toLowerCase() === "outputs" && parts[2];
			refs.push({
				job,
				reference:
					job === null
						? "needs(*)"
						: precise
							? `needs.${job}.outputs.${parts[2]}`
							: `needs.${job}.outputs(*)`,
			});
		}
	}
	return refs;
}

/** Classify every job of one parsed workflow. `file` is the workflow basename. */
export function classify(file: string, doc: unknown): JobVerdict[] {
	if (!isRec(doc) || !isRec(doc.jobs)) return [];
	const oidcOn = doc["enable-openid-connect"] === true;
	const wfCreds = credentials(flatten(doc.env, false));
	const jobs = Object.entries(doc.jobs);
	const verdicts = jobs.map(([job, body]) => {
		// Raw text: every run/env/with/if value, shell comments included.
		const creds = new Set([...wfCreds, ...credentials(flatten(body, false))]);
		const jobOidc = isRec(body) ? body["enable-openid-connect"] : undefined;
		// A job-level value wins; only an explicit false turns it off (fail closed).
		if (jobOidc !== false && (jobOidc != null || oidcOn)) creds.add("oidc");
		const markers = code(body, doc);
		return {
			id: `${file}:${job}`,
			credentials: [...creds],
			code: markers,
			mixed: creds.size > 0 && markers.length > 0,
		};
	});
	const byJob = new Map(jobs.map(([job], i) => [job.toLowerCase(), verdicts[i]]));
	const refs = jobs.map(([, body]) => outputReferences(flatten(body, false)));
	let changed = true;
	while (changed) {
		changed = false;
		for (const [i, verdict] of verdicts.entries()) {
			for (const ref of refs[i] ?? []) {
				const body = jobs[i]?.[1];
				const dependencies = [isRec(body) ? body.needs : undefined]
					.flat()
					.filter((job) => typeof job === "string");
				const producers = (ref.job === null ? dependencies : [ref.job]).map((job) =>
					byJob.get(job.toLowerCase()),
				);
				if (
					producers.every((producer) => producer?.credentials.length === 0) ||
					verdict.credentials.includes(ref.reference)
				)
					continue;
				verdict.credentials.push(ref.reference);
				verdict.mixed = verdict.code.length > 0;
				changed = true;
			}
		}
	}
	return verdicts;
}

function harness(msg: string): never {
	console.error(`HARNESS: ${msg}`);
	process.exit(3);
}

function main(): void {
	const dir = process.argv[2] ?? ".forgejo/workflows";
	const legacyPath = process.argv[3] ?? "scripts/done-means/credential-split.legacy";
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
			.sort();
	} catch (e) {
		harness(`cannot read workflows dir ${dir}: ${(e as Error).message}`);
	}
	let legacyText: string;
	try {
		legacyText = readFileSync(legacyPath, "utf8");
	} catch (e) {
		harness(`cannot read legacy file ${legacyPath}: ${(e as Error).message}`);
	}
	const legacy = new Set(
		legacyText
			.split("\n")
			.map((l) => l.replace(/#.*/, "").trim())
			.filter((l) => l !== ""),
	);

	const verdicts: JobVerdict[] = [];
	for (const f of files) {
		let doc: unknown;
		try {
			doc = parse(readFileSync(join(dir, f), "utf8"));
		} catch (e) {
			harness(`cannot parse ${f}: ${(e as Error).message}`);
		}
		verdicts.push(...classify(f, doc));
	}
	if (verdicts.length === 0) harness(`no jobs found under ${dir}`);

	const mixed = new Set(verdicts.filter((v) => v.mixed).map((v) => v.id));
	const findings: string[] = [];
	for (const v of verdicts) {
		if (v.mixed && !legacy.has(v.id))
			findings.push(
				`FAIL ${v.id}: credential and code in one job: split it, sf#1680 (credential: ${v.credentials.join(", ")}; code: ${v.code.join(", ")})`,
			);
	}
	for (const id of [...legacy].sort()) {
		if (!mixed.has(id))
			findings.push(
				`FAIL ${id}: remove it from credential-split.legacy: the ratchet only shrinks (job is not MIXED or does not exist)`,
			);
	}
	for (const line of findings) console.log(line);
	console.log(
		`examined ${verdicts.length} jobs in ${files.length} workflows; ${mixed.size} mixed, ${legacy.size} legacy, ${findings.length} findings`,
	);
	process.exit(findings.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
