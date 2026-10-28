/**
 * @module reconcile/argo-refresh
 * @description The factory's Argo CD hard refresh for one app after its bump PR
 *   merges.
 *
 *   WHY: Argo tracks `http://10.0.20.58:3000/rtech/k3s-deploy.git` while
 *   Forgejo's webhook payload names `https://forge.example.internal/...`, so the Argo
 *   webhook matches no app and refreshes nothing. The factory therefore asks for
 *   the refresh itself. The Argo application name equals the k3s-deploy app dir.
 *
 *   The token is the read-only Argo account `software-factory`; it is never the
 *   image-builds kube credential. Token traffic is https only, and neither the
 *   token nor a response body is ever logged or thrown.
 */

import { traced } from "../log";

/** Hard-refresh the Argo application named by `appDir`. Throws on refusal or non-2xx. */
export type ArgoRefresh = (appDir: string) => Promise<void>;

const DEFAULT_SERVER = "https://argocd.example.internal";
const APP_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TIMEOUT_MS = 15_000;

/**
 * Build the refresher from the environment, or `null` when it is not configured
 * (no `ARGOCD_TOKEN`) or the server is not https. The caller logs the disabled state.
 */
function createArgoRefresherImpl(
	env: Record<string, string | undefined>,
	fetchImpl: typeof fetch = fetch,
): ArgoRefresh | null {
	const token = (env.ARGOCD_TOKEN ?? "").trim();
	if (token === "") return null;
	const raw = (env.ARGOCD_SERVER ?? "").trim();
	const server = (raw === "" ? DEFAULT_SERVER : raw).replace(/\/+$/, "");
	if (!server.startsWith("https://")) return null;

	return async (appDir: string): Promise<void> => {
		if (!APP_NAME.test(appDir)) {
			throw new Error("argo refresh refused: app name is not a DNS label");
		}
		const url = `${server}/api/v1/applications/${encodeURIComponent(appDir)}?refresh=hard`;
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		await response.body?.cancel();
		if (!response.ok) throw new Error(`argo refresh failed: HTTP ${response.status}`);
	};
}

export const createArgoRefresher = traced(
	"reconcile.createArgoRefresher",
	createArgoRefresherImpl,
	{ redact: { args: [0] } },
);
