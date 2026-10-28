/**
 * @module hostedapp/schema
 * @description Strict Zod v4 schemas for the two hosted-app documents: the
 *   declaration (`hosted-app/v1`) that lives in a product repo and the registry
 *   entry (`hosted-app-registry/v1`) that lives in the registry repo. Every
 *   object is `.strict()`, so an unknown key anywhere is a validation failure
 *   naming its path rather than a silently dropped field.
 *
 * @outputs
 *   - `declarationSchema` / `Declaration` -- the product-repo document
 *   - `registryEntrySchema` / `RegistryEntry` -- the accepted pointer
 *   - `declarationJsonSchema` -- JSON Schema rendering of the declaration
 *   - `dns1123`, `tagPatternMatches` -- shared primitives used by validate.ts
 *
 * @dependencies
 *   - zod -- schema definition and JSON Schema emission
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { z } from "zod";
import { traced } from "../log";

/** DNS-1123 label: lowercase alphanumeric with internal dashes. */
export const DNS1123 = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const PG_IDENT = /^[a-z_][a-z0-9_]*$/;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|Mi|Gi|Ki|M|G|K)?$/;
/** A complete image reference: name[:tag]@sha256:<64 hex>, anchored at both ends. */
const DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A DNS-1123 label bounded by `max` characters. */
function dns1123(max: number, min = 2): z.ZodString {
	return z.string().min(min).max(max).regex(DNS1123, "must be a DNS-1123 label");
}

/** Reject absolute paths and any `..` traversal segment in a repo-relative path. */
const relativePath = z
	.string()
	.min(1)
	.refine((v) => !v.startsWith("/"), "must be a relative path, no leading /")
	.refine((v) => !v.split("/").includes(".."), "must not contain a .. segment");

const absolutePath = z.string().min(1).startsWith("/", "must be an absolute path");

/**
 * The build_bump tag-pattern rule: one anchored glob, at most one `*`, first
 * character alphanumeric, never a bare `*`.
 */
const tagPattern = z
	.string()
	.min(1)
	.refine((v) => (v.match(/\*/g) ?? []).length <= 1, "at most one * is allowed")
	.refine((v) => v !== "*", "a bare * is not an anchored pattern")
	.refine((v) => /^[A-Za-z0-9]/.test(v), "first character must be alphanumeric");

/** True when `tag` matches a build_bump `tag_pattern` glob. */
export const tagPatternMatches = traced(
	"hostedapp.tagPatternMatches",
	function tagPatternMatches(pattern: string, tag: string): boolean {
		const star = pattern.indexOf("*");
		if (star === -1) return tag === pattern;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		return (
			tag.length >= prefix.length + suffix.length && tag.startsWith(prefix) && tag.endsWith(suffix)
		);
	},
);

/** A DNS name: lowercase DNS-1123 labels joined by dots, 253 chars total. */
const hostname = z
	.string()
	.min(1)
	.max(253)
	.refine(
		(v) => v.split(".").every((l) => l.length > 0 && l.length <= 63 && DNS1123.test(l)),
		"must be a valid DNS name",
	);

/** Fail when a list has duplicate values of `pick`, naming the field. */
function unique<T>(pick: (item: T) => string, field: string) {
	return (items: T[], ctx: z.RefinementCtx): void => {
		const seen = new Set<string>();
		items.forEach((item, i) => {
			const key = pick(item);
			if (seen.has(key)) {
				ctx.addIssue({ code: "custom", path: [i, field], message: `duplicate ${field}: ${key}` });
			}
			seen.add(key);
		});
	};
}

const buildSchema = z
	.object({
		containerfile: relativePath,
		context: relativePath.default("."),
		tag_pattern: tagPattern.default("v*"),
	})
	.strict();

const pinnedSchema = z
	.object({
		ref: z.string().min(1).regex(DIGEST, "must carry an @sha256: digest of 64 hex characters"),
	})
	.strict();

const imageSchema = z
	.object({ build: buildSchema.optional(), pinned: pinnedSchema.optional() })
	.strict()
	.refine(
		(v) => (v.build === undefined) !== (v.pinned === undefined),
		"exactly one of build or pinned is required",
	);

