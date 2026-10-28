/**
 * @module tests/fleet/support/operation-admission-wiring
 * @description Shared harness for the fleet patch 10 tests. It applies
 *   patches 09 and 10 to the installed-source fixtures in a temp root, slices the
 *   patched text, and evaluates the real patched helpers and dispatch closure
 *   with fakes for everything they close over. No provider, board or database is
 *   reached: the admission store is injected and `db.$client.unsafe` throws.
 *   `PAPERCLIP_ADMISSION_WIRING_PATCH` points patch 10 at a copy for mutation runs.
 *
 * @outputs
 *   - `loadWiring` -- the patched slices and the delivered admission modules
 *   - `memoryStore` -- an in-memory admission store
 *   - `recordingDb` -- a fake drizzle handle that logs every update
 *   - `buildSubject` -- the patched closure and helpers bound to fakes
 *   - `withSwitch` -- run with `PAPERCLIP_OPERATION_ADMISSION` set, then restore
 *
 * @dependencies
 *   - tests/support/test-temp -- the temp root
 *   - fleet/paperclip-patches/2026.916.1 -- patches 09 and 10
 *   - tests/fleet/fixtures/operation-admission -- the installed-source fixtures
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../../support/test-temp";

type Row = Record<string, unknown>;
type Fn = (...args: never[]) => unknown;

export interface StoredRecord extends Row {
	key: string;
	version: number;
}

export interface MemoryStore {
	read: (key: string) => Promise<StoredRecord | null>;
	compareAndSet: (key: string, expectedVersion: number, next: StoredRecord) => Promise<boolean>;
	records: Map<string, StoredRecord>;
	/** `read` calls, including one that rejects. */
	reads: number;
	/** `compareAndSet` calls that stored a record. */
	writes: number;
}

export interface Wiring {
	root: string;
	helpersSource: string;
	closureSource: string;
	hookSource: string;
	recoverySource: string;
	modules: {
		admit: Fn;
		classifyRunEnd: Fn;
		holdOnce: Fn;
		settle: Fn;
		reconcileAdmission: Fn;
		ownsAdmission: Fn;
		createAdmissionEvidenceReader: Fn;
		mapOperation: Fn;
	};
}

/** One recorded `update`: the table's name and the values passed to `set`. */
export interface UpdateEntry {
	table: string;
	set: Row;
}

export interface RecordingDbOptions {
	/** The run under test: the default `heartbeatRuns` row and the base of every `returning()` row. */
	run?: Row;
	/** Rows a `select` resolves to, keyed by table name. */
	rows?: Record<string, Row[]>;
	/** Return true to make that update reject. */
	failUpdate?: (table: string, set: Row) => boolean;
}

/** One recorded row lock: the table's name and the arguments passed to `for`. */
export interface LockEntry {
	table: string;
	args: unknown[];
}

export interface RecordingDb {
	log: UpdateEntry[];
	locks: LockEntry[];
	transaction: <T>(fn: (tx: RecordingDb) => Promise<T>) => Promise<T>;
	select: (fields?: unknown) => unknown;
	update: (table: { name: string }) => unknown;
	$client: { unsafe: (text: string, params?: unknown) => unknown };
}

export interface DispatchResult {
	dispatched: boolean;
	resultPromise?: unknown;
}

export interface SubjectCalls {
	storeCreated: number;
	gate: number;
	/** `{ level, args }` per logger call. */
	warnings: { level: string; args: unknown[] }[];
	/** The event passed to `publishLiveEvent`. */
	live: Row[];
	/** The run passed to `publishRunLifecyclePluginEvent`. */
	plugin: Row[];
	/** `[agentId, status]` per `finalizeAgentStatus` call. */
	finalize: unknown[][];
	/** The entry (second argument) of each `logActivity` call. */
	activity: Row[];
	/** The arguments of each `releaseIssueExecutionAndPromote` call. */
	release: unknown[][];
}

export interface SubjectOverrides {
	extraBindings?: Record<string, unknown>;
	mapOperation?: Fn;
	store?: MemoryStore;
	storeForbidden?: boolean;
	db?: RecordingDb;
	sourceIssue?: Row | null;
	run?: Row;
	context?: Row;
	runOptions?: Row;
	issueId?: string | null;
	issueContext?: Row | null;
	continuationWake?: boolean;
	gate?: Row;
}

export interface Subject {
	closure: (dispatch: (onStarted: () => void) => unknown) => Promise<DispatchResult>;
	settleAtRunEnd: (latestRun: Row) => Promise<void>;
	helpers: {
		readOperationAdmissionSwitch: () => "off" | "enforce" | "invalid";
		admitOperationBeforeDispatch: (
			run: Row,
			context: Row,
			runOptions: Row,
			issueId: string | null,
			issueContext: Row | null,
		) => Promise<{ held: DispatchResult | null; reserved: Row | null; store: unknown }>;
	};
	calls: SubjectCalls;
	store: MemoryStore;
	db: RecordingDb;
	context: Row;
	run: Row;
}

