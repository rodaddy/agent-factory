/**
 * @module observability/critical-alert
 * @description The ONE egress that makes a critical watcher failure reach a
 *   human. Every failure path in this service terminated in `log()`,
 *   and nothing reads the logs: the status server is loopback-only on a box
 *   reachable only through a shell on its host, so a reconcile pass could fail every 15
 *   minutes for days in silence. The `[monitoring-critical]` convention is
 *   documented in AGENTS.md as the thing the operator reads FIRST at session
 *   start — this module is what finally writes one.
 *
 *   Forge is the egress deliberately: the factory already holds a Forge
 *   credential and the owner already reads `[monitoring-critical]` issues, so no new
 *   dependency, no pager client, no SMTP, no second secret. The issue-opening
 *   path is the SAME marker dedupe the audit publisher uses
 *   (`github/publish-dedupe.findMarkedIssue`), not a second hand-rolled one.
 *
 *   Three properties make this safe to call from an error sink:
 *   - OFF BY DEFAULT. With no target configured `raiseCriticalAlert` makes zero
 *     forge calls and returns — same posture as `doorbell_enabled`.
 *   - IT NEVER THROWS. The caller is `defaultOnError`, the sink that keeps one
 *     bad repository from ending the pass; an alert that threw would destroy the
 *     pass it is reporting on. Every failure inside is caught and logged at warn.
 *   - IT DEDUPES. The reconcile pass runs every 15 minutes, so an alert that
 *     opened an issue per failure would file 96 issues a day and be worse than
 *     silence. The dedupe key is derived from the alert CLASS, not the cause
 *     text, so a flapping message cannot split one incident into many issues.
 *
 *   D4 TRIAGE LINE. When a NEW issue opens for `reconcile pass error`
 *   or a `postings-absence:` class, the body carries one advisory line from the
 *   `monitoring-triage` Jev classifier (EXPECTED / INVESTIGATE / UNSURE /
 *   NO_SIGNAL). It is advisory: any fault yields NO_SIGNAL (or no line), never a
 *   throw and never a blocked issue, and the line carries only the classifier's
 *   own words, never the cause text. No call on dedupe or for other classes.
 *
 * @outputs
 *   - `raiseCriticalAlert` -- open or dedupe onto the class's issue; never throws
 *   - `AlertDelivery` -- whether the operator can now SEE an issue for this class
 *   - `CriticalAlertTarget` -- the configured repository + lazy client resolver
 *   - `CriticalFailure` -- the bounded class + cause the caller reports
 *   - `CRITICAL_ALERT_TITLE_PREFIX` -- the operator-facing title convention
 *
 * @dependencies
 *   - ../jev/classifier -- the `monitoring-triage` classifier (D4 line)
 *   - ../forge/boundary -- the bounded forge read/write seam
 *   - ../github/publish-dedupe -- the existing marker scan (`findMarkedIssue`)
 *   - ../log -- structured logging and `errorMessage`
 */
import type { WatcherConfig } from "../config/schema";
import type { ForgeClient } from "../forge/boundary";
import { findMarkedIssue } from "../github/publish-dedupe";
import { type Ask, type Classifier, classify, loadClassifier } from "../jev/classifier";
import { askJev } from "../jev/client";
import { errorMessage, log, traced } from "../log";
import { recordAlertDelivery } from "./alert-tally";

/** The title convention AGENTS.md startup rule 2 tells the operator to read first. */
export const CRITICAL_ALERT_TITLE_PREFIX = "[monitoring-critical] ";

/** Hard bound on the cause text that reaches the issue body. */
const MAX_CAUSE_CHARS = 800;

/**
 * Where a critical alert is filed. `undefined` at the call site is the
 * off-by-default posture: no configuration, no forge call, no new failure mode.
 * `client` is LAZY so an unconfigured deployment never resolves a credential,
 * and a credential failure is just another caught error rather than a boot fault.
 */
export interface CriticalAlertTarget {
	/** The `owner/repo` the alert issue is opened in. */
	repository: string;
	/** Resolve the bounded forge client for that repository. */
	client: () => Promise<ForgeClient>;
	/** The Jev ask for the D4 triage line; defaults to `askJev`. */
	ask?: Ask;
	/** The alert clock for the triage `utc_time` field; defaults to `new Date()`. */
	now?: () => Date;
}

