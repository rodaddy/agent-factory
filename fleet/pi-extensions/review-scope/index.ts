/** Review tool fence, not an OS sandbox. The trusted launcher supplies one
 * immutable, read-only checkout via REVIEW_SCOPE_ROOT and loads this extension.
 * Host ownership must prevent checkout/symlink changes during the run. Keys,
 * execution capture and peer reports belong outside the checkout. No model
 * argument can change the root. Pi 1.0.3 rg/fd factories do not pass --follow;
 * an inherited ripgrep config is refused because it could override that rule.
 */
import { realpathSync, statSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { piResolve, readCandidates, within } from "../read-roots/paths.ts";

export const REFUSED = "review-scope: refused";
const NAMES = new Set(["read", "grep", "find", "ls"]);
type Env = Record<string, string | undefined>;
type Input = Record<string, unknown>;

function trustedRoot(given: string | undefined, env: Env): string {
	if (!given || !isAbsolute(given) || env.RIPGREP_CONFIG_PATH) throw new Error(REFUSED);
	const root = realpathSync(given);
	if (!statSync(root).isDirectory()) throw new Error(REFUSED);
	return root;
}

/** Uses the existing Pi resolver/fallback helpers, including nearest ancestors. */
export function scopedPath(root: string, name: string, input: Input, env: Env): string {
	if (!NAMES.has(name) || (name === "read" && typeof input.path !== "string"))
		throw new Error(REFUSED);
	if (input.path !== undefined && typeof input.path !== "string") throw new Error(REFUSED);
	const target = piResolve((input.path as string | undefined) || ".", root, env);
	const candidates = name === "read" ? readCandidates(target) : [target];
	if (!candidates.every((candidate) => within(candidate, [root]))) throw new Error(REFUSED);
	return target;
}

/** Concrete Pi factories retain their schemas, rendering and output bounds. */
export function createReviewTools(given: string, env: Env = process.env) {
	const root = trustedRoot(given, env);
	// Operations receive absolute paths already selected by Pi, including read
	// fallbacks and literal directory entries. Re-resolving would rewrite valid
	// Unicode filenames. The input wrapper has already fenced all read candidates.
	const check = (path: string) => {
		if (!isAbsolute(path) || !within(path, [root])) throw new Error(REFUSED);
		return path;
	};
	const definitions = [
		createReadToolDefinition(root, {
			operations: {
				access: async (path) => {
					await access(check(path));
				},
				readFile: async (path) => readFile(check(path)),
				detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(check(path)),
			},
		}),
		createLsToolDefinition(root, {
			operations: {
				exists: async (path) => {
					await access(check(path));
					return true;
				},
				stat: (path) => statSync(check(path)),
				readdir: async (path) => readdir(check(path)),
			},
		}),
		createFindToolDefinition(root),
		createGrepToolDefinition(root, {
			operations: {
				isDirectory: (path) => statSync(check(path)).isDirectory(),
				readFile: async (path) => readFile(check(path), "utf8"),
			},
		}),
	];
	return definitions.map((tool) => ({
		...tool,
		execute: async (...args: Parameters<typeof tool.execute>) => {
			const [id, input, signal, update, ctx] = args;
			const path = scopedPath(root, tool.name, input as Input, env);
			return tool.execute(id, { ...input, path } as never, signal, update, { ...ctx, cwd: root });
		},
	}));
}

/** Loading without valid trusted configuration blocks every tool. */
export function makeReviewScope(env: Env = process.env) {
	const snapshot = { ...env };
	let tools: ReturnType<typeof createReviewTools> | undefined;
	try {
		tools = createReviewTools(snapshot.REVIEW_SCOPE_ROOT ?? "", snapshot);
	} catch {
		/* fail closed */
	}
	return (pi: ExtensionAPI) => {
		// Each definition retains its own schema; the array has heterogeneous renderers.
		for (const tool of tools ?? [])
			pi.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
		pi.on("tool_call", async (event) => {
			if (!tools || !NAMES.has(event.toolName)) return { block: true, reason: REFUSED };
			try {
				scopedPath(
					realpathSync(snapshot.REVIEW_SCOPE_ROOT ?? ""),
					event.toolName,
					event.input as Input,
					snapshot,
				);
			} catch {
				return { block: true, reason: REFUSED };
			}
			return undefined;
		});
	};
}

export default function reviewScope(pi: ExtensionAPI): void {
	makeReviewScope()(pi);
}
