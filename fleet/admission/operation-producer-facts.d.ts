export function producerKey(kind: "issue" | "routine" | "approval", subject: string): string;
export function routineAuthorizationKey(facts: { routineId: string; triggerId: string }): string;
export const authorizationSchema: import("zod").ZodType;
export function parseAuthorizationRecord(
	value: unknown,
	key: string,
	companyId: string,
): {
	key: string;
	version: 1;
	approvalId: string;
	decidedByUserId: string;
	payload: { schema: string; facts: Record<string, unknown> };
};
