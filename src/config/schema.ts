/**
 * @module config/schema
 * @description Zod schema for the watcher's YAML configuration. Defines the
 *   managed-repository list, poll interval, and the allowlisted job-template
 *   mapping, and validates them strictly at the boundary — unknown keys and
 *   invalid values are rejected. Repository content and configuration are
 *   untrusted input (see _DOCS/architecture.md); this is the boundary check.
 *
 * @outputs
 *   - `configSchema` -- the strict Zod schema for a parsed config document
 *   - `WatcherConfig` / `RepositoryConfig` / `JobTemplateConfig` -- inferred types
 *
 * @dependencies
 *   - zod -- boundary validation
 *   - ../forge/provider -- the closed forge-provider enum
 *   - node:net -- IP validation for `metrics_scrape_allow`
 */
import { isIP } from "node:net";
import { z } from "zod";
import { PROVIDERS } from "../forge/provider";
import { resolveRegistryOwner } from "../imagebuild/job";
import {
	buildBumpEnvironments,
	buildBumpImageSchema,
	refineBuildBumpImages,
} from "./build-bump-images";

/**
 * The `[monitoring-critical]` alert target must be a MANAGED (provider,
 * repository) pair.
 *
 * The watcher holds a credential for the managed repositories and nothing
 * else, so an unmanaged target is a config defect that would otherwise only
 * surface as a caught warn line at the exact moment an alert was most needed.
 * Rejecting it at load turns a silent runtime degradation into a boot failure.
 *
 * Its own function so the `superRefine` above stays inside the 50-line bound.
 */
function refineCriticalAlertTarget(
	cfg: { critical_alert?: { provider: string; repository: string } },
	managedPairs: Set<string>,
	ctx: z.RefinementCtx,
): void {
	const target = cfg.critical_alert;
	if (target === undefined) return;
	if (managedPairs.has(`${target.provider}\u0000${target.repository}`)) return;
	ctx.addIssue({
		code: "custom",
		message: `critical_alert targets unmanaged repository: ${target.provider}:${target.repository}`,
		path: ["critical_alert"],
	});
}

/**
 * ONE REPOSITORY PER REGISTRY IMAGE. A build pushes to
 * `<registry>/<owner>/<image>:<tag>` and its Kaniko Job is adopted by the
 * (owner, image, tag, sha) label selector, so two enrolments naming the same
 * owner/image would share a registry destination and could adopt each other's
 * Jobs. Refused here, where the enrolment is written, rather than widened into
 * another Job label. The destination owner is the REGISTRY owner the renderer
 * resolves from the image name (`resolveRegistryOwner`, PR #688 round 3), not
 * the repository's owner: `rodaddy/api` and `acme/api` both publish to
 * `<registry>/rtech/api`. The image is the declared name or, without an
 * `images` block, the repository's short name.
 */
