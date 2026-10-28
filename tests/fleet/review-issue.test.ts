/**
 * @module tests/fleet/review-issue.test
 * @description review-issue: a good capture signs a
 *   verifiable attestation, a second call re-emits the same bytes, and a capture
 *   whose bytes or manifests disagree is refused with nothing stored. Captures are
 *   built from `fixtures/review-issue/` in a temp dir with a fresh Ed25519 key.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { attest, type IssuerPaths } from "../../fleet/review/issuer/review-issue";
import { testTmpBase } from "../support/test-temp";

const FIX = join(import.meta.dir, "fixtures", "review-issue");
const CAPTURE = "0b6e1f3a-7c2d-4e59-8a1b-3c4d5e6f7a8b";
const NOW = new Date("2026-10-12T08:00:00.000Z");
const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
	const base = process.env.RTECH_TEMP_ROOT?.trim()
		? join(process.env.RTECH_TEMP_ROOT, "software-factory")
		: testTmpBase();
	mkdirSync(base, { recursive: true });
	const d = mkdtempSync(join(base, "review-issue-"));
	dirs.push(d);
	return d;
}

/** A complete two-lane capture plus a key pair; `edit` may alter a lane's run.json before it is written. */
function setup(
	edit: (lane: string, run: Record<string, unknown>) => void = () => {},
): IssuerPaths & { pubPem: string } {
	const root = tempRoot();
	const paths = {
		captures: join(root, "captures"),
		key: join(root, "signing.key"),
		pub: join(root, "signing.pub"),
		store: join(root, "issued"),
		ownerUid: process.getuid?.() ?? 0,
	};
	for (const lane of ["gpt", "claude"]) {
		const dir = join(paths.captures, CAPTURE, lane);
		mkdirSync(dir, { recursive: true });
		for (const f of ["events.jsonl", "stderr.txt", "collector.json", "prepare.json"]) {
			copyFileSync(join(FIX, f), join(dir, f));
			chmodSync(join(dir, f), 0o644);
		}
		const run = JSON.parse(readFileSync(join(FIX, `run-${lane}.json`), "utf8"));
		edit(lane, run);
		writeFileSync(join(dir, "run.json"), JSON.stringify(run));
		chmodSync(join(dir, "run.json"), 0o644);
		chmodSync(dir, 0o755);
	}
	chmodSync(join(paths.captures, CAPTURE), 0o755);
	mkdirSync(paths.store);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	writeFileSync(paths.key, privateKey.export({ type: "pkcs8", format: "pem" }));
	const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	writeFileSync(paths.pub, pubPem);
	return { ...paths, pubPem };
}

