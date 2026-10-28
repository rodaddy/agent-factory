/** Protected Pi extension: one machine identity record, then fail closed on drift.
 * Only a launcher protecting code/env/FD1 can make this evidence trustworthy.
 * Model text, tool results and Pi custom messages never produce this record. */
import { writeSync } from "node:fs";
import { z } from "zod";

type Context = { model?: { provider: string; id: string; api: string } };
export type RuntimeCaptureApi = {
	on(event: string, handler: (event: unknown, context: Context) => unknown): unknown;
	getThinkingLevel(): string;
};
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const idsSchema = z.strictObject({
	nonce: z.string().regex(/^[a-f0-9]{64}$/),
	attemptId: ref,
	childRunId: ref,
});
export type RuntimeCaptureIds = z.infer<typeof idsSchema>;
type Identity = { provider: string; model: string; api: string; thinking: string };
const token = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_.:-]+$/);
const identitySchema = z.strictObject({
	provider: token,
	model: token,
	api: token,
	thinking: token,
});

/** Pi redirects process.stdout.write to stderr in JSON mode. A small protected
 * raw FD1 record bypasses that output guard; incomplete writes fail capture. */
function rawStdout(line: string) {
	if (writeSync(1, line) !== Buffer.byteLength(line))
		throw new Error("review_capture: write_failed");
}
/** Install identity capture. Injection parameters are trusted code/test seams.
 * @param pi Installed Pi extension API (getThinkingLevel is mandatory).
 * @param ids Protected launcher environment binding, never prompt arguments.
 * @param write Protected raw JSONL sink, defaults to FD1. */
export function installRuntimeCapture(
	pi: RuntimeCaptureApi,
	ids: RuntimeCaptureIds,
	write: (line: string) => unknown = rawStdout,
): void {
	const parsed = idsSchema.safeParse(ids);
	if (!parsed.success) throw new Error("review_capture: config");
	let locked: Identity | null = null;
	let failed = false;
	const emit = (record: Record<string, unknown>) => write(`${JSON.stringify(record)}\n`);
	const fail = (code: string): never => {
		if (!failed) emit({ type: "factory_review_runtime_error", version: 1, ...parsed.data, code });
		failed = true;
		throw new Error(`review_capture: ${code}`);
	};
	const thinking = (): string => {
		try {
			return pi.getThinkingLevel();
		} catch {
			return fail("identity_missing");
		}
	};
	const actual = (ctx: Context): Identity => {
		const model = ctx.model;
		const value = identitySchema.safeParse({
			provider: model?.provider,
			model: model?.id,
			api: model?.api,
			thinking: thinking(),
		});
		if (!value.success) return fail("identity_missing");
		return value.data;
	};
	const check = (_event: unknown, ctx: Context) => {
		if (failed) return fail("identity_changed");
		if (locked && JSON.stringify(actual(ctx)) !== JSON.stringify(locked))
			return fail("identity_changed");
	};
	pi.on("before_agent_start", (_event, ctx) => {
		if (locked || failed) return fail("reentry");
		locked = actual(ctx);
		emit({ type: "factory_review_runtime", version: 1, ...parsed.data, ...locked });
	});
	watchChanges(pi, check, () => locked, fail);
	for (const name of ["before_provider_request", "agent_end"]) pi.on(name, check);
}

function watchChanges(
	pi: RuntimeCaptureApi,
	check: (event: unknown, ctx: Context) => unknown,
	selected: () => Identity | null,
	fail: (code: string) => never,
) {
	pi.on("model_select", (event, ctx) => {
		const e = event as { model?: Context["model"] };
		if (
			selected() &&
			e.model &&
			(e.model.id !== selected()?.model ||
				e.model.provider !== selected()?.provider ||
				e.model.api !== selected()?.api)
		)
			return fail("identity_changed");
		return check(event, ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		const e = event as { level?: string };
		if (selected() && e.level !== undefined && e.level !== selected()?.thinking)
			return fail("identity_changed");
		return check(event, ctx);
	});
}

/** Default Pi extension entrypoint. No fallback identity or nullable effort. */
export default function runtimeCapture(pi: RuntimeCaptureApi): void {
	installRuntimeCapture(pi, {
		nonce: process.env.REVIEW_CAPTURE_NONCE ?? "",
		attemptId: process.env.REVIEW_CAPTURE_ATTEMPT_ID ?? "",
		childRunId: process.env.REVIEW_CAPTURE_CHILD_RUN_ID ?? "",
	});
}
