/**
 * @module tests/actions/render-verb
 * @description Functional tests for the Actions verb renderer (829b2):
 *   a handed rails manifest that does not match MANIFEST_SHA exits 1 and writes
 *   nothing; a match renders the shared box body (the fixed service-catalog
 *   compile line and a bundle rooted at `^<base>`); shell metacharacters in the
 *   manifest land as heredoc DATA and in a spliced input are refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RenderVerbError, renderVerb } from "../../scripts/actions/render-verb";
import { testTmpBase } from "../support/test-temp";

const CLI = join(import.meta.dir, "../../scripts/actions/render-verb.ts");
const BASE = "b".repeat(40);
const MANIFEST = new TextEncoder().encode("rails:\n  - name: probe $(whoami) `id` ; rm -rf /\n");
const DIGEST = createHash("sha256").update(MANIFEST).digest("hex");
const ENV = {
	VERB: "newapp",
	REPO: "rtech/k3s-deploy",
	ITEM: "12",
	APP: "probe-app",
	MANIFEST_SHA: DIGEST,
	BASE_SHA: BASE,
};
const PATHS = {
	enginePath: "/rt/verb-work/rtech-infra-src",
	k3sCheckoutPath: "/rt/verb-work/k3s-deploy-src",
};

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("render-verb", () => {
	test("a manifest digest mismatch exits 1 and writes nothing", () => {
		const temp = mkdtempSync(join(testTmpBase(), "render-verb-"));
		roots.push(temp);
		mkdirSync(join(temp, "verb-input"));
		writeFileSync(join(temp, "verb-input", "factory-rails.yml"), MANIFEST);
		const run = Bun.spawnSync(["bun", CLI], {
			env: {
				...process.env,
				...ENV,
				MANIFEST_SHA: "0".repeat(64),
				RTECH_INFRA_SHA: "c".repeat(40),
				RUNNER_TEMP: temp,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain("does not match MANIFEST_SHA");
		expect(existsSync(join(temp, "verb-work"))).toBe(false);
		expect(readdirSync(temp)).toEqual(["verb-input"]);
	});

	test("the CLI unpacks both handed tars, detaches each at its sha, and writes job.sh", () => {
		const temp = mkdtempSync(join(testTmpBase(), "render-verb-"));
		roots.push(temp);
		const input = join(temp, "verb-input");
		mkdirSync(input);
		writeFileSync(join(input, "factory-rails.yml"), MANIFEST);
		const gitEnv = {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		};
		const sh = (cwd: string, cmd: string[]): string => {
			const out = Bun.spawnSync(cmd, { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
			if (out.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${out.stderr.toString()}`);
			return out.stdout.toString().trim();
		};
		/**
		 * The prepare job's shape (.forgejo/workflows/verb.yml): `git init` plus a
		 * fetch of the sha, nothing checked out, and only `.git` tarred.
		 */
		const handed = (name: string): string => {
			const origin = join(temp, `origin-${name}`);
			mkdirSync(origin);
			sh(origin, ["git", "init", "-q", "-b", "main"]);
			writeFileSync(join(origin, "marker"), `${name}\n`);
			sh(origin, ["git", "add", "marker"]);
			sh(origin, ["git", "commit", "-qm", name]);
			const sha = sh(origin, ["git", "rev-parse", "HEAD"]);
			const fetched = join(temp, `fetched-${name}`);
			mkdirSync(fetched);
			sh(fetched, ["git", "init", "-q"]);
			sh(fetched, ["git", "fetch", "-q", "--no-tags", origin, sha]);
			sh(fetched, ["tar", "-cf", join(input, `${name}.tar`), ".git"]);
			return sha;
		};
		const baseSha = handed("k3s-deploy");
		const infraSha = handed("rtech-infra");
		const run = Bun.spawnSync(["bun", CLI], {
			env: {
				...gitEnv,
				...ENV,
				BASE_SHA: baseSha,
				RTECH_INFRA_SHA: infraSha,
				RUNNER_TEMP: temp,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		const work = join(temp, "verb-work");
		const k3s = join(work, "k3s-deploy-src");
		const engine = join(work, "rtech-infra-src");
		expect(sh(k3s, ["git", "rev-parse", "HEAD"])).toBe(baseSha);
		expect(sh(engine, ["git", "rev-parse", "HEAD"])).toBe(infraSha);
		expect(readFileSync(join(k3s, "marker"), "utf8")).toBe("k3s-deploy\n");
		const body = readFileSync(join(work, "job.sh"), "utf8");
		expect(body).toContain(`k3s_base_sha=${baseSha}`);
		expect(body).toContain(`engine_src=${engine}`);
		expect(body).toContain(`k3s_src=${k3s}`);
	});

	test("the pure builder refuses a mismatched digest too", () => {
		expect(() => renderVerb({ ...ENV, MANIFEST_SHA: "0".repeat(64) }, MANIFEST, PATHS)).toThrow(
			RenderVerbError,
		);
	});

	test("a match renders the compile line and the bundle rooted at ^base", () => {
		const body = renderVerb(ENV, MANIFEST, PATHS);
		expect(body).toContain(
			'bash "$engine_dir/scripts/service-catalog" compile --all --repo "$engine_dir"',
		);
		expect(body).toContain('bundle create "$bundle_tmp" "^${k3s_base_sha}" HEAD');
		expect(body).toContain(`k3s_base_sha=${BASE}`);
		expect(body).toContain(`engine_src=${PATHS.enginePath}`);
		expect(body).toContain(`k3s_src=${PATHS.k3sCheckoutPath}`);
	});

	test("manifest metacharacters land as quoted heredoc data", () => {
		const body = renderVerb(ENV, MANIFEST, PATHS);
		expect(body).toContain("<<'SF_RAILS_MANIFEST_EOF'");
		expect(body).toContain("  - name: probe $(whoami) `id` ; rm -rf /");
	});

	test("an input carrying shell metacharacters is refused, not spliced", () => {
		for (const over of [
			{ APP: "x$(id)" },
			{ REPO: "a/b;rm" },
			{ ITEM: "1;id" },
			{ VERB: "newapp`id`" },
		]) {
			expect(() => renderVerb({ ...ENV, ...over }, MANIFEST, PATHS)).toThrow(RenderVerbError);
		}
	});
});
