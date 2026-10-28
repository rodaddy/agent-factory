/** Private H runtime references; never print or forward credentials to a model. */
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const KEYS = [
	"trancheId",
	"natsUrl",
	"natsCredsFile",
	"postgresUrlFile",
	"stream",
	"consumer",
	"subject",
	"stateRoot",
	"repoPath",
];

/** Bound private regular files and refuse symlinks or other-user ownership. */
export function readPrivateFile(path, maxBytes = 16384) {
	assert.ok(
		typeof path === "string" && isAbsolute(path) && normalize(path) === path,
		"request_private_path_refused",
	);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		assert.ok(
			stat.isFile() &&
				stat.size > 0 &&
				stat.size <= maxBytes &&
				(stat.mode & 0o077) === 0 &&
				[0, process.getuid()].includes(stat.uid),
			"request_private_file_refused",
		);
		const content = readFileSync(fd, "utf8");
		assert.ok(Buffer.byteLength(content) <= maxBytes, "request_private_file_size");
		return content;
	} finally {
		closeSync(fd);
	}
}
/** A closed H namespace and file references only; no environment inheritance. */
export function loadRequestConfig(path, { worker = false, readCredential = readPrivateFile } = {}) {
	const config = JSON.parse(readCredential(path));
	assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort(), "request_config_shape");
	assert.ok(
		/^DURABLE-PI-REQUEST-[A-Za-z0-9_-]*H(?:-[A-Za-z0-9_-]+)?$/.test(config.trancheId),
		"request_tranche_refused",
	);
	assert.ok(
		/^DURABLE_PI_REQUEST_H(?:_TEST_[A-Z0-9_]+)?$/.test(config.stream),
		"request_stream_refused",
	);
	assert.ok(
		/^request-H-workers(?:-test-[a-z0-9-]+)?$/.test(config.consumer),
		"request_consumer_refused",
	);
	assert.ok(
		/^durable\.pi\.request\.H\.jobs(?:\.test\.[a-z0-9_]+)?$/.test(config.subject),
		"request_subject_refused",
	);
	const nats = new URL(config.natsUrl);
	assert.ok(
		["nats:", "tls:"].includes(nats.protocol) &&
			!nats.username &&
			!nats.password &&
			!nats.search &&
			!nats.hash &&
			["", "/"].includes(nats.pathname),
		"request_nats_url_refused",
	);
	for (const key of ["natsCredsFile", "postgresUrlFile", "repoPath", "stateRoot"])
		assert.ok(
			typeof config[key] === "string" &&
				isAbsolute(config[key]) &&
				normalize(config[key]) === config[key],
			"request_config_path_refused",
		);
	assert.ok(
		config.stateRoot.startsWith(worker ? "/var/lib/durable-pi-pilot/request-H/" : "/opt/_tmp/"),
		"request_state_root_refused",
	);
	readCredential(config.natsCredsFile);
	const database = new URL(readCredential(config.postgresUrlFile).trim());
	assert.ok(
		["postgres:", "postgresql:"].includes(database.protocol) &&
			/^\/durable_pi_request_h(?:_test_[a-z0-9_]+)?$/.test(database.pathname),
		"request_database_refused",
	);
	return Object.freeze(config);
}
