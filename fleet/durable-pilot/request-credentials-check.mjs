/** Real file reads with controlled Linux ACL/mount boundaries; no live services or models. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { nkeys } from "nats";
import { connectRequestBus, requestAuthenticator } from "./request-bus.mjs";
import { loadRequestConfig, readPrivateFile } from "./request-config.mjs";

const root = process.env.REQUEST_CREDENTIAL_TEST_ROOT;
assert.ok(
	root?.startsWith("/opt/_tmp/") || root?.startsWith("/mnt/share/tmp_space/"),
	"credential_test_root_required",
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const uid = process.getuid();
const instance = `gpt-${randomUUID()}`;
const canonical = `/run/credentials/durable-pi-request-H@${instance}.service`;
const alias = "/etc/durable-pi-pilot/request-H-worker";

async function boundaryFixture() {
	const directory = fs.mkdtempSync(join(root, "view-"));
	for (const path of [canonical, alias]) fs.mkdirSync(`${directory}${path}`, { recursive: true });
	const key = nkeys.createUser();
	const config = {
		trancheId: "DURABLE-PI-REQUEST-H",
		natsUrl: "nats://127.0.0.1:4222",
		natsCredsFile: `${alias}/nats.seed`,
		postgresUrlFile: `${alias}/postgres.url`,
		stream: "DURABLE_PI_REQUEST_H",
		consumer: "request-H-workers",
		subject: "durable.pi.request.H.jobs",
		stateRoot: "/var/lib/durable-pi-pilot/request-H/jobs",
		repoPath: "/opt/software-factory",
	};
	const contents = {
		"config.json": JSON.stringify(config),
		"nats.seed": key.getSeed(),
		"postgres.url": "postgres://localhost/durable_pi_request_h",
		"ca.crt": "fixture certificate",
	};
	for (const [name, content] of Object.entries(contents)) {
		fs.writeFileSync(`${directory}${canonical}/${name}`, content, { mode: 0o400 });
		fs.linkSync(`${directory}${canonical}/${name}`, `${directory}${alias}/${name}`);
	}
	let condition = "valid";
	const paths = new Map();
	const directoryInode = fs.statSync(`${directory}${canonical}`).ino;
	mock.module("node:fs", {
		namedExports: {
			closeSync: fs.closeSync,
			constants: fs.constants,
			readSync: fs.readSync,
			openSync(path, flags) {
				const match = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(path);
				const translated =
					path === "/" ? directory : join(paths.get(Number(match?.[1])), match?.[2]);
				if (condition === "symlink" && translated.endsWith("/nats.seed"))
					throw new Error("symlink refused");
				const fd = fs.openSync(translated, flags);
				paths.set(fd, translated);
				return fd;
			},
			fstatSync(fd) {
				const stat = fs.fstatSync(fd);
				const path = paths.get(fd);
				const view = path === `${directory}${canonical}` || path === `${directory}${alias}`;
				const file = stat.isFile();
				const fallback = condition === "fallback";
				return Object.assign(stat, {
					uid: view || file ? (fallback ? uid : condition === "owner" ? uid + 1 : 0) : 0,
					mode:
						(stat.mode & ~0o7777) |
						(view
							? fallback
								? 0o500
								: 0o550
							: file
								? fallback
									? 0o400
									: 0o440
								: condition === "parent"
									? 0o777
									: 0o755),
					ino: view
						? directoryInode + (condition === "inode" && path.endsWith("request-H-worker") ? 1 : 0)
						: stat.ino,
				});
			},
		},
	});
	mock.module("node:child_process", {
		namedExports: {
			execFileSync(tool, _args, options) {
				if (condition === "tool") throw new Error("sensitive tool error must not escape");
				if (tool.endsWith("findmnt"))
					return JSON.stringify({
						filesystems: [{ "vfs-options": condition === "mount" ? "rw,nosuid" : "ro,nosuid" }],
					});
				const stat = fs.fstatSync(options.stdio[3]);
				const permission = stat.isDirectory() ? "r-x" : "r--";
				const entries = [`user::${permission}`, "group::---", "other::---"];
				if (condition !== "fallback")
					entries.push(`user:${uid}:${permission}`, `mask::${permission}`);
				if (condition === "principal") entries.push("user:65534:r--");
				if (condition === "write") entries[0] = "user::rw-";
				return `${entries.join("\n")}\n\n`;
			},
		},
	});
	const helper = process.env.REQUEST_CREDENTIAL_HELPER
		? pathToFileURL(process.env.REQUEST_CREDENTIAL_HELPER).href
		: new URL("./request-credentials.mjs", import.meta.url).href;
	const { createDeliveredCredentialReader } = await import(helper);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux" });
	try {
		const options = { instance, serviceUid: uid, credentialsDirectory: canonical };
		assert.throws(
			() =>
				createDeliveredCredentialReader({ ...options, credentialsDirectory: `${canonical}-wrong` }),
			/request_delivered_context_refused/,
		);
		assert.throws(
			() => createDeliveredCredentialReader({ ...options, instance: "gpt-invalid" }),
			/request_delivered_context_refused/,
		);
		assert.throws(
			() => createDeliveredCredentialReader({ ...options, serviceUid: uid + 1 }),
			/request_delivered_context_refused/,
		);
		const readCredential = createDeliveredCredentialReader(options);
		assert.equal(readCredential(`${canonical}/postgres.url`), contents["postgres.url"]);
		assert.deepEqual(
			loadRequestConfig(`${alias}/config.json`, { worker: true, readCredential }),
			config,
		);
		assert.equal(
			requestAuthenticator(`${alias}/nats.seed`, readCredential)().nkey,
			key.getPublicKey(),
		);
		for (const bad of [
			"mount",
			"inode",
			"principal",
			"write",
			"owner",
			"parent",
			"symlink",
			"tool",
		]) {
			condition = bad;
			assert.throws(
				() => readCredential(`${alias}/nats.seed`),
				/^Error: request_delivered_credential_refused$/,
				bad,
			);
		}
		condition = "fallback";
		assert.equal(readCredential(`${alias}/ca.crt`), contents["ca.crt"]);
		condition = "valid";
		for (const path of [
			`${alias}/other`,
			`${canonical}-other/nats.seed`,
			`${alias}/../request-H-worker/nats.seed`,
		])
			assert.throws(() => readCredential(path), /request_delivered_credential_refused/);
		assert.throws(
			() => readCredential(`${alias}/config.json`, 1),
			/request_delivered_credential_refused/,
		);
		const certificate = `${directory}${canonical}/ca.crt`;
		fs.chmodSync(certificate, 0o600);
		fs.writeFileSync(certificate, Buffer.alloc(16385));
		fs.chmodSync(certificate, 0o400);
		assert.throws(() => readCredential(`${alias}/ca.crt`), /request_delivered_credential_refused/);
		fs.chmodSync(certificate, 0o600);
		fs.writeFileSync(certificate, Buffer.from([0xff]));
		fs.chmodSync(certificate, 0o400);
		assert.throws(() => readCredential(`${alias}/ca.crt`), /request_delivered_credential_refused/);
		fs.renameSync(certificate, `${certificate}.archived`);
		fs.symlinkSync(`${certificate}.archived`, certificate);
		assert.throws(
			() => readCredential(`${canonical}/ca.crt`),
			/request_delivered_credential_refused/,
		);
		fs.renameSync(certificate, `${certificate}.symlink-archived`);
		execFileSync("/usr/bin/mkfifo", ["-m", "600", certificate]);
		assert.throws(
			() => readCredential(`${canonical}/ca.crt`),
			/request_delivered_credential_refused/,
		);
		await assert.rejects(
			connectRequestBus(config, {
				readCredential: () => {
					throw new Error("controlled_no_socket");
				},
			}),
			/controlled_no_socket/,
		);
	} finally {
		Object.defineProperty(process, "platform", platform);
		key.clear();
	}
}

if (process.argv.includes("--boundary-fixture")) await boundaryFixture();
else {
	test("delivered reader accepts sealed ACL/fallback views and refuses unsafe Linux metadata", () => {
		execFileSync(
			process.execPath,
			["--experimental-test-module-mocks", new URL(import.meta.url).pathname, "--boundary-fixture"],
			{ timeout: 10000, stdio: "pipe" },
		);
	});
	test("default strict readers still reject ordinary 0440, symlinks, FIFO and foreign owner", () => {
		const directory = fs.mkdtempSync(join(root, "strict-"));
		const path = join(directory, "private");
		fs.writeFileSync(path, "fixture", { mode: 0o440 });
		for (const read of [readPrivateFile, requestAuthenticator])
			assert.throws(() => read(path), /private_file_refused/);
		fs.chmodSync(path, 0o400);
		const link = join(directory, "link");
		fs.symlinkSync(path, link);
		for (const read of [readPrivateFile, requestAuthenticator]) assert.throws(() => read(link));
		const fifo = join(directory, "fifo");
		execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
		for (const read of [readPrivateFile, requestAuthenticator])
			assert.throws(() => read(fifo), /private_file_refused/);
		const uidMock = mock.method(process, "getuid", () => uid + 1);
		try {
			for (const read of [readPrivateFile, requestAuthenticator])
				assert.throws(() => read(path), /private_file_refused/);
		} finally {
			uidMock.mock.restore();
		}
	});
}
