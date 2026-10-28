/** Real PG/JetStream boundaries; one foreground supervisor, no provider requests. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { connect, nkeyAuthenticator, nkeys } from "nats";
import {
	CONSUMER_CONFIG,
	connectRequestBus,
	createRequestBus,
	STREAM_CONFIG,
} from "./request-bus.mjs";
import { createStore, initializeStore, openRequestSql } from "./request-store.mjs";

const execute = promisify(execFile);
const ROOT = "/opt/_tmp/software-factory/_validation-runs/durable-request-H";
const PG = "/opt/homebrew/opt/postgresql@18/bin";
const NATS = "/opt/homebrew/bin/nats-server";
const children = new Set();

async function freePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}
function service(binary, args, logPath, marker) {
	const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
	children.add(child);
	let log = "";
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("integration_service_start_timeout")), 15000);
		const finish = (callback, value) => {
			clearTimeout(timer);
			callback(value);
		};
		for (const output of [child.stdout, child.stderr])
			output.on("data", (bytes) => {
				log += bytes.toString();
				writeFileSync(logPath, log, { mode: 0o600 });
				if (log.includes(marker)) finish(resolve, child);
			});
		child.once("error", (error) => finish(reject, error));
		child.once("exit", (code) => finish(reject, new Error(`integration_service_exit_${code}`)));
	});
	return ready;
}
async function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		await exited;
	} finally {
		clearTimeout(timer);
	}
}

test("real isolated PG and JetStream preserve request admission, fencing and ACK", {
	timeout: 420000,
}, async () => {
	const id = randomUUID().replaceAll("-", "");
	const directory = join(ROOT, `integration-${id}`);
	mkdirSync(directory, { mode: 0o700 });
	const pgData = join(directory, "postgres");
	const assertions = [];
	const receipt = {
		directory,
		node: process.version,
		postgres: "18.6",
		nats: "2.15.0",
		assertions,
		productionConnections: 0,
		modelRequests: 0,
	};
	const deadline = setTimeout(() => {
		for (const child of children) child.kill("SIGKILL");
	}, 410000);
	let sql;
	let connection;
	let authenticatedBus;
	try {
		const init = await execute(
			join(PG, "initdb"),
			["-D", pgData, "-U", "pilot_test", "--auth=trust", "--no-locale", "--encoding=UTF8"],
			{ timeout: 20000 },
		);
		writeFileSync(join(directory, "initdb.log"), init.stdout + init.stderr, { mode: 0o600 });
		const pgPort = await freePort();
		// TCP only avoids macOS's 103-byte Unix socket pathname limit in deep temp roots.
		await service(
			join(PG, "postgres"),
			["-D", pgData, "-h", "127.0.0.1", "-p", String(pgPort), "-k", ""],
			join(directory, "postgres.log"),
			"ready to accept connections",
		);
		const database = `durable_pi_request_h_test_${id}`;
		await execute(
			join(PG, "createdb"),
			["-h", "127.0.0.1", "-p", String(pgPort), "-U", "pilot_test", database],
			{ timeout: 10000 },
		);
		sql = openRequestSql(`postgres://pilot_test@127.0.0.1:${pgPort}/${database}`);
		const natsPort = await freePort();
		const registeredKey = nkeys.createUser();
		const adminKey = nkeys.createUser();
		const registeredSeedFile = join(directory, "registered-test-user.nkey");
		writeFileSync(registeredSeedFile, registeredKey.getSeed(), { mode: 0o600 });
		const natsConfig = join(directory, "nats.conf");
		writeFileSync(
			natsConfig,
			JSON.stringify({
				authorization: {
					users: [
						{ nkey: adminKey.getPublicKey() },
						{
							nkey: registeredKey.getPublicKey(),
							permissions: {
								publish: { allow: [">"] },
								subscribe: { allow: [`_INBOX.${registeredKey.getPublicKey()}.>`] },
							},
						},
					],
				},
			}),
			{ mode: 0o600 },
		);
		await service(
			NATS,
			[
				"-a",
				"127.0.0.1",
				"-p",
				String(natsPort),
				"-c",
				natsConfig,
				"-js",
				"-sd",
				join(directory, "jetstream"),
			],
			join(directory, "nats.log"),
			"Server is ready",
		);
		connection = await connect({
			servers: `nats://127.0.0.1:${natsPort}`,
			authenticator: nkeyAuthenticator(adminKey.getSeed()),
			reconnect: false,
			timeout: 3000,
		});
		adminKey.clear();
		const names = {
			stream: `DURABLE_PI_REQUEST_H_TEST_${id.toUpperCase()}`,
			consumer: `request-H-workers-test-${id}`,
			subject: `durable.pi.request.H.jobs.test.${id}`,
		};
		const manager = await connection.jetstreamManager();
		const authNames = {
			stream: `${names.stream}_INBOX`,
			consumer: `${names.consumer}-inbox`,
			subject: `${names.subject}_inbox`,
		};
		for (const scoped of [names, authNames]) {
			await manager.streams.add({
				name: scoped.stream,
				subjects: [scoped.subject],
				...STREAM_CONFIG,
			});
			await manager.consumers.add(scoped.stream, {
				durable_name: scoped.consumer,
				filter_subject: scoped.subject,
				...CONSUMER_CONFIG,
			});
		}
		authenticatedBus = await connectRequestBus({
			...authNames,
			natsUrl: `nats://127.0.0.1:${natsPort}`,
			natsCredsFile: registeredSeedFile,
		});
		registeredKey.clear();
		const unregisteredKey = nkeys.createUser();
		const unregisteredSeedFile = join(directory, "unregistered-test-user.nkey");
		writeFileSync(unregisteredSeedFile, unregisteredKey.getSeed(), { mode: 0o600 });
		unregisteredKey.clear();
		await assert.rejects(
			connectRequestBus({
				...names,
				natsUrl: `nats://127.0.0.1:${natsPort}`,
				natsCredsFile: unregisteredSeedFile,
			}),
			/Authorization Violation/i,
		);
		receipt.authentication = {
			registeredStaticNKeyAccepted: true,
			unregisteredStaticNKeyRefused: true,
		};
		assertions.push(
			"official bus authenticator connects registered static user seed and rejects unregistered seed on real NATS",
		);
		const bus = await createRequestBus({ connection, ...names });
		receipt.ports = { postgres: pgPort, nats: natsPort };
		let serial = 0;
		async function store(maxRequests = 6, factory = createStore) {
			const trancheId = `TEST-${id}-${serial++}`;
			await initializeStore(sql, { trancheId, maxRequests });
			return factory({ sql, trancheId });
		}
		const input = (key, family = "claude", targetHost = null) => ({
			requestKey: key,
			packet: { safe: "fixture" },
			packetHash: "a".repeat(64),
			family,
			targetHost,
		});
		const output = { result: { summary: "fixture", findings: [] }, resultHash: "b".repeat(64) };
		const authStore = await store();
		const authJob = (await authStore.submit(input("own-inbox"))).job;
		await authenticatedBus.publishOutbox(authStore);
		const authDelivery = await authenticatedBus.next();
		assert.equal(authDelivery.jobId, authJob.id);
		const authClaim = await authStore.claim(authJob.id, "inbox-fixture", "107");
		assert.equal(
			await authStore.fail(authJob.id, authClaim.claimToken, { reason: "fixture_without_model" }),
			true,
		);
		assert.equal(await authenticatedBus.handleAck(authDelivery.message, authStore), true);
		await authenticatedBus.close();
		receipt.authentication.ownInboxOnlyApiPullAndAck = true;
		assertions.push(
			"connectRequestBus derives the authenticated user's inbox prefix and completes API, publish, pull and ACK under own-inbox-only subscription ACL",
		);
		// Poison messages must release pending capacity without granting execution authority.
		for (const kind of ["invalid-json", "invalid-uuid", "ack-invalid-uuid", "missing-row"]) {
			const suffix = kind.replaceAll("-", "_");
			const isolated = {
				stream: `${names.stream}_${suffix.toUpperCase()}`,
				consumer: `${names.consumer}-${kind}`,
				subject: `${names.subject}_${suffix}`,
			};
			await manager.streams.add({
				name: isolated.stream,
				subjects: [isolated.subject],
				...STREAM_CONFIG,
			});
			await manager.consumers.add(isolated.stream, {
				durable_name: isolated.consumer,
				filter_subject: isolated.subject,
				...CONSUMER_CONFIG,
			});
			const isolatedBus = await createRequestBus({ connection, ...isolated });
			const scoped = await store();
			const legitimate = (await scoped.submit(input(`legitimate-${kind}`))).job;
			for (let poison = 0; poison < 3; poison++) {
				const payload =
					kind === "invalid-json"
						? "not-json"
						: JSON.stringify({
								jobId: kind === "missing-row" ? randomUUID() : "-".repeat(36),
							});
				await connection.jetstream().publish(isolated.subject, payload);
			}
			await isolatedBus.publishOutbox(scoped);
			for (let poison = 0; poison < 3; poison++) {
				if (kind === "missing-row") {
					const delivery = await isolatedBus.next();
					assert.equal(await isolatedBus.handleAck(delivery.message, scoped), false);
				} else if (kind === "ack-invalid-uuid") {
					const rawConsumer = await connection
						.jetstream()
						.consumers.get(isolated.stream, isolated.consumer);
					const message = await rawConsumer.next({ expires: 1000 });
					await assert.rejects(isolatedBus.handleAck(message, scoped), /request_notification_id/);
				} else {
					await assert.rejects(isolatedBus.next());
				}
			}
			await connection.flush();
			const pending = (await manager.consumers.info(isolated.stream, isolated.consumer))
				.num_ack_pending;
			receipt.poisonRecovery ??= {};
			receipt.poisonRecovery[kind] = { pendingAfterThree: pending };
			assert.equal(pending, 0, `request_poison_pending_${kind}`);
			const fourth = await isolatedBus.next();
			assert.equal(fourth.jobId, legitimate.id, `request_poison_fourth_starved_${kind}`);
			assert.equal((await scoped.status(legitimate.id)).status, "queued");
			const [budget] =
				await sql`SELECT admissions,attempts FROM durable_pi_request.tranches WHERE id=${legitimate.trancheId}`;
			assert.deepEqual([budget.admissions, budget.attempts], [1, 0]);
			receipt.poisonRecovery[kind].legitimateFourthDelivered = true;
			receipt.poisonRecovery[kind].attempts = budget.attempts;
			const claim = await scoped.claim(legitimate.id, "poison-fixture", "107");
			assert.equal(
				await scoped.fail(legitimate.id, claim.claimToken, { reason: "fixture_without_model" }),
				true,
			);
			assert.equal(await isolatedBus.handleAck(fourth.message, scoped), true);
		}
		assertions.push(
			"malformed next/ACK and missing rows TERM, free three pending slots, deliver legitimate fourth, and consume no model budget",
		);
		async function admissionCase(factory = createStore) {
			const scoped = await store(2, factory);
			const first = await scoped.submit(input("one"));
			assert.equal((await scoped.submit(input("one"))).created, false);
			await assert.rejects(
				scoped.submit({ ...input("one"), packet: { safe: "changed" } }),
				/request_replay_conflict/,
			);
			await scoped.submit(input("two"));
			await assert.rejects(scoped.submit(input("three")), /request_admission_limit/);
			assert.equal((await scoped.pendingOutbox()).length, 2);
			assert.equal((await scoped.status(first.job.id)).status, "queued");
		}
		await admissionCase();
		assertions.push("idempotent replay, conflicting replay, admission cap and no extra outbox");
		const concurrent = await store();
		const sameKey = await Promise.all(
			Array.from({ length: 8 }, () => concurrent.submit(input("shared"))),
		);
		assert.equal(sameKey.filter((entry) => entry.created).length, 1);
		const jobId = sameKey[0].job.id;
		const claims = await Promise.all(
			["a", "b", "c"].map((worker) => concurrent.claim(jobId, worker, "107")),
		);
		assert.equal(claims.filter(Boolean).length, 1);
		const winner = claims.find(Boolean);
		assert.equal(await concurrent.complete(jobId, winner.claimToken, output), false);
		const reserved = await concurrent.reserveAttempt(jobId, winner.claimToken);
		assert.ok(reserved);
		assert.equal(await concurrent.reserveAttempt(jobId, winner.claimToken), null);
		assert.equal(await concurrent.complete(jobId, randomUUID(), output), false);
		assert.equal(await concurrent.complete(jobId, winner.claimToken, output), true);
		assert.equal(
			await concurrent.complete(jobId, winner.claimToken, { ...output, result: { changed: true } }),
			false,
		);
		assert.deepEqual((await concurrent.status(jobId)).result, output.result);
		assertions.push(
			"concurrent same-key admission and claim have one winner; reservation and result immutable and fenced",
		);
		const leases = await store();
		const before = (await leases.submit(input("before"))).job;
		const oldClaim = await leases.claim(before.id, "old", "109", { leaseMs: 20 });
		await sql`SELECT pg_sleep(0.05)`;
		assert.deepEqual((await leases.expire()).requeued, [before.id]);
		const replacement = await leases.claim(before.id, "new", "109");
		assert.ok(replacement);
		assert.equal(replacement.job.claimEpoch, 2);
		assert.notEqual(oldClaim.claimToken, replacement.claimToken);
		assert.equal(await leases.reserveAttempt(before.id, oldClaim.claimToken), null);
		assert.equal(await leases.fail(before.id, oldClaim.claimToken, { reason: "stale" }), false);
		assert.equal((await leases.pendingOutbox()).length, 2);
		const after = (await leases.submit(input("after"))).job;
		const expiring = await leases.claim(after.id, "uncertain", "113", { leaseMs: 30 });
		await leases.reserveAttempt(after.id, expiring.claimToken);
		await sql`SELECT pg_sleep(0.06)`;
		assert.equal(await leases.complete(after.id, expiring.claimToken, output), false);
		assert.deepEqual((await leases.expire()).uncertain, [after.id]);
		assert.equal((await leases.status(after.id)).status, "uncertain");
		assert.equal(await leases.claim(after.id, "retry", "113"), null);
		assert.equal((await leases.pendingOutbox()).length, 3);
		assertions.push(
			"expired unreserved claim requeues with new fence; reserved expiry is terminal uncertain without retry",
		);
		const slots = await store();
		for (const family of ["claude", "gpt"])
			for (const host of ["107", "109", "113"]) {
				const row = (await slots.submit(input(`${family}-${host}`, family, host))).job;
				assert.equal(await slots.claim(row.id, "wrong-host", host === "107" ? "109" : "107"), null);
				const claim = await slots.claim(row.id, "slot", host);
				assert.ok(await slots.reserveAttempt(row.id, claim.claimToken));
			}
		await assert.rejects(slots.submit(input("seventh")), /request_admission_limit/);
		const duplicateSlot = await store();
		const slotRows = await Promise.all(
			["same-slot-a", "same-slot-b"].map((key) =>
				duplicateSlot.submit(input(key, "claude", "107")),
			),
		);
		const slotClaims = await Promise.all(
			slotRows.map((row, index) => duplicateSlot.claim(row.job.id, `slot-${index}`, "107")),
		);
		const attempts = await Promise.allSettled(
			slotClaims.map((claim) => duplicateSlot.reserveAttempt(claim.job.id, claim.claimToken)),
		);
		assert.equal(
			attempts.filter((attempt) => attempt.status === "fulfilled" && attempt.value).length,
			1,
		);
		const rejected = attempts.find((attempt) => attempt.status === "rejected");
		assert.match(rejected.reason.message, /request_host_family_limit/);
		assertions.push(
			"six host-family slots; concurrent duplicate slot has one reservation; wrong-host claim and seventh admission refuse",
		);
		const busStore = await store();
		const queued = (await busStore.submit(input("wire"))).job;
		// A lost DB publication acknowledgement leaves the same outbox UUID pending.
		await assert.rejects(
			bus.publishOutbox({
				...busStore,
				markPublished: async () => {
					throw new Error("injected_mark_loss");
				},
			}),
			/injected_mark_loss/,
		);
		assert.equal((await busStore.pendingOutbox()).length, 1);
		assert.deepEqual(await bus.publishOutbox(busStore), { published: 1, pending: 0 });
		assert.equal((await manager.streams.info(names.stream)).state.messages, 1);
		const delivery = await bus.next();
		assert.equal(delivery.jobId, queued.id);
		assert.equal(await bus.handleAck(delivery.message, busStore), false);
		assert.equal((await manager.consumers.info(names.stream, names.consumer)).num_ack_pending, 1);
		const wireClaim = await busStore.claim(queued.id, "wire", "107");
		assert.ok(await busStore.reserveAttempt(queued.id, wireClaim.claimToken));
		assert.equal(await busStore.complete(queued.id, wireClaim.claimToken, output), true);
		const redelivery = await bus.next({ expiresMs: 3000 });
		assert.equal(redelivery.jobId, queued.id);
		assert.equal(await bus.handleAck(redelivery.message, busStore), true);
		assert.equal((await manager.consumers.info(names.stream, names.consumer)).num_ack_pending, 0);
		await connection.jetstream().publish(names.subject, JSON.stringify({ jobId: queued.id }));
		const duplicate = await bus.next();
		assert.equal(await busStore.claim(duplicate.jobId, "duplicate", "107"), null);
		assert.equal(await bus.handleAck(duplicate.message, busStore), true);
		assertions.push(
			"real publish dedup after DB acknowledgement loss; queued ACK refuses; terminal and duplicate delivery ACK without execution",
		);
		const routing = await store();
		const routed = (await routing.submit(input("routing", "gpt", "113"))).job;
		await bus.publishOutbox(routing);
		for (let attempt = 0; attempt < 6; attempt++) {
			const wrongHost = await bus.next();
			assert.equal(wrongHost.jobId, routed.id);
			assert.equal(await routing.claim(routed.id, `wrong-${attempt}`, "107"), null);
			// Immediate NAK controls transport timing; no worker execution or sleeps.
			wrongHost.message.nak();
			await connection.flush();
		}
		const correctHost = await bus.next();
		receipt.routing = {
			nonterminalDeliveries: 6,
			seventhDelivered: Boolean(correctHost),
			status: (await routing.status(routed.id)).status,
		};
		assert.ok(correctHost, "request_seventh_delivery_starved");
		assert.equal(correctHost.jobId, routed.id);
		const rightful = await routing.claim(routed.id, "rightful", "113");
		assert.ok(rightful);
		assert.equal(rightful.job.attemptId, null);
		assert.equal(
			await routing.fail(routed.id, rightful.claimToken, { reason: "fixture_without_model" }),
			true,
		);
		assert.equal(await bus.handleAck(correctHost.message, routing), true);
		assertions.push(
			"six wrong-host deliveries consume no model attempt; rightful seventh delivery remains available and terminal ACK succeeds",
		);
		const refused = await store();
		await refused.submit(input("publish-refused"));
		await manager.streams.update(names.stream, { sealed: true });
		await assert.rejects(bus.publishOutbox(refused));
		assert.equal((await refused.pendingOutbox()).length, 1);
		assertions.push("real JetStream publication refusal leaves Postgres outbox pending");
		// Mutation stays in an owned temp module; repository source is never edited.
		const mutated = join(directory, "mutation");
		mkdirSync(mutated, { mode: 0o700 });
		const source = readFileSync(new URL("./request-store.mjs", import.meta.url), "utf8");
		const guard =
			/assert\.ok\(\s*budget\.admissions < budget\.max_requests,\s*"request_admission_limit",?\s*\);/;
		assert.ok(guard.test(source), "integration_mutation_target_missing");
		writeFileSync(
			join(mutated, "request-store.mjs"),
			source.replace(guard, 'assert.ok(true, "request_admission_limit");'),
		);
		copyFileSync(
			new URL("./request-schema.sql", import.meta.url),
			join(mutated, "request-schema.sql"),
		);
		symlinkSync(
			fileURLToPath(new URL("./node_modules", import.meta.url)),
			join(mutated, "node_modules"),
		);
		const altered = await import(pathToFileURL(join(mutated, "request-store.mjs")).href);
		await assert.rejects(admissionCase(altered.createStore), (error) => {
			receipt.mutation = {
				guard: "tranche admission cap removed",
				outcome: "RED",
				name: error.name,
				code: error.code,
				message: error.message,
				stack: error.stack,
				restoredSourceCheck: "GREEN",
			};
			return /Missing expected rejection/.test(error.message);
		});
		await admissionCase();
		assertions.push(
			"admission-cap assertion fails RED with removed guard in temp source and passes GREEN unchanged",
		);
		receipt.status = "passed";
	} catch (error) {
		receipt.status = "failed";
		receipt.failure = {
			name: error.name,
			message: error.message.slice(0, 500),
			stack: error.stack?.slice(0, 2500),
		};
		throw error;
	} finally {
		// Teardown services even if a client's close operation rejects.
		const closing = await Promise.allSettled([
			authenticatedBus ? authenticatedBus.close() : Promise.resolve(),
			connection ? connection.close() : Promise.resolve(),
			sql ? sql.end({ timeout: 5 }) : Promise.resolve(),
		]);
		await Promise.all([...children].map(stop));
		clearTimeout(deadline);
		receipt.childrenStopped = [...children].every(
			(child) => child.exitCode !== null || child.signalCode !== null,
		);
		writeFileSync(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
			mode: 0o600,
		});
		process.stdout.write(
			`${JSON.stringify({ event: "request_integration_receipt", ...receipt })}\n`,
		);
		assert.equal(
			closing.filter((result) => result.status === "rejected").length,
			0,
			"integration_client_teardown_failed",
		);
		assert.equal(receipt.childrenStopped, true, "integration_child_teardown_failed");
	}
});
