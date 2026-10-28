/**
 * Functional tests for the hosted-app schemas at their public boundary: each
 * rule the proposal names is exercised with an input that must pass and one
 * that must fail, so a rule silently dropped from the schema goes red here.
 */
import { describe, expect, test } from "bun:test";
import {
	declarationJsonSchema,
	declarationSchema,
	registryEntrySchema,
	tagPatternMatches,
} from "../../src/hostedapp/schema";

/** A minimal declaration that passes; tests mutate one field at a time. */
function baseDeclaration(): Record<string, unknown> {
	return {
		schema: "hosted-app/v1",
		name: "demo-app",
		owner: "rodaddy",
		image: { build: { containerfile: "Containerfile" } },
		runtime: {
			port: 8080,
			health: { path: "/healthz" },
			resources: {
				requests: { cpu: "50m", memory: "128Mi" },
				limits: { cpu: "500m", memory: "512Mi" },
			},
		},
		probe: { path: "/api/status" },
		targets: [{ name: "uat" }],
	};
}

/** A minimal registry entry that passes. */
function baseEntry(): Record<string, unknown> {
	const hex64 = "a".repeat(64);
	return {
		schema: "hosted-app-registry/v1",
		name: "demo-app",
		repo: "rodaddy/demo-app",
		declaration: "hosted-app.yaml",
		accepted: {
			ref: "b".repeat(40),
			declaration_sha256: hex64,
			images: { uat: { tag: "v0.1.0", image: `reg/demo:v0.1.0@sha256:${hex64}` } },
			by: "operator",
			on: "2026-09-07",
		},
		targets: [{ name: "uat", merge: "auto" }],
		state: "active",
	};
}

