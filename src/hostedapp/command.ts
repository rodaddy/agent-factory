/**
 * @module hostedapp/command
 * @description The `hosted-app` CLI dispatch. It owns nothing but the
 *   selector, so `validate.ts` and `render.ts` stay independent of each other
 *   — a renderer importing the validator's CLI (or the reverse) would make the
 *   two modules mutually dependent for no behavioural gain.
 *
 * @outputs
 *   - `runHostedApp` -- selector -> process exit code
 *
 * @dependencies
 *   - ./validate -- `validate` and `schema`
 *   - ./render -- `render`
 *   - ./land-cli -- `land`
 *   - ./map -- `map`
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";
import { runHostedAppLand } from "./land-cli";
import { runHostedAppMap } from "./map";
import { runHostedAppRender } from "./render";
import { runHostedAppCommand } from "./validate";

/**
 * Run the `hosted-app` subcommand.
 *
 * @param args - the argument list after the `hosted-app` selector
 * @returns 0 success, 1 invalid input, 3 harness error
 */
export const runHostedApp = traced(
	"hostedapp.runHostedApp",
	async function runHostedApp(args: readonly string[]): Promise<number> {
		if (args[0] === "map") return await runHostedAppMap(args.slice(1));
		if (args[0] === "render") return await runHostedAppRender(args.slice(1));
		if (args[0] === "land") return await runHostedAppLand(args.slice(1));
		return await runHostedAppCommand(args);
	},
);
