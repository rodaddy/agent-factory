/** JetStream is a notification rail; Postgres alone authorizes execution. */
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { connect, credsAuthenticator, nkeyAuthenticator } from "nats";
import { TERMINAL } from "./request-store.mjs";
export const BUS_DEFAULTS = {
	stream: "DURABLE_PI_REQUEST_H",
	consumer: "request-H-workers",
	subject: "durable.pi.request.H.jobs",
};
export const STREAM_CONFIG = {
	retention: "limits",
	storage: "file",
	discard: "new",
	max_msgs: 256,
	max_bytes: 1048576,
	max_age: 0,
	duplicate_window: 120000000000,
};
export const CONSUMER_CONFIG = {
	ack_policy: "explicit",
	deliver_policy: "all",
	ack_wait: 120000000000,
	max_deliver: -1,
	max_ack_pending: 3,
};
/** Static user NKey seeds and JWT .creds use the client's maintained authenticators. */
export function requestAuthenticator(path, readCredential) {
	assert.ok(
		typeof path === "string" && isAbsolute(path) && normalize(path) === path,
		"request_nats_private_path_refused",
	);
	let content;
	if (readCredential) content = readCredential(path, 16384).trim();
	else {
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			assert.ok(
				stat.isFile() &&
					stat.size > 0 &&
					stat.size <= 16384 &&
					(stat.mode & 0o077) === 0 &&
					[0, process.getuid()].includes(stat.uid),
				"request_nats_private_file_refused",
			);
			const bytes = Buffer.alloc(16385);
			const length = readSync(fd, bytes, 0, bytes.length, 0);
			assert.ok(length > 0 && length <= 16384, "request_nats_private_file_refused");
			content = bytes.subarray(0, length).toString("utf8").trim();
		} finally {
			closeSync(fd);
		}
	}
	try {
		const bytes = new TextEncoder().encode(content);
		const authenticator = /^SU[A-Z2-7]{56}$/.test(content)
			? nkeyAuthenticator(bytes)
			: credsAuthenticator(new TextEncoder().encode(`${content}\n`));
		// Validate decoding before opening a socket; never include credential content in errors.
		const auth = authenticator("request-H-auth-validation");
		assert.ok(/^U[A-Z2-7]{55}$/.test(auth.nkey), "request_nats_user_key_refused");
		return authenticator;
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify({ event: "request_nats_credentials_invalid", errorClass: error?.constructor?.name ?? "Error" })}\n`,
		);
		throw new Error("request_nats_credentials_invalid");
	}
}
export function validateBusNames({ stream, consumer, subject }) {
	assert.match(stream, /^DURABLE_PI_REQUEST_H(?:_TEST_[A-Z0-9_]+)?$/, "request_stream_refused");
	assert.match(consumer, /^request-H-workers(?:-test-[a-z0-9-]+)?$/, "request_consumer_refused");
	assert.match(
		subject,
		/^durable\.pi\.request\.H\.jobs(?:\.test\.[a-z0-9_]+)?$/,
		"request_subject_refused",
	);
}
export function validateBusContract(streamInfo, consumerInfo, names) {
	validateBusNames(names);
	assert.deepEqual(streamInfo.config.subjects, [names.subject], "request_stream_subject_mismatch");
	for (const [key, expected] of Object.entries(STREAM_CONFIG))
		assert.equal(streamInfo.config[key], expected, `request_stream_config_${key}`);
	assert.equal(streamInfo.config.name, names.stream, "request_stream_name_mismatch");
	assert.equal(consumerInfo.config.durable_name, names.consumer, "request_consumer_name_mismatch");
	assert.equal(
		consumerInfo.config.filter_subject,
		names.subject,
		"request_consumer_subject_mismatch",
	);
	for (const [key, expected] of Object.entries(CONSUMER_CONFIG))
		assert.equal(consumerInfo.config[key], expected, `request_consumer_config_${key}`);
}
function decodeNotification(message, subject) {
	try {
		assert.ok(
			message.subject === subject && message.data.length <= 100,
			"request_notification_refused",
		);
		const parsed = JSON.parse(new TextDecoder().decode(message.data));
		assert.deepEqual(Object.keys(parsed), ["jobId"], "request_notification_shape");
		assert.match(
			parsed.jobId,
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
			"request_notification_id",
		);
		return parsed.jobId;
	} catch (error) {
		message.term();
		throw error;
	}
}
export async function createRequestBus({ connection, ...given }) {
	const names = { ...BUS_DEFAULTS, ...given };
	validateBusNames(names);
	const manager = await connection.jetstreamManager({ checkAPI: false });
	validateBusContract(
		await manager.streams.info(names.stream),
		await manager.consumers.info(names.stream, names.consumer),
		names,
	);
	const js = connection.jetstream();
	const consumer = await js.consumers.get(names.stream, names.consumer);
	return {
		async publishOutbox(store) {
			let published = 0;
			for (const row of await store.pendingOutbox({ limit: 6 })) {
				await js.publish(
					names.subject,
					new TextEncoder().encode(JSON.stringify({ jobId: row.jobId })),
					{ msgID: row.id, timeout: 3000 },
				);
				if (await store.markPublished(row.id)) published++;
			}
			return { published, pending: (await store.pendingOutbox({ limit: 100 })).length };
		},
		async next({ expiresMs = 1000 } = {}) {
			assert.ok(
				Number.isInteger(expiresMs) && expiresMs >= 1000 && expiresMs <= 10000,
				"request_pull_bound",
			);
			const messages = await consumer.fetch({ max_messages: 1, expires: expiresMs });
			try {
				for await (const message of messages) {
					return { jobId: decodeNotification(message, names.subject), message };
				}
				return null;
			} finally {
				messages.stop();
			}
		},
		async handleAck(message, store) {
			const row = await store.status(decodeNotification(message, names.subject));
			if (!row) {
				// H uses one fixed tranche; an absent row cannot authorize execution.
				message.term();
				return false;
			}
			if (!TERMINAL.has(row.status)) {
				// Give an active lease time to finish, without using the message as authorization.
				const remaining = row?.leaseExpiresAt
					? new Date(row.leaseExpiresAt).getTime() - Date.now()
					: 1000;
				message.nak(Math.min(120000, Math.max(1000, remaining)));
				return false;
			}
			return message.ackAck({ timeout: 3000 });
		},
		async close() {
			await connection.close();
		},
	};
}
export async function connectRequestBus(config, { readCredential } = {}) {
	const names = { ...BUS_DEFAULTS, ...config };
	validateBusNames(names);
	const url = new URL(config.natsUrl);
	assert.ok(
		["nats:", "tls:"].includes(url.protocol) && !url.username && !url.password,
		"request_nats_url_refused",
	);
	assert.ok(typeof config.natsCredsFile === "string", "request_nats_creds_refused");
	const authenticator = requestAuthenticator(config.natsCredsFile, readCredential);
	const connection = await connect({
		servers: config.natsUrl,
		authenticator,
		inboxPrefix: `_INBOX.${authenticator().nkey}`,
		timeout: 3000,
		reconnect: false,
	});
	try {
		return await createRequestBus({
			connection,
			stream: names.stream,
			consumer: names.consumer,
			subject: names.subject,
		});
	} catch (error) {
		await connection.close();
		throw error;
	}
}