describe("declarationSchema", () => {
	test("accepts the minimal declaration and applies defaults", () => {
		const r = declarationSchema.safeParse(baseDeclaration());
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.image.build?.context).toBe(".");
		expect(r.data.image.build?.tag_pattern).toBe("v*");
		expect(r.data.runtime.replicas).toBe(1);
		expect(r.data.runtime.stateless).toBe(true);
		expect(r.data.probe.expect_status).toBe(200);
		expect(r.data.storage).toEqual([]);
	});

	test("rejects a wrong schema literal", () => {
		expect(
			declarationSchema.safeParse({ ...baseDeclaration(), schema: "hosted-app/v2" }).success,
		).toBe(false);
	});

	test("rejects an unknown key naming its path", () => {
		const r = declarationSchema.safeParse({ ...baseDeclaration(), bogus: 1 });
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
	});

	test("rejects an unknown key nested inside runtime", () => {
		const base = baseDeclaration();
		const runtime = base.runtime as Record<string, unknown>;
		expect(declarationSchema.safeParse({ ...base, runtime: { ...runtime, nope: 1 } }).success).toBe(
			false,
		);
	});

	test.each([
		["Demo", false],
		["-demo", false],
		["d", false],
		["de", true],
		["demo-app", true],
	])("name %s validity is %p", (name, valid) => {
		expect(declarationSchema.safeParse({ ...baseDeclaration(), name }).success).toBe(valid);
	});

	test("requires exactly one of build or pinned", () => {
		const hex64 = "a".repeat(64);
		expect(declarationSchema.safeParse({ ...baseDeclaration(), image: {} }).success).toBe(false);
		expect(
			declarationSchema.safeParse({
				...baseDeclaration(),
				image: { build: { containerfile: "Containerfile" }, pinned: { ref: `x@sha256:${hex64}` } },
			}).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({
				...baseDeclaration(),
				image: { pinned: { ref: `x@sha256:${hex64}` } },
			}).success,
		).toBe(true);
	});

	test("rejects a pinned ref without a full digest", () => {
		expect(
			declarationSchema.safeParse({
				...baseDeclaration(),
				image: { pinned: { ref: "ghcr.io/x:v1" } },
			}).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({
				...baseDeclaration(),
				image: { pinned: { ref: "ghcr.io/x@sha256:abc" } },
			}).success,
		).toBe(false);
	});

	test.each(["/Containerfile", "../Containerfile", "a/../../b"])(
		"rejects escaping containerfile %s",
		(containerfile) => {
			expect(
				declarationSchema.safeParse({ ...baseDeclaration(), image: { build: { containerfile } } })
					.success,
			).toBe(false);
		},
	);

	test.each([
		["v*", true],
		["*", false],
		["*v", false],
		["v*.*", false],
		["v1.0", true],
	])("tag_pattern %s validity is %p", (tag_pattern, valid) => {
		expect(
			declarationSchema.safeParse({
				...baseDeclaration(),
				image: { build: { containerfile: "Containerfile", tag_pattern } },
			}).success,
		).toBe(valid);
	});

	test("rejects an out-of-range port and a relative health path", () => {
		const base = baseDeclaration();
		const runtime = base.runtime as Record<string, unknown>;
		expect(declarationSchema.safeParse({ ...base, runtime: { ...runtime, port: 0 } }).success).toBe(
			false,
		);
		expect(
			declarationSchema.safeParse({ ...base, runtime: { ...runtime, port: 65536 } }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, runtime: { ...runtime, health: { path: "healthz" } } })
				.success,
		).toBe(false);
	});

	test("rejects a non-quantity resource value and a lowercase env key", () => {
		const base = baseDeclaration();
		const runtime = base.runtime as Record<string, unknown>;
		expect(
			declarationSchema.safeParse({
				...base,
				runtime: {
					...runtime,
					resources: {
						requests: { cpu: "fast", memory: "128Mi" },
						limits: { cpu: "1", memory: "1Gi" },
					},
				},
			}).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, runtime: { ...runtime, env: { log_level: "info" } } })
				.success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, runtime: { ...runtime, env: { LOG_LEVEL: "info" } } })
				.success,
		).toBe(true);
	});

	test("replicas > 1 requires stateless and no storage", () => {
		const base = baseDeclaration();
		const runtime = base.runtime as Record<string, unknown>;
		expect(
			declarationSchema.safeParse({
				...base,
				runtime: { ...runtime, replicas: 3, stateless: false },
			}).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({
				...base,
				runtime: { ...runtime, replicas: 3 },
				storage: [{ name: "data", mount: "/var/lib/app", size: "5Gi" }],
			}).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, runtime: { ...runtime, replicas: 3 } }).success,
		).toBe(true);
	});

	test("secrets need a non-empty item, keys, and unique names", () => {
		const base = baseDeclaration();
		const one = { name: "app-secrets", vaultwarden_item: "Item", keys: ["A_KEY"] };
		expect(declarationSchema.safeParse({ ...base, secrets: [one] }).success).toBe(true);
		expect(
			declarationSchema.safeParse({ ...base, secrets: [{ ...one, vaultwarden_item: "" }] }).success,
		).toBe(false);
		expect(declarationSchema.safeParse({ ...base, secrets: [{ ...one, keys: [] }] }).success).toBe(
			false,
		);
		expect(declarationSchema.safeParse({ ...base, secrets: [one, one] }).success).toBe(false);
	});

	test("database identifiers and env_key are constrained, with defaults", () => {
		const base = baseDeclaration();
		const db = { name: "demo_app", role: "demo_app", password_item: "Item" };
		const r = declarationSchema.safeParse({ ...base, database: db });
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.database?.cluster).toBe("general");
			expect(r.data.database?.env_key).toBe("DATABASE_URL");
		}
		expect(
			declarationSchema.safeParse({ ...base, database: { ...db, name: "Demo-App" } }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, database: { ...db, env_key: "database_url" } })
				.success,
		).toBe(false);
	});

	test("storage needs an absolute mount, Mi/Gi size, and unique names and mounts", () => {
		const base = baseDeclaration();
		const s = { name: "data", mount: "/var/lib/app", size: "5Gi" };
		expect(declarationSchema.safeParse({ ...base, storage: [s] }).success).toBe(true);
		expect(
			declarationSchema.safeParse({ ...base, storage: [{ ...s, mount: "var/lib/app" }] }).success,
		).toBe(false);
		expect(declarationSchema.safeParse({ ...base, storage: [{ ...s, size: "5G" }] }).success).toBe(
			false,
		);
		expect(
			declarationSchema.safeParse({ ...base, storage: [s, { ...s, name: "other" }] }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, storage: [s, { ...s, mount: "/other" }] }).success,
		).toBe(false);
	});

	test("cron needs five schedule fields and a non-empty command", () => {
		const base = baseDeclaration();
		const c = { name: "nightly", schedule: "17 3 * * *", command: ["run"] };
		expect(declarationSchema.safeParse({ ...base, cron: [c] }).success).toBe(true);
		expect(
			declarationSchema.safeParse({ ...base, cron: [{ ...c, schedule: "17 3 * *" }] }).success,
		).toBe(false);
		expect(declarationSchema.safeParse({ ...base, cron: [{ ...c, command: [] }] }).success).toBe(
			false,
		);
		expect(
			declarationSchema.safeParse({ ...base, cron: [{ ...c, name: "n".repeat(53) }] }).success,
		).toBe(false);
	});

	test("config_files paths are relative and mounts absolute and unique", () => {
		const base = baseDeclaration();
		const f = { name: "app-config", mount: "/etc/app/c.yaml", path: "deploy/c.yaml" };
		expect(declarationSchema.safeParse({ ...base, config_files: [f] }).success).toBe(true);
		expect(
			declarationSchema.safeParse({ ...base, config_files: [{ ...f, path: "/deploy/c.yaml" }] })
				.success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, config_files: [{ ...f, path: "../c.yaml" }] }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, config_files: [f, { ...f, name: "two" }] }).success,
		).toBe(false);
	});

	test.each([
		[{ host: "a.rtech.internal", public: false }, true],
		[{ host: "a.rtech.internal", public: true }, false],
		[{ host: "a.local", public: true }, false],
		[{ host: "a.lan", public: true }, false],
		[{ host: "a.example.net", public: true }, true],
		[{ host: "A.example.net" }, false],
	])("hostname %o validity is %p", (host, valid) => {
		expect(declarationSchema.safeParse({ ...baseDeclaration(), hostnames: [host] }).success).toBe(
			valid,
		);
	});

	test("duplicate hostnames fail", () => {
		const h = { host: "a.example.net", public: true };
		expect(declarationSchema.safeParse({ ...baseDeclaration(), hostnames: [h, h] }).success).toBe(
			false,
		);
	});

	test("probe is required and bounded", () => {
		const base = baseDeclaration();
		const { probe: _drop, ...withoutProbe } = base;
		expect(declarationSchema.safeParse(withoutProbe).success).toBe(false);
		expect(declarationSchema.safeParse({ ...base, probe: { path: "status" } }).success).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, probe: { path: "/s", expect_status: 99 } }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, probe: { path: "/s", expect_status: 599 } }).success,
		).toBe(true);
	});

	test("targets must be non-empty, uniquely named, and within the 63-char combined limit", () => {
		const base = baseDeclaration();
		expect(declarationSchema.safeParse({ ...base, targets: [] }).success).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, targets: [{ name: "uat" }, { name: "uat" }] }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, targets: [{ name: "a".repeat(17) }] }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({
				...base,
				name: "a".repeat(40),
				targets: [{ name: "b".repeat(16) }],
			}).success,
		).toBe(true);
	});

	test("overrides accept only the allowlisted keys, and merge and tag_pattern are not target fields", () => {
		const base = baseDeclaration();
		for (const key of ["runtime", "hostnames", "storage", "cron", "config_files"]) {
			expect(
				declarationSchema.safeParse({
					...base,
					targets: [{ name: "uat", overrides: { [key]: {} } }],
				}).success,
			).toBe(true);
		}
		expect(
			declarationSchema.safeParse({ ...base, targets: [{ name: "uat", overrides: { image: {} } }] })
				.success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, targets: [{ name: "uat", merge: "auto" }] }).success,
		).toBe(false);
		expect(
			declarationSchema.safeParse({ ...base, targets: [{ name: "uat", tag_pattern: "v*" }] })
				.success,
		).toBe(false);
	});
});

