// One slice of a test-file selection, for a matrix of parallel CI jobs
// (sf#1648 follow-up: factory/prepush runs its tests as N jobs across the
// runner band). Pure, so it is testable without a spawn.
//
// The split spreads the heavy files: sort by byte size descending (path breaks
// ties, so the result is deterministic for a given list), then deal snake-order
// 1..n, n..1, 1..n, ... so every slice gets one of the biggest files.

import { isAbsolute, resolve } from "node:path";

export interface SizedFile {
	path: string;
	size: number;
}

/** Parse `<i>/<n>` with 1 <= i <= n; throws on anything else. */
export function parseShard(spec: string): { index: number; total: number } {
	const m = /^(\d+)\/(\d+)$/.exec(spec);
	const index = Number(m?.[1]);
	const total = Number(m?.[2]);
	// Safe integers only: a long digit run parses to Infinity or loses precision.
	if (
		!m ||
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(total) ||
		index < 1 ||
		total < 1 ||
		index > total
	) {
		throw new Error(`test-run: bad --shard ${spec}, want <i>/<n> with 1 <= i <= n`);
	}
	return { index, total };
}

/** The paths of slice `index` (1-based) of `total`, in deal order. */
export function shardSlice(files: SizedFile[], index: number, total: number): string[] {
	const sorted = [...files].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
	const out: string[] = [];
	for (const [k, file] of sorted.entries()) {
		const round = Math.floor(k / total);
		const pos = k % total;
		const slot = round % 2 === 0 ? pos : total - 1 - pos;
		if (slot === index - 1) out.push(file.path);
	}
	return out;
}

// Bun test options that take their value as the NEXT argument; `--opt=value`
// is one argument and needs no entry here.
const VALUE_OPTIONS = new Set([
	"--timeout",
	"--test-name-pattern",
	"-t",
	"--rerun-each",
	"--retry",
	"--seed",
	"--preload",
	"--reporter",
	"--reporter-outfile",
	"--coverage-reporter",
	"--coverage-dir",
	"--max-concurrency",
]);

/**
 * A selected test path as the file to stat and the argument to hand `bun test`:
 * relative paths resolve against `root` and gain `./` (so bun reads a path, not
 * a filter); an absolute path is stat-ed and passed unchanged.
 */
export function testFileArg(root: string, path: string): { stat: string; arg: string } {
	return { stat: resolve(root, path), arg: isAbsolute(path) ? path : `./${path}` };
}

/** Split `bun test` args into options (each with its value) and test files. */
export function splitTestArgs(args: string[]): { options: string[]; files: string[] } {
	const options: string[] = [];
	const files: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const a = args[k] ?? "";
		if (!a.startsWith("-")) files.push(a.replace(/^\.\//, ""));
		else {
			options.push(a);
			const value = args[k + 1];
			// `--bail` takes an OPTIONAL count: only an all-digit next arg is its value.
			const takesValue = VALUE_OPTIONS.has(a) || (a === "--bail" && /^\d+$/.test(value ?? ""));
			if (takesValue && value !== undefined) {
				options.push(value);
				k++;
			}
		}
	}
	return { options, files };
}
