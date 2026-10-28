export interface TraceSecrets {
	boardApiKey: string;
	langfusePublicKey: string;
	langfuseSecretKey: string;
}

export interface TraceResult {
	runId: string;
	events: number;
	successes: number;
	errors: number;
	diagnostics: string[];
}

export class HttpError extends Error {
	status: number;
	constructor(message: string, status: number);
}

export function withRetry<T>(
	fn: () => Promise<T>,
	options?: { delays?: number[]; sleep?: (ms: number) => Promise<void> },
): Promise<T>;

export function traceRun(input: {
	runId: string;
	companyId: string;
	config: { boardUrl?: string; langfuseHost?: string } & Record<string, unknown>;
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
	secrets: TraceSecrets;
	sleep?: (ms: number) => Promise<void>;
	requestTimeoutMs?: number;
}): Promise<TraceResult>;