const SWITCH = "PAPERCLIP_OPERATION_ADMISSION";
const PATCH_DIR = resolve(import.meta.dir, "../../../fleet/paperclip-patches/2026.916.1");
const FIXTURES = resolve(import.meta.dir, "../fixtures/operation-admission");
const SERVICES = "server/dist/services";

function applyPatch(root: string, args: string[], label: string): string {
	const ran = Bun.spawnSync(["patch", "-p1", ...args], { cwd: root });
	const output = ran.stdout.toString() + ran.stderr.toString();
	if (ran.exitCode !== 0) throw new Error(`${label} exited ${ran.exitCode}\n${output}`);
	return output;
}

/** Lines from the first one `isStart` accepts up to, not including, the first later one `isEnd` accepts. */
function sliceLines(
	lines: string[],
	label: string,
	isStart: (line: string) => boolean,
	isEnd: (line: string) => boolean,
	includeEnd = false,
): string {
	const from = lines.findIndex(isStart);
	if (from < 0) throw new Error(`operation-admission-wiring: ${label}: start marker not found`);
	const offset = lines.slice(from + 1).findIndex(isEnd);
	if (offset < 0) throw new Error(`operation-admission-wiring: ${label}: end marker not found`);
	const to = from + 1 + offset;
	return lines.slice(from, includeEnd ? to + 1 : to).join("\n");
}

function hookSlice(lines: string[]): string {
	const end = lines.findIndex(
		(line) => line.trim() === "await settleOperationAdmissionAtRunEnd(latestRun);",
	);
	if (end < 0) throw new Error("operation-admission-wiring: hookSource: end marker not found");
	if (end < 4 || lines[end - 4]?.trim() !== "if (latestRun &&")
		throw new Error("operation-admission-wiring: hookSource: start marker not found");
	return lines.slice(end - 4, end + 1).join("\n");
}

async function buildWiring(): Promise<Wiring> {
	const root = mkdtempSync(join(testTmpBase(), "operation-admission-wiring-"));
	const heartbeatPath = join(root, SERVICES, "heartbeat.js");
	const recoveryPath = join(root, SERVICES, "recovery/service.js");
	mkdirSync(join(root, SERVICES, "recovery"), { recursive: true });
	copyFileSync(
		join(FIXTURES, "heartbeat-1-4-11752-11760-15529-15569-18427-18473.orig"),
		heartbeatPath,
	);
	copyFileSync(join(FIXTURES, "service-495-516.orig"), recoveryPath);
	const patch09 =
		process.env.PAPERCLIP_ADMISSION_MODULES_PATCH ??
		join(PATCH_DIR, "09-operation-admission-modules.patch");
	const patch10 =
		process.env.PAPERCLIP_ADMISSION_WIRING_PATCH ??
		join(PATCH_DIR, "10-operation-admission-wiring.patch");
	applyPatch(root, ["-i", patch09], "patch 09");
	const applied = applyPatch(root, ["-i", patch10], "patch 10");
	if (applied.includes("fuzz")) throw new Error(`patch 10 applied with fuzz\n${applied}`);
	applyPatch(root, ["-R", "--dry-run", "-i", patch10], "patch 10 reverse dry run");

	// Patch14's exact import hunk is required before patch15; its other regions
	// are exercised by company-budget tests and full-source install acceptance.
	const patch14 = readFileSync(join(PATCH_DIR, "14-company-budget.patch"), "utf8");
	const import14 = patch14.slice(0, patch14.indexOf("@@ -6064"));
	const importPath = join(root, "budget-import.patch");
	writeFileSync(importPath, import14);
	applyPatch(root, ["-i", importPath], "patch 14 import");
	const patch15 = join(PATCH_DIR, "15-activation-reconciler.patch");
	applyPatch(root, ["-i", patch15], "patch 15");
	applyPatch(root, ["-R", "--dry-run", "-i", patch15], "patch 15 reverse dry run");
	const patch23 = join(PATCH_DIR, "23-diagnostic-refusal-settlement.patch");
	const refusalApplied = applyPatch(root, ["-i", patch23], "patch 23");
	if (refusalApplied.includes("fuzz"))
		throw new Error(`patch 23 applied with fuzz\n${refusalApplied}`);
	applyPatch(root, ["-R", "--dry-run", "-i", patch23], "patch 23 reverse dry run");
	const heartbeat = readFileSync(heartbeatPath, "utf8").split("\n");
	const recovery = readFileSync(recoveryPath, "utf8").split("\n");
	const admission = await import(join(root, SERVICES, "operation-admission.js"));
	const adapter = await import(join(root, SERVICES, "operation-admission-store.js"));
	const identity = await import(join(root, SERVICES, "operation-identity.js"));
	return {
		root,
		helpersSource: sliceLines(
			heartbeat,
			"helpersSource",
			(line) => line.startsWith("    // sf#1830 operation admission (fleet patch 10)."),
			(line) => line === "    async function claimQueuedRun(run, companyAgents) {",
		),
		closureSource: sliceLines(
			heartbeat,
			"closureSource",
			(line) =>
				line.includes(
					"const dispatchResolvedInteractionContinuationWithAtomicGate = async (dispatch) => {",
				),
			(line) => line === `${" ".repeat(12)}};`,
			true,
		),
		hookSource: hookSlice(heartbeat),
		recoverySource: sliceLines(
			recovery,
			"recoverySource",
			(line) => line === "function isOperatorCancelledRun(latestRun, currentAgentId) {",
			(line) => line.startsWith("function isUnsuccessfulTerminalIssueRun"),
		),
		modules: {
			admit: admission.admit,
			classifyRunEnd: admission.classifyRunEnd,
			holdOnce: admission.holdOnce,
			settle: admission.settle,
			reconcileAdmission: admission.reconcileAdmission,
			ownsAdmission: admission.ownsAdmission,
			createAdmissionEvidenceReader: adapter.createAdmissionEvidenceReader,
			mapOperation: identity.mapOperation,
		},
	};
}

