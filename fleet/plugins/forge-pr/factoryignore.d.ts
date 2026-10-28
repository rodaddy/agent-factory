// Types for factoryignore.js, the review fast path's classifier.
import type { ReviewIssue } from "./logic.js";

export interface FileFacts {
	path: string;
	/** The git tree mode, e.g. "100644"; unknown is refused. */
	mode?: string;
	/** The file's first line; unknown is refused. */
	firstLine?: string;
}
export interface NonCodeVerdict {
	nonCode: boolean;
	refused: Array<{ path: string; reason: string }>;
	code: string[];
	/** The .factoryignore lines that match a refused path. */
	patterns: string[];
}
export const DEFAULT_FACTORYIGNORE: string[];
export const NON_CODE_EXTENSIONS: string[];
export const REFUSED: string[];
export const SCRIPTED_VERDICT: string;
export function classify(input: {
	factoryignore: string | null;
	files: FileFacts[];
}): NonCodeVerdict;
type Get = (path: string) => Promise<unknown>;
export function nonCodeVerdict(
	get: Get,
	repo: string,
	refs: { baseRef: string; headSha: string },
	files: Array<{ filename: string; previous_filename?: string }>,
): Promise<NonCodeVerdict>;
/** The changed paths that are non-code by classify's rules, sorted; a read error throws. */
export function docPaths(
	get: Get,
	repo: string,
	refs: { baseRef: string; headSha: string },
	files: Array<{ filename: string; previous_filename?: string }>,
): Promise<string[]>;
interface Head {
	repo: string;
	number: number;
	headSha: string;
	url: string;
}
export function scriptedComment(ev: Head, paths: string[]): string;
export function scriptedMergeTask(ev: Head, assigneeAgentId: string): ReviewIssue;
