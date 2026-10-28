import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parsePacket } from "../../src/packets/loader";
import { renderPacketScaffold } from "../../src/packets/scaffold";
import {
	PACKET_BODY_SECTIONS,
	PACKET_SCAFFOLD_MARKER,
	packetFrontmatterSchema,
} from "../../src/packets/schema";

/** Pull the raw frontmatter block out of a scaffold so it can be schema-checked alone. */
function frontmatterOf(text: string): unknown {
	const end = text.indexOf("\n---\n", 4);
	return parseYaml(text.slice(4, end));
}

/**
 * The scaffold with its `runtime` marker replaced by a real runtime — the one
 * deliberate choice an author makes in frontmatter (the
 * scaffolder does NOT default `runtime`). Body stubs are untouched.
 */
function withRuntime(text: string, runtime: string): string {
	const line = text.split("\n").find((l) => l.startsWith("runtime:"));
	if (line === undefined) throw new Error("scaffold rendered no runtime line");
	return text.replace(line, `runtime: ${runtime}`);
}

describe("packet scaffold", () => {
	test("emits frontmatter the strict schema accepts once runtime is chosen", () => {
		const parsed = packetFrontmatterSchema.safeParse(
			frontmatterOf(withRuntime(renderPacketScaffold("demo"), "pi")),
		);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.id).toBe("demo");
		expect(parsed.data.lane).toBe("demo");
		// Closed by default: a new packet is tier-1-locked until an author opens it.
		expect(parsed.data.accepts_extras).toBe("none");
		// Every OTHER required key is stamped with a real value, so the runtime
		// refusal below is about runtime alone and not a half-rendered frontmatter.
		expect(parsed.data.runtime).toBe("pi");
	});

	test("does NOT default runtime — the raw scaffold is REFUSED naming runtime", () => {
		// a silent runtime default is the same footgun as
		// the derived runtime #175's review removed — the wrong rail dispatches
		// quietly and nothing goes red. The marker makes YAML yield the string
		// `TODO(make-packet)`, which the schema's closed runtime enum refuses BY
		// NAME, so a new packet cannot boot until an author picks on purpose.
		const text = renderPacketScaffold("demo");
		expect(text).toContain(`runtime: ${PACKET_SCAFFOLD_MARKER}`);
		// The suggestion travels with the marker rather than being stamped as a value.
		expect(text).toContain("pi is the suggested rail");
		const parsed = parsePacket(text, "demo");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("runtime");
	});

	test("the scaffolded packet PARSES through the loader once runtime AND stubs are filled", () => {
		// The cross-PR guard: `parsePacket` runs the same strict frontmatter schema
		// the merged #175 tightened, so this goes red the moment the scaffold and
		// the schema disagree about a required key.
		const parsed = parsePacket(authored(), "demo");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.packet.frontmatter.runtime).toBe("pi");
	});

	test("emits ALL five fixed body sections", () => {
		const text = renderPacketScaffold("demo");
		for (const section of PACKET_BODY_SECTIONS) {
			expect(text).toContain(`# ${section}`);
		}
	});

	test("is STRUCTURALLY well-formed but the loader REFUSES it while stubs remain", () => {
		// The whole posture in one test: the shape is right, so an author sees a
		// valid skeleton; the content is provably not authored, so it cannot boot.
		// Runtime is already chosen here, so the refusal is the BODY stubs — the
		// frontmatter refusal has its own test above.
		const text = withRuntime(renderPacketScaffold("demo"), "pi");
		const parsed = parsePacket(text, "demo");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain(PACKET_SCAFFOLD_MARKER);
		expect(parsed.error).toContain("scaffold stub");
	});

	test("the refusal is the STUB, not a structural fault — filling every stub loads", () => {
		// Proves the previous test fails for the intended reason. If the scaffold
		// were structurally broken (a missing section, bad frontmatter), replacing
		// the markers would not be enough to make it load.
		expect(parsePacket(authored(), "demo").ok).toBe(true);
	});

	test("every section carries a stub, so no section can be forgotten silently", () => {
		const text = withRuntime(renderPacketScaffold("demo"), "pi");
		const filledOne = text.replace(PACKET_SCAFFOLD_MARKER, "Authored");
		// One replacement is not enough: the remaining sections still refuse.
		expect(parsePacket(filledOne, "demo").ok).toBe(false);
	});
});

/**
 * An authored packet for `demo` — runtime chosen and every body stub replaced,
 * so it parses clean. Runtime is filled FIRST and separately: the scaffolder
 * stamps the same marker there, and blanket-replacing it with prose would leave
 * an invalid runtime rather than an authored packet.
 */
function authored(): string {
	return withRuntime(renderPacketScaffold("demo"), "pi").replaceAll(
		PACKET_SCAFFOLD_MARKER,
		"Authored",
	);
}

describe("scaffold-marker detection", () => {
	test("the authored baseline parses — every RED below is the marker, not the shape", () => {
		expect(parsePacket(authored(), "demo").ok).toBe(true);
	});

	// The near-miss variants an author produces by retyping the marker rather than
	// leaving the generated literal. Each one is still a placeholder reaching a
	// runner as if it were an authored system prompt.
	for (const variant of ["TODO(make_packet)", "TODO[make-packet]", "todo (make-packet)"]) {
		test(`REFUSES the hand-retyped variant '${variant}'`, () => {
			const text = authored().replace("# Goals\n\nAuthored", `# Goals\n\n${variant}`);
			expect(text).toContain(variant);
			const parsed = parsePacket(text, "demo");
			expect(parsed.ok).toBe(false);
			if (parsed.ok) return;
			expect(parsed.error).toContain("scaffold stub");
			// The section is still named when the hit sits inside a fixed section.
			expect(parsed.error).toContain("'Goals'");
		});
	}

	test("REFUSES a stub under a NON-fixed heading, which per-section matching could not see", () => {
		// `extractSections` only maps the five fixed headings, so a stub living
		// under any other heading was never scanned at all. Body-level scanning is
		// what closes it; the error falls back to naming the body.
		const text = `${authored()}\n\n# Appendix\n\n${PACKET_SCAFFOLD_MARKER}: fill this in\n`;
		const parsed = parsePacket(text, "demo");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("scaffold stub");
		expect(parsed.error).toContain("body still carries");
	});

	test("a bare TODO in prose is NOT a marker — the packet may discuss the word", () => {
		const text = authored().replace(
			"# Goals\n\nAuthored",
			"# Goals\n\nTODO items in the target repo are in scope for triage.",
		);
		expect(parsePacket(text, "demo").ok).toBe(true);
	});

	// The pattern is anchored to line start. The scaffolder emits every marker at
	// the start of its own line, so the anchor loses no detection — but it stops
	// the widened pattern from bricking a packet that DOCUMENTS the marker, which
	// was refused at boot with a misleading "unfilled stub" error.
	test("an authored packet whose PROSE quotes the marker mid-line BOOTS", () => {
		const text = authored().replace(
			"# Goals\n\nAuthored",
			`# Goals\n\nA scaffolded section still carrying ${PACKET_SCAFFOLD_MARKER} is refused at boot.`,
		);
		expect(text).toContain(PACKET_SCAFFOLD_MARKER);
		expect(parsePacket(text, "demo").ok).toBe(true);
	});

	test("a markdown link reading 'todo [make-packet](...)' mid-line BOOTS", () => {
		const text = authored().replace(
			"# Goals\n\nAuthored",
			"# Goals\n\nSee the todo [make-packet](../scripts/make-packet.ts) scaffolder for the stub shape.",
		);
		expect(parsePacket(text, "demo").ok).toBe(true);
	});
});
