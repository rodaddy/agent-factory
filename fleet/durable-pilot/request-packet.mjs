/** H-only frozen packet intake. F/G seals and admissions are unchanged. */
import assert from "node:assert/strict";
import { parsePatch } from "diff";
import { hash, PROMPT, validateResult } from "./shadow-packet.mjs";
export const PACKET_LIMIT = 6144;
export const REQUEST_SCHEMA = "durable-pi-request-packet.v1";
const SHA = /^[0-9a-f]{40}$/;
const KEYS = [
	"schema",
	"url",
	"repository",
	"pr",
	"title",
	"base",
	"head",
	"mergeBase",
	"allowedPaths",
	"diff",
	"context",
];

/** Only the exact pilot repository and canonical positive PR URLs are admitted. */
export function parseRequestUrl(value) {
	assert.equal(typeof value, "string", "request_url_refused");
	const match =
		/^https:\/\/forge\.example\.internal\/rodaddy\/software-factory\/pulls\/([1-9][0-9]*)$/.exec(
			value,
		);
	assert.ok(match && Number.isSafeInteger(Number(match[1])), "request_url_refused");
	return { url: value, repository: "rodaddy/software-factory", pr: Number(match[1]) };
}
function safePath(path) {
	assert.ok(
		typeof path === "string" &&
			/^[A-Za-z0-9_./-]+$/.test(path) &&
			!path.startsWith("/") &&
			!path.split("/").some((part) => !part || part === "." || part === ".."),
		"request_path_refused",
	);
	return path;
}
function diffPaths(diff) {
	assert.equal(typeof diff, "string", "request_diff_refused");
	assert.ok(Buffer.byteLength(diff) <= PACKET_LIMIT, "request_packet_size");
	assert.ok(
		!diff.includes(String.fromCharCode(0)) &&
			!/^GIT binary patch|^Binary files|^rename |^copy |^similarity index|^old mode|^new mode|^deleted file mode|^new file mode/m.test(
				diff,
			),
		"request_diff_unsupported",
	);
	const headers = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
	for (const header of headers) {
		safePath(header[1]);
		safePath(header[2]);
	}
	const patches = parsePatch(diff, { strict: true });
	assert.ok(patches.length > 0 && patches.length <= 20, "request_diff_paths_limit");
	assert.equal(headers.length, patches.length, "request_diff_unsupported");
	let changed = 0;
	const paths = patches.map((patch, index) => {
		const path = safePath(patch.newFileName?.replace(/^b\//, ""));
		assert.ok(headers[index][1] === path && headers[index][2] === path, "request_diff_unsupported");
		assert.equal(patch.oldFileName, `a/${path}`, "request_diff_unsupported");
		assert.equal(patch.newFileName, `b/${path}`, "request_diff_unsupported");
		assert.ok(patch.hunks.length > 0, "request_diff_unsupported");
		changed += patch.hunks
			.flatMap((hunk) => hunk.lines)
			.filter((line) => /^[+-]/.test(line)).length;
		return path;
	});
	assert.equal(new Set(paths).size, paths.length, "request_diff_duplicate_path");
	assert.ok(changed > 0 && changed <= 400, "request_diff_lines_limit");
	return paths;
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	return value;
}
/** Revalidate before egress; the hash covers canonical JSON bytes exactly. */
export function validateRequestPacket(packet, { expectedHash } = {}) {
	assert.ok(packet && typeof packet === "object" && !Array.isArray(packet), "request_packet_shape");
	assert.deepEqual(Object.keys(packet).sort(), [...KEYS].sort(), "request_packet_shape");
	const identity = parseRequestUrl(packet.url);
	assert.equal(packet.schema, REQUEST_SCHEMA, "request_packet_schema");
	assert.equal(packet.repository, identity.repository, "request_packet_repository");
	assert.equal(packet.pr, identity.pr, "request_packet_pr");
	assert.ok(
		[packet.base, packet.head, packet.mergeBase].every(
			(sha) => typeof sha === "string" && SHA.test(sha),
		),
		"request_packet_sha",
	);
	assert.ok(
		typeof packet.title === "string" && packet.title.length > 0 && packet.title.length <= 300,
		"request_packet_title",
	);
	assert.deepEqual(packet.allowedPaths, diffPaths(packet.diff), "request_packet_paths");
	assert.deepEqual(
		packet.context,
		{ path: packet.allowedPaths[0], text: "" },
		"request_packet_context",
	);
	const bytes = Buffer.from(JSON.stringify(canonical(packet)));
	assert.ok(bytes.length <= PACKET_LIMIT, "request_packet_size");
	const packetHash = hash(bytes);
	if (expectedHash !== undefined) assert.equal(packetHash, expectedHash, "request_packet_seal");
	const content = `${PROMPT}\nPACKET\n${bytes.toString("utf8")}`;
	assert.ok(
		Buffer.byteLength(JSON.stringify([{ role: "user", content }])) <= 8192,
		"request_message_size",
	);
	return { packet, packetHash, packetBytes: bytes.length, content };
}
/** Freeze metadata only after confirming the PR did not move during collection. */
export function buildRequestPacket({ url, prBefore, prAfter, diff, mergeBase }) {
	const identity = parseRequestUrl(url);
	for (const pr of [prBefore, prAfter]) {
		assert.ok(
			pr?.number === identity.pr && pr.state === "open" && pr.merged === false,
			"request_pr_refused",
		);
		assert.ok(SHA.test(pr?.base?.sha) && SHA.test(pr?.head?.sha), "request_packet_sha");
	}
	assert.equal(prBefore.base.sha, prAfter.base.sha, "request_pr_drift");
	assert.equal(prBefore.head.sha, prAfter.head.sha, "request_pr_drift");
	const allowedPaths = diffPaths(diff);
	return validateRequestPacket({
		schema: REQUEST_SCHEMA,
		...identity,
		title: prBefore.title,
		base: prBefore.base.sha,
		head: prBefore.head.sha,
		mergeBase,
		allowedPaths,
		diff,
		context: { path: allowedPaths[0], text: "" },
	});
}
/** H shares G's schema and new-side finding scope, with no synthetic context. */
export function validateRequestResult(raw, packet) {
	validateRequestPacket(packet);
	return validateResult(raw, packet);
}
