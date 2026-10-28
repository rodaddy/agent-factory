export default {
	id: "rodaddy.project-guard",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Project guard",
	description:
		"Every task carries a project (sf#1690): an issue created without one, or whose project is cleared, gets one derived from its title, parent or infra origin; otherwise it goes to the triage lead with a comment.",
	author: "rodaddy",
	categories: ["automation"],
	capabilities: [
		"events.subscribe",
		"issues.read",
		"issues.update",
		"issue.comments.create",
		"projects.read",
		"agents.read",
	],
	entrypoints: { worker: "./worker.js" },
	instanceConfigSchema: { type: "object", properties: {} },
};