const resourceBlock = z
	.object({
		cpu: z.string().regex(QUANTITY, "must be a k8s quantity"),
		memory: z.string().regex(QUANTITY, "must be a k8s quantity"),
	})
	.strict();

const runtimeSchema = z
	.object({
		port: z.int().min(1).max(65535),
		health: z.object({ path: absolutePath, port: z.int().min(1).max(65535).optional() }).strict(),
		resources: z.object({ requests: resourceBlock, limits: resourceBlock }).strict(),
		env: z
			.record(z.string().regex(ENV_KEY, "env key must be an upper-snake identifier"), z.string())
			.default({}),
		command: z.array(z.string()).default([]),
		replicas: z.int().min(0).default(1),
		stateless: z.boolean().default(true),
	})
	.strict();

const secretSchema = z
	.object({
		name: dns1123(63),
		vaultwarden_item: z.string().min(1),
		keys: z.array(z.string().regex(SECRET_KEY, "must be a valid secret key name")).min(1),
	})
	.strict();

const databaseSchema = z
	.object({
		cluster: dns1123(63).default("general"),
		name: z.string().regex(PG_IDENT, "must be a lowercase SQL identifier"),
		role: z.string().regex(PG_IDENT, "must be a lowercase SQL identifier"),
		extensions: z.array(z.string()).default([]),
		password_item: z.string().min(1),
		env_key: z.string().regex(ENV_KEY, "must be an upper-snake identifier").default("DATABASE_URL"),
	})
	.strict();

const storageSchema = z
	.object({
		name: dns1123(63),
		mount: absolutePath,
		size: z.string().regex(/^[0-9]+(\.[0-9]+)?(Mi|Gi)$/, "must be a k8s quantity ending Mi or Gi"),
	})
	.strict();

const cronSchema = z
	.object({
		name: dns1123(52),
		schedule: z
			.string()
			.refine(
				(v) => v.trim().split(/\s+/).length === 5,
				"must be five whitespace-separated cron fields",
			),
		command: z.array(z.string()).min(1),
	})
	.strict();

const configFileSchema = z
	.object({ name: dns1123(63), mount: absolutePath, path: relativePath })
	.strict();

const hostnameSchema = z
	.object({ host: hostname, public: z.boolean().default(false) })
	.strict()
	.refine(
		(v) => !(v.public && /\.(internal|local|lan)$/.test(v.host)),
		"public: true is not allowed on a private zone (.internal, .local, .lan)",
	);

const probeSchema = z
	.object({
		path: absolutePath,
		expect_status: z.int().min(100).max(599).default(200),
		expect_body_contains: z.string().optional(),
	})
	.strict();

/** Keys a target override may name; anything else fails naming the key. */
export const OVERRIDE_KEYS = ["runtime", "hostnames", "storage", "cron", "config_files"] as const;

const overridesSchema = z.record(z.string(), z.unknown()).superRefine((v, ctx) => {
	for (const key of Object.keys(v)) {
		if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
			ctx.addIssue({ code: "custom", path: [key], message: `overrides may not name ${key}` });
		}
	}
});

const targetSchema = z
	.object({ name: dns1123(16), overrides: overridesSchema.optional() })
	.strict();

