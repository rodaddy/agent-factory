/**
 * @module results/reconcile
 * @description Restart-safe reconciliation of completed runner output. Active
 *   submitted attempts are loaded from durable database state, their bounded
 *   host directories are discovered through an `ArtifactReader`, and each output
 *   is ingested independently so one unreadable or malformed result cannot block
 *   the rest of the pass.
 *
 *   The artifact SOURCE is injectable. It defaults to the collab
 *   share (`ShareResultReader`), which is byte-for-byte the behavior that
 *   existed before the seam, and a caller may supply any `ArtifactReader` —
 *   in practice a `CompositeResultReader` putting the NATS-fed `bus_results`
 *   table ahead of the share. Nothing downstream changes with it: the byte cap,
 *   strict schema validation, named-artifact selection, and wrapper
 *   side-channel classification are all unchanged, and the side channel
 *   deliberately keeps reading the SHARE (see `readerFor`).
 *
 * @dependencies
 *   - ./artifact-reader -- the injectable artifact source contract
 *   - ./share-reader -- the default (and side-channel) collab-share source
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { jobAttempts, jobs } from "../db/schema";
import { INFRA_RESULT_NAME, INFRA_TEMPLATE_ID } from "../infra/body";
import { errorMessage, log, traced } from "../log";
import {
	EVENT_STREAM_NAME,
	isAgentLaneJobType,
	isVerbLaneJobType,
	WATCHER_RESULT_NAME,
} from "../templates/agent-lane";
import type { ArtifactReader } from "./artifact-reader";
import {
	type ChangeVerifier,
	type IngestObserver,
	ingestResult,
	type ResultReader,
} from "./ingest";
import { ShareResultReader } from "./share-reader";
import { DbResultStore } from "./store";
import {
	AGENT_LOG_NAME,
	classifyWrapperFailure,
	MAX_AGENT_LOG_BYTES,
	MAX_WRAPPER_BYTES,
	WRAPPER_ENVELOPE_NAME,
	WRAPPER_VERDICT_NAME,
} from "./wrapper-verdict";

export const MAX_ACTIVE_RESULT_ATTEMPTS = 500;
export const MAX_HOSTS_PER_ATTEMPT = 8;

export interface ResultReconcileSummary {
	attempts: number;
	hosts: number;
	ingested: number;
	invalid: number;
	pending: number;
	failures: number;
}

export interface ResultReconcilerOptions {
	shareRoot?: string;
	/**
	 * The artifact SOURCE. Absent — the default — the reconciler reads
	 * the collab share exactly as it always has, so every existing caller is
	 * unaffected. Supplied, it is typically a `CompositeResultReader` placing the
	 * NATS-fed `bus_results` table ahead of a `ShareResultReader`, letting a runner
	 * that publishes to the bus and one that writes to the share reconcile through
	 * the same unchanged pipeline.
	 *
	 * `shareRoot` stays meaningful either way: the wrapper's verdict/envelope side
	 * channel is read from the SHARE regardless of this option, because those
	 * artifacts are written by the fleet wrapper around the job rather than
	 * published by it.
	 */
	reader?: ArtifactReader;
	maxAttempts?: number;
	maxHostsPerAttempt?: number;
	onError?: (error: Error) => void;
	/**
	 * Proves a claimed change before its result is accepted (#65 -> #66). When
	 * absent, a result carrying a change is REFUSED at ingest rather than accepted
	 * unverified — the implement lane simply does not function without one, which
	 * is the correct failure for a boundary that decides what gets pushed.
	 */
	changeVerifier?: ChangeVerifier;
	/**
	 * Resolve a repository's config-declared issue-triage label allowlist,
	 * used FACTORY-SIDE to filter the runner's chosen labels at the publication
	 * boundary. Absent, every repository resolves an empty allowlist, so a triage
	 * result's chosen labels all demote to requests rather than being applied.
	 */
	triageAllowlistFor?: (repository: string, jobType: string) => readonly string[];
	/**
	 * The OPTIONAL observability sink. Absent, ingest never reads an event
	 * stream and behaves byte-identically to before the feature existed — which is
	 * also what happens when Langfuse is simply unconfigured.
	 */
	observer?: IngestObserver;
}

/** Resolve the platform collab root while retaining a deterministic test seam. */
export const defaultCollabRoot = traced(
	"results.defaultCollabRoot",
	function defaultCollabRoot(platform: NodeJS.Platform = process.platform): string {
		return platform === "darwin" ? "/mnt/share" : "/mnt/share";
	},
);

