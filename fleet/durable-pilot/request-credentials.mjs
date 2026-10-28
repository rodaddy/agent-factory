/** Read only the sealed, per-instance systemd H credential view. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname } from "node:path";

const INSTANCE = /^(?:claude|gpt)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAMES = new Set(["config.json", "nats.seed", "postgres.url", "ca.crt"]);
const ALIAS = "/etc/durable-pi-pilot/request-H-worker";
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function inspect(tool, args, fd) {
	return execFileSync(`/usr/bin/${tool}`, args, {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 8192,
		stdio: ["ignore", "pipe", "pipe", fd],
		env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
	});
}

function sameFile(a, b) {
	assert.ok(a.dev === b.dev && a.ino === b.ino, "credential_identity");
}

function privateView(fd, serviceUid, directory) {
	const stat = fstatSync(fd);
	assert.ok(directory ? stat.isDirectory() : stat.isFile(), "credential_type");
	const permission = directory ? "r-x" : "r--";
	const rootOwned = stat.uid === 0;
	assert.ok(rootOwned || stat.uid === serviceUid, "credential_owner");
	const mode = directory ? (rootOwned ? 0o550 : 0o500) : rootOwned ? 0o440 : 0o400;
	assert.equal(stat.mode & 0o7777, mode, "credential_mode");
	const acl = inspect(
		"getfacl",
		["--numeric", "--omit-header", "--absolute-names", "/proc/self/fd/3"],
		fd,
	)
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.sort();
	const expected = [`user::${permission}`, "group::---", "other::---"];
	if (rootOwned) expected.push(`user:${serviceUid}:${permission}`, `mask::${permission}`);
	assert.deepEqual(acl, expected.sort(), "credential_acl");
	const mounts = JSON.parse(
		inspect("findmnt", ["--json", "--target", "/proc/self/fd/3", "--output", "VFS-OPTIONS"], fd),
	);
	assert.equal(mounts.filesystems?.length, 1, "credential_mount");
	const options = mounts.filesystems[0]["vfs-options"]?.split(",");
	assert.ok(options?.includes("ro") && !options.includes("rw"), "credential_mount");
	return stat;
}

/** Open each parent through its held directory FD; symlink replacement cannot redirect a read. */
function directoryFd(path, fds) {
	let fd = openSync("/", FLAGS | constants.O_DIRECTORY);
	fds.push(fd);
	for (const part of path.slice(1).split("/")) {
		const parent = fstatSync(fd);
		assert.ok(
			parent.isDirectory() && parent.uid === 0 && (parent.mode & 0o022) === 0,
			"credential_parent",
		);
		fd = openSync(`/proc/self/fd/${fd}/${part}`, FLAGS | constants.O_DIRECTORY);
		fds.push(fd);
	}
	return fd;
}

function boundedRead(fd, maxBytes) {
	const before = fstatSync(fd);
	assert.ok(before.size > 0 && before.size <= maxBytes, "credential_size");
	const bytes = Buffer.alloc(maxBytes + 1);
	let length = 0;
	while (length < bytes.length) {
		const count = readSync(fd, bytes, length, bytes.length - length, length);
		if (count === 0) break;
		length += count;
	}
	assert.ok(length > 0 && length <= maxBytes, "credential_size");
	const after = fstatSync(fd);
	sameFile(before, after);
	assert.ok(
		before.size === after.size &&
			before.mtimeMs === after.mtimeMs &&
			before.ctimeMs === after.ctimeMs,
		"credential_changed",
	);
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
}

/**
 * @returns A bounded UTF8 reader for four fixed H names at the canonical or identical alias view.
 * @throws A sanitized refusal when Linux identity, ACL, mount or file checks fail.
 */
export function createDeliveredCredentialReader({
	instance,
	serviceUid,
	credentialsDirectory = process.env.CREDENTIALS_DIRECTORY,
}) {
	const canonical = `/run/credentials/durable-pi-request-H@${instance}.service`;
	assert.ok(
		process.platform === "linux" &&
			INSTANCE.test(instance) &&
			Number.isSafeInteger(serviceUid) &&
			serviceUid > 0 &&
			[0, serviceUid].includes(process.getuid()) &&
			credentialsDirectory === canonical,
		"request_delivered_context_refused",
	);
	return function readCredential(path, maxBytes = 16384) {
		const fds = [];
		try {
			assert.ok(
				typeof path === "string" &&
					Number.isSafeInteger(maxBytes) &&
					maxBytes > 0 &&
					maxBytes <= 16384,
				"credential_input",
			);
			const name = basename(path);
			assert.ok(
				NAMES.has(name) &&
					[canonical, ALIAS].includes(dirname(path)) &&
					path === `${dirname(path)}/${name}`,
				"credential_path",
			);
			const canonicalFd = directoryFd(canonical, fds);
			const aliasFd = directoryFd(ALIAS, fds);
			sameFile(privateView(canonicalFd, serviceUid, true), privateView(aliasFd, serviceUid, true));
			const fd = openSync(`/proc/self/fd/${canonicalFd}/${name}`, FLAGS);
			fds.push(fd);
			const aliasFile = openSync(`/proc/self/fd/${aliasFd}/${name}`, FLAGS);
			fds.push(aliasFile);
			sameFile(privateView(fd, serviceUid, false), privateView(aliasFile, serviceUid, false));
			return boundedRead(fd, maxBytes);
		} catch {
			// OS errors may include paths or subprocess output; expose no credential context.
			throw new Error("request_delivered_credential_refused");
		} finally {
			for (const fd of fds.reverse()) closeSync(fd);
		}
	};
}