function refineRegistryImages(
	cfg: { repositories: Array<{ name: string; build_bump?: { images?: Array<{ name: string }> } }> },
	ctx: z.RefinementCtx,
): void {
	const holderOf = new Map<string, string>();
	for (const repo of cfg.repositories) {
		if (!repo.build_bump) continue;
		const names = repo.build_bump.images?.map((image) => image.name) ?? [
			repo.name.slice(repo.name.indexOf("/") + 1),
		];
		for (const name of names) {
			const image = `${resolveRegistryOwner(name)}/${name}`;
			const holder = holderOf.get(image);
			if (holder !== undefined && holder !== repo.name) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate build_bump image: ${image} is declared by ${holder} and ${repo.name}`,
					path: ["repositories"],
				});
			}
			holderOf.set(image, repo.name);
		}
	}
}

/** `owner/repo`, the only shape a managed repository name may take. */
const repoFullName = z
	.string()
	.regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "must be in 'owner/repo' form");

/**
 * The forge a managed repository lives on. A CLOSED enum (`github` | `forgejo`),
 * and REQUIRED: an entry that names no provider fails validation rather
 * than defaulting to `github`, so a Forge repository that forgot the key can
 * never be watched on the wrong forge. There is deliberately no free-form
 * provider or per-repo URL: a `forgejo` repository binds to the ONE reviewed
 * deployed Forgejo host (`forge.example.internal`), an author-controlled constant, so a
 * config entry can never point the watcher at an unrecognised forge host.
 */
const repoProvider = z.enum(PROVIDERS);

/**
 * One `metrics_scrape_allow` entry: a bare IPv4/IPv6 address, or a
 * CIDR whose prefix fits the address family. Validated with `node:net` rather
 * than a hand-rolled pattern, so the entry the status server later feeds to
 * `BlockList` is one `BlockList` accepts.
 */
const metricsPeerEntry = z.string().refine(
	(entry) => {
		const [address = "", prefix, ...rest] = entry.split("/");
		const family = isIP(address);
		if (family === 0 || rest.length > 0) {
			return false;
		}
		if (prefix === undefined) {
			return true;
		}
		return /^[0-9]{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
	},
	{ message: "must be an IPv4/IPv6 address or CIDR" },
);

/**
 * Refuse an entry with no `provider` key, naming the entry so the operator can
 * find it. A bare required enum would report only a path such as
 * `repositories.3.provider`; this runs first and aborts that entry with one
 * bounded message instead.
 */
function requireProvider(kind: string, nameKey: string) {
	return (value: unknown, ctx: z.RefinementCtx): unknown => {
		if (typeof value === "object" && value !== null && !("provider" in value)) {
			const name = String((value as Record<string, unknown>)[nameKey]).slice(0, 200);
			ctx.addIssue({
				code: "custom",
				message: `${kind} ${name}: provider is required (${PROVIDERS.join(" | ")})`,
				input: value,
			});
		}
		return value;
	};
}

/**
 * The per-lane runtime flags that hand a lane to a Forgejo Actions workflow.
 * `actions` needs a Forgejo repository: on GitHub reconcile queues no box job
 * and there is no workflow to dispatch, so the lane would silently vanish
 * (factory pr-review verdicts on PRs 889 and 896, MAP #810 sweep group E).
 */
const ACTIONS_RUNTIME_FLAGS = [
	"static_runtime",
	"pr_review_runtime",
	"implement_runtime",
	"triage_runtime",
	"verb_runtime",
	"prepush_runtime",
] as const;

/** Refuse `<flag>: actions` on a non-Forgejo repository, naming repo and flag. */
function refineActionsRuntimeProvider(
	repo: { name: string; provider: string } & Partial<
		Record<(typeof ACTIONS_RUNTIME_FLAGS)[number], string>
	>,
	ctx: z.RefinementCtx,
): void {
	if (repo.provider === "forgejo") return;
	for (const flag of ACTIONS_RUNTIME_FLAGS) {
		if (repo[flag] !== "actions") continue;
		ctx.addIssue({
			code: "custom",
			message: `repository ${repo.name}: ${flag}: actions requires provider forgejo (got ${repo.provider})`,
			path: [flag],
		});
	}
}

/** A single managed repository entry. */
export const repositoryConfigSchema = z.preprocess(
	requireProvider("repository", "name"),
	z
		.object({
			name: repoFullName,
			provider: repoProvider,
			checks: z.enum(["standard", "static-only"]).default("standard"),
			// Set false when native Forge/Actions owns pull-request review for this
			// repository. Absent or true preserves the watcher's existing review lane.
			pr_review: z.boolean().optional(),
			// Which runtime runs a static-only repository's gates. `box`
			// (absent counts as box, the default) keeps the runner-box lane;
			// `actions` lets the watcher dispatch the infra-static Forgejo Actions
			// workflow. Stays box until the base-relative verdict (827c) lands: an
			// absolute verdict on a base that already fails its linters would turn
			// every PR red.
			static_runtime: z.enum(["box", "actions"]).optional(),
			// Who runs this repository's PR review. Absent means `box`: the
			// watcher queues a runner-box pr-review job. `actions` hands review to the
			// pr-review Forgejo Actions lane the webhook receiver dispatches
			// (src/hooks/pr-review.ts); reconcile then queues no box job. Both sides
			// read this one flag. Optional rather than defaulted so existing config
			// literals stay valid; readers treat absent as `box`.
			pr_review_runtime: z.enum(["box", "actions"]).optional(),
			// How the Actions pr-review lane publishes `factory/pr-review`.
			// Absent means `enforcing`: the status follows the verdict. Only the
			// Actions pr-review lane (.forgejo/workflows/pr-review.yml) reads it.
			// `advisory` posts `success` on every terminal state, so a repo whose
			// merge rule requires all statuses success is not blocked; the findings
			// stay in the comment.
			pr_review_status: z.enum(["enforcing", "advisory"]).optional(),
			// Who runs this repository's prepush gate (D23), mirroring
			// `pr_review_runtime`. Absent means `box`: the pre-push receipt gate
			// stays the runner-box path. `actions` makes the webhook receiver dispatch
			// the prepush.yml Forgejo Actions workflow on every PR head
			// (src/hooks/prepush.ts), software-factory itself included, so the
			// `factory/prepush` status comes from the default-branch workflow.
			// Optional rather than defaulted so existing config literals stay valid.
			prepush_runtime: z.enum(["box", "actions"]).optional(),
			// How a static-only repository selects which fixed static gates run.
			// `full` (default) always runs every fixed static gate; `changed-files`
			// lets the watcher read the candidate's changed PATHS and run only the
			// relevant fixed gates, while STILL failing closed to a full escalation on
			// any indeterminate/cross-cutting change (see src/infra/gates). It selects
			// no command, host, or endpoint — only which fixed reviewed gates apply.
			gate_selection: z.enum(["changed-files", "full"]).default("full"),
			// The branch a change proposal targets (Q4). Optional: when unset the
			// watcher reads the repository's default branch from the forge instead.
			//
			// Pinning it here is the PREDICTABLE choice — the target cannot move under
			// the watcher because someone renamed a default branch on the forge — while
			// the forge-read fallback keeps a repository working with no configuration.
			// It is deliberately NOT derivable from runner output: a runner that could
			// choose the base could target a branch nobody reviews.
			//
			// The value is a plain branch name (no refs/ prefix, no path traversal, no
			// whitespace), because it is interpolated into a forge API payload.
			proposal_base_branch: z
				.string()
				.min(1)
				.max(255)
				.regex(/^[A-Za-z0-9._\-/]+$/, "must be a plain branch name")
				.refine((b) => !b.includes("..") && !b.startsWith("/") && !b.startsWith("refs/"), {
					message: "must not traverse, be absolute, or carry a refs/ prefix",
				})
				.optional(),
			// The issue label that opts ONE issue into the implement lane.
			//
			// Absent by default, and that default is the point: with no value here a
			// repository queues no implement work at all, so enabling the lane is an
			// explicit per-repository act rather than something a repo acquires by
			// being managed. This is the THIRD gate on the lane, and the only one with
			// per-item granularity — the template must also be registered in code and
			// present in the `job_templates` allowlist.
			//
			// It is an EXACT, case-sensitive label match, never a prefix or pattern: a
			// pattern here would let an unrelated label someone adds for their own
			// reasons start queueing code-producing work.
			implement_label: z
				.string()
				.min(1)
				.max(50)
				.regex(/^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/, "must be a plain label name")
				.optional(),
			// Who runs this repository's implement lane, mirroring
			// `pr_review_runtime`. Absent means `box`: reconcile queues a runner-box
			// implement job for an issue carrying `implement_label`. `actions` hands
			// it to the implement Forgejo Actions lane the webhook receiver dispatches
			// (src/hooks/implement.ts); reconcile then queues no box job. Both sides
			// read this one flag, and neither acts unless `implement_label` is set.
			// Optional rather than defaulted so existing config literals stay valid.
			implement_runtime: z.enum(["box", "actions"]).optional(),
			// Per-repository opt-in for the issue-triage lane (lane C of #108).
			//
			// Off by default, and that default is the point: with `triage` unset (or
			// false) a repository queues NO triage work, so enabling the lane is an
			// explicit per-repository act rather than something a repo acquires by
			// being managed. Unlike the implement lane there is no per-issue label
			// prerequisite — labelling is what triage DOES, so requiring a label to
			// trigger it would defeat the lane. In an opted-in repository EVERY open
			// issue without a triage job gets one, bounded by the existing dedup key
			// `(repository, item, sha, job_type)`.
			//
			// OPTIONAL rather than defaulted, mirroring `implement_label`: an opt-in
			// lane flag reads as "absent means off" without forcing every existing
			// config (and every consumer that treats absence as off) to carry it.
			// `repo.triage === true` is the only enabling condition.
			triage: z.boolean().optional(),
			// Who runs this repository's issue triage, mirroring
			// `pr_review_runtime`. Absent means `box`: reconcile queues a runner-box
			// issue-triage job. `actions` hands triage to the issue-triage Forgejo
			// Actions lane the webhook receiver dispatches (src/hooks/issue-triage.ts);
			// reconcile then queues no box job. Both sides read this one flag, and
			// neither acts unless `triage` is true. Optional rather than defaulted so
			// existing config literals stay valid; readers treat absent as `box`.
			triage_runtime: z.enum(["box", "actions"]).optional(),
			// Per-repository opt-in for deterministic verb dispatch. Absent or
			// false means the live reconcile cycle does not feed this repository's issues
			// into the verb control surface. This gate is separate from `job_templates`:
			// the repository must opt in here AND the resolved verb template must remain
			// allowlisted in config before any runner allocation can occur.
			verb_dispatch: z.boolean().optional(),
			// Who runs this repository's verb jobs, mirroring
			// `pr_review_runtime`. Absent means `box`: dispatchVerbLive queues the
			// runner-box verb job. `actions` hands the verb to the verb.yml Forgejo
			// Actions workflow through src/hooks/verb.ts instead. Neither acts unless
			// `verb_dispatch` is true and the verb template is allowlisted. Optional
			// rather than defaulted so existing config literals stay valid.
			verb_runtime: z.enum(["box", "actions"]).optional(),
			// The per-repository triage label vocabulary. The FIXED allowlist the
			// runner may choose from and the factory applies. The filter is enforced
			// FACTORY-SIDE at the publication boundary: a runner result naming a label
			// outside this set produces NO label plan — it demotes to a structured
			// request block inside the bounded comment. Untrusted runner output can
			// therefore never invent a forge label mutation; it can only select from,
			// or request an addition to, this author-declared set.
			//
			// Each entry is an EXACT, case-sensitive plain label name (same shape as
			// `implement_label`), validated at this boundary like every repo input.
			// OPTIONAL: an opted-in repository with no vocabulary (absent or empty)
			// applies no labels at all, and every runner-named label demotes to a
			// request. Every consumer reads it as `?? []`, so absent behaves as empty.
			triage_labels: z
				.array(
					z
						.string()
						.min(1)
						.max(50)
						.regex(/^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/, "must be a plain label name"),
				)
				.max(100)
				.optional(),
			// Per-repository enrolment in the k3s build-bump lane (child of
			// sf#533). ABSENT MEANS NOT ENROLLED — the repository queues no build-bump
			// work at all, the same opt-in posture as `implement_label` and `triage`.
			// There is deliberately no derived boolean flag: every consumer reads the
			// presence of this block, so enrolment cannot drift from a second field.
			build_bump: z
				.object({
					// THE ORDERED ENVIRONMENT LIST (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md`
					// §1-2). A repository declares the levels it has, IN ORDER: the first
					// follows the version-tag stream, and every later one follows a movable
					// tag named after itself. Most repositories have exactly one, which is
					// one line of configuration that never sees a marker.
					//
					// An environment owns its own `app_dirs`, whose regex is the SECURITY
					// BOUNDARY, not a tidiness rule: entries are interpolated into the
					// bump script's `--app` argument, so refusing `/`, `..`, whitespace,
					// and every shell metacharacter happens in `buildBumpAppDirs` rather
					// than downstream.
					//
					// OPTIONAL, because a repository may own no app directory at all: a
					// block with neither `environments` nor `images` is BUILD-ONLY
					// enrolment (see the note below `.strict()`). Each environment's
					// `app_dirs` keeps its own `.min(1)`, so the distinction is between
					// "no list" (deliberate) and "an empty list" (a mistake).
					//
					// Every invariant — unique names, one owner per directory, exactly one
					// tag-stream environment and it is the first, unique markers — lives in
					// `buildBumpEnvironments` with the exact messages its tests pin.
					environments: buildBumpEnvironments.optional(),
					// ONE REPOSITORY, SEVERAL IMAGES. Absent: the tag builds one
					// image, the repository's short name from the root Dockerfile, and the
					// list above is its target. Present: one Kaniko build per entry from
					// its own dockerfile, each bumping its OWN environments, and the
					// top-level list must be absent (`refineBuildBumpImages`).
					images: z.array(buildBumpImageSchema).min(1).max(10).optional(),
					// Which tags trigger a bump, as a single anchored glob over the bare
					// tag NAME — never a ref path, which is why `/` is outside the
					// character class. At most one `*`, so the pattern stays a simple
					// prefix/suffix match rather than something with matching semantics
					// a reader has to reason about. Defaults to `v*`, the shape every
					// pilot repository already tags with.
					//
					// The first character is anchored to `[A-Za-z0-9]` for the same reason
					// `app_dirs` is, one step removed: this pattern SELECTS the tag that a
					// later lane passes as the bump script's `--tag` argument, so a pattern
					// like `-*` would enroll tags that read as options at that boundary. A
					// leading `*` is refused with it, which makes a match-everything
					// pattern impossible to configure by accident.
					tag_pattern: z
						.string()
						.min(1)
						.max(50)
						.regex(/^[A-Za-z0-9][A-Za-z0-9._*-]*$/, "must be a plain tag glob")
						.refine((p) => (p.match(/\*/g)?.length ?? 0) <= 1, {
							message: "must contain at most one '*'",
						})
						.default("v*"),
				})
				.strict()
				.superRefine(refineBuildBumpImages)
				// A block may declare NEITHER list. That is BUILD-ONLY enrolment: the tag
				// builds and pushes an image, and no manifest is bumped because this
				// repository owns no app directory.
				//
				// It is a real shape, not the misconfiguration an earlier version of this
				// refinement called it. rtech-mcps publishes rtech-mcps-servers, which
				// mcp2cli's Dockerfile consumes by tag; the consumer's pin is a reviewed
				// edit in the CONSUMER's repo, so there is nothing here for the bump stage
				// to write. Requiring a directory would have forced a fictional one.
				//
				// The stage boundary already enforces this correctly and needs no help:
				// intake (`src/reconcile/build-bump-intake.ts`) gates on the PRESENCE of
				// this block plus `provider: forgejo` plus a tag match, and never reads
				// the environments; only the bump stage reads them, and it treats a
				// repository with none as `build-only` and writes no row. So environments
				// are what select a bump TARGET, not what enrol a repository.
				//
				// What stays refused is a declared list left empty: `environments: []` and
				// `app_dirs: []` each name nothing, which IS the configuration mistake.
				// `buildBumpEnvironments` and `buildBumpAppDirs` keep their `.min(1)` for
				// that, so the distinction is between "no list" (deliberate) and "empty
				// list" (a mistake), enforced one level down rather than here.
				.optional(),
		})
		.strict()
		.superRefine(refineActionsRuntimeProvider),
);