/** Production result reconciler built from durable DB state and the collab share. */
export class ResultReconciler {
	private readonly db: WatcherDb;
	private readonly reader: ArtifactReader;
	/**
	 * The collab share, always. This is the SAME object as `reader` in the default
	 * configuration; it is held separately so the wrapper's verdict/envelope/log
	 * side channel keeps reading the share even when `reader` is a composite over
	 * the bus. Those artifacts are written by the fleet wrapper AROUND the job, so
	 * a bus-fed result has no wrapper envelope to find.
	 */
	private readonly shareReader: ShareResultReader;
	private readonly store: DbResultStore;
	private readonly maxAttempts: number;
	private readonly maxHostsPerAttempt: number;
	private readonly onError?: (error: Error) => void;
	private readonly changeVerifier?: ChangeVerifier;
	private readonly observer?: IngestObserver;

	constructor(db: WatcherDb, options: ResultReconcilerOptions = {}) {
		this.db = db;
		this.shareReader = new ShareResultReader(options.shareRoot ?? defaultCollabRoot());
		this.reader = options.reader ?? this.shareReader;
		this.store = new DbResultStore(db, undefined, options.triageAllowlistFor);
		this.maxAttempts = Math.max(
			1,
			Math.min(options.maxAttempts ?? MAX_ACTIVE_RESULT_ATTEMPTS, 5000),
		);
		this.maxHostsPerAttempt = Math.max(
			1,
			Math.min(options.maxHostsPerAttempt ?? MAX_HOSTS_PER_ATTEMPT, 64),
		);
		this.onError = options.onError;
		this.changeVerifier = options.changeVerifier;
		this.observer = options.observer;
	}

	async run(): Promise<ResultReconcileSummary> {
		const rows = await this.db
			.select({ runnerJobId: jobAttempts.runnerJobId, jobType: jobs.jobType })
			.from(jobAttempts)
			.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
			.where(
				and(
					eq(jobAttempts.status, "submitted"),
					eq(jobs.status, "running"),
					isNotNull(jobAttempts.runnerJobId),
				),
			)
			.orderBy(asc(jobAttempts.id))
			.limit(this.maxAttempts);

		const summary: ResultReconcileSummary = {
			attempts: rows.length,
			hosts: 0,
			ingested: 0,
			invalid: 0,
			pending: 0,
			failures: 0,
		};

		for (const row of rows) {
			if (row.runnerJobId === null) continue;
			await this.reconcileAttempt(summary, row.runnerJobId, row.jobType);
		}

		return summary;
	}

	/**
	 * Ingest every host directory recorded under one attempt's runner job id.
	 * Results are per (job, host), so a single attempt can carry more than one.
	 * A per-host fault is recorded and skipped rather than aborting the pass.
	 */
	private async reconcileAttempt(
		summary: ResultReconcileSummary,
		runnerJobId: string,
		jobType: string,
	): Promise<void> {
		let hosts: string[];
		try {
			hosts = await this.reader.listHosts(runnerJobId, this.maxHostsPerAttempt);
		} catch (err) {
			this.recordFailure(summary, {
				stage: "list_hosts",
				jobRunnerId: runnerJobId,
				cause: err,
			});
			return;
		}
		summary.hosts += hosts.length;
		// The infra-static, scheduled-audit, and three agent lanes each write their
		// watcher-schema result to a fixed, author-owned named artifact (not the
		// wrapper-owned result.json, which the wrapper overwrites on every terminal
		// path), so their ingest reads that named artifact. Every other job type keeps
		// reading result.json unchanged. Only a FIXED author literal — keyed on the
		// DB-joined job type, never a caller/config name — reaches the reader, and the
		// same byte cap, schema, and containment guards apply.
		const reader = this.readerFor(jobType);
		for (const host of hosts) {
			try {
				const outcome = await ingestResult({
					reader,
					store: this.store,
					jobRunnerId: runnerJobId,
					hostname: host,
					changeVerifier: this.changeVerifier,
					observer: this.observer,
				});
				if (outcome.status === "ingested") summary.ingested++;
				else if (outcome.status === "invalid" || outcome.status === "missing") summary.invalid++;
				else summary.pending++;
			} catch (err) {
				this.recordFailure(summary, {
					stage: "ingest",
					jobRunnerId: runnerJobId,
					host,
					cause: err,
				});
			}
		}
	}

