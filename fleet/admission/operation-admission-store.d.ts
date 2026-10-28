// Types for operation-admission-store.js (plain ESM; the caller owns the driver).
import type { AdmissionRecord, AdmissionStore } from "./operation-admission.js";

/** Minimal record identity required by the runtime version-checked adapter. */
export interface AdmissionCASRecord {
	key: string;
	version: number;
}
/** The reusable typed CAS shape; persistence and query errors remain caller-owned. */
export interface AdmissionCASStore<TRecord extends AdmissionCASRecord = AdmissionRecord> {
	read(key: string): Promise<TRecord | undefined>;
	compareAndSet(key: string, expectedVersion: number, next: TRecord): Promise<boolean>;
}
/** Runs one statement with bound parameters and resolves to its rows. A failure must reject. */
export type AdmissionQuery<TRecord extends AdmissionCASRecord = AdmissionRecord> = (
	text: string,
	params: unknown[],
) => Promise<AdmissionRow<TRecord>[]>;
/** A row of `operation_admissions` as the adapter selects it. */
export interface AdmissionRow<TRecord extends AdmissionCASRecord = AdmissionRecord> {
	record?: TRecord;
	version: number;
}
export interface AdmissionStoreOptions<TRecord extends AdmissionCASRecord = AdmissionRecord> {
	query: AdmissionQuery<TRecord>;
	/** The Paperclip company the records belong to; a uuid. */
	companyId: string;
}

/** The compare-and-set store `admit` takes, over `operation_admissions`. Every query error rejects. */
export function createAdmissionStore(options: AdmissionStoreOptions): AdmissionStore;
/** Explicit record type opts into typed CAS; default callers retain the existing admission API. */
export function createAdmissionStore<TRecord extends AdmissionCASRecord = AdmissionRecord>(
	options: AdmissionStoreOptions<TRecord>,
): AdmissionCASStore<TRecord>;

import type { AdmissionOwnerRun } from "./operation-admission.js";
export function createAdmissionEvidenceReader(options: {
	query: (text: string, params: unknown[]) => Promise<AdmissionOwnerRun[]>;
	companyId: string;
	executionStopped: (run: AdmissionOwnerRun) => Promise<boolean>;
	isTracked: (runId: string) => boolean;
}): (record: AdmissionRecord) => Promise<AdmissionOwnerRun[]>;
