import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";

const tmp = mkdtempSync(join(tmpdir(), "rw-config-"));

/** Write a YAML fixture and return its path. */
function fixture(name: string, body: string): string {
	const path = join(tmp, name);
	writeFileSync(path, body);
	return path;
}

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("loads the documented example config", async () => {
		const result = await loadConfig("config/repos.example.yml");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.poll_interval_minutes).toBe(15);
			expect(result.config.repositories.length).toBe(5);
			expect(result.config.repositories[0]?.name).toBe("rodaddy/open-brain");
			expect(result.config.job_templates.map((t) => t.id)).toContain("pr-review");
			// compat-matrix is retired with sf#830 (D10): no config still names it.
			expect(result.config.job_templates.map((t) => t.id)).not.toContain("compat-matrix");
		}
	});

	test("still rejects an unknown job_templates key", async () => {
		const path = fixture(
			"badtpl.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\njob_templates:\n  - id: pr-review\n    label: x\n    runner_size: medium\n    backdoor: true\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
	});

	test("applies defaults for optional fields", async () => {
		const path = fixture(
			"defaults.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.repositories[0]?.checks).toBe("standard");
			expect(result.config.job_templates).toEqual([]);
		}
	});

	test("rejects a missing file with a safe message", async () => {
		const result = await loadConfig(join(tmp, "does-not-exist.yml"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("not found");
		}
	});

	test("rejects malformed YAML", async () => {
		const path = fixture("bad.yml", "poll_interval_minutes: 15\n  : : :\n");
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("not valid YAML");
		}
	});

	test("rejects unknown top-level keys", async () => {
		const path = fixture(
			"unknown.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\nsecret_backdoor: true\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("invalid config");
		}
	});

	test("rejects an invalid repository name", async () => {
		const path = fixture(
			"badname.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: not-a-repo\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("owner/repo");
		}
	});

	test("rejects an out-of-range poll interval", async () => {
		const path = fixture(
			"interval.yml",
			"poll_interval_minutes: 0\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
	});

	test("rejects an empty repository list", async () => {
		const path = fixture("empty.yml", "poll_interval_minutes: 15\nrepositories: []\n");
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
	});

	test("rejects duplicate repositories", async () => {
		const path = fixture(
			"dup.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n  - name: rodaddy/x\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("duplicate repository");
		}
	});

	test("accepts the same owner/repo managed on both GitHub and Forgejo", async () => {
		const path = fixture(
			"cross-provider-ok.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: github\n  - name: rodaddy/x\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.repositories.map((r) => r.provider)).toEqual(["github", "forgejo"]);
		}
	});

	test("still rejects an EXACT (provider, name) duplicate", async () => {
		const path = fixture(
			"cross-provider-exact-dup.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n  - name: rodaddy/x\n    provider: forgejo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("duplicate repository");
		}
	});

	test("rejects two repositories enrolled for the same registry image", async () => {
		const path = fixture(
			"build-bump-image-dup.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/rtech-mcps\n    provider: forgejo\n    build_bump:\n      images:\n        - name: mcp-gitingest\n  - name: rodaddy/mcp-gitingest\n    provider: forgejo\n    build_bump: {}\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain(
				"duplicate build_bump image: rtech/mcp-gitingest is declared by rodaddy/rtech-mcps and rodaddy/mcp-gitingest",
			);
		}
	});

	test("the same image name under two repository owners is ONE registry image, refused", async () => {
		// The renderer resolves the registry owner from the image name, not the
		// repository owner, so both would publish to <registry>/rtech/api.
		const path = fixture(
			"build-bump-image-two-owners.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/api\n    provider: forgejo\n    build_bump: {}\n  - name: acme/api\n    provider: forgejo\n    build_bump: {}\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain(
				"duplicate build_bump image: rtech/api is declared by rodaddy/api and acme/api",
			);
		}
	});

	test("an image with a registry-owner override is keyed under that owner", async () => {
		// web-bb-landing publishes under acme (IMAGE_BUILDS.ownerOverrides);
		// a second enrolment of that name collides there, and the message says so.
		const path = fixture(
			"build-bump-image-override-owner.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: acme/web-bb-landing\n    provider: forgejo\n    build_bump: {}\n  - name: rodaddy/site\n    provider: forgejo\n    build_bump:\n      images:\n        - name: web-bb-landing\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("duplicate build_bump image: acme/web-bb-landing");
		}
	});

	test("rejects an unknown check value", async () => {
		const path = fixture(
			"badcheck.yml",
			"poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n    checks: yolo\n",
		);
		const result = await loadConfig(path);
		expect(result.ok).toBe(false);
	});
});