	/**
	 * The `ResultReader` an attempt's ingest uses, keyed on its DB-joined job type.
	 * An `infra-static` attempt reads its fixed INFRA_RESULT_NAME artifact, and each of
	 * the three agent lanes (pr-review, issue-triage, implement-issue) reads its fixed
	 * WATCHER_RESULT_NAME artifact — each through an adapter that forces `readResult`
	 * to that named artifact (mirroring the pre-push/compat lanes); every other job
	 * type reads the wrapper-owned `result.json` through the default reader unchanged.
	 * The name is a fixed author literal selected by job type — never a caller/config
	 * value — and the same byte cap, strict schema validation, and
	 * O_NOFOLLOW/regular-file containment guards remain in force. A missing or invalid
	 * named artifact still ingests as `invalid`, never a false pass.
	 *
	 * The agent-lane AND infra-static adapters additionally classify a MISSING named
	 * artifact from the wrapper's own verdict/envelope side channel plus the agent's
	 * log (`classifyMissing`), so a run where the job failed before writing a result
	 * records the wrapper's terminal state ("runner agent failed before producing a
	 * result: <state> — <language>") rather than a bare "missing" — and never a zod
	 * union error from schema-parsing the wrapper envelope, which these lanes never
	 * do. A runtime AUTH death additionally carries its own class prefix
	 * ("runtime-auth-failure: ..."), because the wrapper's terminal state cannot
	 * express a credential that is present but dead.
	 *
	 * The artifact itself is read through the injected `ArtifactReader` (the share
	 * by default, a bus-first composite when supplied). The wrapper side channel is
	 * NOT: `classifyMissing` reads the share directly, because the wrapper writes
	 * those artifacts around the job rather than publishing them.
	 */
	private readerFor(jobType: string): ResultReader {
		// The named-artifact lanes read a fixed, author-owned filename instead of the
		// wrapper-owned result.json. The name is a FIXED author literal selected by the
		// DB-joined job type — never a caller/config value — and the same byte cap,
		// strict schema, and O_NOFOLLOW/regular-file containment guards remain in force.
		const agentLane = isAgentLaneJobType(jobType);
		// A deterministic k3s VERB job is not an agent lane — it runs `runtime: script`
		// with no agent and no credential — but it writes the same named artifact.
		// It has to: the wrapper OWNS result.json and overwrites it with its
		// caller envelope on every terminal path, so a verb result written there is
		// destroyed by the wrapper that copies it back. It reads the named artifact but
		// does NOT take the agent-lane `classifyMissing` path below, because a script
		// job writes no agent log to classify.
		const verbLane = isVerbLaneJobType(jobType);
		const namedArtifact =
			jobType === INFRA_TEMPLATE_ID
				? INFRA_RESULT_NAME
				: agentLane || verbLane
					? WATCHER_RESULT_NAME
					: null;
		const reader = this.reader;
		// The OPTIONAL per-attempt event stream, read from the job/host `out/`
		// SUBDIRECTORY through the same containment guards as every other
		// artifact. It is offered on every lane, not just the named-artifact ones,
		// because any lane may run an agent that writes one; a lane that writes none
		// reads null and ingest is unaffected. Observability only — nothing here
		// decides anything.
		//
		// `readOutArtifact`, NOT `readNamedResult`. The wrapper FLATTENS most
		// artifacts to `<job>/<host>/` — result.json, watcher-result.json,
		// changes.bundle, DONE — but leaves the event stream nested at
		// `out/events.jsonl`. This line read the flat path for the stream's whole
		// life, so it could never find one: measured 2026-09-10, 133 streams on the
		// share and zero where the reader looked, hence zero parsed traces, zero
		// trace_id stamps and zero Langfuse emissions across 29 attempts. The comment
		// here used to claim the stream was read like "every other artifact", which
		// was true of its GUARDS and false of its LOCATION — and that half-true
		// sentence is part of why the gap survived review.
		const readEventStream: NonNullable<ResultReader["readEventStream"]> = (
			jobRunnerId,
			hostname,
			maxBytes,
		) => reader.readOutArtifact(jobRunnerId, hostname, EVENT_STREAM_NAME, maxBytes);

		if (namedArtifact === null) {
			return {
				isDone: (jobRunnerId, hostname) => reader.isDone(jobRunnerId, hostname),
				readResult: (jobRunnerId, hostname, maxBytes) =>
					reader.readResult(jobRunnerId, hostname, maxBytes),
				readEventStream,
			};
		}
		const adapter: ResultReader = {
			isDone: (jobRunnerId, hostname) => reader.isDone(jobRunnerId, hostname),
			readResult: (jobRunnerId, hostname, maxBytes) =>
				reader.readNamedResult(jobRunnerId, hostname, namedArtifact, maxBytes),
			// Name the artifact actually sought in the missing-artifact reason, so the
			// operator sees which file was absent instead of a hardcoded result.json.
			resultName: namedArtifact,
			readEventStream,
		};
		// The three agent lanes and `infra-static` all run UNDER the fleet wrapper, so
		// when their named artifact is ABSENT but the wrapper reached a terminal state,
		// the wrapper's verdict/envelope names the cause. The scheduled-audit lane is
		// deliberately excluded: it is not dispatched through the wrapper, so it writes
		// no verdict/envelope and classification would find nothing to read.
		//
		// infra-static was left out of this path until sf#263, and the cost is on
		// record: a fleet-wide credential outage surfaced on every infra-static attempt
		// as the bare "DONE present but infra-static-result.json is missing", and three
		// sessions hunted a repo-layout ghost for four days. The witness was on the
		// share the whole time.
		if (!agentLane && jobType !== INFRA_TEMPLATE_ID) {
			return adapter;
		}
		// Read that side channel (UNTRUSTED — the share is writable by other
		// principals) and classify it into a bounded, sanitized reason. A
		// missing/unusable verdict yields null, and ingest falls back to the generic
		// named missing-artifact reason.
		//
		// The agent's own log is read alongside them for the sf#254 auth carve-out:
		// a dead-but-present credential passes the wrapper's preflight, so the
		// wrapper finishes `completed` and only `agent.log` names the cause. All
		// three reads are keyed on (jobRunnerId, hostname) — the per-(job, host)
		// shape #86 fixed; keying on the job alone would read one host's log for
		// another host's attempt.
		adapter.classifyMissing = (jobRunnerId, hostname) =>
			this.classifyFromWrapper(jobRunnerId, hostname);
		return adapter;
	}

