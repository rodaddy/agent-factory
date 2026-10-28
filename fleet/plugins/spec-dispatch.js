// sf#2102: shared implementation wake boundary. The deterministic checker is
// Node 24 TypeScript; plugins invoke the same executable as task-route/task-new.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "../bin/spec-ready");
// Diagnosis, review and specification are the only exempt task classes.
export function isWorkTask(title = "") {
	return (
		!/^\s*(?:Checks not green: \S+\/\S+#\d+ @ [0-9a-f]{7,40}$|Resolve merge-check read failure(?: on|:)? \S+\/\S+#\d+(?: @ [0-9a-f]{7,40})?$|(?:[A-Za-z]+:? )?(?:blind )?(?:(?:senior|junior) )?(?:shadow )?review \S+\/\S+#\d+ @ [0-9a-f]{7,40})/i.test(
			title,
		) &&
		!/^\s*(?:triage|review|merge|write spec|spec-writing|diagnose|research|audit|run-audit|fleet audit|infra:|ask:|backlog:|config:)(?:\b|\s)/i.test(
			title,
		)
	);
}
const pending = new Map();

export function runSpecCheck(task, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(CHECK, ["--task-json"], { env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.stdout.on("data", (chunk) => {
			out += chunk;
			if (out.length > 64_000) child.kill("SIGKILL");
		});
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== 1) return reject(new Error("spec-ready harness failed"));
			try {
				resolve(JSON.parse(out));
			} catch {
				reject(new Error("spec-ready returned invalid JSON"));
			}
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(task));
	});
}

async function allow(ctx, companyId, task) {
	const cfg = await ctx.config.get(companyId);
	const token = cfg?.forgeToken
		? await ctx.secrets.resolve(cfg.forgeToken, { companyId, configPath: "forgeToken" })
		: process.env.FORGEJO_TOKEN;
	const result = await runSpecCheck(task, { ...process.env, FORGEJO_TOKEN: token });
	if (result.ready) return true;
	const originId = `${result.issueUrl ?? task.id ?? task.title}:${result.bodyHash}`;
	await serialize(`spec:${companyId}:${originId}`, async () => {
		const found = await ctx.issues.list({ companyId, originKind: "spec-ready", originId });
		if (!found.some((i) => i.originKind === "spec-ready" && i.originId === originId)) {
			await ctx.issues.create({
				companyId,
				title: `Write spec: ${result.issueUrl ?? task.title}`,
				description: `Source: ${result.issueUrl ?? task.id ?? task.title}\n\nMissing: ${result.missing.join(", ")}\n\nWrite the spec, then rerun spec-ready before assigning implementation. Higher effort is allowed only for this step.`,
				status: "backlog",
				originKind: "spec-ready",
				originId,
			});
		}
	});
	return false;
}

/** A held implementation never creates/reassigns/wakes its original seat. */
export function allowWorkTask(ctx, companyId, task) {
	if (!isWorkTask(task.title ?? "")) return Promise.resolve(true);
	const ref = (task.description ?? "").match(
		/https:\/\/forge\.example\.internal\/[^\s)]+\/(?:issues|pulls)\/[0-9]+/,
	)?.[0];
	const key = `${companyId}:${ref ?? task.id ?? task.title}`;
	return serialize(key, () => allow(ctx, companyId, task));
}

function serialize(key, operation) {
	const prior = pending.get(key) ?? Promise.resolve();
	const next = prior.catch(() => {}).then(operation);
	pending.set(key, next);
	void next
		.finally(() => {
			if (pending.get(key) === next) pending.delete(key);
		})
		.catch(() => {});
	return next;
}
