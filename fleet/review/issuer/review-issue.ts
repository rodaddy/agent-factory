/**
 * @module fleet/review/issuer/review-issue
 * @description The execution attester (F5 cut 1). Run as
 *   `sudo -u review-issuer review-issue attest <capture-id>` by the supervisor.
 *   It signs ONLY what root captured: that the gpt and claude review lanes ran
 *   with the fixed models for one review nonce, base bundle and prepared
 *   manifest, each on its own packet (it names its lane), with their
 *   report digests and a clean exit. It binds nothing to a repository, head,
 *   work item or check: the factory's trusted consumer does that
 *   (ATTESTATION.md). One attestation per capture, kept in the store.
 *
 *   The caller is untrusted and sudo gives a clean environment, so the CLI
 *   reads no environment variable: every path is a constant. Tests reach the
 *   same logic through the exported `attest(captureId, paths, now)`.
 *
 *   Exit codes: 0 signed or re-emitted, 1 refused, 3 harness error.
 *
 * @outputs
 *   - `REAL_PATHS` -- the fixed host paths the CLI always uses
 *   - `CAPTURE_ID_RE`, `LANES` -- the accepted capture id and the fixed lanes
 *   - `canonicalJson` -- sorted-key, whitespace-free JSON
 *   - `attest` -- check one capture and sign (or re-emit) its attestation
 *   - `main` -- the argv entry
 *
 * @dependencies
 *   - node:crypto -- sha256, Ed25519 signing, uuid
 *   - node:fs -- read captures (O_NOFOLLOW fds) and keys, link-publish the once-per-capture record
 *   - node:path -- join paths under the fixed roots
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** `ownerUid`: the uid that must own the capture tree (root on the host). */
export type IssuerPaths = Record<"captures" | "key" | "pub" | "store", string> & {
	ownerUid: number;
};

/** The host paths. The shipped CLI uses these and nothing else. */
export const REAL_PATHS: Readonly<IssuerPaths> = Object.freeze({
	captures: "/var/lib/review-jobs/captures",
	key: "/etc/review-jobs/issuer/signing.key",
	pub: "/etc/review-jobs/signing.pub",
	store: "/var/lib/review-issuer/issued",
	ownerUid: 0,
});

export const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SCHEMA = "review-attestation/v1";
export const MAX_PAYLOAD_BYTES = 131072;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 1048576;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const CHUNK = 1 << 20;
const SHA_RE = /^[0-9a-f]{64}$/;

/** The fixed lanes. Principals match the play's `rv_lanes`; never taken from input. */
export const LANES = {
	claude: { model: "claude-sonnet-5-5", thinking: "medium", principal: "review-work-claude" },
	gpt: { model: "gpt-6.1-sol", thinking: "low", principal: "review-work-gpt" },
} as const;
type LaneName = keyof typeof LANES;
const LANE_NAMES = Object.keys(LANES).sort() as LaneName[];
const CAPTURE_FILES = ["events.jsonl", "stderr.txt"] as const;

export type AttestResult = { code: 0 | 1 | 3; stdout: string; stderr: string };

/** A check the capture failed: exit 1. */
class Refusal extends Error {}
/** The issuer itself could not work (key, store, I/O): exit 3. */
class HarnessError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;

