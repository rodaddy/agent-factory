/** Real isolated PostgreSQL TLS controls; no provider or production connections. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT =
	process.env.PILOT_TLS_TEST_ROOT ??
	"/opt/_tmp/software-factory/_validation-runs/durable-request-H";
const PG = process.env.PILOT_PG_BIN_DIR ?? "/opt/homebrew/opt/postgresql@18/bin";
const OPENSSL = process.env.PILOT_OPENSSL_BIN ?? "/opt/homebrew/bin/openssl";

async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		await exited;
	} finally {
		clearTimeout(deadline);
	}
}

test("trusted IP SAN succeeds; wrong SAN and untrusted CA refuse", { timeout: 90000 }, async () => {
	assert.equal(process.versions.node.split(".")[0], "24", "tls_check_requires_node24");
	assert.ok(
		ROOT.startsWith("/opt/_tmp/") || ROOT.startsWith("/mnt/share/tmp_space/"),
		"tls_test_root_refused",
	);
	const id = randomUUID().replaceAll("-", "");
	const directory = join(ROOT, `tls-${id}`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const pgData = join(directory, "postgres");
	const run = (binary, args) =>
		execute(binary, args, { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 16384 });
	const server = createServer().listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	let child;
	let log = "";
	const receipt = {
		directory,
		node: process.version,
		modelRequests: 0,
		productionConnections: 0,
		results: {},
		childrenStopped: false,
	};
	try {
		await run(join(PG, "initdb"), [
			"-D",
			pgData,
			"-A",
			"trust",
			"-U",
			"postgres",
			"--no-locale",
			"--encoding=UTF8",
		]);
		// Self-signed fixtures are trusted explicitly only in the trusted controls.
		for (const [name, ip] of [
			["correct", "127.0.0.1"],
			["wrong", "127.0.0.2"],
		]) {
			const key = join(directory, `${name}.key`);
			await run(OPENSSL, [
				"req",
				"-new",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=isolated-pilot-postgres",
				"-addext",
				`subjectAltName=IP:${ip}`,
				"-keyout",
				key,
				"-out",
				join(directory, `${name}.crt`),
			]);
			chmodSync(key, 0o600);
		}
		const start = async (certificate) => {
			child = spawn(
				join(PG, "postgres"),
				[
					"-D",
					pgData,
					"-h",
					"127.0.0.1",
					"-p",
					String(port),
					"-c",
					"unix_socket_directories=",
					"-c",
					"ssl=on",
					"-c",
					`ssl_cert_file=${join(directory, `${certificate}.crt`)}`,
					"-c",
					`ssl_key_file=${join(directory, `${certificate}.key`)}`,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			await new Promise((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error("tls_pg_start_timeout")), 15000);
				const finish = (fn, value) => {
					clearTimeout(deadline);
					fn(value);
				};
				let current = "";
				for (const output of [child.stdout, child.stderr])
					output.on("data", (bytes) => {
						current += bytes.toString();
						log += bytes.toString();
						if (current.includes("database system is ready to accept connections")) finish(resolve);
					});
				child.once("error", (error) => finish(reject, error));
				child.once("exit", (code) => finish(reject, new Error(`tls_pg_exit_${code}`)));
			});
		};
		await start("correct");
		const database = `durable_pi_request_h_test_${id}`;
		await run(join(PG, "createdb"), [
			"-h",
			"127.0.0.1",
			"-p",
			String(port),
			"-U",
			"postgres",
			database,
		]);
		const probe = async (trusted, encrypted = true, certificate = "correct") => {
			const url = `postgres://postgres@127.0.0.1:${port}/${database}${encrypted ? "?sslmode=verify-full" : ""}`;
			const env = { ...process.env };
			delete env.NODE_EXTRA_CA_CERTS;
			delete env.NODE_TLS_REJECT_UNAUTHORIZED;
			if (trusted) env.NODE_EXTRA_CA_CERTS = join(directory, `${certificate}.crt`);
			const source = `import { openRequestSql } from ${JSON.stringify(new URL("./request-store.mjs", import.meta.url).href)}; const sql=openRequestSql(${JSON.stringify(url)}); try { const [row]=await sql\`SELECT 1 AS value\`; console.log(JSON.stringify({ok:row.value===1})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); } finally { await sql.end({timeout:2}); }`;
			const output = await execute(process.execPath, ["--input-type=module", "--eval", source], {
				env,
				timeout: 10000,
				killSignal: "SIGKILL",
				maxBuffer: 16384,
			});
			return JSON.parse(output.stdout.trim());
		};
		receipt.results.correctTrustedIP = await probe(true);
		receipt.results.untrustedCA = await probe(false);
		receipt.results.plainLoopback = await probe(false, false);
		await stop(child);
		await start("wrong");
		receipt.results.wrongTrustedSAN = await probe(true, true, "wrong");
		assert.deepEqual(receipt.results.correctTrustedIP, { ok: true }, "trusted_ip_san_must_connect");
		assert.equal(receipt.results.untrustedCA.ok, false, "untrusted_ca_must_refuse");
		assert.equal(receipt.results.untrustedCA.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
		assert.deepEqual(receipt.results.plainLoopback, { ok: true });
		assert.deepEqual(receipt.results.wrongTrustedSAN, {
			ok: false,
			code: "ERR_TLS_CERT_ALTNAME_INVALID",
		});
		receipt.passed = true;
	} finally {
		await stop(child);
		receipt.childrenStopped = !child || child.exitCode !== null || child.signalCode !== null;
		writeFileSync(join(directory, "postgres.log"), log, { mode: 0o600 });
		writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2), {
			mode: 0o600,
		});
		process.stdout.write(`${JSON.stringify({ event: "request_tls_check", ...receipt })}\n`);
	}
});
