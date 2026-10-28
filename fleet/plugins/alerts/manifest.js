const secretRef = {
	type: "object",
	required: ["type", "secretId"],
	properties: {
		type: { type: "string", const: "secret_ref" },
		secretId: { type: "string" },
	},
};

export default {
	id: "rodaddy.alerts",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Fleet alerts",
	description:
		"Turns Alertmanager webhooks into Infra board issues for Nagatha in real time: one issue per alert key, repeats as comments, resolves close untouched issues.",
	author: "rodaddy",
	categories: ["connector"],
	capabilities: [
		"webhooks.receive",
		"companies.read",
		"secrets.read-ref",
		"issues.read",
		"issues.create",
		"issues.update",
		"issue.comments.read",
		"issue.comments.create",
		"projects.read",
		"jobs.schedule",
		"agents.read",
		"issue.relations.read",
		"events.subscribe",
	],
	entrypoints: { worker: "./worker.js" },
	webhooks: [{ endpointKey: "alertmanager", displayName: "Alertmanager" }],
	jobs: [
		{ jobKey: "backlog-sweep", displayName: "Backlog sweep", schedule: "0 * * * *" },
		{ jobKey: "ops-guard", displayName: "Nagatha Ops guard", schedule: "*/5 * * * *" },
		{ jobKey: "resume-sweep", displayName: "Resume sweep", schedule: "*/10 * * * *" },
	],
	instanceConfigSchema: {
		type: "object",
		required: ["companyId", "assigneeAgentId", "bearer"],
		properties: {
			companyId: { type: "string" },
			assigneeAgentId: { type: "string" },
			// Optional. First match wins; no match goes to assigneeAgentId.
			routes: {
				type: "array",
				items: {
					type: "object",
					required: ["match", "assigneeAgentId"],
					properties: {
						match: { type: "string" },
						assigneeAgentId: { type: "string" },
					},
				},
			},
			// Optional. The project every alert issue is created in; unset means
			// the project named rtech/rtech-infra.
			projectId: { type: "string" },
			// Optional. Absent, the backlog-sweep job does nothing.
			backlogSweep: {
				type: "object",
				required: ["triageAgentId"],
				properties: { triageAgentId: { type: "string" } },
			},
			// Optional. Absent, the ops-guard job does nothing.
			opsGuard: {
				type: "object",
				required: ["opsAgentId", "homeAgentId"],
				properties: {
					opsAgentId: { type: "string" },
					homeAgentId: { type: "string" },
				},
			},
			// Optional. Absent, the board-watch jobs do nothing.
			boardWatch: {
				type: "object",
				required: ["bishopAgentId"],
				properties: { bishopAgentId: { type: "string" } },
			},
			bearer: secretRef,
		},
	},
};