/**
 * One bounded failure worth waking a human for. `alertClass` is a SHORT, STABLE
 * phrase — it is both the human half of the title and the dedupe identity, so it
 * must not carry the varying part of the failure. `cause` is the already-bounded
 * message (`errorMessage()` output) and is the only free text that reaches the
 * issue body; it never carries a token, a config object, or a stack.
 */
export interface CriticalFailure {
	alertClass: string;
	cause: string;
}

/**
 * Whether the operator can now SEE an issue for this alert class.
 *
 * `delivered` means exactly one thing: a `[monitoring-critical]` issue for this
 * class exists on the forge RIGHT NOW, because this call either opened it
 * (`opened`) or proved one was already open (`deduped`). Every other outcome is
 * `undelivered` — nothing was configured, the write failed, or the dedupe scan
 * could not prove absence and refused to post.
 *
 * This distinction exists because a caller that LATCHES on having alerted (so it
 * does not re-page every pass) is otherwise latching on a promise that resolved,
 * which this function does unconditionally — including during the forge outage
 * that makes the alert matter most. Resolution is not delivery, and a caller
 * cannot tell the two apart without being told.
 */
export type AlertDelivery =
	| { delivered: true; how: "opened" | "deduped" }
	| { delivered: false; why: "unconfigured" | "indeterminate" | "failed" };

/**
 * Open — or dedupe onto — the `[monitoring-critical]` issue for one failure class.
 *
 * NEVER THROWS, in every case including every failure: this is called from an
 * error sink and a throw would destroy the pass it is reporting on. A forge
 * write that fails, a credential that cannot be resolved, and a dedupe scan that
 * cannot prove absence all end the same way — one warn line, and the pass
 * continues. What differs is the RETURNED `AlertDelivery`, so a caller that
 * needs to know whether a human can actually see this can ask.
 *
 * An `indeterminate` dedupe scan deliberately does NOT post. Absence is
 * unproven, so posting risks the duplicate flood this function exists to avoid,
 * and the next pass (15 minutes later) retries the whole thing anyway. It
 * reports `undelivered` precisely so that retry is not suppressed by a caller's
 * latch.
 */
export const raiseCriticalAlert = traced(
	"observability.raiseCriticalAlert",
	async function raiseCriticalAlert(
		target: CriticalAlertTarget | undefined,
		failure: CriticalFailure,
	): Promise<AlertDelivery> {
		// Every outcome is counted here, at the one egress, so the
		// `factory_alert_deliveries_total` series cannot drift from what callers see.
		const delivery = await deliverCriticalAlert(target, failure);
		recordAlertDelivery(delivery);
		return delivery;
	},
	// `failure.cause` is untrusted text and `target` carries a client closure;
	// neither is worth tracing, and the alert's own outcome is already logged.
	{ redact: { args: [0, 1] } },
);

