export default {
	id: "rodaddy.crew",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Crew",
	description: "Crew portraits, roles, and bios on agent pages and the dashboard.",
	author: "rodaddy",
	categories: ["ui"],
	capabilities: ["agents.read", "ui.detailTab.register", "ui.dashboardWidget.register"],
	entrypoints: { worker: "./worker.js", ui: "./ui" },
	instanceConfigSchema: {
		type: "object",
		properties: { crew: { type: ["object", "string"] } },
	},
	ui: {
		slots: [
			{
				type: "detailTab",
				id: "crew-card",
				displayName: "Crew card",
				exportName: "CrewCard",
				entityTypes: ["agent"],
			},
			{ type: "dashboardWidget", id: "the-crew", displayName: "The Crew", exportName: "TheCrew" },
		],
	},
};
