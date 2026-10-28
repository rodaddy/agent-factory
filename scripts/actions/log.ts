/**
 * @module actions/log
 * @description The Actions-lane logger that honors the lane's log level
 *   (708c; D15 dispatch-time escalation). Every workflow hands its
 *   `log_level` input to each bun step as `FACTORY_LOG_LEVEL` through `env:`;
 *   this reads it. One JSON line per event on stderr, so stdout payloads (a
 *   rendered request, an engine reply) stay exactly as they are. `debug` lines
 *   are dropped unless the level is `debug`; an absent or unknown value is
 *   `info`, so a bad value can only make a lane quieter, never louder.
 *
 * @outputs
 *   - `laneLogLevel` -- the lane's level from the environment
 *   - `createActionLog` -- a `{debug, info, warn, error}` logger over a writer
 */
import { traced } from "../../src/log";

export type LaneLogLevel = "info" | "debug";
type Level = "debug" | "info" | "warn" | "error";
type Emit = (event: string, fields?: Record<string, unknown>) => void;
export type ActionLog = Record<Level, Emit>;

function laneLogLevelImpl(env: NodeJS.ProcessEnv = process.env): LaneLogLevel {
	return env.FACTORY_LOG_LEVEL === "debug" ? "debug" : "info";
}

/** The argument is the whole process environment, so it is redacted. */
export const laneLogLevel: (env?: NodeJS.ProcessEnv) => LaneLogLevel = traced(
	"actions.laneLogLevel",
	laneLogLevelImpl,
	{ redact: { args: [0] } },
);

function createActionLogImpl(
	env: NodeJS.ProcessEnv = process.env,
	write: (line: string) => void = (line) => void process.stderr.write(line),
): ActionLog {
	const threshold = laneLogLevelImpl(env);
	const emit =
		(level: Level): Emit =>
		(event, fields = {}) => {
			if (level === "debug" && threshold !== "debug") return;
			write(
				`${JSON.stringify({ ...fields, time: new Date().toISOString(), level, msg: event })}\n`,
			);
		};
	return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** The environment argument is redacted; the result is four closures. */
export const createActionLog = traced("actions.createActionLog", createActionLogImpl, {
	redact: { args: [0] },
});