/** The delivery itself; `raiseCriticalAlert` wraps it to count the outcome. */
async function deliverCriticalAlert(
	target: CriticalAlertTarget | undefined,
	failure: CriticalFailure,
): Promise<AlertDelivery> {
	// OFF BY DEFAULT: unconfigured means not one network call.
	if (target === undefined) return { delivered: false, why: "unconfigured" };
	try {
		const client = await target.client();
		const dedupeKey = criticalAlertDedupeKey(failure.alertClass);
		// sf#901: a closed postings-absence issue is a handled incident, so the next
		// one opens a new issue. Every other class keeps the open-AND-closed scan.
		const existing = await findMarkedIssue(client, target.repository, dedupeKey, {
			openOnly: failure.alertClass.startsWith("postings-absence:"),
		});
		if (existing.status !== "absent") {
			// `found` -- this class already has its issue; a second one adds nothing.
			//   The operator CAN see it, so this counts as delivered.
			// `indeterminate` -- absence unproven; refuse to risk a duplicate. Nobody
			//   has been shown anything, so this is NOT delivered and must not latch.
			log("info", "critical_alert.skipped", {
				alert_class: failure.alertClass,
				dedupe: existing.status,
			});
			return existing.status === "found"
				? { delivered: true, how: "deduped" }
				: { delivered: false, why: "indeterminate" };
		}
		const written = await client.write<unknown>("POST", `/repos/${target.repository}/issues`, {
			title: `${CRITICAL_ALERT_TITLE_PREFIX}${failure.alertClass}`,
			body: alertBody(dedupeKey, failure, await triageLine(target, failure)),
		});
		// BELT AND BRACES ON THE STATUS. Both `ForgeClient` implementations throw
		// on a non-2xx (`src/forgejo/client.ts:256`, `src/github/client.ts:214`)
		// and the interface documents that ("a non-2xx after retries throws"), so
		// this branch is unreachable through either real client. It is here anyway
		// because `delivered: true` is now a LATCH: a future implementation that
		// returned a 4xx instead of throwing would silence this alert for the life
		// of the process, and that failure would be invisible. Cheap guard, and
		// the thing it guards is the expensive one.
		if (written.status < 200 || written.status >= 300) {
			log("warn", "critical_alert.failed", {
				alert_class: failure.alertClass,
				cause: `forge answered HTTP ${written.status}`,
			});
			return { delivered: false, why: "failed" };
		}
		log("error", "critical_alert.opened", { alert_class: failure.alertClass });
		return { delivered: true, how: "opened" };
	} catch (err) {
		// The alert is best-effort by construction. Its own failure is reported at
		// warn and goes no further; the caller is an error sink mid-pass.
		log("warn", "critical_alert.failed", {
			alert_class: failure.alertClass,
			cause: errorMessage(err),
		});
		return { delivered: false, why: "failed" };
	}
}

/**
 * The stable dedupe identity for one alert class. Derived from the CLASS alone
 * (lowercased, punctuation folded), never from the cause text — a failure whose
 * message varies per pass must still land on the one issue.
 */
function criticalAlertDedupeKey(alertClass: string): string {
	const slug =
		alertClass
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "unclassified";
	return `software-factory:critical-alert:${slug}`;
}

/**
 * The issue body: the hidden dedupe marker, the bounded cause, and nothing else.
 * No config, no environment, no token, no stack — the cause string is the only
 * value that crosses from the failure into a forge-hosted document.
 */
function alertBody(dedupeKey: string, failure: CriticalFailure, triage?: string): string {
	// The cause is NOT trusted text. `errorMessage()` returns a thrown value's
	// message verbatim, and the reconcile pass handles repository content, so a
	// cause can carry whatever a managed repository put in front of it. A raw
	// fence in that string would close this block early and let the remainder
	// render as issue markup — so every backtick run is neutralised before the
	// value is embedded, and the block is opened with a longer fence than any
	// run it could contain. AGENTS.md: bound output before posting to a forge.
	const cause = failure.cause.slice(0, MAX_CAUSE_CHARS).replace(/`/g, "'");
	return [
		`<!-- ${dedupeKey} -->`,
		`The watcher reported a critical failure in class \`${failure.alertClass}\`.`,
		"",
		"Bounded cause:",
		"",
		"```",
		cause,
		"```",
		"",
		...(triage === undefined ? [] : [triage, ""]),
		"This issue is opened once per failure class and reused; see the watcher log",
		"for each occurrence.",
	].join("\n");
}

/**
 * The process-level alert destination, installed from config at compose time.
 *
 * A module-level binding rather than a parameter because `defaultOnError` is the
 * FALLBACK sink — `startServiceStages` and `runOnce` both resolve it before any
 * config is loaded, so there is nothing to pass it. `undefined` is the
 * off-by-default state and the state every test starts in.
 *
 * Lives here rather than in `service.ts` because it is alert plumbing, and
 * because `service.ts` sits against the 500-line `max-lines` bound.
 */
let criticalAlertTarget: CriticalAlertTarget | undefined;