let wiring: Promise<Wiring> | undefined;

/** Apply the patches once per process and return the patched slices and delivered modules. */
export function loadWiring(): Promise<Wiring> {
	wiring ??= buildWiring();
	return wiring;
}

/** An in-memory admission store. `failRead` makes every `read` reject. */
export function memoryStore(
	seed?: Iterable<readonly [string, StoredRecord]>,
	options: { failRead?: boolean } = {},
): MemoryStore {
	const store: MemoryStore = {
		records: new Map(seed ?? []),
		reads: 0,
		writes: 0,
		read: async (key) => {
			store.reads += 1;
			if (options.failRead) throw new Error("memoryStore: read failed");
			return store.records.get(key) ?? null;
		},
		compareAndSet: async (key, expectedVersion, next) => {
			if ((store.records.get(key)?.version ?? 0) !== expectedVersion) return false;
			store.records.set(key, next);
			store.writes += 1;
			return true;
		},
	};
	return store;
}

/** A fake drizzle handle. Tables are named by their `name`; every update lands in `log`, every row lock in `locks`. */
export function recordingDb(options: RecordingDbOptions = {}): RecordingDb {
	const run = options.run ?? {};
	const rowsFor = (table: string): Row[] =>
		options.rows?.[table] ?? (table === "heartbeatRuns" && options.run ? [options.run] : []);
	const db: RecordingDb = {
		log: [],
		locks: [],
		transaction: (fn) => fn(db),
		select: () => ({
			from: (table: { name: string }) => {
				const query = {
					where: () => query,
					for: (...args: unknown[]) => {
						db.locks.push({ table: table.name, args });
						return query;
					},
					limit: async (count: number) => rowsFor(table.name).slice(0, count),
				};
				return query;
			},
		}),
		update: (table) => ({
			set: (values: Row) => {
				const entry = { table: table.name, set: values };
				const run_ = async (rows: Row[]): Promise<Row[]> => {
					db.log.push(entry);
					if (options.failUpdate?.(entry.table, values))
						throw new Error(`recordingDb: update of ${entry.table} failed`);
					return rows;
				};
				return {
					where: () => ({
						// biome-ignore lint/suspicious/noThenProperty: drizzle's update builder is awaitable.
						then: (onDone: (rows: Row[]) => unknown, onError: (err: unknown) => unknown) =>
							run_([]).then(onDone, onError),
						returning: () => run_([{ ...run, ...values }]),
					}),
				};
			},
		}),
		$client: {
			unsafe: (text: string) => {
				if (text.startsWith("SELECT r.id")) return [];
				throw new Error("recordingDb: the real admission store adapter was reached");
			},
		},
	};
	return db;
}

const DEFAULT_RUN: Row = {
	id: "run-1",
	companyId: "co-1",
	agentId: "agent-1",
	status: "running",
	runtimeMode: "legacy",
	invocationSource: "automation",
	wakeupRequestId: "wake-1",
	retryOfRunId: null,
	scheduledRetryReason: null,
	contextSnapshot: {},
	resultJson: null,
};