/** The product-repo declaration, `hosted-app/v1`. */
export const declarationSchema = z
	.object({
		schema: z.literal("hosted-app/v1"),
		name: dns1123(40),
		owner: z.string().min(1),
		description: z.string().optional(),
		image: imageSchema,
		runtime: runtimeSchema,
		secrets: z
			.array(secretSchema)
			.superRefine(unique((s) => s.name, "name"))
			.default([]),
		database: databaseSchema.optional(),
		storage: z
			.array(storageSchema)
			.superRefine(unique((s) => s.name, "name"))
			.superRefine(unique((s) => s.mount, "mount"))
			.default([]),
		cron: z
			.array(cronSchema)
			.superRefine(unique((c) => c.name, "name"))
			.default([]),
		config_files: z
			.array(configFileSchema)
			.superRefine(unique((c) => c.name, "name"))
			.superRefine(unique((c) => c.mount, "mount"))
			.default([]),
		hostnames: z
			.array(hostnameSchema)
			.superRefine(unique((h) => h.host, "host"))
			.default([]),
		probe: probeSchema,
		targets: z
			.array(targetSchema)
			.min(1)
			.superRefine(unique((t) => t.name, "name")),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.runtime.replicas > 1 && !v.runtime.stateless) {
			ctx.addIssue({
				code: "custom",
				path: ["runtime", "replicas"],
				message: "replicas > 1 requires runtime.stateless: true",
			});
		}
		if (v.runtime.replicas > 1 && v.storage.length > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["runtime", "replicas"],
				message: "replicas > 1 is not allowed with storage",
			});
		}
		v.targets.forEach((t, i) => {
			const combined = `${v.name}-${t.name}`;
			if (combined.length > 63) {
				ctx.addIssue({
					code: "custom",
					path: ["targets", i, "name"],
					message: `<name>-<target> is ${combined.length} chars, max 63`,
				});
			}
		});
	});

export type Declaration = z.infer<typeof declarationSchema>;

const acceptedImageSchema = z
	.object({
		tag: z.string().min(1).optional(),
		image: z.string().min(1).regex(DIGEST, "must carry an @sha256: digest of 64 hex characters"),
	})
	.strict();

/** Merge policy is per target, and `prod` is not special (k3s.md row 350, the owner 2026-09-04). */
const registryTargetSchema = z
	.object({ name: dns1123(16), merge: z.enum(["auto", "manual"]) })
	.strict();

/** The registry-repo accepted pointer, `hosted-app-registry/v1`. */
export const registryEntrySchema = z
	.object({
		schema: z.literal("hosted-app-registry/v1"),
		name: dns1123(40),
		repo: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/, "must be <owner>/<repo>"),
		declaration: relativePath,
		accepted: z
			.object({
				ref: z.string().regex(HEX40, "must be a full 40-hex commit sha"),
				declaration_sha256: z.string().regex(HEX64, "must be a 64-hex sha256"),
				images: z.record(dns1123(16), acceptedImageSchema),
				by: z.string().min(1),
				on: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
			})
			.strict(),
		targets: z
			.array(registryTargetSchema)
			.min(1)
			.superRefine(unique((t) => t.name, "name")),
		state: z.enum(["active", "paused", "retired"]),
		notes: z.string().optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		// The image-key set must equal the target-name set, so a registry-only
		// check (the registry CI) catches a target with no accepted image and an
		// image for a target that does not exist.
		const targets = new Set(v.targets.map((t) => t.name));
		for (const t of targets) {
			if (!Object.hasOwn(v.accepted.images, t)) {
				ctx.addIssue({
					code: "custom",
					path: ["accepted", "images", t],
					message: `no accepted image for target ${t}`,
				});
			}
		}
		for (const key of Object.keys(v.accepted.images)) {
			if (!targets.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["accepted", "images", key],
					message: `image for undeclared target ${key}`,
				});
			}
		}
	});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** JSON Schema for the declaration, for editors and other repos' CI. */
export const declarationJsonSchema = traced(
	"hostedapp.declarationJsonSchema",
	function declarationJsonSchema(): Record<string, unknown> {
		const schema = z.toJSONSchema(declarationSchema, { io: "input" }) as Record<string, unknown>;
		// z.toJSONSchema cannot express refine/superRefine rules. The one that
		// changes a document's shape (image is build XOR pinned) is added by hand;
		// the rest are named so a consumer knows this output is structural only.
		const image = (schema.properties as Record<string, Record<string, unknown>>).image ?? {};
		image.oneOf = [
			{ required: ["build"], not: { required: ["pinned"] } },
			{ required: ["pinned"], not: { required: ["build"] } },
		];
		schema.$comment =
			"Structural schema only. Rules the CLI also enforces: unique names/mounts/hosts; " +
			"replicas > 1 needs stateless and no storage; public hosts may not end .internal/.local/.lan; " +
			"<name>-<target> <= 63 chars; target overrides are re-validated after merge.";
		return schema;
	},
);
