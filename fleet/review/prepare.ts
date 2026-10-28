/** Factory source preparation. Launcher supplies frozen inputs and exclusive output, then root seals. */
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	manifestWireSchema,
	PREPARATION_LIMITS,
	type PreparationManifest,
	parsePreparationManifest,
} from "./preparation-contract.ts";
import {
	decode,
	PreparationGit,
	PreparationHold,
	readTree,
	requireInput,
	utf8Order,
} from "./preparation-git.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const packetSchema = manifestWireSchema
	.pick({ repo: true, pr: true, baseSha: true, headSha: true })
	.extend({
		version: z.literal(1),
		id: z.string().uuid(),
		lane: z.enum(["gpt", "claude"]),
		model: z.string(),
		thinking: z.string(),
		nonce: digest,
		attemptId: id,
		childRunId: id,
		timeoutMs: z.number().int().min(1).max(900_000).optional(),
		packetSha256: digest.optional(),
		manifestSha256: digest.optional(),
		review: z.record(z.string(), z.unknown()).optional(),
	});
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Sort nested context keys so lane envelopes never affect common bytes. */
function canonical(value: unknown, depth = 0): unknown {
	if (depth > 64) throw new PreparationHold("context_depth");
	if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => utf8Order(a, b))
			.map(([k, v]) => [k, canonical(v, depth + 1)]),
	);
}
function packetInput(path: string) {
	requireInput(path, 65_536);
	const parsed = packetSchema.safeParse(JSON.parse(decode(readFileSync(path))));
	if (!parsed.success) throw new PreparationHold("packet_schema");
	const p = parsed.data;
	const expected = { gpt: ["gpt-6.1-sol", "low"], claude: ["claude-sonnet-5-5", "medium"] }[p.lane];
	if (p.model !== expected[0] || p.thinking !== expected[1])
		throw new PreparationHold("packet_lane");
	return p;
}
function inventory(
	git: PreparationGit,
	binding: Pick<PreparationManifest, "repo" | "pr" | "baseSha" | "headSha">,
): PreparationManifest {
	const manifest: PreparationManifest = { schemaVersion: 1, ...binding, files: [], gitlinks: [] };
	for (const side of ["base", "head"] as const) {
		for (const e of readTree(git, binding[side === "base" ? "baseSha" : "headSha"])) {
			if (e.gitMode === "160000") {
				manifest.gitlinks.push({
					repoPath: e.repoPath,
					side,
					gitMode: e.gitMode,
					objectOid: e.objectOid,
				});
				continue;
			}
			const common = {
				path: `${side}/${e.repoPath}`,
				bytes: e.bytes,
				sha256: "0".repeat(64),
				repoPath: e.repoPath,
				side,
				objectOid: e.objectOid,
			};
			manifest.files.push(
				e.gitMode === "120000"
					? { ...common, kind: "symlink", gitMode: e.gitMode }
					: { ...common, kind: "regular", gitMode: e.gitMode },
			);
		}
	}
	manifest.gitlinks.sort((a, b) => utf8Order(`${a.side}/${a.repoPath}`, `${b.side}/${b.repoPath}`));
	return manifest;
}
function validate(manifest: PreparationManifest): Buffer {
	manifest.files.sort((a, b) => utf8Order(a.path, b.path));
	const bytes = json(manifest);
	const result = parsePreparationManifest(bytes, manifest);
	if (!result.ok) throw new PreparationHold(`manifest_${result.reason}`);
	return bytes;
}
/** Reject colliding directory spellings before materializing, including non-materialized gitlinks. */
function directories(manifest: PreparationManifest): string[] {
	const paths = [
		...manifest.files.map((f) => f.path),
		...manifest.gitlinks.map((g) => `${g.side}/${g.repoPath}`),
	];
	const dirs = new Map<string, string>([
		["base", "base"],
		["head", "head"],
	]);
	for (const path of paths) {
		let parent = dirname(path);
		while (parent !== ".") {
			const key = parent.normalize("NFC");
			if (dirs.has(key) && dirs.get(key) !== parent)
				throw new PreparationHold("directory_collision");
			dirs.set(key, parent);
			parent = dirname(parent);
		}
	}
	const files = new Set(manifest.files.map((f) => f.path.normalize("NFC")));
	if ([...dirs.keys()].some((d) => files.has(d))) throw new PreparationHold("directory_collision");
	if (dirs.size + manifest.files.length + 1 > PREPARATION_LIMITS.entries)
		throw new PreparationHold("entry_bounds");
	// Gitlink-only parents are not output directories; inventory must remain exact.
	const output = new Set(["base", "head"]);
	for (const f of manifest.files) {
		let parent = dirname(f.path);
		while (parent !== ".") {
			output.add(parent);
			parent = dirname(parent);
		}
	}
	return [...output].sort(utf8Order);
}
function outputRoot(path: string): void {
	if (
		!isAbsolute(path) ||
		realpathSync(path) !== path ||
		!lstatSync(path).isDirectory() ||
		readdirSync(path).length !== 0
	)
		throw new PreparationHold("output_not_empty_directory");
}
function reviewDiff(git: PreparationGit, baseSha: string, headSha: string): Buffer {
	return git.run(
		[
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--binary",
			"--full-index",
			"--no-color",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--diff-algorithm=myers",
			baseSha,
			headSha,
			"--",
		],
		PREPARATION_LIMITS.diffBytes,
	);
}
/** Successful return is only preparation evidence; root must independently validate and seal. */
export function prepareReview(
	packetPath: string,
	bundlePath: string,
	output: string,
): { manifestSha256: string; files: number } {
	const p = packetInput(packetPath);
	requireInput(bundlePath, 536_870_912);
	outputRoot(output);
	const scratch = join(output, ".prepare-git");
	mkdirSync(scratch, { mode: 0o700 });
	try {
		const git = new PreparationGit(scratch);
		git.import(bundlePath, [p.baseSha, p.headSha]);
		const binding = { repo: p.repo, pr: p.pr, baseSha: p.baseSha, headSha: p.headSha };
		const manifest = inventory(git, binding);
		const context = json({ ...binding, review: canonical(p.review ?? {}) });
		if (context.length > PREPARATION_LIMITS.contextBytes)
			throw new PreparationHold("context_bounds");
		const diff = reviewDiff(git, p.baseSha, p.headSha);
		const artifacts = new Map([
			["context.json", context],
			["diff.patch", diff],
		]);
		for (const [path, bytes] of artifacts)
			manifest.files.push({
				path: path as "context.json" | "diff.patch",
				bytes: bytes.length,
				sha256: hash(bytes),
				kind: "artifact",
			});
		validate(manifest);
		for (const dir of directories(manifest)) mkdirSync(join(output, dir), { mode: 0o700 });
		for (const f of manifest.files) {
			const bytes =
				f.kind === "artifact"
					? artifacts.get(f.path)
					: git.run(["cat-file", "blob", f.objectOid], PREPARATION_LIMITS.fileBytes);
			if (!bytes || bytes.length !== f.bytes) throw new PreparationHold("blob_size_mismatch");
			f.sha256 = hash(bytes);
			writeFileSync(join(output, f.path), bytes, { flag: "wx", mode: 0o600 });
		}
		const bytes = validate(manifest);
		// No scratch or completion manifest is visible to a reviewer before success and root sealing.
		rmSync(scratch, { recursive: true });
		writeFileSync(join(output, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
		return { manifestSha256: hash(bytes), files: manifest.files.length + 1 };
	} catch (error) {
		throw error instanceof PreparationHold ? error : new PreparationHold("preparation_io");
	}
}
