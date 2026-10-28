// Paperclip OTel preload. Loaded with
//   node --import /home/operator/fleet/paperclip-otel/preload.mjs <paperclip> run ...
// so the ESM hook and the SDK exist BEFORE Paperclip's ESM entry imports
// express, node:http and postgres. Paperclip's own bootstrap is async and too
// late for those modules; it stays off because OTEL_EXPORTER_OTLP_ENDPOINT is
// left unset (this file reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT instead).
import { createRequire, register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ignoreIncomingRequest } from "./ignore.mjs";
import { createPostgresInstrumentation, slowMsFromEnv } from "./postgres.mjs";

const TAG = "[paperclip-otel]";
const SHUTDOWN_CAP_MS = 5000;

function start() {
	const env = process.env;
	if (!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;
	// One resolution root, so the SDK, the instrumentations and this file share
	// one copy of @opentelemetry/api.
	const root =
		env.PAPERCLIP_OTEL_MODULES || "/home/operator/.paperclip/cli/installs/npm/node_modules/";
	const require = createRequire(join(root, "paperclip-otel-preload.js"));
	register(
		pathToFileURL(require.resolve("@opentelemetry/instrumentation/hook.mjs")),
		import.meta.url,
	);

	const api = require("@opentelemetry/api");
	const { NodeSDK } = require("@opentelemetry/sdk-node");
	const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
	const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
	const otel = require("@opentelemetry/instrumentation");

	const sdk = new NodeSDK({
		instrumentations: [
			new HttpInstrumentation({
				ignoreIncomingRequestHook: (req) => ignoreIncomingRequest(req.url),
			}),
			new ExpressInstrumentation(),
			createPostgresInstrumentation(otel, api, slowMsFromEnv(env.PAPERCLIP_OTEL_PG_SLOW_MS)),
		],
	});
	// Traces only. The SDK configures metrics and logs from env at start(); pin
	// them off for that call without leaving the values for child processes.
	const saved = {
		OTEL_METRICS_EXPORTER: env.OTEL_METRICS_EXPORTER,
		OTEL_LOGS_EXPORTER: env.OTEL_LOGS_EXPORTER,
	};
	env.OTEL_METRICS_EXPORTER = "none";
	env.OTEL_LOGS_EXPORTER = "none";
	try {
		sdk.start();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete env[k];
			else env[k] = v;
		}
	}

	process.once("SIGTERM", async () => {
		let timer;
		const cap = new Promise((resolve) => {
			timer = setTimeout(resolve, SHUTDOWN_CAP_MS);
			timer.unref();
		});
		await Promise.race([sdk.shutdown().catch(() => {}), cap]);
		clearTimeout(timer);
		// Our listener is gone now; if nobody else handles SIGTERM, keep the
		// default behavior (exit) instead of swallowing the signal.
		if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
	});
}

try {
	start();
} catch (error) {
	console.error(`${TAG} tracing not started: ${String(error?.message ?? error).split("\n")[0]}`);
}
