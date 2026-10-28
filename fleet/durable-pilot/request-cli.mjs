/** Mac-side request intake and bounded H operator CLI; no automatic daemon. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildRequestPacket, parseRequestUrl } from "./request-packet.mjs";
import { loadRequestConfig, readPrivateFile } from "./request-config.mjs";
const exec = promisify(execFile);
const FORGE = "/opt/dev/_ob/bin/forge";
const REFUSALS = new Set(
	"request_url_refused request_repo_remote_refused request_packet_sha request_pr_refused request_pr_drift request_packet_size request_message_size request_diff_refused request_diff_unsupported request_diff_paths_limit request_diff_lines_limit request_diff_duplicate_path request_path_refused request_packet_shape request_packet_schema request_packet_repository request_packet_pr request_packet_title request_packet_paths request_packet_context request_packet_seal request_private_path_refused request_private_file_refused request_private_file_size request_config_shape request_tranche_refused request_stream_refused request_consumer_refused request_subject_refused request_nats_url_refused request_config_path_refused request_state_root_refused request_database_refused request_config_argument_required request_submit_arguments request_target_host_refused request_command_refused request_arguments request_job_not_found request_tranche_missing request_replay_conflict request_admission_limit request_limit_refused request_limit_conflict request_git_read_failed request_commits_unavailable request_forge_read_failed".split(
		" ",
	),
);
/** Only known categories may cross stderr, never command/database payloads. */
export function requestErrorCategory(error) {
	const code = /\b(request_[a-z_]+)\b/.exec(error instanceof Error ? error.message : "")?.[1];
	return REFUSALS.has(code) ? code : "command_refused_or_failed";
}
async function git(repoPath, args) {
	try {
		const output = await exec("git", ["-C", repoPath, ...args], {
			timeout: 30000,
			maxBuffer: 100000,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_NO_REPLACE_OBJECTS: "1",
			},
		});
		return output.stdout;
	} catch {
		throw new Error(
			args[0] === "merge-base" ? "request_commits_unavailable" : "request_git_read_failed",
		);
	}
}
async function forge(repository, number) {
	try {
		const output = await exec(
			FORGE,
			["--as", "codex", "--json", "api", "GET", `/repos/${repository}/pulls/${number}`],
			{ timeout: 30000, maxBuffer: 100000 },
		);
		return JSON.parse(output.stdout);
	} catch {
		throw new Error("request_forge_read_failed");
	}
}
/** Injectable read boundaries let tests prove refusal before admission. */
export async function freezeRequest(url, config, boundaries = { git, forge }) {
	const identity = parseRequestUrl(url);
	const remote = (await boundaries.git(config.repoPath, ["remote", "get-url", "origin"])).trim();
	assert.equal(
		remote,
		"https://forge.example.internal/rodaddy/software-factory.git",
		"request_repo_remote_refused",
	);
	const prBefore = await boundaries.forge(identity.repository, identity.pr);
	assert.ok(
		/^[0-9a-f]{40}$/.test(prBefore?.base?.sha) && /^[0-9a-f]{40}$/.test(prBefore?.head?.sha),
		"request_packet_sha",
	);
	const mergeBase = (
		await boundaries.git(config.repoPath, ["merge-base", prBefore.base.sha, prBefore.head.sha])
	).trim();
	assert.ok(/^[0-9a-f]{40}$/.test(mergeBase), "request_packet_sha");
	const diff = await boundaries.git(config.repoPath, [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-renames",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		mergeBase,
		prBefore.head.sha,
		"--",
	]);
	const prAfter = await boundaries.forge(identity.repository, identity.pr);
	return buildRequestPacket({ url, prBefore, prAfter, diff, mergeBase });
}
function argumentsOf(argv) {
	const index = argv.indexOf("--config");
	assert.ok(index >= 0 && argv[index + 1], "request_config_argument_required");
	const args = argv.filter((_value, i) => i !== index && i !== index + 1);
	return { configPath: argv[index + 1], args };
}
function submitArgs(args) {
	const [url, ...options] = args;
	assert.ok(options.length === 4 || options.length === 6, "request_submit_arguments");
	const flags = Object.fromEntries(
		options.filter((_value, i) => i % 2 === 0).map((value, i) => [value, options[i * 2 + 1]]),
	);
	assert.equal(Object.keys(flags).length * 2, options.length, "request_submit_arguments");
	assert.ok(
		Object.keys(flags).every((key) => ["--family", "--request-key", "--target-host"].includes(key)),
		"request_submit_arguments",
	);
	assert.ok(
		["claude", "gpt"].includes(flags["--family"]) &&
			typeof flags["--request-key"] === "string" &&
			/^[A-Za-z0-9_-]{1,80}$/.test(flags["--request-key"]),
		"request_submit_arguments",
	);
	const targetHost = flags["--target-host"] ?? null;
	assert.ok(
		targetHost === null || ["107", "109", "113"].includes(targetHost),
		"request_target_host_refused",
	);
	return { url, family: flags["--family"], requestKey: flags["--request-key"], targetHost };
}
/** Execute only one explicit operator command, closing both transports. */
export async function main(argv = process.argv.slice(2)) {
	const { configPath, args } = argumentsOf(argv);
	const [command, ...rest] = args;
	assert.ok(
		["init", "submit", "status", "result", "drain"].includes(command),
		"request_command_refused",
	);
	const input = command === "submit" ? submitArgs(rest) : undefined;
	const config = loadRequestConfig(configPath);
	const { createStore, initializeStore, openRequestSql } = await import("./request-store.mjs");
	const { connectRequestBus } = await import("./request-bus.mjs");
	const sql = openRequestSql(readPrivateFile(config.postgresUrlFile).trim());
	let bus;
	try {
		if (command === "init") {
			assert.equal(rest.length, 0, "request_arguments");
			return await initializeStore(sql, { trancheId: config.trancheId, maxRequests: 6 });
		}
		const store = createStore({ sql, trancheId: config.trancheId });
		if (["status", "result"].includes(command)) {
			assert.ok(rest.length === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(rest[0]), "request_arguments");
			const job = await store.status(rest[0]);
			assert.ok(job, "request_job_not_found");
			return command === "result"
				? { id: job.id, status: job.status, result: job.result, error: job.error }
				: {
						id: job.id,
						status: job.status,
						family: job.family,
						targetHost: job.targetHost,
						head: job.packet.head,
						packetHash: job.packetHash,
						error: job.error,
					};
		}
		if (command === "submit") {
			const sealed = await freezeRequest(input.url, config);
			const admitted = await store.submit({
				requestKey: input.requestKey,
				packet: sealed.packet,
				packetHash: sealed.packetHash,
				family: input.family,
				targetHost: input.targetHost,
			});
			return {
				id: admitted.job.id,
				created: admitted.created,
				status: admitted.job.status,
				delivery: admitted.created ? "pending_outbox_drain" : "existing_request",
				head: sealed.packet.head,
				packetHash: sealed.packetHash,
			};
		}
		assert.equal(rest.length, 0, "request_arguments");
		const expired = await store.expire();
		bus = await connectRequestBus(config);
		return { expired, outbox: await bus.publishOutbox(store) };
	} finally {
		if (bus) await bus.close();
		await sql.end({ timeout: 5 });
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main()
		.then((result) => process.stdout.write(`${JSON.stringify(result ?? { initialized: true })}\n`))
		.catch((error) => {
			const reason = requestErrorCategory(error);
			process.stderr.write(`${JSON.stringify({ event: "request_cli_failed", reason })}\n`);
			process.exitCode = 1;
		});
}
