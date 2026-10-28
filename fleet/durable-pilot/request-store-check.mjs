/** Public-boundary checks. Integration mode requires isolated Postgres and NATS. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { nkeys } from "nats";
import * as requestBus from "./request-bus.mjs";
import {
	BUS_DEFAULTS,
	CONSUMER_CONFIG,
	STREAM_CONFIG,
	validateBusContract,
	validateBusNames,
} from "./request-bus.mjs";
import { normalizeHost, validateDatabaseUrl } from "./request-store.mjs";

const FIXTURE_ROOT =
	process.env.RODADDY_WATCHER_TEST_TMP ??
	"/opt/_tmp/software-factory/_validation-runs/durable-request-H";
assert.ok(
	normalize(FIXTURE_ROOT) === FIXTURE_ROOT &&
		["/opt/_tmp", "/mnt/share/tmp_space"].some(
			(root) => FIXTURE_ROOT === root || FIXTURE_ROOT.startsWith(`${root}/`),
		),
	"request_test_root_refused",
);

test("store refuses production or ambiguous database names", () => {
	assert.throws(
		() => validateDatabaseUrl("postgres://localhost/paperclip"),
		/request_database_refused/,
	);
	assert.throws(
		() => validateDatabaseUrl("postgres://localhost/durable_pi_request_h_bad"),
		/request_database_refused/,
	);
	assert.equal(
		validateDatabaseUrl("postgres://localhost/durable_pi_request_h"),
		"postgres://localhost/durable_pi_request_h",
	);
	assert.equal(normalizeHost("durable-pi-pilot-02"), "109");
	assert.throws(() => normalizeHost("sf-fleet-01"), /request_host_refused/);
});

test("private static user seed signs a nonce; malformed and exposed files refuse", () => {
	const directory = join(FIXTURE_ROOT, `auth-check-${randomUUID()}`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = join(directory, "ephemeral-user.nkey");
	const key = nkeys.createUser();
	writeFileSync(file, key.getSeed(), { mode: 0o600 });
	const nonce = "request-H-offline-auth-challenge";
	const auth = requestBus.requestAuthenticator(file)(nonce);
	assert.equal(auth.nkey, key.getPublicKey());
	assert.ok(key.verify(new TextEncoder().encode(nonce), nkeys.decode(auth.sig)));
	assert.equal(auth.jwt, undefined);
	const jwt = Buffer.from(randomUUID()).toString("base64url");
	writeFileSync(
		file,
		`-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${new TextDecoder().decode(key.getSeed())}\n------END USER NKEY SEED------\n`,
		{ mode: 0o600 },
	);
	const jwtAuth = requestBus.requestAuthenticator(file)(nonce);
	assert.equal(jwtAuth.jwt, jwt);
	assert.equal(jwtAuth.nkey, key.getPublicKey());
	assert.ok(key.verify(new TextEncoder().encode(nonce), nkeys.decode(jwtAuth.sig)));
	chmodSync(file, 0o644);
	assert.throws(() => requestBus.requestAuthenticator(file), /request_nats_private_file_refused/);
	chmodSync(file, 0o600);
	const link = join(directory, "symlink.nkey");
	symlinkSync(file, link);
	assert.throws(() => requestBus.requestAuthenticator(link));
	writeFileSync(file, "invalid fixture", { mode: 0o600 });
	assert.throws(() => requestBus.requestAuthenticator(file), /request_nats_credentials_invalid/);
	writeFileSync(file, Buffer.alloc(16385), { mode: 0o600 });
	assert.throws(() => requestBus.requestAuthenticator(file), /request_nats_private_file_refused/);
	key.clear();
});

test("bus refuses production names and changed durable acknowledgment policy", () => {
	assert.throws(
		() =>
			validateBusNames({
				stream: "FACTORY_JOBS",
				consumer: "watcher-ingest",
				subject: "factory.jobs.1.result",
			}),
		/request_stream_refused/,
	);
	const stream = {
		config: { name: BUS_DEFAULTS.stream, subjects: [BUS_DEFAULTS.subject], ...STREAM_CONFIG },
	};
	const consumer = {
		config: {
			durable_name: BUS_DEFAULTS.consumer,
			filter_subject: BUS_DEFAULTS.subject,
			...CONSUMER_CONFIG,
		},
	};
	validateBusContract(stream, consumer, BUS_DEFAULTS);
	assert.throws(
		() =>
			validateBusContract(
				stream,
				{ config: { ...consumer.config, ack_policy: "none" } },
				BUS_DEFAULTS,
			),
		/request_consumer_config_ack_policy/,
	);
	assert.throws(
		() =>
			validateBusContract({ config: { ...stream.config, discard: "old" } }, consumer, BUS_DEFAULTS),
		/request_stream_config_discard/,
	);
});

test("requestAuthenticator promptly refuses an actual FIFO", () => {
	const directory = join(FIXTURE_ROOT, `fifo-${crypto.randomUUID()}`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const fifo = `${directory}/private.fifo`;
	execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
	const code = `import assert from "node:assert/strict"; import { requestAuthenticator } from ${JSON.stringify(new URL("./request-bus.mjs", import.meta.url).href)}; assert.throws(() => requestAuthenticator(${JSON.stringify(fifo)}), /request_nats_private_file_refused/);`;
	execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
		timeout: 2000,
		killSignal: "SIGKILL",
		stdio: "pipe",
	});
});
