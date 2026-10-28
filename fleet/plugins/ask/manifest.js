const secretRef = {
	type: "object",
	required: ["type", "secretId"],
	properties: {
		type: { type: "string", const: "secret_ref" },
		secretId: { type: "string" },
	},
};

export default {
	id: "rodaddy.ask",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Ask Nagatha",
	description:
		"Takes infra questions on a shared-secret webhook and files them as Ask: issues for Nagatha; her ANSWER: comment is posted to the asker's callback and closes the issue.",
	author: "rodaddy",
	categories: ["connector"],
	capabilities: [
		"webhooks.receive",
		"events.subscribe",
		"companies.read",
		"secrets.read-ref",
		"issues.read",
		"issues.create",
		"issues.update",
		"issue.comments.read",
		"plugin.state.read",
		"plugin.state.write",
	],
	entrypoints: { worker: "./worker.js" },
	webhooks: [{ endpointKey: "ask", displayName: "Ask Nagatha" }],
	instanceConfigSchema: {
		type: "object",
		required: ["companyId", "assigneeAgentId", "token"],
		properties: {
			companyId: { type: "string" },
			assigneeAgentId: { type: "string" },
			token: secretRef,
			callbackHosts: { type: "array", items: { type: "string" } },
		},
	},
};
