import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { findCrew, rosterFromConfig } from "./crew.js";

let ctx;

async function roster(companyId) {
	const cfg = companyId ? await ctx.config.get(companyId).catch(() => null) : null;
	return rosterFromConfig(cfg);
}

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		ctx.data.register("roster", async ({ companyId }) => roster(companyId));
		// The detail tab only knows the agent id; resolve its board name here.
		ctx.data.register("crew-card", async ({ agentId, companyId }) => {
			if (typeof agentId !== "string" || typeof companyId !== "string") return null;
			const agent = await ctx.agents.get(agentId, companyId);
			return agent ? findCrew(agent.name, await roster(companyId)) : null;
		});
	},
	async onHealth() {
		return { status: "ok", message: "crew ready" };
	},
});

export default plugin;
runWorker(plugin, import.meta.url);
