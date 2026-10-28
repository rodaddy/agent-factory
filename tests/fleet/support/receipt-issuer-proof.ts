/** Local-only composition with the independently owned issuer source.
 * No models or host paths: captures and ephemeral signing keys live in test temp.
 * Issuer contract inspected at f1d63efa7a79b108520f5e47e675e02a7dffeaa7.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testArchiveDir, testTmpBase } from "../../support/test-temp.ts";

type Envelope = { keyId: string; payload: string; signature: string };
type Paths = Record<"captures" | "key" | "pub" | "store", string> & { ownerUid: number };
type Result = { code: number; stdout: string; stderr: string };

/** Archive fixture output after the proof, including when the proof fails. */
export async function withIssuerArchive<T>(
	root: string,
	proof: () => Promise<T>,
	archive = (path: string) =>
		renameSync(path, join(testArchiveDir(), path.split("/").at(-1) as string)),
): Promise<T> {
	const result = await Promise.resolve()
		.then(proof)
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	try {
		archive(root);
	} catch (cleanup) {
		const message = `issuer archive failed; fixture retained at ${root}`;
		if (!result.ok)
			throw new AggregateError([result.error, cleanup], message, { cause: result.error });
		throw new Error(message, { cause: cleanup });
	}
	if (!result.ok) throw result.error;
	return result.value;
}

export async function issuerProof(tree = process.env.REVIEW_ISSUER_TREE) {
	if (!tree) throw new Error("REVIEW_ISSUER_TREE required");
	const expectedHead = "f1d63efa7a79b108520f5e47e675e02a7dffeaa7";
	const git = (args: string[]) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
	const head = git(["rev-parse", "HEAD"]);
	const status = git(["status", "--porcelain", "--untracked-files=all"]);
	if (
		head.status !== 0 ||
		head.stdout.trim() !== expectedHead ||
		status.status !== 0 ||
		status.stdout.trim()
	)
		throw new Error(`issuer proof source must be clean at ${expectedHead}`);
	const issuer = (await import(
		pathToFileURL(resolve(tree, "fleet/review/issuer/review-issue.ts")).href
	)) as {
		attest(id: string, paths: Paths, now: Date): Result;
	};
	const fixtures = resolve(tree, "tests/fleet/fixtures/review-issue");
	const root = mkdtempSync(join(testTmpBase(), "receipt-compatibility-"));
	const keys = generateKeyPairSync("ed25519");
	const pubPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
	const captureId = "0b6e1f3a-7c2d-4e59-8a1b-3c4d5e6f7a8b";
	const results: Result[] = [];
	return withIssuerArchive(root, async () => {
		for (const mode of ["valid", "incomplete", "null-exit", "binding", "truncated", "timeout"]) {
			const dir = join(root, mode);
			const paths: Paths = {
				captures: join(dir, "captures"),
				key: join(dir, "signing.key"),
				pub: join(dir, "signing.pub"),
				store: join(dir, "issued"),
				ownerUid: process.getuid?.() ?? 0,
			};
			for (const lane of ["claude", "gpt"]) {
				const laneDir = join(paths.captures, captureId, lane);
				mkdirSync(laneDir, { recursive: true, mode: 0o755 });
				for (const name of ["events.jsonl", "stderr.txt", "collector.json", "prepare.json"]) {
					copyFileSync(join(fixtures, name), join(laneDir, name));
					chmodSync(join(laneDir, name), 0o644);
				}
				const run = JSON.parse(readFileSync(join(fixtures, `run-${lane}.json`), "utf8"));
				if (lane === "gpt") {
					if (mode === "incomplete") run.collectorComplete = false;
					if (mode === "null-exit") run.termination.exitCode = null;
					if (mode === "binding") run.declared.nonce = "e".repeat(64);
					if (mode === "truncated") run.termination.truncated = true;
					if (mode === "timeout") run.termination.timedOut = true;
				}
				writeFileSync(join(laneDir, "run.json"), JSON.stringify(run), { mode: 0o644 });
			}
			mkdirSync(paths.store, { mode: 0o755 });
			writeFileSync(paths.key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
				mode: 0o600,
			});
			writeFileSync(paths.pub, pubPem, { mode: 0o644 });
			results.push(issuer.attest(captureId, paths, new Date("2026-10-12T11:30:00Z")));
		}
		const [good, ...bad] = results;
		if (good?.code !== 0 || good.stderr || bad.some((r) => r.code !== 1 || r.stdout !== ""))
			throw new Error(`unexpected issuer results: ${JSON.stringify(results)}`);
		return {
			envelope: JSON.parse(good.stdout) as Envelope,
			pubPem,
			refusals: bad.map((r) => r.stderr),
		};
	});
}
