const secretRef = {
	type: "object",
	required: ["type", "secretId"],
	properties: {
		type: { type: "string", const: "secret_ref" },
		secretId: { type: "string" },
	},
};

export default {
	id: "rodaddy.forge-pr",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Forge PR intake",
	description:
		"Turns signed Forge pull-request and issue webhooks, plus a 5-minute Forge sweep, into review and triage issues on the Software Factory board.",
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
		"agents.read",
		"agents.invoke",
		"issues.wakeup",
		"projects.read",
		"plugin.state.read",
		"plugin.state.write",
		"jobs.schedule",
		"approvals.read",
		"approvals.respond",
		"events.subscribe",
		"issue.interactions.read",
	],
	entrypoints: { worker: "./worker.js" },
	webhooks: [{ endpointKey: "forge", displayName: "Forge pull requests and issues" }],
	jobs: [
		// sf#1730: seat question cards go to Smythe as Decision: tasks, not to the owner.
		{ jobKey: "question-route", displayName: "Seat questions to Smythe", schedule: "*/5 * * * *" },
		{ jobKey: "forge-sweep", displayName: "Forge sweep", schedule: "*/5 * * * *" },
		{ jobKey: "tier-retag", displayName: "Tier label re-tag", schedule: "17 * * * *" },
	],
	instanceConfigSchema: {
		type: "object",
		required: ["reviewerAgentId", "triageAgentId", "repos", "webhookSecret", "forgeToken"],
		properties: {
			reviewerAgentId: { type: "string" },
			triageAgentId: { type: "string" },
			repos: { type: "array", items: { type: "string" } },
			// The board user stale approvals are rejected as.
			boardUserId: { type: "string" },
			// The non-code fast path runs only when true. Off until
			// merge-check accepts the scripted verdict, so no Merge task can stall.
			scriptedNonCode: { type: "boolean" },
			// The no-lead reviewer pair: a new head gets one task per
			// reviewer family. Off until merge-check and the merge sweep read pairs.
			pairReview: { type: "boolean" },
			// Code-only review: each pair task lists the docs to skip.
			codeOnlyReview: { type: "boolean" },
			// Label ids by name, "tier-0".."tier-5"; fleet/bin/ensure-labels
			// prints them to paste. Absent: no tier labels, logged once. The key
			// "priority" is the board label a Forge PR's `priority` label maps to.
			tierLabels: { type: "object", additionalProperties: { type: "string" } },
			webhookSecret: secretRef,
			forgeToken: secretRef,
			// Board API key: cancelling a superseded review through the board route
			// also stops its live run. Absent: the task is cancelled, the run is not.
			boardApiKey: secretRef,
		},
	},
};
