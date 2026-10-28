import { describe, expect, test } from "bun:test";
import {
	type ControlSurface,
	type ControlSurfaceDecision,
	createControlSurfaceRegistry,
	runControlSurfacePass,
} from "../../src/control-surface";

/**
 * A surface whose mutating operation THROWS. A default success stub would make
 * every dry-run assertion below pass regardless of what actually ran, so the
 * fake fails loudly instead of being absorbed into a green result.
 */
function makeSurface(labels: string[], column: string | null = "Todo"): ControlSurface {
	return {
		readLabels: async () => labels,
		readColumn: async () => column,
		proposeLabelWrite: async () => {
			throw new Error("a mutating call was made during a dry run");
		},
	};
}

const EVENT = { repository: "rodaddy/software-factory", item: 253 };

describe("runControlSurfacePass — dry run", () => {
	test("observes, resolves, and logs a decision without dispatching", async () => {
		const dispatched: unknown[] = [];
		const logged: ControlSurfaceDecision[] = [];
		const result = await runControlSurfacePass({
			surface: makeSurface(["factory-implement"]),
			events: [EVENT],
			dryRun: true,
			dispatch: (d) => {
				dispatched.push(d);
				throw new Error("DRY-RUN VIOLATION: dispatch was called");
			},
			log: (d) => logged.push(d),
		});

		expect(dispatched).toHaveLength(0);
		expect(logged).toHaveLength(1);
		expect(result.decisions).toHaveLength(1);
		// C5 is the control for C4: it decided AND it did not act. Either alone is
		// satisfiable by an implementation that does nothing at all.
		expect(result.decisions[0]?.decision.job).toBe("implement-issue");
		expect(result.decisions[0]?.dispatched).toBe(false);
	});

	test("defaults to dry run when the caller omits the flag", async () => {
		const dispatched: unknown[] = [];
		await runControlSurfacePass({
			surface: makeSurface(["factory-triage"]),
			events: [EVENT],
			dispatch: (d) => dispatched.push(d),
		});
		// The safe mode must be the one you get by omission.
		expect(dispatched).toHaveLength(0);
	});

	test("records the observed column and its lifecycle state", async () => {
		const result = await runControlSurfacePass({
			surface: makeSurface(["factory-review"], "In Progress"),
			events: [EVENT],
		});
		expect(result.decisions[0]?.column).toBe("In Progress");
		expect(result.decisions[0]?.columnState).toBe("dispatched");
	});

	test("logs a decision for an unknown label too, so the event is not lost", async () => {
		const result = await runControlSurfacePass({
			surface: makeSurface(["some-unrelated-label"]),
			events: [EVENT],
		});
		expect(result.decisions).toHaveLength(1);
		expect(result.decisions[0]?.decision.job).toBeNull();
		expect(result.decisions[0]?.decision.reason.length).toBeGreaterThan(0);
	});

	test("dispatches nothing when no events are supplied", async () => {
		const result = await runControlSurfacePass({ surface: makeSurface([]) });
		expect(result.decisions).toHaveLength(0);
	});

	test("survives a backend that cannot answer, falling back to the observed label", async () => {
		const unreachable: ControlSurface = {
			readLabels: async () => {
				throw new Error("backend unreachable");
			},
			readColumn: async () => {
				throw new Error("backend unreachable");
			},
			proposeLabelWrite: async () => ({ applied: false, intent: "none" }),
		};
		const result = await runControlSurfacePass({
			surface: unreachable,
			events: [{ ...EVENT, label: "factory-triage" }],
		});
		// One unreachable repository must not take down the pass.
		expect(result.decisions[0]?.decision.job).toBe("issue-triage");
	});
});

describe("runControlSurfacePass — applying mode", () => {
	test("dispatches a resolved job only when dry run is explicitly disabled", async () => {
		const dispatched: ControlSurfaceDecision[] = [];
		await runControlSurfacePass({
			surface: makeSurface(["factory-implement"]),
			events: [EVENT],
			dryRun: false,
			dispatch: (d) => dispatched.push(d),
		});
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.decision.job).toBe("implement-issue");
	});

	test("awaits an async dispatcher before the pass returns", async () => {
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let returned = false;
		const running = runControlSurfacePass({
			surface: makeSurface(["deploy:demo"]),
			events: [EVENT],
			dryRun: false,
			dispatch: async () => {
				markStarted?.();
				await gate;
			},
		}).then(() => {
			returned = true;
		});

		await started;
		expect(returned).toBe(false);
		release?.();
		await running;
		expect(returned).toBe(true);
	});

	test("does not dispatch an unresolved label even outside dry run", async () => {
		const dispatched: unknown[] = [];
		await runControlSurfacePass({
			surface: makeSurface(["not-a-factory-label"]),
			events: [EVENT],
			dryRun: false,
			dispatch: (d) => dispatched.push(d),
		});
		expect(dispatched).toHaveLength(0);
	});

	test("dispatches a parameterized deploy label through its registered verb job", async () => {
		const dispatched: Array<{ decision: { job: string | null; parameter: string | null } }> = [];
		await runControlSurfacePass({
			surface: makeSurface(["deploy:paperless"]),
			events: [EVENT],
			dryRun: false,
			dispatch: (decision) => dispatched.push(decision),
		});
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.decision).toMatchObject({ job: "newapp", parameter: "paperless" });
	});
});

describe("createControlSurfaceRegistry", () => {
	const surface = makeSurface(["factory-triage"]);

	test("enumerates its registered backends", () => {
		const registry = createControlSurfaceRegistry({ backends: { github: surface } });
		expect(registry.backends()).toContain("github");
	});

	test("resolves a registered backend to its surface", () => {
		const registry = createControlSurfaceRegistry({ backends: { github: surface } });
		const resolved = registry.surfaceFor("github");
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(typeof resolved.surface.readLabels).toBe("function");
		}
	});

	test("fails closed for an unregistered backend rather than throwing", () => {
		const registry = createControlSurfaceRegistry({ backends: { github: surface } });
		const resolved = registry.surfaceFor("forgejo");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.error).toContain("forgejo");
		}
	});

	test("returns a stable answer within a pass", () => {
		const registry = createControlSurfaceRegistry({ backends: { github: surface } });
		expect(registry.surfaceFor("github")).toBe(registry.surfaceFor("github"));
	});

	test("enumerates an empty set when no backend is registered", () => {
		expect(createControlSurfaceRegistry().backends()).toHaveLength(0);
	});
});