/**
 * How a code-producing lane returns its proposed change. This selects WHO
 * MOVES THE BYTES, never what the runner is allowed to do:
 *
 * - `patch` (default) — the runner writes a git bundle into its own job
 *   directory on the share and holds NO forge write credential. The watcher
 *   verifies the bundle and pushes from the service host, where the credential
 *   already lives and is audited. A bundle is inspectable BEFORE it becomes a
 *   branch, so this is the reviewable default.
 * - `push` — the runner pushes a prefix-scoped branch itself. This places a
 *   repo-write credential inside a privileged box running agent-authored code,
 *   so it is gated on the least-privilege runner identity and is inert
 *   until that lands.
 *
 * Defaulting to `patch` means an existing config, and any config that names no
 * mode, can never grant a runner write authority by omission.
 *
 * `push` remains in the enum but is REFUSED at this boundary unless the owning
 * template also carries `push_identity_ready: true` — see the guard on
 * `jobTemplateConfigSchema`. The enum keeps the value because the mode is a
 * designed part of the contract; the guard stops config from selecting a mode
 * that has no runner identity behind it.
 */
const returnMode = z.enum(["patch", "push"]);

/**
 * An allowlisted job template: a stable identifier mapped to the fixed runner
 * job it dispatches. Only templates named here may ever be dispatched.
 */
