import type { ForgeClient } from "../forge/boundary";
import { errorClass, log, traced } from "../log";
import { MAX_PATH_LENGTH, type ChangedFilesResult } from "./changed-files";
import { MAX_CHANGED_PATHS } from "./gates";

const uncertain = (reason: string): ChangedFilesResult => ({
	paths: [],
	indeterminate: true,
	reason: `changed-files read: Forgejo ${reason}`,
});

type Pull = { changed_files?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown } };

function pullProblem(body: unknown, sha: string, base: string): string | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "malformed PR body";
	const pull = body as Pull;
	if (pull.head?.sha !== sha) return "PR head SHA differs from pinned SHA";
	// The gate set is selected against this base; a retarget or base update can change
	// the file list while head and count stay equal, so the base is pinned too.
	if (pull.base?.sha !== base) return "PR base SHA differs from the selected base";
	if (!Number.isSafeInteger(pull.changed_files) || (pull.changed_files as number) < 0)
		return "PR changed_files count missing or invalid";
	if ((pull.changed_files as number) > MAX_CHANGED_PATHS)
		return "PR changed_files exceeds path cap";
	return null;
}

function filePaths(entry: unknown): string[] | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	const file = entry as { filename?: unknown; previous_filename?: unknown };
	const paths = [file.filename];
	if (file.previous_filename !== undefined && file.previous_filename !== null)
		paths.push(file.previous_filename);
	if (paths.some((p) => typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LENGTH))
		return null;
	return paths as string[];
}

async function readFiles(
	client: ForgeClient,
	path: string,
	count: number,
): Promise<ChangedFilesResult> {
	const names = new Set<string>();
	const paths = new Set<string>();
	let exhausted = false;
	// One extra page permits an exhausted empty page at the exact path cap.
	for (let page = 1; page <= Math.ceil(MAX_CHANGED_PATHS / 50) + 1; page++) {
		const result = await client.getPage<unknown>(`${path}/files?limit=50&page=${page}`);
		if (!Array.isArray(result.body) || result.body.length > 50)
			return uncertain("malformed files page");
		if (result.totalCount !== undefined && result.totalCount !== count)
			return uncertain("X-Total-Count differs from PR changed_files count");
		for (const entry of result.body) {
			const extracted = filePaths(entry);
			if (!extracted) return uncertain("malformed file entry or path length out of bounds");
			names.add(extracted[0] as string);
			for (const name of extracted) paths.add(name);
		}
		if (names.size > count || paths.size > MAX_CHANGED_PATHS)
			return uncertain("files count exceeds expected count or path cap");
		if (result.next === null && (result.body.length < 50 || names.size === count)) {
			exhausted = true;
			break;
		}
	}
	if (!exhausted) return uncertain("files pagination exceeds page cap");
	if (names.size !== count)
		return uncertain("distinct files count differs from PR changed_files count");
	if (paths.size === 0) return uncertain("no changed files resolved");
	return {
		paths: [...paths],
		indeterminate: false,
		reason: `changed-files read: ${paths.size} path(s) resolved`,
	};
}

/** Prove a mutable PR file list complete and pinned, checking head and base again after pagination. */
export const readForgejoChangedFiles = traced(
	"infra.readForgejoChangedFiles",
	async function readForgejoChangedFiles(args: {
		client: ForgeClient;
		repository: string;
		sha: string;
		base: string;
		pullNumber: number;
	}): Promise<ChangedFilesResult> {
		const { client, repository, sha, base, pullNumber } = args;
		if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) return uncertain("invalid PR number");
		const path = `/repos/${repository}/pulls/${pullNumber}`;
		try {
			const first = await client.getPage<unknown>(path);
			const problem = pullProblem(first.body, sha, base);
			if (problem) return uncertain(problem);
			const count = (first.body as Pull).changed_files as number;
			const files = await readFiles(client, path, count);
			if (files.indeterminate) return files;
			const last = await client.getPage<unknown>(path);
			const drift = pullProblem(last.body, sha, base);
			if (drift) return uncertain(drift);
			if ((last.body as Pull).changed_files !== count)
				return uncertain("PR changed_files count changed during read");
			return files;
		} catch (error) {
			log("warn", "infra.changed_files.read_failed", {
				repository,
				sha,
				pull: pullNumber,
				error_class: errorClass(error),
			});
			return uncertain("PR files API or network error");
		}
	},
);
