import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	createReviewTools,
	makeReviewScope,
} from "../../fleet/pi-extensions/review-scope/index.ts";
import { testTmpBase } from "../support/test-temp.ts";

const temp = join(testTmpBase(), "_scratch", "review-scope");
mkdirSync(temp, { recursive: true });
const home = mkdtempSync(join(temp, "case-"));
const root = join(home, "checkout");
const peer = join(home, "peer");
mkdirSync(root);
mkdirSync(peer);
writeFileSync(join(root, "safe.txt"), "SAFE marker\n");
writeFileSync(join(peer, "secret.txt"), "PEER SECRET marker\n");
symlinkSync(peer, join(root, "escape"));
symlinkSync(join(peer, "secret.txt"), join(root, "secret-link"));
const tools = createReviewTools(root);
const run = async (name: string, input: Record<string, unknown>) => {
	const tool = tools.find((tool) => tool.name === name);
	assert.ok(tool);
	return tool.execute("test", input as never, undefined, undefined, { cwd: root } as never);
};
test("read cannot expose peer data through traversal or symlinks", async () => {
	assert.match(JSON.stringify(await run("read", { path: "safe.txt" })), /SAFE marker/);
	for (const path of [
		"../peer/secret.txt",
		"escape/secret.txt",
		"secret-link",
		`file://${peer}/secret.txt`,
		`@${peer}/secret.txt`,
		"escape/missing/file",
	])
		await assert.rejects(run("read", { path }), /review-scope: refused/);
});
test("recursive search and listing never expose nested symlink targets", async () => {
	for (const name of ["find", "grep", "ls"]) {
		const input =
			name === "find"
				? { pattern: "**/*" }
				: name === "grep"
					? { pattern: "marker", context: 1 }
					: {};
		const output = JSON.stringify(await run(name, input));
		assert.doesNotMatch(output, /PEER SECRET|secret.txt/);
		assert.match(output, /safe.txt/);
	}
});

test("Pi path rewrites admit scoped files and reject escaped fallback candidates", async () => {
	writeFileSync(join(root, "safe space.txt"), "SPACE marker");
	for (const path of [
		"@safe.txt",
		`file://${root}/safe.txt`,
		"sub/../safe.txt",
		"safe\u00a0space.txt",
	])
		assert.match(JSON.stringify(await run("read", { path })), /marker/);
	symlinkSync(join(peer, "secret.txt"), join(root, "quote\u2019.txt"));
	await assert.rejects(run("read", { path: "quote'.txt" }), /review-scope: refused/);
	for (const name of ["grep", "find", "ls"])
		await assert.rejects(run(name, { path: "escape", pattern: "marker" }), /review-scope: refused/);
});

test("read preserves Pi's selected AM/PM fallback filename", async () => {
	writeFileSync(join(root, "Capture 10.00.00\u202fAM.txt"), "SCOPED SCREENSHOT NAME");
	assert.match(
		JSON.stringify(await run("read", { path: "Capture 10.00.00 AM.txt" })),
		/SCOPED SCREENSHOT NAME/,
	);
});

test("read emits a scoped PNG image attachment and refuses an outside image link", async () => {
	copyFileSync(
		new URL("../../fleet/plugins/crew/avatars/reviewer.png", import.meta.url),
		join(root, "pixel.png"),
	);
	const result = await run("read", { path: "pixel.png" });
	const image = result.content.find((part) => part.type === "image");
	assert.ok(image);
	assert.equal(image.mimeType, "image/png");
	assert.ok(image.data.length > 0);
	writeFileSync(join(peer, "private.png"), "PEER IMAGE");
	symlinkSync(join(peer, "private.png"), join(root, "private-image.png"));
	await assert.rejects(run("read", { path: "private-image.png" }), /review-scope: refused/);
});

test("ls and grep context preserve Unicode directory-entry filenames", async () => {
	const name = "entry\u00a0space.txt";
	writeFileSync(join(root, name), "UNICODE BEFORE\nUNICODE NEEDLE\nUNICODE AFTER\n");
	const output = JSON.stringify(await run("grep", { pattern: "UNICODE NEEDLE", context: 1 }));
	assert.match(output, /UNICODE BEFORE/);
	assert.match(output, /UNICODE NEEDLE/);
	assert.match(output, /UNICODE AFTER/);
	assert.doesNotMatch(output, /unable to read file/);
	assert.match(JSON.stringify(await run("ls", {})), /entry\u00a0space\.txt/);
});

test("ls follows confined directory symlinks but omits escaping entries", async () => {
	const directory = join(root, "inside-directory");
	mkdirSync(directory);
	writeFileSync(join(directory, "inside-child.txt"), "INSIDE");
	symlinkSync(directory, join(root, "inside-link"));
	assert.match(JSON.stringify(await run("ls", { path: "inside-link" })), /inside-child\.txt/);
	const listing = JSON.stringify(await run("ls", {}));
	assert.match(listing, /inside-link\//);
	assert.doesNotMatch(listing, /escape|secret-link|private-image/);
	await assert.rejects(run("ls", { path: "escape" }), /review-scope: refused/);
});

function install(env: Record<string, string | undefined>) {
	let handler!: (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>;
	const registered: string[] = [];
	makeReviewScope(env)({
		registerTool: (tool: { name: string }) => registered.push(tool.name),
		on: (_name: string, callback: typeof handler) => {
			handler = callback;
		},
	} as never);
	return { handler, registered };
}

test("trusted immutable root blocks unknown tools, peer paths and invalid configurations", async () => {
	const env = { REVIEW_SCOPE_ROOT: root };
	const installed = install(env);
	assert.deepEqual(installed.registered, ["read", "ls", "find", "grep"]);
	env.REVIEW_SCOPE_ROOT = peer;
	assert.equal(
		await installed.handler({ toolName: "read", input: { path: "safe.txt" } }),
		undefined,
	);
	for (const event of [
		{ toolName: "added-later", input: {} },
		{ toolName: "bash", input: { command: "cat secret" } },
		{ toolName: "read", input: { path: join(peer, "secret.txt") } },
	])
		assert.deepEqual(await installed.handler(event), {
			block: true,
			reason: "review-scope: refused",
		});
	for (const invalid of [
		{},
		{ REVIEW_SCOPE_ROOT: "relative" },
		{ REVIEW_SCOPE_ROOT: join(root, "absent") },
		{ REVIEW_SCOPE_ROOT: root, RIPGREP_CONFIG_PATH: "config" },
	]) {
		const closed = install(invalid);
		assert.equal(closed.registered.length, 0);
		assert.deepEqual(await closed.handler({ toolName: "read", input: { path: "safe.txt" } }), {
			block: true,
			reason: "review-scope: refused",
		});
	}
});
