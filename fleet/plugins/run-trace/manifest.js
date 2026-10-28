const secretRef = {
	type: "object",
	required: ["type", "secretId"],
	properties: {
		type: { type: "string", const: "secret_ref" },
		secretId: { type: "string" },
	},
};

export default {
	id: "rodaddy.run-trace",
	apiVersion: 1,
	version: "0.1.0",
	displayName: "Run trace",
	description:
		"Sends each finished agent run to Langfuse as a trace with generation and tool steps.",
	author: "rodaddy",
	categories: ["connector"],
	capabilities: ["events.subscribe", "companies.read", "secrets.read-ref"],
	entrypoints: { worker: "./worker.js" },
	instanceConfigSchema: {
		type: "object",
		required: ["boardApiKey", "langfusePublicKey", "langfuseSecretKey"],
		properties: {
			boardUrl: { type: "string", default: "http://127.0.0.1:3100" },
			langfuseHost: { type: "string", default: "https://langfuse.example.internal" },
			boardApiKey: secretRef,
			langfusePublicKey: secretRef,
			langfuseSecretKey: secretRef,
		},
	},
};
