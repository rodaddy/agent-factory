export interface SpecTask {
	id?: string;
	title?: string;
	description?: string;
	labels?: { name: string }[];
}
export interface DispatchContext {
	config: { get(companyId: string): Promise<{ forgeToken?: string } | null> };
	secrets: {
		resolve(ref: string, scope: { companyId: string; configPath: string }): Promise<string>;
	};
	issues: {
		list(query: {
			companyId: string;
			originKind: string;
			originId: string;
		}): Promise<{ originKind?: string; originId?: string }[]>;
		create(task: Record<string, unknown>): Promise<unknown>;
	};
}
export function runSpecCheck(
	task: SpecTask,
	env?: Record<string, string | undefined>,
): Promise<{ ready: boolean; missing: string[]; bodyHash: string; issueUrl: string | null }>;
export function allowWorkTask(
	ctx: DispatchContext,
	companyId: string,
	task: SpecTask,
): Promise<boolean>;

export function isWorkTask(title?: string): boolean;