/**
 * Raise the reconcile-pass alert against whatever target this process bound.
 *
 * The `void` is deliberate and belongs HERE rather than at the call site: the
 * caller is `defaultOnError`, a sink that is synchronous by contract, and the
 * alert is best-effort and never throws. Keeping the fire-and-forget inside
 * this module means the sink reads as one line and cannot accidentally grow an
 * `await` that would make a failing forge slow down the pass reporting it.
 */
export const raiseReconcileAlert = traced(
	"observability.raiseReconcileAlert",
	function raiseReconcileAlert(cause: string): void {
		void raiseCriticalAlert(criticalAlertTarget, { alertClass: "reconcile pass error", cause });
	},
	// The cause is untrusted text; `reconcile.pass.error` already logged it.
	{ redact: { args: [0] } },
);

/**
 * Raise an arbitrary alert CLASS against whatever target this process bound.
 *
 * `raiseReconcileAlert` above fixes its own class because it has exactly one
 * caller; this is the general form, for a caller that owns a distinct failure
 * class of its own (sf#692's dispatch drought is the first). It awaits rather
 * than fire-and-forgets, because its callers are already async and a caller that
 * wants the sink's outcome should be able to have it.
 *
 * Like every path through `raiseCriticalAlert`, it is inert when no target is
 * bound and never throws. It RETURNS that call's `AlertDelivery` rather than
 * swallowing it, because its callers are the ones that latch on having alerted
 * and a latch may only be set on a delivery that actually reached the forge.
 */
export const raiseClassAlert = traced(
	"observability.raiseClassAlert",
	async function raiseClassAlert(failure: CriticalFailure): Promise<AlertDelivery> {
		return await raiseCriticalAlert(criticalAlertTarget, failure);
	},
	// `failure.cause` is untrusted text; the caller has already logged its counts.
	{ redact: { args: [0] } },
);

/**
 * Bind (or clear) the alert destination for this process. Called once from
 * `composeService` with the parsed config and the lazy forge registry, so the
 * credential is resolved only if an alert is ever actually raised.
 */
export const setCriticalAlertTarget = traced(
	"observability.setCriticalAlertTarget",
	function setCriticalAlertTarget(target: CriticalAlertTarget | undefined): void {
		criticalAlertTarget = target;
	},
	// The target carries a credential-resolving closure.
	{ redact: { args: [0] } },
);

/**
 * Bind the `[monitoring-critical]` egress from a booted service.
 *
 * Absent `critical_alert` binds `undefined`, which is exactly the pre-sf#699
 * behavior: `defaultOnError` logs and makes no forge call.
 *
 * RETURNS what it binds, so a caller holding a deps object can pass the SAME
 * target as data rather than re-deriving it. `resolveCriticalAlertTarget` is
 * deliberately module-private — the resolution rule (including the lazy,
 * fail-closed client closure) lives here and has exactly one definition — and
 * the build-bump stuck-pair pass needs the target in its cycle deps
 * (`service-cycle.ts`, `criticalAlertTarget`). Returning it is the narrowest
 * seam that serves both without exporting the resolver or reading the
 * module-level binding from outside.
 *
 * @returns the bound target, or `undefined` when `critical_alert` is absent
 */
export const bindCriticalAlert = traced(
	"observability.bindCriticalAlert",
	function bindCriticalAlert(booted: {
		config: WatcherConfig;
		registry: CriticalAlertRegistry;
	}): CriticalAlertTarget | undefined {
		const target = resolveCriticalAlertTarget(booted.config, booted.registry);
		setCriticalAlertTarget(target);
		return target;
	},
	// The whole booted service, registry closure and all — and the RESULT now
	// carries the same credential-resolving closure the argument does.
	{ redact: { args: [0], result: true } },
);

/** The one registry capability this module needs; a subset of `ForgeRegistry`. */
export interface CriticalAlertRegistry {
	clientFor: (
		provider: "github" | "forgejo",
	) => Promise<{ ok: true; client: ForgeClient } | { ok: false; error: string }>;
}

/**
 * The alert target for a config, or `undefined` when `critical_alert` is absent.
 * The client resolver is lazy and FAILS CLOSED by throwing a bounded, secret-free
 * reason — which `raiseCriticalAlert` catches and logs at warn, so an
 * unresolvable credential degrades the alert rather than the pass.
 */