export const jobTemplateConfigSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9-]+$/, "job template id must be kebab-case"),
		label: z.string().min(1).optional(),
		runner_size: z.enum(["small", "medium", "large", "xl"]).default("small"),
		// How a code-producing lane returns its change. Report-only lanes ignore
		// this; it is meaningful only for a template that can propose a change.
		return_mode: returnMode.default("patch"),
		// Explicit acknowledgement that the forge-side prerequisite for `push` is
		// in place. Absent by default, and absence is what makes the guard
		// below fail closed: `return_mode: "push"` is selectable in the enum but
		// the mode is INERT — no least-privilege runner git identity exists yet,
		// and nothing ingests a push-mode hand-back. Selecting it today produces a
		// lane that silently returns nothing rather than an error, so the schema
		// refuses the combination instead of letting config express it.
		//
		// This flag does NOT create the identity or make `push` work; it records
		// that the operator has verified the rtech-infra-owned surface exists, so
		// the mode cannot be reached by editing one enum value alone.
		push_identity_ready: z.boolean().optional(),
	})
	.strict()
	.superRefine((tpl, ctx) => {
		// `push` is inert pending the forge-side least-privilege identity, which is
		// an rtech-infra surface. Standing ruling 1 — the runner lane is
		// deliberately over-privileged for now — is about the EXISTING patch lane
		// and is untouched here: this refuses a mode that cannot work at all, and
		// narrows no credential the patch lane already holds.
		if (tpl.return_mode === "push" && tpl.push_identity_ready !== true) {
			ctx.addIssue({
				code: "custom",
				message: `job template ${tpl.id}: return_mode "push" is inert pending the least-privilege runner git identity (sf#67); set push_identity_ready: true only once that forge-side identity exists`,
				path: ["return_mode"],
			});
		}
	});

