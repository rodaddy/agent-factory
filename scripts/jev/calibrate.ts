/**
 * @module scripts/jev/calibrate
 * @description Run a Jev classifier's labelled examples against the live Jev
 *   API and print the calibration report.
 *   Usage: `bun scripts/jev/calibrate.ts <id> [--out <path>]`.
 *   Exit 0 clean; 1 when any trusted miss is unsafe; 3 on any no-signal
 *   example, a load/harness error, or bad arguments.
 *
 * @outputs
 *   - stdout: the `CalibrationReport` as pretty JSON
 *   - `--out <path>`: the same JSON written to a file
 */
import { writeFile } from "node:fs/promises";
import { askJev } from "../../src/jev/client";
import { calibrate, loadClassifier } from "../../src/jev/classifier";

const USAGE = "usage: bun scripts/jev/calibrate.ts <id> [--out <path>]";

async function main(argv: string[]): Promise<number> {
	const [id, flag, out, ...extra] = argv;
	const badOut = flag !== undefined && (flag !== "--out" || out === undefined || out === "");
	if (id === undefined || id.startsWith("-") || badOut || extra.length > 0) {
		console.error(USAGE);
		return 3;
	}
	try {
		const report = await calibrate(await loadClassifier(id), askJev);
		// Tab-indented, the repo's biome JSON style, so a committed report passes format:check.
		const json = `${JSON.stringify(report, null, "\t")}\n`;
		process.stdout.write(json);
		if (out !== undefined) await writeFile(out, json);
		if (report.no_signal > 0) {
			console.error(`calibrate: ${report.no_signal} example(s) got no Jev signal`);
			return 3;
		}
		return report.unsafe_misses > 0 ? 1 : 0;
	} catch (err) {
		console.error(`calibrate: ${err instanceof Error ? err.message : String(err)}`);
		return 3;
	}
}

process.exitCode = await main(process.argv.slice(2));
