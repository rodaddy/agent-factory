export interface CompanyCeiling {
	metric: "tokens" | "accounted_cost_cents";
	amount: number;
}
export interface CompanyBudgetDecision {
	allowed: boolean;
	failures: string[];
	cause?: string;
	approvalId?: string;
}
export function readCompanyCeiling(raw: string | undefined): CompanyCeiling | null;
export function dailyCompanySpend(snapshot: unknown): {
	tokens: number;
	accounted_cost_cents: number;
};
export function createCompanyBudgetGuard(options: {
	query: (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
	ceiling?: string;
	cancelWork: (companyId: string, excludedRunId?: string) => Promise<unknown>;
	warn: (fields: Record<string, unknown>, message: string) => void;
	now?: () => Date;
}): (companyId: string, excludedRunId?: string) => Promise<CompanyBudgetDecision>;
