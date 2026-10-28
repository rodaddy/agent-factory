/**
 * @module reconcile/build-bump-resolve
 * @description Compose the build-bump BUMP seam at boot: resolve the
 *   script path and workdir root, capture the forge credential inside the invoke
 *   closure, and build the best-effort receipt sink.
 *
 *   THE CREDENTIAL IS CAPTURED HERE AND NOWHERE ELSE. `src/imagebuild/bump.ts`
 *   takes the token as an argument and `build-bump-bump.ts` takes only the
 *   closure, so the token exists at exactly one boundary — this module — and no
 *   test of either side can be satisfied by one reaching it. It lives in its own
 *   file rather than in `service.ts` for the same reason every other resolver is
 *   being split out: the composition root is at its size ceiling.
 *
 *   AN ABSENT CREDENTIAL IS NOT A BOOT FAILURE. `bump: null` disables this rail
 *   alone and boots the rest of the factory normally. The logged reason is one of
 *   two FIXED strings — never the path from the environment, which an operator can
 *   set to anything, and which would then be echoed into the log.
 *
 * @outputs
 *   - `BUMP_PR_REPOSITORY` -- the deploy repository every bump PR targets
 *   - `resolveBuildBump` -- the composed seam, or the disabled posture
 *   - `BuildBumpBumpDeps` -- re-exported so the composition root imports one module
 *
 * @dependencies
 *   - ../forgejo/client, ../forgejo/config, ../forgejo/credentials -- the forge seam
 *   - ../imagebuild/bump -- the invocation this closure wraps
 *   - ../results/change-verifier -- the watcher-owned work root
 */
import { existsSync } from "node:fs";
import { createForgejoClient } from "../forgejo/client";
import { resolveForgejoDeployment } from "../forgejo/config";
import { resolveForgejoToken } from "../forgejo/credentials";
import { runBump } from "../imagebuild/bump";
import { log, traced } from "../log";
import { defaultChangeWorkRoot } from "../results/change-verifier";
import type { BuildBumpBumpDeps } from "./build-bump-bump";

export type { BuildBumpBumpDeps };

interface ResolveBuildBumpDeps {
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	resolveToken?: typeof resolveForgejoToken;
	resolveDeployment?: typeof resolveForgejoDeployment;
	createClient?: typeof createForgejoClient;
	run?: typeof runBump;
	onInfo?: (reason: string) => void;
}

/**
 * Resolve the build-bump BUMP seam ONCE, at composition.
 *
 * THE CREDENTIAL IS CAPTURED HERE, IN THE CLOSURE. `src/imagebuild/bump.ts` takes
 * the token as a caller-supplied argument and the reconcile pass takes only the
 * closure, so the token exists at exactly one boundary — this function — and no
 * test of either side can be satisfied by one reaching it.
 *
 * An absent token or a missing script is NOT a boot failure: `bump: null` disables
 * this rail alone. The reason is one of two FIXED strings, never the path from the
 * environment, which an operator can set to anything.
 *
 * @returns the invoke seam, the script path, the workdir root, and the receipt sink
 */
export const resolveBuildBump = traced(
	"reconcile.resolveBuildBump",
	function resolveBuildBump(deps: ResolveBuildBumpDeps = {}): BuildBumpBumpDeps {
		const env = deps.env ?? process.env;
		const scriptPath =
			env.BUILD_BUMP_SCRIPT ?? "/mnt/share/checkouts/rtech-infra/scripts/factory/open-bump-pr.sh";
		const workdirRoot = `${defaultChangeWorkRoot()}/build-bump`;
		const off = (reason: string): BuildBumpBumpDeps => {
			log("info", "build_bump_bump.disabled", { reason });
			deps.onInfo?.(reason);
			return { bump: null, scriptPath, workdirRoot };
		};
		const token = (deps.resolveToken ?? resolveForgejoToken)(env);
		if (!token.ok) return off("FORGEJO_TOKEN unset");
		if (!(deps.exists ?? existsSync)(scriptPath)) return off("script absent");
		const cred = { token: token.token, user: env.FORGEJO_USER ?? "software-factory" };
		const deployment = (deps.resolveDeployment ?? resolveForgejoDeployment)(env);
		const postReceipt = deployment.ok
			? async (repository: string, pr: number, body: string) => {
					const client = (deps.createClient ?? createForgejoClient)(token.token, {
						baseUrl: deployment.config.apiUrl,
					});
					await client.write("POST", `/repos/${repository}/issues/${pr}/comments`, {
						body,
					});
				}
			: undefined;
		return {
			bump: (input) => (deps.run ?? runBump)(input, cred),
			scriptPath,
			workdirRoot,
			postReceipt,
		};
	},
	// The resolved deps close over a live Forgejo credential (`cred`, `postReceipt`)
	// and arg 0 can carry `env`. Neither side reaches the trace.
	{ redact: { args: [0], result: true } },
);
