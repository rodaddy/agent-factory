/**
 * @module tests/db/helpers-resolution
 * @description Pure-function coverage for the admin-URL resolver.
 *   No real PostgreSQL: `resolveAdminUrl` takes an explicit env map and an
 *   injectable file-reader seam, so every precedence branch is exercised
 *   deterministically without touching the real home dir or process env.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ReadConfigFile, resolveAdminUrl } from "./helpers";

const DEFAULT_URL = "postgres://127.0.0.1:5432/postgres";
const CONFIG_PATH = join(homedir(), ".config/software-factory/test-db.json");

/** A reader that always throws ENOENT — models a missing config file. */
const missingFile: ReadConfigFile = () => {
	const err = new Error("no such file") as NodeJS.ErrnoException;
	err.code = "ENOENT";
	throw err;
};

/** A reader that must never be consulted (fails the test if it is). */
const unreachableReader: ReadConfigFile = () => {
	throw new Error("readConfigFile should not have been called");
};

describe("resolveAdminUrl", () => {
	test("env override wins over machine config", () => {
		const env = { TEST_ADMIN_DATABASE_URL: "postgres://env-host:5432/postgres" };
		const configReader: ReadConfigFile = () =>
			JSON.stringify({ adminDatabaseUrl: "postgres://config-host:5433/postgres" });
		expect(resolveAdminUrl(env, configReader)).toBe("postgres://env-host:5432/postgres");
	});

	test("env override is read before the config file is even touched", () => {
		const env = { TEST_ADMIN_DATABASE_URL: "postgres://env-host:5432/postgres" };
		// unreachableReader throws if consulted — proves env short-circuits I/O.
		expect(resolveAdminUrl(env, unreachableReader)).toBe("postgres://env-host:5432/postgres");
	});

	test("machine config is used when env is absent", () => {
		const configUrl = "postgres://postgres@10.0.20.74:5433/postgres";
		const configReader: ReadConfigFile = (path) => {
			expect(path).toBe(CONFIG_PATH);
			return JSON.stringify({ adminDatabaseUrl: configUrl });
		};
		expect(resolveAdminUrl({}, configReader)).toBe(configUrl);
	});

	test("missing config file falls through to the local default", () => {
		expect(resolveAdminUrl({}, missingFile)).toBe(DEFAULT_URL);
	});

	test("empty env override string is treated as absent (falls through)", () => {
		expect(resolveAdminUrl({ TEST_ADMIN_DATABASE_URL: "" }, missingFile)).toBe(DEFAULT_URL);
	});

	test("config key absent falls through to the default", () => {
		const configReader: ReadConfigFile = () => JSON.stringify({ somethingElse: true });
		expect(resolveAdminUrl({}, configReader)).toBe(DEFAULT_URL);
	});

	test("unparseable JSON throws naming the path", () => {
		const configReader: ReadConfigFile = () => "{ not json";
		expect(() => resolveAdminUrl({}, configReader)).toThrow(CONFIG_PATH);
	});

	test("non-string adminDatabaseUrl throws naming the path", () => {
		const configReader: ReadConfigFile = () => JSON.stringify({ adminDatabaseUrl: 5433 });
		expect(() => resolveAdminUrl({}, configReader)).toThrow(CONFIG_PATH);
	});

	test("an unreadable (non-ENOENT) config file throws naming the path", () => {
		const configReader: ReadConfigFile = () => {
			const err = new Error("permission denied") as NodeJS.ErrnoException;
			err.code = "EACCES";
			throw err;
		};
		expect(() => resolveAdminUrl({}, configReader)).toThrow(CONFIG_PATH);
	});
});
