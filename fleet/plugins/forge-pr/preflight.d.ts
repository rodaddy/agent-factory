// Types for preflight.js, the mechanical PR preflight.
export interface ChangedFile {
	filename: string;
	additions: number;
	deletions: number;
}
export type PreflightResult = { ok: true } | { ok: false; reasons: string[] };
export const BIG_CHANGE_LINES: number;
export const RISKY_PATHS: string[];
/** review-dispatch step 2's slice count: whole files, at most 400 added lines each; deletions never count. */
export function sliceCount(files: ChangedFile[]): number;
/** A pullFiles result that reached its page cap carries `truncated: true`. */
export type ChangedFiles = ChangedFile[] & { truncated?: boolean };
export function preflight(input: { body: string; files: ChangedFiles }): PreflightResult;
/** The one fix-first comment: `verdict: fix-first (preflight)`, then each reason with its fix. */
export function preflightComment(reasons: string[]): string;
/** Every page of a PR's changed files through get(path), up to 1000; past that, `truncated`. */
type Get = (path: string) => Promise<unknown>;
export function pullFiles(get: Get, repo: string, number: number): Promise<ChangedFiles>;