	/**
	 * Classify a MISSING named artifact from the wrapper's own side channel.
	 *
	 * The three reads go to the SHARE explicitly, never through the injected
	 * `reader`: the fleet wrapper writes the verdict, envelope, and
	 * agent log AROUND the job rather than publishing them, so a bus-delivered
	 * result carries no envelope and routing these through a bus-first composite
	 * would only add three certain misses per classification.
	 */
	private async classifyFromWrapper(jobRunnerId: string, hostname: string): Promise<string | null> {
		const share = this.shareReader;
		const [verdict, envelope, agentLog] = await Promise.all([
			share.readNamedResult(jobRunnerId, hostname, WRAPPER_VERDICT_NAME, MAX_WRAPPER_BYTES),
			share.readNamedResult(jobRunnerId, hostname, WRAPPER_ENVELOPE_NAME, MAX_WRAPPER_BYTES),
			share.readNamedResult(jobRunnerId, hostname, AGENT_LOG_NAME, MAX_AGENT_LOG_BYTES),
		]);
		return classifyWrapperFailure(verdict, envelope, agentLog);
	}

	/**
	 * Count one isolated failure and report it.
	 *
	 * The sink message stays fixed and generic on purpose (bounded, secret-free).
	 * That alone left the summary saying `failures: 3` with no way to learn WHICH
	 * job or host failed or why — the operator's only recourse was to re-read runner
	 * artifacts by hand, which is exactly what diagnosing #59 required. The log line
	 * carries the identifying detail the sink deliberately omits.
	 */
	private recordFailure(
		summary: ResultReconcileSummary,
		context: { stage: string; jobRunnerId: string; host?: string; cause: unknown },
	): void {
		summary.failures++;
		log("error", "results.reconcile.failed", {
			stage: context.stage,
			job_runner_id: context.jobRunnerId,
			host: context.host,
			cause: errorMessage(context.cause),
		});
		this.reportError(new Error("result reconciliation failed for one runner output"));
	}

	/**
	 * Invoke the caller's error sink without ever letting it abort the pass. A
	 * monitoring/logging sink is untrusted here: if it throws, that throw must not
	 * escape `recordFailure` and take down the rest of the result-reconcile pass
	 * (both catch sites route through here). Swallow any exception it raises.
	 */
	private reportError(error: Error): void {
		try {
			this.onError?.(error);
		} catch (err) {
			// A faulty sink must not abort the pass. Nothing safe to do with a
			// logging-sink failure except drop it — debug, because the failure the sink
			// was handed was already logged by recordFailure.
			log("debug", "results.reconcile.sink_failed", { cause: errorMessage(err) });
		}
	}
}