/**
 * The Forge runner fleet's scaling envelope.
 *
 * ABSENT MEANS DISABLED, the same opt-in posture `build_bump` takes on a
 * repository: with no block the scaling pass computes nothing, calls no
 * dependency, and reports one fixed reason. There is deliberately no `enabled`
 * boolean, so the fleet cannot be half-configured.
 *
 * sf#1090: forge slots are EPHEMERAL, cloned and
 * destroyed by the gateway, with ONE warm standby. `floor` is the number of
 * free warm standbys kept in the group whose labels include `standby_label`;
 * every other label group has floor 0. `cap` is the wall on TOTAL running
 * members. `idle_minutes` is the grace before an idle extra slot is taken down.
 * `dead_minutes` is the grace before a running-but-offline slot is judged dead;
 * absent means `idle_minutes` (SOF-11439: a long idle grace must not also let a
 * wedged slot count as free for that long). `slots`, when set, is
 * the ONLY vmid set the pass may count or act on (the cutover filter); absent
 * means every forge-band vmid.
 */
export const forgeRunnerFleetConfigSchema = z
	.object({
		floor: z.number().int().min(0).max(10).default(1),
		standby_label: z.string().min(1).default("forgejo-mvp"),
		cap: z.number().int().min(0).max(50).default(10),
		idle_minutes: z.number().int().min(1).max(1440).default(3),
		dead_minutes: z.number().int().min(1).max(1440).optional(),
		slots: z
			.array(z.number().int().min(9101).max(9150))
			.refine((a) => new Set(a).size === a.length, { message: "slots must be unique" })
			.optional(),
		// The one slot that is never taken down and is brought up whenever absent.
		standing: z.number().int().min(9101).max(9150).optional(),
	})
	.strict()
	.refine((f) => f.cap >= f.floor, {
		message: "cap must be greater than or equal to floor",
	})
	.refine((f) => f.standing === undefined || f.floor === 0, {
		message: "standing replaces the idle standby: set floor: 0",
	})
	.refine((f) => f.standing === undefined || !f.slots || f.slots.includes(f.standing), {
		message: "standing must be one of slots",
	});

