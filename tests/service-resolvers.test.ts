import { afterEach, describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../src/config/schema";
import { VERB_CHANGE_BASE_REPOSITORY } from "../src/jobs/verb-base";
import {
	createCredentialResolver,
	createProviderResolver,
	createRemoteResolver,
} from "../src/service-resolvers";

const CONFIG: WatcherConfig = {
	poll_interval_minutes: 15,
	repositories: [],
	job_templates: [],
	doorbell_enabled: false,
	shadow_publish: false,
};

/** The non-identifying half of a repository entry, so a case states only its point. */
const REPO_DEFAULTS = { checks: "standard", gate_selection: "full" } as const;

/** `resolveForgejoToken` reads `process.env` directly, so drive it there and restore. */
const priorForgejoToken = process.env.FORGEJO_TOKEN;
afterEach(() => {
	if (priorForgejoToken === undefined) {
		delete process.env.FORGEJO_TOKEN;
	} else {
		process.env.FORGEJO_TOKEN = priorForgejoToken;
	}
});

const FORGEJO = {
	config: {
		apiUrl: "https://forge.example.internal/api/v1",
		webUrl: "https://forge.example.internal",
		cloneBase: "https://forge.example.internal",
	},
} as const;

describe("createRemoteResolver", () => {
	test("derives the fixed unmanaged verb target from the Forgejo clone base", () => {
		const remoteFor = createRemoteResolver(CONFIG, FORGEJO);

		expect(remoteFor(VERB_CHANGE_BASE_REPOSITORY)).toBe(
			"https://forge.example.internal/rtech/k3s-deploy.git",
		);
		expect(remoteFor("rtech/unmanaged")).toBeNull();
	});

	test("keeps the fixed verb target unresolvable without a Forgejo deployment", () => {
		const remoteFor = createRemoteResolver(CONFIG, null);

		expect(remoteFor(VERB_CHANGE_BASE_REPOSITORY)).toBeNull();
	});
});

describe("createProviderResolver", () => {
	test("answers forgejo for the fixed unmanaged verb target", () => {
		const providerFor = createProviderResolver(CONFIG, FORGEJO);

		expect(providerFor(VERB_CHANGE_BASE_REPOSITORY)).toBe("forgejo");
	});

	test("widens for exactly one repository, and only with a Forgejo deployment", () => {
		const providerFor = createProviderResolver(CONFIG, FORGEJO);

		// Every OTHER unmanaged repository stays null: the widening is one pinned
		// name, not "unmanaged repositories are Forgejo".
		expect(providerFor("rtech/unmanaged")).toBeNull();
		expect(providerFor("rtech/k3s-deploy-staging")).toBeNull();
		// No deployment means no derivable remote, so the provider is not a usable
		// answer either — mirrors createRemoteResolver.
		expect(createProviderResolver(CONFIG, null)(VERB_CHANGE_BASE_REPOSITORY)).toBeNull();
	});

	test("lets configured repositories keep their own provider", () => {
		const config: WatcherConfig = {
			...CONFIG,
			repositories: [{ ...REPO_DEFAULTS, name: "rodaddy/managed", provider: "github" }],
		};
		const providerFor = createProviderResolver(config, FORGEJO);

		expect(providerFor("rodaddy/managed")).toBe("github");
	});
});

describe("createCredentialResolver", () => {
	test("resolves the Forgejo token for the fixed unmanaged verb target", async () => {
		// sf#313: this resolved null, so change-verifier's base fetch went out
		// anonymous and git prompted for a username in a non-TTY (exit 128).
		process.env.FORGEJO_TOKEN = "forge-secret";
		const credentialFor = createCredentialResolver(
			createProviderResolver(CONFIG, FORGEJO),
			async () => ({ ok: false, error: "github token must not be consulted here" }),
		);

		expect(await credentialFor(VERB_CHANGE_BASE_REPOSITORY)).toBe("forge-secret");
	});

	test("still resolves null for an unmanaged repository that is not the verb target", async () => {
		process.env.FORGEJO_TOKEN = "forge-secret";
		const credentialFor = createCredentialResolver(
			createProviderResolver(CONFIG, FORGEJO),
			async () => ({ ok: true, token: "gh-secret" }),
		);

		expect(await credentialFor("rtech/unmanaged")).toBeNull();
	});
});
