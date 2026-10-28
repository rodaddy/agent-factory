// Types for tier-tags.js.
export const RETAG_CAP: number;
export const OPEN_STATUSES: string[];
export function tierTaskRepo(title: unknown): string | null;
export function tierLabelIds(raw: unknown): Map<number, string> | null;
export function withTierLabel(labelIds: string[], ids: Map<number, string>, tier: number): string[];
export interface RetagDeps {
	repos: string[];
	ids: Map<number, string> | null;
	repoTier: (repo: string) => Promise<number | null>;
	listOpen: () => Promise<unknown[]>;
	update: (id: string, labelIds: string[]) => Promise<unknown>;
	log: (line: string) => void;
}
export function retagTiers(deps: RetagDeps): Promise<number>;