describe("review-issue attest", () => {
	test("a good capture signs an attestation that verifies against the public key", () => {
		const paths = setup();
		const out = attest(CAPTURE, paths, NOW);
		expect(out.stderr).toBe("");
		expect(out.code).toBe(0);
		expect(out.stdout.endsWith("\n")).toBe(true);
		expect(out.stdout.trim().includes("\n")).toBe(false);

		const env = JSON.parse(out.stdout);
		expect(Object.keys(env)).toEqual(["keyId", "payload", "signature"]);
		const pub = createPublicKey(paths.pubPem);
		const der = pub.export({ type: "spki", format: "der" });
		expect(env.keyId).toBe(`ed25519:${createHash("sha256").update(der).digest("hex")}`);
		expect(env.signature).toHaveLength(88);
		expect(
			verify(null, Buffer.from(env.payload, "utf8"), pub, Buffer.from(env.signature, "base64")),
		).toBe(true);

		const p = JSON.parse(env.payload);
		expect(env.payload).not.toMatch(/\s/);
		expect(Object.keys(p)).toEqual([...Object.keys(p)].sort());
		expect(p.schema).toBe("review-attestation/v1");
		expect(p.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(p.captureId).toBe(CAPTURE);
		expect(p.issuedAt).toBe("2026-10-12T08:00:00.000Z");
		expect(p.expiresAt).toBe("2026-10-13T08:00:00.000Z");
		expect(p.nonce).toBe("10f98c587d3720149301b402f78e76bbb0cbd2faf57f144c7a85793629bfa7ca");
		expect(p.bundleSha256).toBe("3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d");
		expect(p.preparedManifestSha256).toBe(
			"62c66a7a5dd70c3146618063c344e531e6d4b59e379808443ce962b3abd63c5a",
		);
		const lane = {
			exitCode: 0,
			eventsSha256: "2a1d66674912de88bfd940683f81e6377f9cffe18a6b1532852a09d339d8cc31",
			stderrSha256: "7dd55a75da1a839a4bc7eedbc8ff101f3cd528265b062ab106c31e23ce4a0ca2",
			eventsBytes: 88,
		};
		expect(p.lanes).toEqual([
			{
				...lane,
				lane: "claude",
				principal: "review-work-claude",
				model: "claude-sonnet-5-5",
				thinking: "medium",
				packetFileSha256: "148de9c5a7a44d19e56cd9ae1a554bf67847afb0c58f6e12fa29ac7ddfca9940",
				startedAt: "2026-10-12T00:01:00.000Z",
				finishedAt: "2026-10-12T00:06:00.000Z",
			},
			{
				...lane,
				lane: "gpt",
				principal: "review-work-gpt",
				model: "gpt-6.1-sol",
				thinking: "low",
				packetFileSha256: "954d5e4f00000000000000000000000000000000000000000000000000000000",
				startedAt: "2026-10-12T00:00:00.000Z",
				finishedAt: "2026-10-12T00:05:00.000Z",
			},
		]);
	});

	test("a second call for the same capture re-emits the stored bytes and signs nothing new", () => {
		const paths = setup();
		const first = attest(CAPTURE, paths, NOW);
		const second = attest(CAPTURE, paths, new Date("2026-10-12T09:00:00.000Z"));
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(second.stdout).toBe(first.stdout);
		expect(readdirSync(paths.store)).toEqual([`${CAPTURE}.json`]);
		expect(readFileSync(join(paths.store, `${CAPTURE}.json`), "utf8")).toBe(first.stdout.trim());
	});

	test("events.jsonl whose bytes differ from the recorded sha256 is refused and nothing is stored", () => {
		const paths = setup();
		writeFileSync(
			join(paths.captures, CAPTURE, "claude", "events.jsonl"),
			readFileSync(join(FIX, "events.jsonl"), "utf8").toUpperCase(),
		);
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({
			code: 1,
			stdout: "",
			stderr: "refused: claude: events.jsonl sha256 does not match the bytes on disk\n",
		});
		expect(readdirSync(paths.store)).toEqual([]);
	});

	test("two lanes with different preparedManifestSha256 are refused", () => {
		const other = "d".repeat(64);
		const paths = setup((lane, run) => {
			if (lane === "gpt") run.preparedManifestSha256 = other;
		});
		const prep = join(paths.captures, CAPTURE, "gpt", "prepare.json");
		writeFileSync(
			prep,
			JSON.stringify({ ...JSON.parse(readFileSync(prep, "utf8")), preparedManifestSha256: other }),
		);
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({
			code: 1,
			stdout: "",
			stderr: "refused: preparedManifestSha256 differs between lanes\n",
		});
		expect(readdirSync(paths.store)).toEqual([]);
	});

	test("two lanes with different declared nonces are refused", () => {
		const paths = setup((lane, run) => {
			if (lane === "gpt") (run.declared as Record<string, unknown>).nonce = "e".repeat(64);
		});
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({ code: 1, stdout: "", stderr: "refused: nonce differs between lanes\n" });
		expect(readdirSync(paths.store)).toEqual([]);
	});

	test("an empty stored record is refused with exit 3, never re-emitted", () => {
		const paths = setup();
		writeFileSync(join(paths.store, `${CAPTURE}.json`), "");
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({ code: 3, stdout: "", stderr: "error: stored record invalid\n" });
	});

	test("a valid stored record for a different capture is refused with exit 3", () => {
		const paths = setup();
		const first = attest(CAPTURE, paths, NOW);
		expect(first.code).toBe(0);
		const other = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
		for (const lane of ["claude", "gpt"]) {
			const src = join(paths.captures, CAPTURE, lane);
			const dst = join(paths.captures, other, lane);
			mkdirSync(dst, { recursive: true });
			chmodSync(dst, 0o755);
			for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
		}
		chmodSync(join(paths.captures, other), 0o755);
		writeFileSync(join(paths.store, `${other}.json`), first.stdout.trim());
		const out = attest(other, paths, NOW);
		expect(out).toEqual({ code: 3, stdout: "", stderr: "error: stored record invalid\n" });
	});

	test("a symlinked events.jsonl is refused and nothing is stored", () => {
		const paths = setup();
		const target = join(paths.captures, CAPTURE, "claude", "events.jsonl");
		const real = join(paths.store, "..", "events-real.jsonl");
		copyFileSync(target, real);
		unlinkSync(target);
		symlinkSync(real, target);
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({
			code: 1,
			stdout: "",
			stderr: "refused: claude: events.jsonl is not a regular file\n",
		});
		expect(readdirSync(paths.store)).toEqual([]);
	});

	test("a stored record is re-emitted after the raw capture is gone", () => {
		const paths = setup();
		const first = attest(CAPTURE, paths, NOW);
		expect(first.code).toBe(0);
		rmSync(join(paths.captures, CAPTURE), { recursive: true });
		expect(attest(CAPTURE, paths, NOW)).toEqual(first);
	});

	test("a FIFO in place of events.jsonl is refused without blocking", () => {
		const paths = setup();
		const target = join(paths.captures, CAPTURE, "claude", "events.jsonl");
		unlinkSync(target);
		execFileSync("mkfifo", ["-m", "644", target]);
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({
			code: 1,
			stdout: "",
			stderr: "refused: claude: events.jsonl is not a regular file\n",
		});
		expect(readdirSync(paths.store)).toEqual([]);
	});

	test("a run.json with exitStatus 1 is refused", () => {
		const paths = setup((lane, run) => {
			if (lane === "gpt") run.exitStatus = 1;
		});
		const out = attest(CAPTURE, paths, NOW);
		expect(out).toEqual({ code: 1, stdout: "", stderr: "refused: gpt: exitStatus is not 0\n" });
		expect(readdirSync(paths.store)).toEqual([]);
	});
});
