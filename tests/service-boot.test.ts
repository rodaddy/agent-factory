import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../src/config/schema";
import type { WatcherDb } from "../src/db/client";
import { type BootDeps, bootService } from "../src/service-boot";

const FORGEJO_ENV = {
	FORGEJO_API_URL: "https://forge.example.internal/api/v1",
	FORGEJO_WEB_URL: "https://forge.example.internal",
	FORGEJO_CLONE_BASE: "https://forge.example.internal",
} as const;

const FORGEJO_DEPLOYMENT = {
	apiUrl: FORGEJO_ENV.FORGEJO_API_URL,
	webUrl: FORGEJO_ENV.FORGEJO_WEB_URL,
	cloneBase: FORGEJO_ENV.FORGEJO_CLONE_BASE,
};

const FORGEJO_ENV_KEYS = Object.keys(FORGEJO_ENV) as Array<keyof typeof FORGEJO_ENV>;
const savedEnv: Partial<Record<keyof typeof FORGEJO_ENV, string>> = {};

function githubConfig(verbDispatch: boolean): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/software-factory",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
				...(verbDispatch ? { verb_dispatch: true } : {}),
			},
		],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

function bootDeps(config: WatcherConfig): BootDeps {
	return {
		loadConfig: async () => ({ ok: true, config }),
		assertPacketsBootable: async () => ({ ok: true }),
		createDb: () => ({ db: {} as WatcherDb, client: {} }),
	};
}

beforeEach(() => {
	for (const key of FORGEJO_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) savedEnv[key] = value;
		else delete savedEnv[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of FORGEJO_ENV_KEYS) {
		const value = savedEnv[key];
		if (value !== undefined) process.env[key] = value;
		else delete process.env[key];
	}
});

describe("bootService Forgejo dependency gate", () => {
	test("resolves Forgejo for a GitHub repository with verb dispatch enabled", async () => {
		Object.assign(process.env, FORGEJO_ENV);

		const booted = await bootService("unused.yml", bootDeps(githubConfig(true)));

		expect(booted.forgejoDeployment?.config).toEqual(FORGEJO_DEPLOYMENT);
	});

	test("fails closed when an enabled verb lane cannot resolve Forgejo", async () => {
		await expect(bootService("unused.yml", bootDeps(githubConfig(true)))).rejects.toThrow(
			"invalid Forgejo endpoint configuration",
		);
	});

	test("skips Forgejo for a GitHub-only config without verb dispatch", async () => {
		const booted = await bootService("unused.yml", bootDeps(githubConfig(false)));

		expect(booted.forgejoDeployment).toBeNull();
	});
});
