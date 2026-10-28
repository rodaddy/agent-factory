export interface LogEntry {
	ts: string;
	stream: string;
	event: Record<string, unknown> | null;
	text?: string;
}

export interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

export interface Step {
	kind: "generation" | "tool";
	id: string;
	name: string;
	model: string | null;
	provider?: string | null;
	input: unknown;
	output: unknown;
	startTime: string;
	endTime: string | null;
	usage: StepUsage | null;
	isError: boolean;
}

export interface IngestionEvent {
	id: string;
	type: "trace-create" | "generation-create" | "span-create";
	timestamp: string;
	body: Record<string, unknown> & { id: string };
}

export function parseLogContent(content: string): LogEntry[];
export function extractSteps(adapterType: string, entries: LogEntry[]): Step[];
export function truncate(text: string, max?: number): string;
export function redact(text: string): string;
export function modelName<T>(model: T): T;
export function providerFamily(model: unknown): "openai" | "anthropic" | "unknown";
export function buildIngestionBatch(
	run: Record<string, unknown>,
	steps: Step[],
	options?: {
		environment?: string;
		canonicalDelivery?:
			| "canonical_delivery_confirmed"
			| "canonical_delivery_incomplete"
			| "canonical_delivery_missing"
			| "canonical_delivery_unknown";
	},
): IngestionEvent[];
