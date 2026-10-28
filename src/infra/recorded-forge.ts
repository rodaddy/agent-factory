/**
 * @module src/infra/recorded-forge
 * @description A ForgeClient that REPLAYS a curl recording of one PR's reads, so
 *   the infra-gates `plan` step runs with no token (D25: a job that
 *   holds a credential runs no repository code). A credential job writes the
 *   recording with curl alone; the code job reads it here. Only `getPage` is
 *   served, and only the two shapes `readForgejoChangedFiles` asks for:
 *   - `/repos/<owner>/<repo>/pulls/<n>`        -> `pull.json`
 *   - `.../pulls/<n>/files?limit=50&page=<p>`  -> `files-<p>.json`, with
 *     `totalCount` from `X-Total-Count` in `files-<p>.headers` (a `curl -D` dump)
 *   Any other path, and any missing or unparseable file, throws. The reader turns
 *   a throw into `indeterminate`, which escalates to every gate: a broken
 *   recording can only widen the checks, never narrow them.
 *
 * @outputs
 *   - `recordedForgeClient` -- recording dir -> a getPage-only ForgeClient
 *
 * @dependencies
 *   - node:fs/promises, node:path -- read the recording files
 *   - ../forge/boundary -- the ForgeClient / ForgePage shapes
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeClient, ForgePage } from "../forge/boundary";

const PULL = /^\/repos\/[^/?]+\/[^/?]+\/pulls\/\d+$/;
const FILES = /^\/repos\/[^/?]+\/[^/?]+\/pulls\/\d+\/files\?limit=50&page=(\d+)$/;

/** The X-Total-Count of a curl `-D` dump; absent -> undefined, malformed -> throw. */
function totalCount(headers: string): number | undefined {
	let found: number | undefined;
	for (const line of headers.split(/\r?\n/)) {
		const match = /^x-total-count:\s*(.*?)\s*$/i.exec(line);
		if (!match) continue;
		if (!/^\d+$/.test(match[1] as string)) throw new Error("recorded X-Total-Count malformed");
		found = Number(match[1]);
	}
	return found;
}

async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

function unavailable(verb: string): never {
	throw new Error(`${verb} not available in a recorded client`);
}

/** A ForgeClient serving only `getPage` for a PR's pull and files reads, from `dir`. */
export function recordedForgeClient(dir: string): ForgeClient {
	return {
		provider: "forgejo",
		getPage: async <T>(pathOrUrl: string): Promise<ForgePage<T>> => {
			if (PULL.test(pathOrUrl))
				return { body: (await json(join(dir, "pull.json"))) as T, next: null };
			const page = FILES.exec(pathOrUrl)?.[1];
			if (page === undefined) throw new Error("path not in the recording");
			const body = (await json(join(dir, `files-${page}.json`))) as T;
			const total = totalCount(await readFile(join(dir, `files-${page}.headers`), "utf8"));
			return total === undefined ? { body, next: null } : { body, next: null, totalCount: total };
		},
		get: async () => unavailable("get"),
		paginate: async () => unavailable("paginate"),
		write: async () => unavailable("write"),
		postCommitCheck: async () => unavailable("postCommitCheck"),
		findCommitCheck: async () => unavailable("findCommitCheck"),
	};
}