describe("registryEntrySchema", () => {
	test("accepts the minimal entry", () => {
		expect(registryEntrySchema.safeParse(baseEntry()).success).toBe(true);
	});

	test("rejects a wrong schema literal and an unknown key", () => {
		expect(registryEntrySchema.safeParse({ ...baseEntry(), schema: "hosted-app/v1" }).success).toBe(
			false,
		);
		expect(registryEntrySchema.safeParse({ ...baseEntry(), bogus: true }).success).toBe(false);
	});

	test.each(["rodaddy", "Rodaddy/demo", "rodaddy/demo/extra"])(
		"rejects malformed repo %s",
		(repo) => {
			expect(registryEntrySchema.safeParse({ ...baseEntry(), repo }).success).toBe(false);
		},
	);

	test("rejects a branch name, a short sha, and a short declaration hash", () => {
		const base = baseEntry();
		const accepted = base.accepted as Record<string, unknown>;
		expect(
			registryEntrySchema.safeParse({ ...base, accepted: { ...accepted, ref: "main" } }).success,
		).toBe(false);
		expect(
			registryEntrySchema.safeParse({ ...base, accepted: { ...accepted, ref: "b".repeat(39) } })
				.success,
		).toBe(false);
		expect(
			registryEntrySchema.safeParse({
				...base,
				accepted: { ...accepted, declaration_sha256: "9c1f" },
			}).success,
		).toBe(false);
	});

	test("an accepted image must carry a digest, and a pinned entry may omit the tag", () => {
		const base = baseEntry();
		const accepted = base.accepted as Record<string, unknown>;
		const hex64 = "a".repeat(64);
		expect(
			registryEntrySchema.safeParse({
				...base,
				accepted: { ...accepted, images: { uat: { tag: "v1", image: "reg/demo:v1" } } },
			}).success,
		).toBe(false);
		expect(
			registryEntrySchema.safeParse({
				...base,
				accepted: { ...accepted, images: { uat: { image: `reg/demo@sha256:${hex64}` } } },
			}).success,
		).toBe(true);
	});

	test.each(["2026-9-7", "07-09-2026", "yesterday"])("rejects accepted.on %s", (on) => {
		const base = baseEntry();
		expect(
			registryEntrySchema.safeParse({ ...base, accepted: { ...(base.accepted as object), on } })
				.success,
		).toBe(false);
	});

	test("the image-key set must equal the target-name set, so --registry-only catches both gaps", () => {
		const base = baseEntry();
		const accepted = base.accepted as Record<string, unknown>;
		const images = accepted.images as Record<string, unknown>;
		const missing = registryEntrySchema.safeParse({
			...base,
			targets: [
				{ name: "uat", merge: "auto" },
				{ name: "prod", merge: "manual" },
			],
		});
		expect(missing.success).toBe(false);
		if (!missing.success) {
			expect(missing.error.issues.some((i) => i.path.join(".") === "accepted.images.prod")).toBe(
				true,
			);
		}
		const extra = registryEntrySchema.safeParse({
			...base,
			accepted: { ...accepted, images: { ...images, stray: images.uat } },
		});
		expect(extra.success).toBe(false);
		if (!extra.success) {
			expect(
				extra.error.issues.some((i) => i.message === "image for undeclared target stray"),
			).toBe(true);
		}
	});

	test("a target named after an Object.prototype key still needs its own image", () => {
		const base = baseEntry();
		const r = registryEntrySchema.safeParse({
			...base,
			targets: [
				{ name: "uat", merge: "auto" },
				{ name: "constructor", merge: "manual" },
			],
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.some((i) => i.path.join(".") === "accepted.images.constructor")).toBe(
				true,
			);
		}
	});

	test("an accepted image is a complete anchored reference: no trailing garbage, a name is required", () => {
		const base = baseEntry();
		const accepted = base.accepted as Record<string, unknown>;
		const hex64 = "a".repeat(64);
		for (const bad of [
			`reg/demo@sha256:${hex64}!`,
			`@sha256:${hex64}`,
			`reg/demo@sha256:${hex64}0`,
		]) {
			const r = registryEntrySchema.safeParse({
				...base,
				accepted: { ...accepted, images: { uat: { tag: "v1", image: bad } } },
			});
			expect(r.success).toBe(false);
		}
		const good = registryEntrySchema.safeParse({
			...base,
			accepted: {
				...accepted,
				images: { uat: { tag: "v1", image: `10.0.20.58:3000/rtech/demo:v1@sha256:${hex64}` } },
			},
		});
		expect(good.success).toBe(true);
	});

	test.each([
		["active", true],
		["paused", true],
		["retired", true],
		["archived", false],
	])("state %s validity is %p", (state, valid) => {
		expect(registryEntrySchema.safeParse({ ...baseEntry(), state }).success).toBe(valid);
	});
});

