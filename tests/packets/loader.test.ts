import { describe, expect, test } from "bun:test";
import { loadPackets, parsePacket } from "../../src/packets/loader";
import { packetsDir } from "../../src/packets/registry";
import { PACKET_BODY_SECTIONS } from "../../src/packets/schema";

/**
 * A minimal WELL-FORMED packet: valid frontmatter plus all five fixed sections.
 * Built here (not read from disk) so each malformed case below mutates exactly one
 * property away from a known-good baseline, and the named boot error can be pinned
 * to that single mutation.
 */
function goodPacket(id = "sample"): string {
	const sections = PACKET_BODY_SECTIONS.map((s) => `# ${s}\n\nprose for ${s}.`).join("\n\n");
	return `---\nid: ${id}\nversion: 1\nlane: ${id}\nruntime: pi\nmodel: gpt-5.6-sol\neffort: low\naccepts_extras: none\noutput: watcher-result/v1\n---\n\n${sections}\n`;
}

describe("parsePacket accepts a well-formed packet", () => {
	test("validates frontmatter and extracts every fixed section", () => {
		const parsed = parsePacket(goodPacket(), "sample");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.packet.frontmatter.id).toBe("sample");
		expect(parsed.packet.frontmatter.accepts_extras).toBe("none");
		expect(parsed.packet.frontmatter.effort).toBe("low");
		for (const section of PACKET_BODY_SECTIONS) {
			expect(parsed.packet.sections[section]).toContain(`prose for ${section}`);
		}
	});
});

describe("a malformed packet fails validation with a named error", () => {
	// Each case is ONE mutation away from goodPacket(). The mutation-proof property:
	// break the loader validation and these named errors vanish (proven in the
	// mutation section below).

	test("a missing fixed section is a named error", () => {
		// Drop the 'Goals' section heading from an otherwise-good packet.
		const raw = goodPacket().replace("# Goals\n\nprose for Goals.\n\n", "");
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("packet sample");
		expect(parsed.error).toContain("missing 'Goals' section");
	});

	test("an unknown frontmatter key is a named error (strict frontmatter)", () => {
		const raw = goodPacket().replace(
			"accepts_extras: none\n",
			"accepts_extras: none\nbackdoor: true\n",
		);
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("invalid frontmatter");
		expect(parsed.error).toContain("backdoor");
	});

	test("a bad accepts_extras value is a named error", () => {
		const raw = goodPacket().replace("accepts_extras: none", "accepts_extras: sometimes");
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("invalid frontmatter");
		expect(parsed.error).toContain("accepts_extras");
	});

	test("a non-integer version is a named error", () => {
		const raw = goodPacket().replace("version: 1", "version: 1.5");
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("invalid frontmatter");
		expect(parsed.error).toContain("version");
	});

	test("a missing frontmatter fence is a named error", () => {
		const parsed = parsePacket("# Identity\n\nno frontmatter here", "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("missing leading '---' frontmatter fence");
	});

	test("an unterminated frontmatter fence is a named error", () => {
		const parsed = parsePacket("---\nid: sample\nversion: 1\n\n# Identity\nprose", "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("unterminated frontmatter fence");
	});

	test("a duplicate fixed section is a named error", () => {
		const raw = goodPacket().replace(
			"# Expected Output\n\nprose for Expected Output.",
			"# Expected Output\n\nprose for Expected Output.\n\n# Goals\n\nsecond goals.",
		);
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("duplicate 'Goals' section");
	});

	// The model id is composed into the pi route as `cliproxy/<model>:<effort>`, so
	// any character that carries meaning IN that composition — whitespace, `/`, `:`
	// — must be refused at the boot boundary rather than silently redirecting the
	// route. Each case below is one mutation of the model field only.
	test.each([
		["whitespace-only", '"   "'],
		["an embedded space", '"gpt 5.6 sol"'],
		["a slash", '"cliproxy/gpt-5.6-sol"'],
		["a colon", '"gpt-5.6-sol:high"'],
		["a control character", '"gpt-5.6\\u0007sol"'],
	])("a model id containing %s is a named error", (_label, literal) => {
		const raw = goodPacket().replace("model: gpt-5.6-sol", `model: ${literal}`);
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("invalid frontmatter");
		expect(parsed.error).toContain("model");
	});

	test("a bare routed model id is accepted", () => {
		const parsed = parsePacket(goodPacket(), "sample");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.packet.frontmatter.model).toBe("gpt-5.6-sol");
	});

	// The name binding is a PARSER check, not a boot-walk one. It
	// used to live in `loadPackets`, so a mismatched packet passed `check:packets`
	// and the receipt gate and only failed after merge — and a mismatched LANE
	// passed even the boot, loading with a silently false lane. Both are pinned
	// here, at the shared parser every path arrives through.
	test("a frontmatter id that disagrees with the packet name is a named error", () => {
		const parsed = parsePacket(goodPacket("other"), "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toBe("packet sample: frontmatter id 'other' does not match filename");
	});

	test("a frontmatter LANE that disagrees with the packet name is a named error", () => {
		// The lane is what the runtime/model route is reviewed against, so a packet
		// declaring another lane dispatches as a lane nobody reviewed it for. The
		// registry keys off the filename stem, so nothing downstream notices.
		const raw = goodPacket("sample").replace("lane: sample", "lane: elsewhere");
		const parsed = parsePacket(raw, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toBe(
			"packet sample: frontmatter lane 'elsewhere' does not match filename",
		);
	});

	test("a named error NEVER echoes the packet body prose", () => {
		// The packet is trusted config, but an error is not a place to leak a prompt.
		const raw = goodPacket().replace("prose for Goals.", "SECRET-BODY-CONTENT-SHOULD-NOT-APPEAR");
		// Force a DIFFERENT failure (missing Identity) so the error is about the body.
		const broken = raw.replace("# Identity\n\nprose for Identity.\n\n", "");
		const parsed = parsePacket(broken, "sample");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).not.toContain("SECRET-BODY-CONTENT-SHOULD-NOT-APPEAR");
	});
});

describe("loadPackets validates the real repo packets directory (the boot input)", () => {
	test("the shipped packets/ directory loads clean and carries issue-triage", async () => {
		const loaded = await loadPackets(packetsDir());
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.packets.has("issue-triage")).toBe(true);
		const triage = loaded.packets.get("issue-triage");
		expect(triage?.frontmatter.lane).toBe("issue-triage");
		// Version 3 adds the fixed read-only issue fetch. Version 2
		// opened exactly one tier-2 extra for a revived attempt's bounded,
		// watcher-authored prior failure; that posture remains unchanged.
		expect(triage?.frontmatter.version).toBe(3);
		expect(triage?.frontmatter.accepts_extras).toBe("allowed");
	});

	test("a missing directory is a bounded named failure, not a throw", async () => {
		const loaded = await loadPackets("does/not/exist/packets");
		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.error).toContain("packets directory could not be read");
	});
});