/** The full configuration document. */
export const configSchema = z
	.object({
		poll_interval_minutes: z.number().int().positive().max(1440),
		// Minutes before a pending factory status whose run shows no pending job is
		// swept to `error` (reconcile/stale-pending). Absent = 120. Capped at
		// 1440: the sweep only watches forge_runs from the last 24 hours.
		stale_pending_minutes: z.number().int().positive().max(1440).optional(),
		repositories: z.array(repositoryConfigSchema).min(1),
		job_templates: z.array(jobTemplateConfigSchema).default([]),
		// The Forge runner fleet scaling envelope. Absent = the scaling pass
		// is disabled with the fixed reason "forge_runner_fleet not configured"; it
		// touches no gateway and calls no dependency. Same opt-in posture as
		// `build_bump` on a repository.
		forge_runner_fleet: forgeRunnerFleetConfigSchema.optional(),
		// Where a `[monitoring-critical]` alert issue is filed when a critical
		// watcher failure occurs. ABSENT BY DEFAULT, exactly like
		// `doorbell_enabled` and `forge_runner_fleet`: with no value the alert path
		// makes no forge call and the watcher behaves precisely as it did before.
		// The value is the `(provider, owner/repo)` the issue is opened in, which
		// must be one of the managed repositories (enforced in the superRefine
		// below) so the alert can only ever write where the watcher is already
		// authorized.
		critical_alert: z
			.object({
				provider: repoProvider,
				repository: repoFullName,
			})
			.strict()
			.optional(),
		// Minutes a lane may go from its oldest dispatch
		// to its first posting before the postings-absence alert raises a
		// [monitoring-critical] issue (605d). Absent = 30; floor 5 so a
		// normal box run (4-5 minutes) can never page.
		postings_absence_minutes: z.number().int().min(5).max(1440).optional(),
		// Optional identifiers-only early-reconciliation doorbell. Off by default:
		// the 15-minute sweep is authoritative and the doorbell only ever asks the
		// existing scheduler to wake early (see src/reconcile/doorbell).
		doorbell_enabled: z.boolean().default(false),
		// Off-loopback peers allowed to scrape GET /metrics, and ONLY /metrics:
		// bare IPv4/IPv6 addresses or CIDRs. Empty by default, which is
		// the loopback-only status surface exactly as before. Every other status
		// route keeps refusing an off-loopback peer whatever this lists.
		// `.optional()` after `.default()` for the same reason as
		// `railsManifestRefresh`: absent still parses to [], and existing
		// WatcherConfig literals keep compiling.
		metrics_scrape_allow: z.array(metricsPeerEntry).max(64).default([]).optional(),
		// Shadow publication mode. Off by default. When true, the publisher runs the
		// full pipeline (dedupe reads included) but records intended GitHub writes to
		// the shadow ledger instead of posting them — for a bounded compare period
		// against the repository's own Actions result (see src/github/publish).
		shadow_publish: z.boolean().default(false),
		// Explicit watcher-side source for the rails manifest shipped with every verb
		// job. Optional because verb dispatch itself is opt-in and must remain
		// dry when this path is absent. There is deliberately no compiled-in fallback:
		// a Mac-local development path must never leak into a runner submission.
		railsManifestPath: z
			.string()
			.trim()
			.min(1)
			.max(1_000)
			.refine((path) => path.startsWith("/"), { message: "must be an absolute path" })
			.optional(),
		// Who keeps that share checkout current. "pull" = the watcher fast-forwards it
		// itself before each read; "external" = another host refreshes it
		// (a fleet host over the collab mount) and the watcher only records
		// the on-disk HEAD. Defaulting to "pull" leaves every existing
		// deployment unchanged. `.optional()` sits AFTER `.default()` so an absent key
		// still PARSES to "pull" (probed against this repo's zod) while the inferred
		// output type stays optional -- every existing WatcherConfig literal keeps
		// compiling without a fixture sweep.
		railsManifestRefresh: z.enum(["pull", "external"]).default("pull").optional(),
		// The read-only rtech-infra checkout on the collab share that owns the render
		// engine. Explicit and optional for the same reason
		// `railsManifestPath` is: verb dispatch is opt-in and must stay dry when the
		// path is absent, and there is deliberately no compiled-in fallback so a
		// Mac-local development path cannot leak into a runner submission.
		verbEnginePath: z
			.string()
			.trim()
			.min(1)
			.max(1_000)
			.refine((path) => path.startsWith("/"), { message: "must be an absolute path" })
			.optional(),
		// The read-only rtech/k3s-deploy checkout on the collab share, which supplies
		// the BASE OBJECTS the rendered change is committed on top of. The box
		// holds no forge credential, so the base cannot be fetched from Forgejo on the
		// box — it comes from this share checkout. Taken from config, never hardcoded,
		// because infra owns the share layout.
		verbK3sCheckoutPath: z
			.string()
			.trim()
			.min(1)
			.max(1_000)
			.refine((path) => path.startsWith("/"), { message: "must be an absolute path" })
			.optional(),
	})
	.strict()
	.superRefine((cfg, ctx) => {
		// Managed identity is PROVIDER-QUALIFIED end to end: the DB row, the audit
		// target, and every lookup key are `(provider, owner/repo)`. The same bare
		// `owner/repo` may therefore be managed on both GitHub and Forgejo in one
		// config; only an exact (provider, name) collision is a duplicate.
		const seenRepos = new Set<string>();
		const managedPairs = new Set<string>();
		for (const repo of cfg.repositories) {
			const key = `${repo.provider}\u0000${repo.name}`;
			if (seenRepos.has(key)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate repository: ${repo.provider}:${repo.name}`,
					path: ["repositories"],
				});
			}
			seenRepos.add(key);
			managedPairs.add(key);
		}
		refineCriticalAlertTarget(cfg, managedPairs, ctx);
		refineRegistryImages(cfg, ctx);
		const seenTemplates = new Set<string>();
		for (const tpl of cfg.job_templates) {
			if (seenTemplates.has(tpl.id)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate job template id: ${tpl.id}`,
					path: ["job_templates"],
				});
			}
			seenTemplates.add(tpl.id);
		}
	});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type JobTemplateConfig = z.infer<typeof jobTemplateConfigSchema>;
export type ForgeRunnerFleetConfig = z.infer<typeof forgeRunnerFleetConfigSchema>;
export type WatcherConfig = z.infer<typeof configSchema>;