describe("tagPatternMatches", () => {
	test.each([
		["v*", "v0.3.0", true],
		["v*", "0.3.0", false],
		["v1.0", "v1.0", true],
		["v1.0", "v1.1", false],
		["release-*", "release-9", true],
	])("pattern %s against %s is %p", (pattern, tag, expected) => {
		expect(tagPatternMatches(pattern, tag)).toBe(expected);
	});
});

describe("declarationJsonSchema", () => {
	test("emits an object schema naming the declaration's top-level keys", () => {
		const schema = declarationJsonSchema();
		expect(schema.type).toBe("object");
		const properties = schema.properties as Record<string, unknown>;
		for (const key of ["schema", "name", "owner", "image", "runtime", "probe", "targets"]) {
			expect(properties[key]).toBeDefined();
		}
	});
});

describe("declarationJsonSchema cross-field rules", () => {
	test("image carries the build-xor-pinned rule and the schema names itself structural", () => {
		const schema = declarationJsonSchema();
		const image = (schema.properties as Record<string, Record<string, unknown>>).image;
		expect(image?.oneOf).toEqual([
			{ required: ["build"], not: { required: ["pinned"] } },
			{ required: ["pinned"], not: { required: ["build"] } },
		]);
		expect(String(schema.$comment)).toContain("Structural schema only");
	});
});
