/**
 * @module scripts/jev/model-route-backtest
 * @description Score the `model-route` classifier once on a held-out file.
 *  Usage:
 *   `bun scripts/jev/model-route-backtest.ts <heldout.json> [--out <path>]`.
 *   The file is `[{fields, expect}]`, every `expect` one of the criteria.
 *   Prints the summary line first, then the `RouteBacktest` as tab-indented
 *   JSON. Applies no threshold. Exit 0 when a report printed; 3 on bad
 *   arguments, unreadable or invalid input, or any no-signal example (a
 *   back-test over missing signal is not a result).
 *
 * @outputs
 *   - stdout: the summary line, then the report JSON
 *   - `--out <path>`: the report JSON written to a file
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { type Ask, loadClassifier } from "../../src/jev/classifier";
import { askJev } from "../../src/jev/client";
import { backtest, summaryLine } from "../../src/jev/model-route";

const USAGE = "usage: bun scripts/jev/model-route-backtest.ts <heldout.json> [--out <path>]";
const heldoutSchema = z.array(
	z.object({ fields: z.record(z.string(), z.string()), expect: z.string() }),
);

export async function main(
	argv: string[],
	ask: Ask = askJev,
	print: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
	const [file, flag, out, ...extra] = argv;
	const badOut = flag !== undefined && (flag !== "--out" || out === undefined || out === "");
	if (file === undefined || file.startsWith("-") || badOut || extra.length > 0) {
		console.error(USAGE);
		return 3;
	}
	try {
		const parsed = heldoutSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
		if (!parsed.success) throw new Error(`${file}: invalid (${parsed.error.issues.length} issues)`);
		const report = await backtest(await loadClassifier("model-route"), parsed.data, ask);
		const json = `${JSON.stringify(report, null, "\t")}\n`;
		print(`${summaryLine(report)}\n${json}`);
		if (out !== undefined) await writeFile(out, json);
		if (report.no_signal > 0) {
			console.error(`model-route backtest: ${report.no_signal} example(s) got no Jev signal`);
			return 3;
		}
		return 0;
	} catch (err) {
		console.error(`model-route backtest: ${err instanceof Error ? err.message : String(err)}`);
		return 3;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
