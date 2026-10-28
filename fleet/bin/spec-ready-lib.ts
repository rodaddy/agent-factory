/** Deterministic dispatch admission for sf#2102. Never executes issue commands. */
import { createHash } from "node:crypto";

export { isWorkTask } from "../plugins/spec-dispatch.js";
export interface SpecResult {
	ready: boolean;
	missing: string[];
	bodyHash: string;
}
export type SpecLabel = string | { name: string };
export type SpecComment = string | { body: string; id?: number; created_at?: string };

function commentBody(comment: SpecComment): string {
	return typeof comment === "string" ? comment : comment.body;
}

/** Split ATX headings only outside fences; retain fenced content in its section. */
function sections(body: string): Map<string, string> {
	const result = new Map<string, string>();
	let heading = "";
	let fence: { char: string; length: number } | null = null;
	for (const line of body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence !== null) {
			if (heading) result.set(heading, `${result.get(heading) ?? ""}\n${line}`);
			if (
				delimiter &&
				delimiter[1]?.[0] === fence.char &&
				delimiter[1].length >= fence.length &&
				!delimiter[2]?.trim()
			)
				fence = null;
			continue;
		}
		if (delimiter?.[1]) fence = { char: delimiter[1][0] ?? "`", length: delimiter[1].length };
		const match = !fence && /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (match) {
			heading = (match[1] ?? "").replace(/[*_`]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
			if (!result.has(heading)) result.set(heading, "");
		} else if (heading) result.set(heading, `${result.get(heading) ?? ""}\n${line}`);
	}
	return result;
}

function populated(text: string | undefined): boolean {
	return !!text?.split(/\r?\n/).some((line) => {
		const value = line.replace(/^\s*[-*+]\s*/, "").trim();
		return !/^(?:$|(?:```|~~~).*$|(?:todo|tbd|none|n\/a|placeholder|\.\.\.)[.!]?$)/i.test(value);
	});
}

function acceptance(text: string): boolean {
	let fence: { char: string; length: number; shell: boolean; lines: string[] } | null = null;
	let command = false;
	const outcomes: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!fence) {
			if (!delimiter) outcomes.push(line);
			if (delimiter?.[1])
				fence = {
					char: delimiter[1][0] ?? "`",
					length: delimiter[1].length,
					shell: /^(?:shell|bash|sh|zsh)$/i.test((delimiter[2] ?? "").trim()),
					lines: [],
				};
		} else if (
			delimiter &&
			delimiter[1]?.[0] === fence.char &&
			delimiter[1].length >= fence.length &&
			!delimiter[2]?.trim()
		) {
			if (
				fence.shell &&
				fence.lines.some(
					(value) =>
						/^\s*(?:\$\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*[A-Za-z0-9_.~/-]+(?:\s|$)/.test(
							value,
						) && !/^\s*#/.test(value),
				)
			)
				command = true;
			fence = null;
		} else fence.lines.push(line);
	}
	return (
		command &&
		/\b(?:exit(?:\s+(?:code|status))?\s*[:=]?\s*0|pass(?:es|ed)?|expected\s*(?:outcome|result)?\s*:\s*\S.+|expect\s+.+|returns?\s+.+)\b/i.test(
			outcomes.join("\n"),
		)
	);
}

/** Shape plus latest advisory, with a NEEDS_SPEC label always taking precedence. */
export function checkSpec(
	body: string,
	labels: readonly SpecLabel[] = [],
	comments: readonly SpecComment[] = [],
): SpecResult {
	const parts = sections(body);
	const matching = (pattern: RegExp): string | undefined =>
		[...parts.entries()]
			.filter(([heading]) => pattern.test(heading))
			.map(([, text]) => text)
			.join("\n") || undefined;
	const combined = matching(/^files to read\s*(?:\/|and|&)\s*(?:to )?change$/);
	const missing: string[] = [];
	if (!populated(combined ?? matching(/^files to read$/))) missing.push("Files to read");
	if (!populated(combined ?? matching(/^files to change$/))) missing.push("Files to change");
	if (!acceptance(matching(/^(?:acceptance(?: criteria)?|done means)$/) ?? ""))
		missing.push("Acceptance commands and expected outcomes");
	if (!populated(matching(/^(?:non[- ]goals|must not)$/))) missing.push("Non-goals");
	let verdict = "";
	for (const comment of comments) {
		for (const line of commentBody(comment).split(/\r?\n/)) {
			const match = /^jev issue-implementable v\d+ \(advisory\): (NEEDS_SPEC|READY)(?:\s|$)/i.exec(
				line.trim(),
			);
			if (match) verdict = (match[1] ?? "").toUpperCase();
		}
	}
	if (
		verdict === "NEEDS_SPEC" ||
		labels.some(
			(label) => (typeof label === "string" ? label : label.name).toUpperCase() === "NEEDS_SPEC",
		)
	)
		missing.push("Jev issue-implementable NEEDS_SPEC");
	return {
		ready: missing.length === 0,
		missing,
		bodyHash: createHash("sha256").update(body).digest("hex"),
	};
}

/** Unknown skills fail closed; these known read/spec/review workflows are exempt. */
export function gateSkill(skill: string): boolean {
	return !new Set(
		`triage-issue review-pr lead-review merge-pr pr-review write-spec spec-writing read research audit run-audit
 daily-report apple-build-review k3s-review review-dispatch infra-health harness-check scout-watchdog jev-route ci-red-check`.split(
			/\s+/,
		),
	).has(skill.toLowerCase());
}

export interface SpecInput {
	issueKey: string;
	body: string;
	labels?: readonly SpecLabel[];
	additionalMissing?: readonly string[];
}
export interface SpecDeps {
	listComments(): Promise<readonly SpecComment[]>;
	postComment(body: string): Promise<unknown>;
	queueSpec(hash: string, missing: string[]): Promise<unknown>;
}

const holds = new Map<string, Promise<unknown>>();
/** Serialize check/comment/queue in process; persistent marker survives retries. */
export async function enforceSpec(input: SpecInput, deps: SpecDeps): Promise<SpecResult> {
	const previous = holds.get(input.issueKey) ?? Promise.resolve();
	const operation = previous
		.catch(() => {})
		.then(async () => {
			const comments = await deps.listComments();
			const result = checkSpec(input.body, input.labels, comments);
			result.missing.push(...(input.additionalMissing ?? []));
			result.ready = result.missing.length === 0;
			if (result.ready) return result;
			const marker = `<!-- spec-ready:${result.bodyHash} -->`;
			if (!comments.some((comment) => commentBody(comment).includes(marker))) {
				await deps.postComment(
					`${marker}\nSpec-ready: held. Missing parts:\n${result.missing.map((part) => `- ${part}`).join("\n")}\n\nNext step: write the spec before dispatching implement/work to a seat.`,
				);
			}
			await deps.queueSpec(result.bodyHash, result.missing);
			return result;
		});
	holds.set(input.issueKey, operation);
	try {
		return await operation;
	} finally {
		if (holds.get(input.issueKey) === operation) holds.delete(input.issueKey);
	}
}
