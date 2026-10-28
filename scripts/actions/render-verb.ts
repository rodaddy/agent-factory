/**
 * @module scripts/actions/render-verb
 * @description Render the verb job.sh the `verb` Forgejo Actions workflow runs
 *   in its UNTRUSTED render job (829b2).
 *
 *   The prepare job hands artifact `verb-input` under "$RUNNER_TEMP/verb-input":
 *   k3s-deploy.tar and rtech-infra.tar (each a bare `.git`) plus the rails
 *   manifest blob factory-rails.yml. This script:
 *     1. binds factory-rails.yml to MANIFEST_SHA (sha256 of its exact bytes,
 *        the digest the watcher dispatched) BEFORE anything else; a mismatch
 *        exits 1 with a fixed reason and writes nothing;
 *     2. materialises both checkouts inside "$RUNNER_TEMP/verb-work" (never the
 *        factory checkout): k3s-deploy detached at BASE_SHA, rtech-infra
 *        detached at RTECH_INFRA_SHA;
 *     3. calls the SAME `renderVerbScriptBody` the box verb lane uses, with
 *        those local paths, and writes "$RUNNER_TEMP/verb-work/job.sh".
 *
 *   Every input reaches the body only through renderVerbScriptBody's allowlist
 *   (verb, repo, item, app, base sha, manifest sha, absolute paths); anything
 *   else makes it return null, which exits 1. The manifest bytes land as a
 *   quoted heredoc (DATA). No network, no credential.
 *
 * @outputs
 *   - `renderVerb` -- the pure builder: env + manifest bytes + local paths -> job.sh
 *   - CLI: exit 0 writing job.sh; exit 1 with one stderr line on refusal
 *
 * @dependencies
 *   - ../../src/jobs/verb-body -- the shared verb body renderer
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { traced } from "../../src/log";
import { renderVerbScriptBody } from "../../src/jobs/verb-body";

/** The environment the render job hands the script, before validation. */
export interface RenderVerbEnv {
	VERB?: string;
	REPO?: string;
	ITEM?: string;
	APP?: string;
	MANIFEST_SHA?: string;
	BASE_SHA?: string;
}

/** Thrown on any refusal; the CLI turns it into exit 1 with the message. */
export class RenderVerbError extends Error {}

/** The fixed reason for a handed manifest that is not the dispatched one. */
export const MANIFEST_MISMATCH = "the handed factory-rails.yml does not match MANIFEST_SHA";

function renderVerbImpl(
	env: RenderVerbEnv,
	manifestBytes: Uint8Array,
	paths: { enginePath: string; k3sCheckoutPath: string },
): string {
	const digest = createHash("sha256").update(manifestBytes).digest("hex");
	if (digest !== env.MANIFEST_SHA) throw new RenderVerbError(MANIFEST_MISMATCH);
	const item = env.ITEM ?? "";
	if (!/^[1-9][0-9]*$/.test(item)) throw new RenderVerbError("ITEM must be a positive integer");
	const body = renderVerbScriptBody({
		verb: env.VERB ?? "",
		repository: env.REPO ?? "",
		itemNumber: Number(item),
		app: env.APP ?? "",
		manifest: { content: new TextDecoder().decode(manifestBytes), sha256: digest },
		k3sBaseSha: env.BASE_SHA ?? "",
		enginePath: paths.enginePath,
		k3sCheckoutPath: paths.k3sCheckoutPath,
	});
	if (body === null) throw new RenderVerbError("an input is not allowlisted; nothing rendered");
	return body;
}

export const renderVerb = traced("actions.verb.renderVerb", renderVerbImpl, {
	redact: { args: [1], result: true },
});

function git(args: string[]): void {
	const run = Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "inherit" });
	if (run.exitCode !== 0) throw new RenderVerbError(`git ${args[0] ?? ""} failed`);
}

/** Untar a handed `.git` into `dir` and detach its tree at `sha`. */
function materialise(tarPath: string, dir: string, sha: string): void {
	mkdirSync(dir, { recursive: true });
	const tar = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir], { stderr: "inherit" });
	if (tar.exitCode !== 0) throw new RenderVerbError(`could not unpack ${tarPath}`);
	git(["-C", dir, "checkout", "--quiet", "--detach", sha]);
}

if (import.meta.main) {
	try {
		const temp = process.env.RUNNER_TEMP ?? "";
		if (!temp.startsWith("/")) throw new RenderVerbError("RUNNER_TEMP must be an absolute path");
		const input = join(temp, "verb-input");
		const work = join(temp, "verb-work");
		const env = process.env as RenderVerbEnv;
		const manifest = new Uint8Array(readFileSync(join(input, "factory-rails.yml")));
		// Bind the handed manifest FIRST: a mismatch writes nothing at all.
		if (createHash("sha256").update(manifest).digest("hex") !== env.MANIFEST_SHA) {
			throw new RenderVerbError(MANIFEST_MISMATCH);
		}
		const infraSha = process.env.RTECH_INFRA_SHA ?? "";
		if (!/^[0-9a-f]{40}$/.test(infraSha))
			throw new RenderVerbError("RTECH_INFRA_SHA must be 40 hex");
		if (!/^[0-9a-f]{40}$/.test(env.BASE_SHA ?? ""))
			throw new RenderVerbError("BASE_SHA must be 40 hex");
		if (existsSync(work)) throw new RenderVerbError("verb-work already exists");
		const k3sCheckoutPath = join(work, "k3s-deploy-src");
		const enginePath = join(work, "rtech-infra-src");
		materialise(join(input, "k3s-deploy.tar"), k3sCheckoutPath, env.BASE_SHA ?? "");
		materialise(join(input, "rtech-infra.tar"), enginePath, infraSha);
		const body = renderVerb(env, manifest, { enginePath, k3sCheckoutPath });
		writeFileSync(join(work, "job.sh"), body, { mode: 0o755 });
		process.stdout.write(`render-verb: wrote ${join(work, "job.sh")}\n`);
	} catch (error) {
		if (error instanceof RenderVerbError) {
			process.stderr.write(`render-verb: ${error.message}\n`);
			process.exitCode = 1;
		} else {
			throw error;
		}
	}
}
