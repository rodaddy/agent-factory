import { describe, expect, test } from "bun:test";
import { readFactoryStaticPolicy } from "../../src/config/factory-yml";
import { STATIC_GATES } from "../../src/infra/gates";

// The policy is read from git objects (ls-tree mode + show text), never a checkout.
const withPolicy = (body: string | null, mode = "100644") =>
	readFactoryStaticPolicy(body === null ? null : { mode, text: body });

describe("readFactoryStaticPolicy", () => {
	test("an absent factory.yml is the default: all four gates, no lintrc", async () => {
		const r = await withPolicy(null);
		expect(r).toEqual({
			ok: true,
			policy: { source: "default", gates: [...STATIC_GATES], lintrc: {} },
		});
	});

	test("a gates subset restricts the policy, in fixed gate order; other top-level keys ignored", async () => {
		const r = await withPolicy(
			"app: web\nstatic:\n  gates: [scripts, ansible]\n  shellcheck_rc: .shellcheckrc\n",
		);
		expect(r).toEqual({
			ok: true,
			policy: {
				source: "factory.yml",
				gates: ["ansible", "scripts"],
				lintrc: { shellcheck_rc: ".shellcheckrc" },
			},
		});
	});

	test("a bad gate name is a refusal naming the field", async () => {
		const r = await withPolicy("static:\n  gates: [ansible, docker]\n");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toStartWith("factory.yml static.gates.1:");
	});

	test("path traversal, absolute paths, a leading dash and shell syntax in a lintrc path are refused", async () => {
		for (const bad of ["../x.yml", "/etc/yamllint", "a/../../b", "x;rm -rf .", "$(id)", "-c/x"]) {
			const r = await withPolicy(`static:\n  yamllint_config: ${JSON.stringify(bad)}\n`);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toStartWith("factory.yml static.yamllint_config:");
		}
	});

	test("an unknown key under static: is refused, naming it", async () => {
		const r = await withPolicy("static:\n  gatez: [ansible]\n");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("static.gatez");
	});

	test("an unknown key name is sanitized: no markdown and no zod message text is echoed", async () => {
		const evil = JSON.stringify(`x](https://evil.invalid) **pwn** ${"y".repeat(100)}`);
		const r = await withPolicy(`static:\n  ${evil}: 1\n`);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		const field = r.error.slice("factory.yml ".length, r.error.indexOf(": "));
		expect(field).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
		expect(r.error).not.toContain("](");
		expect(r.error).not.toContain("**");
		expect(r.error).not.toContain("Unrecognized");
	});

	test("a factory.yml that is a symlink (mode 120000) or anything but 100644 is refused", async () => {
		for (const mode of ["120000", "100755", "040000", "160000"]) {
			const r = await withPolicy("static:\n  gates: [scripts]\n", mode);
			expect(r).toEqual({ ok: false, error: "factory.yml (file): is not a regular file" });
		}
	});

	test("an oversized policy text is refused", async () => {
		const r = await withPolicy(`# ${"x".repeat(20000)}\n`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("exceeds");
	});
});