/** JSON with object keys sorted at every depth and no whitespace. */
export function canonicalJson(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function code(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Owned by `owner` and not writable by group or other. */
function checkOwner(st: Stats, owner: number, label: string): void {
	if (st.uid !== owner) throw new Refusal(`${label} is not owned by uid ${owner}`);
	if ((st.mode & 0o022) !== 0) throw new Refusal(`${label} is group or other writable`);
}

/** A real directory (lstat: never a symlink) with the expected owner and mode. */
function checkDir(path: string, label: string, owner: number): void {
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch (err) {
		if (code(err) === "ENOENT") throw new Refusal(`${label} not found`);
		throw new HarnessError(`cannot stat ${label}`);
	}
	if (!st.isDirectory()) throw new Refusal(`${label} is not a directory`);
	checkOwner(st, owner, label);
}

type Sink = (chunk: Buffer) => void;

/**
 * Open with O_NOFOLLOW and O_NONBLOCK (a FIFO cannot hang the open), check the SAME fd
 * (regular file, owner, mode, size), then stream it into `sink` in chunks, never past
 * `limit`. Returns the byte count. Every byte comes from this fd, so a swapped path
 * cannot change what is read.
 */
function readRegular(path: string, label: string, owner: number, limit: number, sink: Sink) {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		if (code(err) === "ENOENT") throw new Refusal(`${label} missing`);
		if (code(err) === "ELOOP") throw new Refusal(`${label} is not a regular file`);
		throw new HarnessError(`cannot open ${label}`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Refusal(`${label} is not a regular file`);
		checkOwner(st, owner, label);
		const buf = Buffer.allocUnsafe(CHUNK);
		let total = st.size > limit ? limit + 1 : 0;
		for (let n = 1; n > 0 && total <= limit; total += n) {
			n = readSync(fd, buf, 0, CHUNK, null);
			sink(buf.subarray(0, n));
		}
		if (total > limit) throw new Refusal(`${label} exceeds ${limit} bytes`);
		return total;
	} finally {
		closeSync(fd);
	}
}

function readObject(path: string, label: string, owner: number): Obj {
	const parts: Buffer[] = [];
	readRegular(path, label, owner, MAX_RECORD_BYTES, (c) => parts.push(Buffer.from(c)));
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
	} catch {
		throw new Refusal(`${label} is not JSON`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Refusal(`${label} is not an object`);
	}
	return parsed as Obj;
}

function expect(cond: boolean, reason: string): asserts cond {
	if (!cond) throw new Refusal(reason);
}

function sha(value: unknown, label: string): string {
	expect(typeof value === "string" && SHA_RE.test(value), `${label} is not a sha256`);
	return value as string;
}

function epochIso(value: unknown, label: string): string {
	expect(Number.isSafeInteger(value) && (value as number) > 0, `${label} is not epoch seconds`);
	return new Date((value as number) * 1000).toISOString();
}

/** What both lanes must share. The packet is not: each one names its own lane, model and thinking. */
const SHARED = ["nonce", "bundleSha256", "preparedManifestSha256"] as const;
type LaneFacts = Record<(typeof SHARED)[number], string> & { lane: LaneName; record: Obj };

/** Every check on one lane directory. Returns the facts the payload carries. */
function checkLane(dir: string, lane: LaneName, owner: number): LaneFacts {
	const run = readObject(join(dir, "run.json"), `${lane}/run.json`, owner);
	const collector = readObject(join(dir, "collector.json"), `${lane}/collector.json`, owner);
	const prepare = readObject(join(dir, "prepare.json"), `${lane}/prepare.json`, owner);
	const want = LANES[lane];
	const at = (k: string) => `${lane}: ${k}`;

	expect(run.lane === lane, at("run.json lane does not match its directory"));
	// systemd Result and ExecMainStatus. Top-level `exitCode` is ExecMainCode, a string: not checked.
	expect(run.result === "success", at("result is not success"));
	expect(run.exitStatus === 0, at("exitStatus is not 0"));
	expect(run.requestedModel === want.model, at(`requestedModel is not ${want.model}`));
	expect(run.requestedThinking === want.thinking, at(`requestedThinking is not ${want.thinking}`));
	expect(run.cancelled === false, at("cancelled"));
	expect(run.unitLost === false, at("unit lost"));
	expect(run.timedOut === false, at("timed out"));
	expect(run.collectorComplete === true, at("collector incomplete"));
	expect(collector.complete === true, at("collector.json not complete"));
	expect(run.preparationStatus === "ok", at("preparation not ok"));
	expect(prepare.status === "ok", at("prepare.json status not ok"));

	const term = run.termination as Obj | null | undefined;
	expect(typeof term === "object" && term !== null, at("termination missing"));
	expect(term.exitCode === 0, at("termination.exitCode is not 0"));
	expect(term.signal === null, at("termination.signal is not null"));
	expect(term.timedOut === false, at("termination.timedOut"));
	expect(term.truncated === false, at("termination.truncated"));

	const captures = run.captures;
	expect(Array.isArray(captures), at("captures missing"));
	for (const c of captures as Obj[]) {
		expect(typeof c === "object" && c !== null && c.truncated === false, at("capture truncated"));
	}
	type Digest = { sha256: string; bytes: number };
	const out: Record<string, Digest> = {};
	for (const name of CAPTURE_FILES) {
		const rec = (captures as Obj[]).filter((c) => c.name === name);
		expect(rec.length === 1, at(`${name} not recorded exactly once`));
		const recorded = sha(rec[0]?.sha256, at(`${name} sha256`));
		// Recompute from the bytes on disk, streamed from the checked fd: the record alone is never trusted.
		const h = createHash("sha256");
		const size = readRegular(join(dir, name), at(name), owner, MAX_CAPTURE_BYTES, (c) => {
			h.update(c);
		});
		const actual = h.digest("hex");
		expect(actual === recorded, at(`${name} sha256 does not match the bytes on disk`));
		expect(rec[0]?.bytes === size, at(`${name} byte count does not match`));
		out[name] = { sha256: actual, bytes: size };
	}
	const startedAt = epochIso(run.startedAt, at("startedAt"));
	const finishedAt = epochIso(run.finishedAt, at("finishedAt"));
	const span = (run.finishedAt as number) - (run.startedAt as number);
	expect(span >= 0, at("finishedAt before startedAt"));

	const packetFileSha256 = sha(run.packetFileSha256, at("packetFileSha256"));
	const bundleSha256 = sha(run.bundleSha256, at("bundleSha256"));
	const preparedManifestSha256 = sha(run.preparedManifestSha256, at("preparedManifestSha256"));
	const manifestOk = prepare.preparedManifestSha256 === preparedManifestSha256;
	expect(manifestOk, at("prepare.json manifest differs from run.json"));
	const declared = (run.declared ?? {}) as Obj;
	expect(typeof declared === "object", at("declared is not an object"));
	const packetOk = declared.packetSha256 == null || declared.packetSha256 === packetFileSha256;
	expect(packetOk, at("declared packetSha256 differs from the packet file"));
	const declaredOk =
		declared.manifestSha256 == null || declared.manifestSha256 === preparedManifestSha256;
	expect(declaredOk, at("declared manifestSha256 differs from prepared"));
	const nonce = declared.nonce;
	expect(typeof nonce === "string" && SHA_RE.test(nonce), at("declared nonce is not 64 hex"));

	const [events, stderr] = CAPTURE_FILES.map((n) => out[n]) as [Digest, Digest];
	return {
		lane,
		nonce,
		bundleSha256,
		preparedManifestSha256,
		record: {
			lane,
			principal: want.principal,
			model: want.model,
			thinking: want.thinking,
			packetFileSha256,
			startedAt,
			finishedAt,
			exitCode: 0,
			eventsSha256: events.sha256,
			stderrSha256: stderr.sha256,
			eventsBytes: events.bytes,
		},
	};
}

/** Exactly the fixed lane directories, nothing else. */
function checkCapture(root: string, owner: number): LaneFacts[] {
	checkDir(root, "capture", owner);
	const entries = readdirSync(root).sort();
	expect(entries.join(",") === LANE_NAMES.join(","), "capture must hold exactly claude/ and gpt/");
	return LANE_NAMES.map((lane) => {
		const dir = join(root, lane);
		checkDir(dir, lane, owner);
		return checkLane(dir, lane, owner);
	});
}

/** Load the private key, derive the keyId, and match it against the published public key when present. */
function loadKey(paths: IssuerPaths): { key: KeyObject; pub: KeyObject; keyId: string } {
	let key: KeyObject;
	let pem: string;
	try {
		pem = readFileSync(paths.key, "utf8");
		key = createPrivateKey(pem);
	} catch {
		throw new HarnessError("signing key unreadable");
	}
	if (key.asymmetricKeyType !== "ed25519") throw new HarnessError("signing key is not Ed25519");
	const pub = createPublicKey(pem);
	const der = pub.export({ type: "spki", format: "der" });
	let published: string | undefined;
	try {
		published = readFileSync(paths.pub, "utf8");
	} catch (err) {
		if (code(err) !== "ENOENT") throw new HarnessError("public key unreadable");
	}
	if (published !== undefined) {
		let pubDer: Buffer;
		try {
			pubDer = createPublicKey(published).export({ type: "spki", format: "der" });
		} catch {
			throw new HarnessError("public key unparseable");
		}
		if (!pubDer.equals(der)) throw new HarnessError("public key does not match the signing key");
	}
	return { key, pub, keyId: `ed25519:${createHash("sha256").update(der).digest("hex")}` };
}

/**
 * The stored record for `id` (undefined when none), returned only if it is this issuer's
 * valid v1 envelope for THIS capture; anything else is a harness error, never exit 0.
 */
function storedFor(path: string, signer: { pub: KeyObject; keyId: string }, id: string) {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (err) {
		if (code(err) === "ENOENT") return undefined;
		throw new HarnessError("cannot read the issued record");
	}
	const bad = () => new HarnessError("stored record invalid");
	let env: Obj;
	let payload: Obj;
	try {
		env = JSON.parse(text) as Obj;
		if (env === null || typeof env !== "object" || Array.isArray(env)) throw bad();
		if (Object.keys(env).sort().join(",") !== "keyId,payload,signature") throw bad();
		if (typeof env.payload !== "string" || typeof env.signature !== "string") throw bad();
		payload = JSON.parse(env.payload) as Obj;
	} catch {
		throw bad();
	}
	if (env.keyId !== signer.keyId) throw bad();
	const sig = Buffer.from(env.signature as string, "base64");
	if (!verify(null, Buffer.from(env.payload as string, "utf8"), signer.pub, sig)) throw bad();
	if (payload === null || typeof payload !== "object") throw bad();
	if (payload.schema !== SCHEMA || payload.captureId !== id) throw bad();
	return text;
}

/**
 * fsync the store directory so the record's link survives a crash. Every exit-0 path runs
 * it, including re-emission, so a record is never reported issued before its link is durable.
 */
function syncDir(store: string): void {
	let fd: number;
	try {
		fd = openSync(store, constants.O_RDONLY);
	} catch {
		throw new HarnessError("cannot sync the issued record");
	}
	try {
		fsyncSync(fd);
	} catch {
		throw new HarnessError("cannot sync the issued record");
	} finally {
		closeSync(fd);
	}
}

/**
 * Publish `<store>/<id>.json` never partial: temp (O_EXCL, 0400), fsync, then link(2),
 * which fails EEXIST atomically if another call won (returns false). Temp always removed.
 * The caller syncs the directory.
 */
function publish(store: string, id: string, envelope: string): boolean {
	const temp = join(store, `.${id}.${randomUUID()}.tmp`);
	let written = false;
	try {
		const fd = openSync(temp, "wx", 0o400);
		try {
			writeFileSync(fd, envelope);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		written = true;
		linkSync(temp, join(store, `${id}.json`));
		return true;
	} catch (err) {
		if (written && code(err) === "EEXIST") return false;
		throw new HarnessError("cannot write the issued record");
	} finally {
		rmSync(temp, { force: true });
	}
}

/** Check one capture and return its attestation envelope, signing at most once per capture. */
export function attest(captureId: string, paths: IssuerPaths, now: Date): AttestResult {
	try {
		if (!CAPTURE_ID_RE.test(captureId)) throw new HarnessError("capture id is not a uuid");
		const signer = loadKey(paths);
		const { key, keyId } = signer;
		// The stored record first: re-emission must not need the raw capture, which may be gone.
		const storePath = join(paths.store, `${captureId}.json`);
		const prior = storedFor(storePath, signer, captureId);
		if (prior !== undefined) {
			syncDir(paths.store);
			return { code: 0, stdout: `${prior}\n`, stderr: "" };
		}

		const lanes = checkCapture(join(paths.captures, captureId), paths.ownerUid);
		const [a, b] = lanes as [LaneFacts, LaneFacts];
		for (const k of SHARED) expect(a[k] === b[k], `${k} differs between lanes`);

		const payload = canonicalJson({
			schema: SCHEMA,
			id: randomUUID(),
			captureId,
			issuedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
			nonce: a.nonce,
			bundleSha256: a.bundleSha256,
			preparedManifestSha256: a.preparedManifestSha256,
			lanes: lanes.map((l) => l.record as Json),
		});
		if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES)
			throw new HarnessError("payload too large");
		const signature = sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
		const envelope = JSON.stringify({ keyId, payload, signature });

		if (publish(paths.store, captureId, envelope)) {
			syncDir(paths.store);
			return { code: 0, stdout: `${envelope}\n`, stderr: "" };
		}
		// A race loser discards its own signature and re-emits the winner's, validated.
		const winner = storedFor(storePath, signer, captureId);
		if (winner === undefined) throw new HarnessError("issued record vanished");
		syncDir(paths.store);
		return { code: 0, stdout: `${winner}\n`, stderr: "" };
	} catch (err) {
		const line = (s: string) => s.replace(/[\r\n]+/g, " ");
		if (err instanceof Refusal)
			return { code: 1, stdout: "", stderr: `refused: ${line(err.message)}\n` };
		const msg = err instanceof HarnessError ? err.message : "unexpected failure";
		return { code: 3, stdout: "", stderr: `error: ${line(msg)}\n` };
	}
}

/** argv entry: `attest <capture-id>`, nothing more. Always the real paths. */
export function main(argv: readonly string[]): number {
	const [verb, id, ...rest] = argv;
	if (verb !== "attest" || id === undefined || rest.length > 0 || !CAPTURE_ID_RE.test(id)) {
		process.stderr.write("error: usage: review-issue attest <capture-id>\n");
		return 3;
	}
	const result = attest(id, REAL_PATHS, new Date());
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.code;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
