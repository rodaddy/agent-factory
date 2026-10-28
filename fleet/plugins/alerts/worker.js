import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { runBacklogSweep } from "./backlog-sweep.js";
import { onRunFailed, runResumeSweep } from "./board-watch.js";
import { handleWebhook, runOpsGuard } from "./logic.js";

// A webhook carries no company and companies.list has no invocation scope
// there, so Alertmanager must send the company id in the `x-alerts-company`
// header (webhook_configs http_config http_headers; the receiver's job in
// SOF-1488). The bearer is checked against THAT company's secret.

let ctx;

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		ctx.jobs.register("ops-guard", () => runOpsGuard(ctx));
		ctx.jobs.register("backlog-sweep", () => runBacklogSweep(ctx, () => Date.now()));
		ctx.jobs.register("resume-sweep", () => runResumeSweep(ctx, () => Date.now()));
		ctx.events.on("agent.run.failed", (e) => onRunFailed(ctx, e, () => Date.now()));
	},
	async onHealth() {
		return { status: "ok", message: "alerts ready" };
	},
	async onWebhook(input) {
		const results = await handleWebhook(ctx, input, () => Date.now());
		ctx.logger.info("alerts: delivery handled", { results });
	},
});
export default plugin;
runWorker(plugin, import.meta.url);