describe("job_templates return_mode", () => {
	const tpl = (extra: string) =>
		`poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\njob_templates:\n  - id: implement-issue\n    runner_size: medium\n${extra}`;

	test("defaults to patch, so omitting it never grants the runner a credential", async () => {
		const result = await loadConfig(fixture("rm-default.yml", tpl("")));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.job_templates[0]?.return_mode).toBe("patch");
		}
	});

	test("accepts the two reviewed modes, push only with its sf#67 opt-in", async () => {
		// `push` still parses as a reviewed mode, but sf#67 now requires the
		// template to carry `push_identity_ready: true` as well — the mode is inert
		// without the forge-side least-privilege identity, so config may no longer
		// select it by naming the enum value alone.
		const optIn: Record<string, string> = {
			patch: "",
			push: "    push_identity_ready: true\n",
		};
		for (const mode of ["patch", "push"] as const) {
			const result = await loadConfig(
				fixture(`rm-${mode}.yml`, tpl(`    return_mode: ${mode}\n${optIn[mode]}`)),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.job_templates[0]?.return_mode).toBe(mode);
			}
		}
	});

	test("rejects push without the sf#67 opt-in (the mode is inert)", async () => {
		const result = await loadConfig(fixture("rm-push-bare.yml", tpl("    return_mode: push\n")));
		expect(result.ok).toBe(false);
	});

	test("rejects any mode outside the closed enum", async () => {
		const result = await loadConfig(fixture("rm-bad.yml", tpl("    return_mode: force-push\n")));
		expect(result.ok).toBe(false);
	});
});

describe("per-repo triage opt-in and label allowlist", () => {
	const repo = (extra: string) =>
		`poll_interval_minutes: 15\nrepositories:\n  - name: rodaddy/x\n    provider: forgejo\n${extra}`;

	test("triage is absent by default (opt-in), so the lane stays off", async () => {
		const result = await loadConfig(fixture("triage-default.yml", repo("")));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.repositories[0]?.triage).toBeUndefined();
			expect(result.config.repositories[0]?.triage_labels).toBeUndefined();
		}
	});

	test("accepts triage: true and a validated label allowlist", async () => {
		const result = await loadConfig(
			fixture(
				"triage-on.yml",
				repo(
					'    triage: true\n    triage_labels:\n      - "type: bug"\n      - "priority: high"\n',
				),
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.repositories[0]?.triage).toBe(true);
			expect(result.config.repositories[0]?.triage_labels).toEqual(["type: bug", "priority: high"]);
		}
	});

	test("rejects a non-boolean triage flag", async () => {
		const result = await loadConfig(fixture("triage-bad.yml", repo("    triage: maybe\n")));
		expect(result.ok).toBe(false);
	});

	test("rejects a triage label carrying a structural character", async () => {
		const result = await loadConfig(
			fixture("triage-badlabel.yml", repo('    triage_labels:\n      - "bad\\nlabel"\n')),
		);
		expect(result.ok).toBe(false);
	});
});

describe("live verb dispatch config", () => {
	const base = {
		poll_interval_minutes: 15,
		repositories: [{ name: "rodaddy/x", provider: "github", checks: "standard" }],
	};

	test("is off by omission and accepts the explicit opt-in plus absolute manifest path", () => {
		const absent = configSchema.safeParse(base);
		expect(absent.success).toBe(true);
		if (absent.success) {
			expect(absent.data.repositories[0]?.verb_dispatch).toBeUndefined();
			expect(absent.data.railsManifestPath).toBeUndefined();
		}

		const enabled = configSchema.safeParse({
			...base,
			repositories: [{ ...base.repositories[0], verb_dispatch: true }],
			railsManifestPath: "/etc/rodaddy-watcher/factory-rails.yml",
		});
		expect(enabled.success).toBe(true);
	});

	test("rejects a relative manifest path and credential-shaped watcher key", () => {
		expect(
			configSchema.safeParse({ ...base, railsManifestPath: "factory-rails.yml" }).success,
		).toBe(false);
		expect(configSchema.safeParse({ ...base, forgeWriteCredential: "fixture" }).success).toBe(
			false,
		);
	});
});
