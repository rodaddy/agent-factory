/** Node 24/Bun CLI for spec-ready. Only fixed Forge/board requests; no model or command execution. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpecComment, SpecLabel, SpecResult } from "./spec-ready-lib.ts";
import { checkSpec, enforceSpec, gateSkill, isWorkTask } from "./spec-ready-lib.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const api = (process.env.FORGEJO_API_URL ?? "https://forge.example.internal/api/v1").replace(
	/\/+$/,
	"",
);
const token = process.env.FORGEJO_TOKEN;
const queue = args.includes("--queue-spec");

async function request<T>(
	url: string,
	authorization: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch(url, {
		method,
		headers: { Authorization: authorization, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`${method} request failed: HTTP ${response.status}`);
	return (await response.json()) as T;
}

async function queueSpec(
	issueUrl: string | null,
	hash: string,
	missing: string[],
	description: string,
): Promise<void> {
	if (!queue) return;
	const base = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
	const boardToken = process.env.PAPERCLIP_BOARD_TOKEN ?? process.env.PAPERCLIP_API_KEY;
	const company = process.env.PAPERCLIP_COMPANY_ID;
	if (!boardToken || !company)
		throw new Error(
			"spec queue requires PAPERCLIP_COMPANY_ID and PAPERCLIP_BOARD_TOKEN or PAPERCLIP_API_KEY",
		);
	const endpoint = `${base}/api/companies/${encodeURIComponent(company)}/issues`;
	const originId = `${issueUrl ?? "board-task"}:${hash}`;
	for (let offset = 0; ; offset += 1000) {
		const tasks = await request<{ originKind?: string; originId?: string }[]>(
			`${endpoint}?limit=1000&offset=${offset}`,
			`Bearer ${boardToken}`,
		);
		if (tasks.some((task) => task.originKind === "spec-ready" && task.originId === originId))
			return;
		if (tasks.length < 1000) break;
	}
	await request(endpoint, `Bearer ${boardToken}`, "POST", {
		title: `Write spec ${issueUrl ? issueUrl.replace("https://forge.example.internal/", "").replace(/\/(?:issues|pulls)\//, "#") : "board task"}`,
		description: `${issueUrl ?? description}\n\nMissing:\n${missing.map((part) => `- ${part}`).join("\n")}\n\n<!-- spec-ready:${hash} -->`,
		status: "backlog",
		originKind: "spec-ready",
		originId,
	});
}

function issueLinks(description: string): string[] {
	return [
		...new Set(
			description.match(
				/https:\/\/forge\.example\.internal\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*(?![0-9A-Za-z/])/g,
			) ?? [],
		),
	];
}
async function issueIn(description: string): Promise<string | null> {
	const explicit = issueLinks(description);
	if (explicit.length) return explicit.length === 1 ? (explicit[0] ?? null) : null;
	const prs = [
		...new Set(
			description.match(
				/https:\/\/forge\.example\.internal\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9][0-9]*(?![0-9A-Za-z/])/g,
			) ?? [],
		),
	];
	if (prs.length !== 1 || !token) return null;
	const pr = prs[0] as string;
	const match = /forge\.example\.internal\/(.+)\/pulls\/(\d+)$/.exec(pr);
	const result = await request<{ body: string }>(
		`${api}/repos/${match?.[1]}/pulls/${match?.[2]}`,
		`token ${token}`,
	);
	const links: string[] = [];
	for (const ref of result.body.matchAll(
		/\b(?:closes?|fix(?:es)?|resolves?|source(?: issue)?\s*:?)\s+(?:\[[^\]]*\]\()?((?:https:\/\/forge\.example\.internal\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*)|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*)/gi,
	)) {
		const value = ref[1] ?? "";
		const [repo, number] = value.split("#");
		links.push(
			value.startsWith("https://")
				? value
				: `https://forge.example.internal/${repo || match?.[1]}/issues/${number}`,
		);
	}
	if (!links.length) links.push(...issueLinks(result.body));
	const unique = [...new Set(links)];
	return unique.length === 1 ? (unique[0] ?? null) : null;
}

async function source(
	issueUrl: string,
	labels: SpecLabel[],
	description: string,
	local?: SpecResult,
): Promise<SpecResult> {
	const match =
		/^https:\/\/forge\.example\.internal\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/.exec(
			issueUrl,
		);
	if (!match) throw new Error("--issue requires an exact forge.example.internal issue URL");
	if (!token) throw new Error("FORGEJO_TOKEN is required");
	const endpoint = `${api}/repos/${match[1]}/issues/${match[2]}`;
	const authorization = `token ${token}`;
	const issue = await request<{ body: string; labels?: SpecLabel[]; pull_request?: unknown }>(
		endpoint,
		authorization,
	);
	if (
		typeof issue.body !== "string" ||
		(issue.labels !== undefined && !Array.isArray(issue.labels))
	)
		throw new Error("invalid Forge issue response");
	if (issue.pull_request) {
		const held = checkSpec("");
		held.missing.push("source Forge issue (PR is not an issue spec)");
		await queueSpec(null, held.bodyHash, held.missing, description);
		return held;
	}
	return enforceSpec(
		{
			issueKey: issueUrl,
			body: issue.body,
			labels: [...(issue.labels ?? []), ...labels],
			additionalMissing: local?.missing.map((part) => `Task ticket: ${part}`),
		},
		{
			listComments: async () => {
				const out: SpecComment[] = [];
				for (let page = 1; ; page++) {
					const comments = await request<SpecComment[]>(
						`${endpoint}/comments?limit=100&page=${page}`,
						authorization,
					);
					if (!Array.isArray(comments)) throw new Error("invalid Forge comments response");
					out.push(...comments);
					if (comments.length < 100) return out;
				}
			},
			postComment: (body) => request(`${endpoint}/comments`, authorization, "POST", { body }),
			queueSpec: (hash, missing) => queueSpec(issueUrl, hash, missing, description),
		},
	);
}

// Kernel flock is released on exit/SIGKILL; never delete its inode.
async function lockedSource(
	issueUrl: string,
	labels: SpecLabel[],
	description: string,
	local?: SpecResult,
): Promise<SpecResult> {
	const root =
		process.env.RTECH_TEMP_ROOT ??
		(process.platform === "darwin" ? "/opt/_tmp" : "/mnt/share/tmp_space");
	const locks = join(root, "software-factory", "spec-ready-locks");
	await mkdir(locks, { recursive: true });
	const lock = join(locks, `${createHash("sha256").update(issueUrl).digest("hex")}.flock`);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.platform === "darwin" ? "/opt/homebrew/bin/flock" : "/usr/bin/flock",
			[
				"-n",
				...(process.platform === "darwin" ? [] : ["-F"]),
				"-E",
				"3",
				lock,
				process.execPath,
				process.argv[1] as string,
				"--locked-source",
				...(queue ? ["--queue-spec"] : []),
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error("source check failed or already running"));
			try {
				resolve(JSON.parse(out) as SpecResult);
			} catch {
				reject(new Error("invalid locked check response"));
			}
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify({ issueUrl, labels, description, local }));
	});
}

async function stdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	if (args.includes("--locked-source")) {
		const input = JSON.parse(await stdin()) as {
			issueUrl: string;
			labels: SpecLabel[];
			description: string;
			local?: SpecResult;
		};
		process.stdout.write(
			JSON.stringify(await source(input.issueUrl, input.labels, input.description, input.local)),
		);
		return;
	}
	let issueUrl: string | null = flag("--issue") ?? null;
	if (issueUrl?.includes("/pulls/")) issueUrl = await issueIn(issueUrl);
	let local: SpecResult | undefined;
	let description = "";
	let labels: SpecLabel[] = [];
	if (args.includes("--task-json")) {
		const task = JSON.parse(await stdin()) as {
			title?: string;
			description?: string;
			skill?: string;
			labels?: SpecLabel[];
		};
		if (
			(task.skill && !gateSkill(task.skill)) ||
			(!task.skill && task.title && !isWorkTask(task.title))
		) {
			process.stdout.write(
				`${JSON.stringify({ ready: true, missing: [], bodyHash: checkSpec(task.description ?? "").bodyHash, issueUrl: null, nextStep: null })}\n`,
			);
			return;
		}
		description = task.description ?? "";
		labels = task.labels ?? [];
		issueUrl = await issueIn(description);
	} else if (flag("--file")) {
		local = checkSpec(await readFile(flag("--file") as string, "utf8"));
	} else if (flag("--description-file")) {
		description = await readFile(flag("--description-file") as string, "utf8");
		local = checkSpec(description);
		issueUrl ??= await issueIn(description);
	} else if (!issueUrl)
		throw new Error(
			"usage: spec-ready --issue <url> | --file <md> | --description-file <md> | --task-json [--queue-spec]",
		);
	let result: SpecResult;
	if (flag("--file")) result = local as SpecResult;
	else if (!issueUrl) {
		result = checkSpec(description);
		result.missing = [...new Set([...result.missing, "source Forge issue"])];
		result.ready = false;
		await queueSpec(null, result.bodyHash, result.missing, description);
	} else {
		result = await lockedSource(issueUrl, labels, description, local);
	}
	process.stdout.write(
		`${JSON.stringify({ ...result, issueUrl, nextStep: result.ready ? null : "write-spec" })}\n`,
	);
	process.exitCode = result.ready ? 0 : 1;
}

try {
	await main();
} catch (error: unknown) {
	process.stderr.write(`spec-ready: ${error instanceof Error ? error.message : "invalid input"}\n`);
	process.exitCode = 3;
}