function resolveCriticalAlertTarget(
	config: WatcherConfig,
	registry: CriticalAlertRegistry,
): CriticalAlertTarget | undefined {
	const configured = config.critical_alert;
	if (configured === undefined) return undefined;
	return {
		repository: configured.repository,
		client: async () => {
			const resolved = await registry.clientFor(configured.provider);
			if (!resolved.ok) throw new Error(`critical alert client unavailable: ${resolved.error}`);
			return resolved.client;
		},
	};
}

/**
 * The default error sink for both the daemon and the one-shot path.
 *
 * Every isolated failure in the reconcile machinery — a per-repository dispatch
 * fault, one schedule's evaluation, a result-ingest throw — is funnelled to an
 * `onError` sink so one bad repository cannot end the pass. This is where that
 * sink lands when the caller supplies none, which is the production case.
 *
 * It was previously an ad-hoc `process.stderr.write` duplicated at both call
 * sites, which put the pass's only failure record outside the log format (so it
 * did not grep with anything else) and collapsed every non-Error throw to the
 * text "unknown error", discarding the value.
 *
 * It ALSO raises the one `[monitoring-critical]` alert. Logging was the
 * whole of this function's reach, and nothing reads the logs — the status server
 * is loopback-only on a box reachable only through a shell on its host — so a pass could
 * fail every 15 minutes for days in silence. The alert is inert unless
 * `critical_alert` is configured, dedupes onto one issue per failure class, and
 * never throws.
 *
 * It lives in this module rather than in `service.ts` because both halves of it
 * are observability, and because `service.ts` sits against the 500-line
 * `max-lines` bound that `lint:size` enforces.
 */
export const defaultOnError = traced(
	"observability.defaultOnError",
	function defaultOnError(error: unknown): void {
		const cause = errorMessage(error);
		log("error", "reconcile.pass.error", { cause });
		raiseReconcileAlert(cause);
	},
	// The thrown value is untrusted and its message is logged deliberately at
	// `reconcile.pass.error` below, bounded; the raw value is not worth tracing.
	{ redact: { args: [0] } },
);

/**
 * The D4 advisory triage line for a newly-opened alert, or `undefined`
 * when the class is not triaged or the classifier cannot load. A failed or
 * throwing ask yields the NO_SIGNAL line; nothing here throws. The line is built
 * only from the classifier file and the verdict, never from the cause text.
 */
const triageLine = traced(
	"observability.triageLine",
	async function triageLine(
		target: CriticalAlertTarget,
		failure: CriticalFailure,
	): Promise<string | undefined> {
		const alertClass = failure.alertClass;
		if (alertClass !== "reconcile pass error" && !alertClass.startsWith("postings-absence:")) {
			return undefined;
		}
		let clf: Classifier;
		try {
			clf = await loadClassifier("monitoring-triage");
		} catch (e) {
			log("warn", "critical_alert.triage_failed", {
				alert_class: alertClass,
				cause: errorMessage(e),
			});
			return undefined;
		}
		// Everything before the ask can fault too (an injected or invalid clock):
		// that is no line, never a blocked issue (PR 1098 review).
		let fields: Record<string, string>;
		try {
			const at = (target.now ?? (() => new Date()))();
			const hhmm = at.toISOString().slice(11, 16);
			const cause = failure.cause.slice(0, MAX_CAUSE_CHARS);
			fields = { alert_class: alertClass, cause, utc_time: `${hhmm} UTC` };
		} catch (e) {
			log("warn", "critical_alert.triage_failed", {
				alert_class: alertClass,
				cause: errorMessage(e),
			});
			return undefined;
		}
		const head = `jev ${clf.id} v${clf.version} (advisory):`;
		try {
			const v = await classify(clf, fields, target.ask ?? askJev);
			const conf = v.signal ? ` ${v.confidence.toFixed(2)}` : "";
			return `${head} ${v.verdict}${conf} (${v.why})`;
		} catch {
			return `${head} ${clf.no_signal.verdict} (no Jev signal)`;
		}
	},
	// `target` carries a client closure and `failure.cause` is untrusted text.
	{ redact: { args: [0, 1] } },
);
