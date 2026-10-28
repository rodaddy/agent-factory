/**
 * @module forge/provider
 * @description The durable forge-provider identity and the STRICT supported
 *   remote identities for each provider. This slice supports exactly two forges:
 *   public GitHub, and the ONE deployed Forgejo instance at `forge.example.internal`
 *   (SSH `git-ssh.example.internal:2222`). There is deliberately no generic plugin
 *   system — a provider is a closed enum, and each provider's accepted remote
 *   hosts are fixed author-controlled constants, so a repository's provider is a
 *   trusted, bounded label and a remote URL can never bind to an unrecognised host.
 *
 *   `parseRemoteIdentity` is the single shared parser the pre-push candidate
 *   identity, the push-destination binding, and the runner clone base all use, so
 *   a receipt validated for one provider/host/repo can never authorize a push to
 *   another. It fails closed to `null` for any host that is not one of the fixed
 *   accepted hosts of a supported provider.
 *
 * @outputs
 *   - `Provider` / `PROVIDERS` -- the closed forge-provider enum
 *   - `isProvider` / `parseProvider` -- bounded provider validation
 *   - `RemoteIdentity` -- a normalized (provider, host, owner/repo) remote
 *   - `parseRemoteIdentity` -- normalize a supported SSH/HTTPS remote, else null
 *   - `providerApiBase` / `providerCloneBase` -- the reviewed fixed endpoints
 *
 * @dependencies
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { traced } from "../log";

/** The closed set of forge providers this watcher supports. */
export const PROVIDERS = ["github", "forgejo"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * True when `value` is one of the closed provider labels.
 *
 * Declared as `isProviderImpl` and re-exported through `traced()` with its own
 * type: the wrapper's signature is `(...args: A) => R`, which erases the
 * `value is Provider` predicate, and every caller here narrows on it.
 */
function isProviderImpl(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export const isProvider = traced("forge.isProvider", isProviderImpl) as typeof isProviderImpl;

/**
 * Validate a stored/config provider label. An absent, empty, or unknown value
 * fails closed to `null` (sf#812: there is no `github` default any more), so a
 * corrupt or legacy row can never route to a forge it did not name. Every caller
 * already refuses on `null`.
 */
export const parseProvider = traced(
	"forge.parseProvider",
	function parseProvider(value: unknown): Provider | null {
		return isProvider(value) ? value : null;
	},
);

/**
 * The fixed, reviewed host identities for each provider. Every field is an
 * author-controlled constant — never sourced from repository or runner content:
 *   - `apiBase`: the REST API base the read/write client targets.
 *   - `httpsHost` / `sshHost` / `sshPort`: the accepted remote hosts a push
 *     destination or a runner clone base may name. Anything else fails closed.
 *   - `cloneBase`: the reviewed HTTPS clone base a fixed runner fetch body uses.
 *
 * GitHub is public (`github.com` / `api.github.com`). Forgejo is the single
 * deployed instance at `forge.example.internal`, whose SSH endpoint is the documented
 * non-standard `git-ssh.example.internal:2222` (see _DOCS/deployment.md).
 */
interface ProviderHosts {
	readonly apiBase: string;
	readonly httpsHost: RemoteIdentity["host"];
	readonly sshHost: string;
	readonly sshPort: number | null;
	readonly cloneBase: string;
}

const PROVIDER_HOSTS: Record<Provider, ProviderHosts> = {
	github: {
		apiBase: "https://api.github.com",
		httpsHost: "github.com",
		sshHost: "github.com",
		sshPort: null,
		cloneBase: "https://github.com",
	},
	forgejo: {
		apiBase: "https://forge.example.internal/api/v1",
		httpsHost: "forge.example.internal",
		sshHost: "git-ssh.example.internal",
		sshPort: 2222,
		cloneBase: "https://forge.example.internal",
	},
} as const;

/** The reviewed REST API base for a provider. Author-controlled constant. */
export const providerApiBase = traced(
	"forge.providerApiBase",
	function providerApiBase(provider: Provider): string {
		return PROVIDER_HOSTS[provider].apiBase;
	},
);

/**
 * The reviewed HTTPS clone base for a provider (no trailing slash). A fixed
 * runner fetch body appends `/<owner>/<repo>` to this to fetch the exact SHA;
 * it never weakens the exact-SHA/sandbox rules and never carries a credential.
 */
export const providerCloneBase = traced(
	"forge.providerCloneBase",
	function providerCloneBase(provider: Provider): string {
		return PROVIDER_HOSTS[provider].cloneBase;
	},
);

/** A normalized, provider-bound remote identity. */
export interface RemoteIdentity {
	provider: Provider;
	/** Canonical HTTPS host for the provider, never the SSH transport host. */
	host: "github.com" | "forge.example.internal";
	/** `owner/repo`. */
	repository: string;
}

/** `owner/repo` with the safe charset both forges accept. */
const OWNER_REPO = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/**
 * Normalize a supported SSH/HTTPS remote URL to its `(provider, owner/repo)`
 * identity, or `null` for any host that is not a fixed accepted host of a
 * supported provider. This is the single shared parser the candidate identity,
 * the push-destination binding, and the runner clone base all use.
 *
 * Accepted forms, with or without a trailing `.git` and a tolerated trailing
 * slash, are deliberately exact:
 *   - GitHub: `git@github.com:owner/repo` or `https://github.com/owner/repo`
 *   - Forgejo: `https://forge.example.internal/owner/repo` or
 *     `ssh://git@git-ssh.example.internal:2222/owner/repo`
 *
 * A different host, an extra path segment, or (for a provider with a fixed SSH
 * port) a scp-style form that cannot express that port, all fail closed to null.
 */
export const parseRemoteIdentity = traced(
	"forge.parseRemoteIdentity",
	function parseRemoteIdentity(remote: string): RemoteIdentity | null {
		const trimmed = remote.trim().replace(/\/+$/, "");
		for (const provider of PROVIDERS) {
			const hosts = PROVIDER_HOSTS[provider];
			const repository = matchRemoteForHosts(trimmed, hosts);
			if (repository !== null) {
				return { provider, host: hosts.httpsHost, repository };
			}
		}
		return null;
	},
);

/** Match a remote against ONE provider's fixed hosts; return `owner/repo` or null. */
function matchRemoteForHosts(remote: string, hosts: ProviderHosts): string | null {
	// HTTPS: https://<httpsHost>/owner/repo
	const httpsPrefix = `https://${hosts.httpsHost}/`;
	if (remote.startsWith(httpsPrefix)) {
		return normalizeOwnerRepo(remote.slice(httpsPrefix.length));
	}

	// ssh:// is supported only for a provider with an explicit reviewed
	// non-standard port (Forgejo 2222). GitHub remains limited to its existing
	// HTTPS and SCP forms.
	const sshUrl = remote.match(/^ssh:\/\/git@([A-Za-z0-9.-]+)(?::(\d+))?\/(.+)$/);
	if (sshUrl) {
		const [, host, portText, rest] = sshUrl;
		const port = portText === undefined ? null : Number(portText);
		if (hosts.sshPort !== null && host === hosts.sshHost && port === hosts.sshPort) {
			return normalizeOwnerRepo(rest ?? "");
		}
		return null;
	}

	// scp-style: git@<sshHost>:owner/repo. Only valid for a provider whose SSH
	// port is the implicit default (null); a provider with a fixed non-standard
	// port cannot be expressed scp-style, so it fails closed here.
	const scp = remote.match(/^git@([A-Za-z0-9.-]+):(.+)$/);
	if (scp) {
		const [, host, rest] = scp;
		if (host === hosts.sshHost && hosts.sshPort === null) {
			return normalizeOwnerRepo(rest ?? "");
		}
		return null;
	}

	return null;
}

/** Reduce a trailing `owner/repo(.git)` path to canonical `owner/repo`, or null. */
function normalizeOwnerRepo(path: string): string | null {
	const cleaned = path.replace(/\/+$/, "");
	const match = cleaned.match(OWNER_REPO);
	if (!match) {
		return null;
	}
	const owner = match[1];
	const repo = match[2];
	if (!owner || !repo || repo === ".git") {
		return null;
	}
	return `${owner}/${repo}`;
}
