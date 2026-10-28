/**
 * Strict deployed Forgejo endpoint contract. Runtime composition reads all three
 * values exported by infrastructure and accepts only the reviewed HTTPS host.
 */

import { traced } from "../log";

export interface ForgejoDeploymentConfig {
	apiUrl: "https://forge.example.internal/api/v1";
	webUrl: "https://forge.example.internal";
	cloneBase: "https://forge.example.internal";
}

export type ForgejoDeploymentResult =
	| { ok: true; config: ForgejoDeploymentConfig }
	| { ok: false; error: string };

const DEPLOYED: ForgejoDeploymentConfig = {
	apiUrl: "https://forge.example.internal/api/v1",
	webUrl: "https://forge.example.internal",
	cloneBase: "https://forge.example.internal",
};

/** Resolve and strictly validate the infrastructure-owned Forgejo environment. */
function resolveForgejoDeploymentImpl(
	env: NodeJS.ProcessEnv = process.env,
): ForgejoDeploymentResult {
	if (
		env.FORGEJO_API_URL !== DEPLOYED.apiUrl ||
		env.FORGEJO_WEB_URL !== DEPLOYED.webUrl ||
		env.FORGEJO_CLONE_BASE !== DEPLOYED.cloneBase
	) {
		return {
			ok: false,
			error:
				"invalid Forgejo endpoint configuration: require exact FORGEJO_API_URL, FORGEJO_WEB_URL, and FORGEJO_CLONE_BASE for https://forge.example.internal",
		};
	}
	return { ok: true, config: DEPLOYED };
}

export const resolveForgejoDeployment = traced(
	"forgejo.resolveForgejoDeployment",
	resolveForgejoDeploymentImpl,
);