/** A table stand-in: `name` is the table's name, any other column reads as `<name>.<column>`. */
function table(name: string): { name: string } {
	return new Proxy(
		{ name },
		{ get: (_target, column) => (column === "name" ? name : `${name}.${String(column)}`) },
	);
}

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

/** Evaluate the patched helpers and closure together, bound to fakes. */
export function buildSubject(wiring: Wiring, overrides: SubjectOverrides = {}): Subject {
	const calls: SubjectCalls = {
		storeCreated: 0,
		gate: 0,
		warnings: [],
		live: [],
		plugin: [],
		finalize: [],
		activity: [],
		release: [],
	};
	const run: Row = { ...DEFAULT_RUN, ...overrides.run };
	const store = overrides.store ?? memoryStore();
	const db = overrides.db ?? recordingDb({ run });
	const context = overrides.context ?? {};
	const bindings: Record<string, unknown> = {
		admit: wiring.modules.admit,
		classifyRunEnd: wiring.modules.classifyRunEnd,
		holdOnce: wiring.modules.holdOnce,
		settle: wiring.modules.settle,
		reconcileAdmission: wiring.modules.reconcileAdmission,
		ownsAdmission: wiring.modules.ownsAdmission,
		createAdmissionEvidenceReader: wiring.modules.createAdmissionEvidenceReader,
		mapOperation: overrides.mapOperation ?? wiring.modules.mapOperation,
		createAdmissionStore: () => {
			if (overrides.storeForbidden) throw new Error("buildSubject: the store was created");
			calls.storeCreated += 1;
			return store;
		},
		db,
		runningProcesses: new Map(),
		activeRunExecutions: new Map(),
		logger: {
			warn: (...args: unknown[]) => calls.warnings.push({ level: "warn", args }),
			error: (...args: unknown[]) => calls.warnings.push({ level: "error", args }),
		},
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
		and: (...conditions: unknown[]) => ({ and: conditions }),
		eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
		issues: table("issues"),
		agentWakeupRequests: table("agentWakeupRequests"),
		heartbeatRuns: table("heartbeatRuns"),
		parseObject: (value: unknown) =>
			value && typeof value === "object" && !Array.isArray(value) ? value : {},
		retryChatControlAdmission: (attempt: () => unknown) => attempt(),
		publishLiveEvent: (event: Row) => calls.live.push(event),
		publishRunLifecyclePluginEvent: (settled: Row) => calls.plugin.push(settled),
		finalizeAgentStatus: async (...args: unknown[]) => {
			calls.finalize.push(args);
		},
		logActivity: async (_db: unknown, entry: Row) => {
			calls.activity.push(entry);
		},
		releaseIssueExecutionAndPromote: async (...args: unknown[]) => {
			calls.release.push(args);
		},
		getIssueExecutionContext: async () => overrides.sourceIssue ?? null,
		RECOVERY_ORIGIN_KINDS: { strandedIssueRecovery: "stranded_issue_recovery" },
		isHeartbeatRunTerminalStatus: (status: string) => TERMINAL.includes(status),
		controllerLease: { assertOwned: async () => {} },
		authorizeFailedChatRetryExecution: async () => {},
		withChatControlRecoveryGate: async () => true,
		run,
		context,
		runOptions: overrides.runOptions ?? {},
		issueId: "issueId" in overrides ? overrides.issueId : "issue-1",
		issueContext:
			"issueContext" in overrides
				? overrides.issueContext
				: { id: "issue-1", originKind: "manual", originId: null },
		isResolvedInteractionContinuationWakeContext: () => overrides.continuationWake === true,
		options: {},
		runDispatch: {
			dispatchResolvedInteractionIfCurrent: async () => {
				calls.gate += 1;
				return overrides.gate ?? { dispatched: true };
			},
		},
		applyRunDispatchPostCommitEffects: () => {},
	};
	Object.assign(bindings, overrides.extraBindings ?? {});
	const names = Object.keys(bindings);
	const evaluated = new Function(
		...names,
		`${wiring.helpersSource}
${wiring.closureSource}
return {
	closure: dispatchResolvedInteractionContinuationWithAtomicGate,
	settleAtRunEnd: settleOperationAdmissionAtRunEnd,
	helpers: { readOperationAdmissionSwitch, admitOperationBeforeDispatch },
};`,
	)(...names.map((name) => bindings[name])) as Pick<
		Subject,
		"closure" | "settleAtRunEnd" | "helpers"
	>;
	return { ...evaluated, calls, store, db, context, run };
}

/** Run `fn` with the admission switch set to `value` (unset when undefined), then restore it. */
export async function withSwitch<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const previous = process.env[SWITCH];
	if (value === undefined) delete process.env[SWITCH];
	else process.env[SWITCH] = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[SWITCH];
		else process.env[SWITCH] = previous;
	}
}
