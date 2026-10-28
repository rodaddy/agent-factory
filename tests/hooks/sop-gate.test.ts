import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { WatcherConfig } from "../../src/config/schema";
import { forgeDeliveries } from "../../src/db/schema";
import { handleForgejoHook } from "../../src/hooks/forgejo";
import {
	createSopGateTrigger,
	HOSTED_APP_REGISTRY_REPO,
	SITE_PUBLISH_SOURCE_REPO,
	SOP_GATE_DISPATCH_REPO,
	SOP_GATE_GATED_REPO,
	type SopGateRead,
	type SopGateTrigger,
	type SopGateWrite,
} from "../../src/hooks/sop-gate";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

const SECRET = "s3cr3t-hook-key";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

describe("sop-gate allowlisted constants", () => {
	test("the gated and dispatch repositories are the reviewed literals", () => {
		expect(SOP_GATE_GATED_REPO).toBe("rtech/k3s-deploy");
		expect(SOP_GATE_DISPATCH_REPO).toBe("rodaddy/software-factory");
	});
});

/** One recorded write through the injected seam. */
interface RecordedWrite {
	method: string;
	path: string;
	body: unknown;
}

/** A fake `write` seam that records calls and never touches the network. */
function recorder(reject = false): { calls: RecordedWrite[]; write: SopGateWrite } {
	const calls: RecordedWrite[] = [];
	const write: SopGateWrite = async (method, path, body) => {
		calls.push({ method, path, body });
		if (reject) {
			throw new Error("forge unreachable");
		}
		return { status: 201, data: null, link: null, rateRemaining: null };
	};
	return { calls, write };
}

/** Config with the gated repo managed on forgejo. */
function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: SOP_GATE_GATED_REPO,
				provider: "forgejo",
				checks: "standard",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
	};
}

function sign(body: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

/** A pull_request payload for the gated repo, overridable per test. */
function prPayload(
	over: { repo?: string; action?: string; number?: unknown; sha?: unknown } = {},
): string {
	// `in` rather than `??`, so an explicit null override stays null instead of
	// falling back to the valid default and quietly testing the happy path.
	return JSON.stringify({
		action: over.action ?? "opened",
		repository: { full_name: over.repo ?? SOP_GATE_GATED_REPO },
		pull_request: {
			number: "number" in over ? over.number : 42,
			head: { sha: "sha" in over ? over.sha : HEAD_SHA },
		},
	});
}

function hookRequest(body: string, deliveryId: string, event = "pull_request"): Request {
	return new Request("http://10.0.21.0:8787/hooks/forgejo", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-forgejo-signature": sign(body),
			"x-forgejo-event": event,
			"x-forgejo-delivery": deliveryId,
		},
		body,
	});
}

/**
 * Wrap a trigger so a test can await the run the hook fired and forgot:
 * `settled()` waits until the hook has called the trigger, then until that
 * run has finished, so a later absence assertion follows real completion.
 */
function tracked(trigger: SopGateTrigger): {
	sopGate: SopGateTrigger;
	settled: () => Promise<void>;
} {
	let run: Promise<void> | undefined;
	return {
		sopGate: (delivery) => {
			run = trigger(delivery);
			return run;
		},
		settled: async () => {
			await until(() => run !== undefined, 2_000, "sop-gate trigger fired");
			await run?.catch(() => {});
		},
	};
}

describe("createSopGateTrigger", () => {
	test("posts pending status then dispatches, with exact paths and bodies", async () => {
		const { calls, write } = recorder();
		const trigger = createSopGateTrigger(write);
		await trigger({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		});
		expect(calls.length).toBe(2);
		// Order matters: pending is the liveness signal and goes first. The paths
		// are asserted as LITERALS, never interpolated from the module's own
		// constants — a test that reads the constant it is checking follows a
		// mutated value and proves nothing (mutation-probed: changing
		// SOP_GATE_GATED_REPO left a symbolic assertion green).
		expect(calls[0]).toEqual({
			method: "POST",
			path: `https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${HEAD_SHA}`,
			body: {
				context: "sop-gate",
				state: "pending",
				description: "sop-gate queued",
				target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
			},
		});
		expect(calls[1]).toEqual({
			method: "POST",
			path: "https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/sop-gate.yml/dispatches",
			body: { ref: "main", inputs: { pr_number: "42", head_sha: HEAD_SHA } },
		});
	});

	test("does nothing for a repository other than the gated one", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: "rodaddy/software-factory",
			event: "pull_request",
			payload: JSON.parse(prPayload({ repo: "rodaddy/software-factory" })),
		});
		expect(calls.length).toBe(0);
	});

	test("does nothing for a non-pull_request event", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: JSON.parse(prPayload()),
		});
		expect(calls.length).toBe(0);
	});

	test("does nothing for a non-qualifying action", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload({ action: "closed" })),
		});
		expect(calls.length).toBe(0);
	});

	test("fires for every qualifying action", async () => {
		for (const action of ["opened", "synchronized", "edited", "reopened"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SOP_GATE_GATED_REPO,
				event: "pull_request",
				payload: JSON.parse(prPayload({ action })),
			});
			expect(calls.length).toBe(2);
		}
	});

	test("does nothing for a malformed pr number", async () => {
		for (const number of [0, -1, 1.5, "42", null, undefined]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SOP_GATE_GATED_REPO,
				event: "pull_request",
				payload: JSON.parse(prPayload({ number })),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("does nothing for a malformed head sha", async () => {
		for (const sha of ["ABCDEF0123456789abcdef0123456789abcdef01", "deadbeef", "", 12345, null]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SOP_GATE_GATED_REPO,
				event: "pull_request",
				payload: JSON.parse(prPayload({ sha })),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("a failing pending status still leaves the trigger resolved", async () => {
		const { calls, write } = recorder(true);
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		});
		// The pending POST is attempted; its rejection is swallowed and logged by
		// class, and the dispatch is not attempted after a failed liveness signal.
		expect(calls.length).toBe(1);
	});

	test("a failing dispatch after a successful pending still resolves", async () => {
		// Pin the OTHER half of the fire-and-forget contract (PR #494 review,
		// both lanes): pending succeeds, the dispatch POST rejects, and the
		// trigger swallows it — no throw reaches the receiver, and both calls
		// were attempted in order. The pending status is deliberately left
		// standing: a stuck `pending` blocks merge, which the rail design names
		// as the correct failure direction (forgejo-native-rail.md §5.4).
		const calls: RecordedWrite[] = [];
		const write: SopGateWrite = async (method, path, body) => {
			calls.push({ method, path, body });
			if (calls.length > 1) {
				throw new Error("forge unreachable");
			}
			return { status: 201, data: null, link: null, rateRemaining: null };
		};
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		});
		expect(calls.length).toBe(2);
		expect(calls[1]?.path).toContain("/actions/workflows/");
	});
});

/**
 * A stateful fake forge: POSTed commit statuses are stored per
 * (repo, sha) and served back through the combined-status read, keyed on the
 * `status` field the live Forgejo 16 answer uses (probed on rtech/k3s-deploy:
 * `GET /commits/{sha}/status` -> `statuses: [{context, status}]`).
 */
function statefulForge(): {
	statusPosts: RecordedWrite[];
	dispatches: RecordedWrite[];
	write: SopGateWrite;
	read: SopGateRead;
} {
	const statusPosts: RecordedWrite[] = [];
	const dispatches: RecordedWrite[] = [];
	const latest = new Map<string, Map<string, string>>();
	const write: SopGateWrite = async (method, path, body) => {
		const match = /\/repos\/(.+)\/statuses\/([0-9a-f]{40})$/.exec(path);
		if (match) {
			statusPosts.push({ method, path, body });
			const key = `${match[1]}@${match[2]}`;
			const row = body as { context: string; state: string };
			const byContext = latest.get(key) ?? new Map<string, string>();
			byContext.set(row.context, row.state);
			latest.set(key, byContext);
		} else {
			dispatches.push({ method, path, body });
		}
		return { status: 201, data: null, link: null, rateRemaining: null };
	};
	const read: SopGateRead = async (path) => {
		const match = /\/repos\/(.+)\/commits\/([0-9a-f]{40})\/status$/.exec(path);
		const byContext = match ? latest.get(`${match[1]}@${match[2]}`) : undefined;
		const statuses = [...(byContext ?? new Map()).entries()].map(([context, status]) => ({
			context,
			status,
		}));
		return { status: 200, data: { statuses }, link: null, rateRemaining: null };
	};
	return { statusPosts, dispatches, write, read };
}

describe("createSopGateTrigger duplicate pending", () => {
	test("two deliveries for one head sha post exactly one pending status", async () => {
		const forge = statefulForge();
		const trigger = createSopGateTrigger(forge.write, forge.read);
		// Two distinct deliveries for one head sha: the receiver's delivery-id
		// dedupe lets both through, so the gate itself must not double-post.
		for (const action of ["opened", "edited"]) {
			await trigger({
				repository: SOP_GATE_GATED_REPO,
				event: "pull_request",
				payload: JSON.parse(prPayload({ action })),
			});
		}
		expect(forge.statusPosts.length).toBe(1);
		expect(forge.statusPosts[0]?.path).toBe(
			`https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${HEAD_SHA}`,
		);
	});

	test("a settled status for the sha is re-marked pending by a new delivery", async () => {
		const forge = statefulForge();
		const trigger = createSopGateTrigger(forge.write, forge.read);
		const delivery = {
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		};
		await trigger(delivery);
		// The gate run finished and reported.
		await forge.write(
			"POST",
			`https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${HEAD_SHA}`,
			{ context: "sop-gate", state: "success" },
		);
		await trigger({ ...delivery, payload: JSON.parse(prPayload({ action: "reopened" })) });
		const pendings = forge.statusPosts.filter(
			(c) => (c.body as { state: string }).state === "pending",
		);
		expect(pendings.length).toBe(2);
	});

	test("an unreadable status list still posts pending (liveness wins)", async () => {
		const forge = statefulForge();
		const failingRead: SopGateRead = async () => {
			throw new Error("forge unreachable");
		};
		await createSopGateTrigger(
			forge.write,
			failingRead,
		)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		});
		expect(forge.statusPosts.length).toBe(1);
		expect(forge.dispatches.length).toBe(1);
	});

	test("two push-on-main deliveries for one merge sha post exactly one sop-verify pending", async () => {
		const forge = statefulForge();
		const trigger = createSopGateTrigger(forge.write, forge.read);
		for (let i = 0; i < 2; i++) {
			await trigger({ repository: SOP_GATE_GATED_REPO, event: "push", payload: pushPayload() });
		}
		expect(forge.statusPosts.length).toBe(1);
	});
});

/** A push payload for the gated repo, overridable per test. */
function pushPayload(over: { ref?: unknown; after?: unknown } = {}): unknown {
	// `in` rather than `??`, so an explicit null override stays null instead of
	// falling back to the valid default and quietly testing the happy path.
	return {
		ref: "ref" in over ? over.ref : "refs/heads/main",
		after: "after" in over ? over.after : MERGE_SHA,
	};
}

describe("createSopGateTrigger push-on-main", () => {
	test("posts sop-verify pending then dispatches, with exact paths and bodies", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: pushPayload(),
		});
		expect(calls.length).toBe(2);
		// Literals, never the module's own constants — see the PR-path note above.
		expect(calls[0]).toEqual({
			method: "POST",
			path: `https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${MERGE_SHA}`,
			body: {
				context: "sop-verify",
				state: "pending",
				description: "sop-verify queued",
				target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
			},
		});
		expect(calls[1]).toEqual({
			method: "POST",
			path: "https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/sop-verify.yml/dispatches",
			body: { ref: "main", inputs: { merge_sha: MERGE_SHA } },
		});
	});

	test("does nothing for a push on a ref other than refs/heads/main", async () => {
		for (const ref of ["refs/heads/feature-x", "refs/tags/v1"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SOP_GATE_GATED_REPO,
				event: "push",
				payload: pushPayload({ ref }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("does nothing for a push on a repository other than the gated one", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: "rodaddy/software-factory",
			event: "push",
			payload: pushPayload(),
		});
		expect(calls.length).toBe(0);
	});

	test("does nothing for a malformed merge sha", async () => {
		// The all-zeros sha is a Forgejo branch-deletion push: dispatching on it
		// would post a status on a commit that does not exist.
		for (const after of [
			"0000000000000000000000000000000000000000",
			"DEADBEEF0123456789abcdef0123456789abcdef",
			"deadbeef",
			"",
			12345,
			null,
			undefined,
		]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SOP_GATE_GATED_REPO,
				event: "push",
				payload: pushPayload({ after }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("a failing pending status still leaves the push trigger resolved", async () => {
		const { calls, write } = recorder(true);
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: pushPayload(),
		});
		expect(calls.length).toBe(1);
	});

	test("a failing dispatch after a successful pending still resolves on the push path", async () => {
		const calls: RecordedWrite[] = [];
		const write: SopGateWrite = async (method, path, body) => {
			calls.push({ method, path, body });
			if (calls.length > 1) {
				throw new Error("forge unreachable");
			}
			return { status: 201, data: null, link: null, rateRemaining: null };
		};
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: pushPayload(),
		});
		expect(calls.length).toBe(2);
		expect(calls[1]?.path).toContain("/actions/workflows/");
	});
});

describe("handleForgejoHook sop-gate wiring", () => {
	test("a new qualifying delivery triggers the gate", async () => {
		await withTestDb(async (db) => {
			const fired: unknown[] = [];
			const body = prPayload();
			const res = await handleForgejoHook(hookRequest(body, "sop-1"), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				sopGate: async (delivery) => {
					fired.push(delivery);
				},
			});
			expect(res.status).toBe(202);
			await until(() => fired.length === 1, 2_000, "sop-gate fired");
			expect(fired.length).toBe(1);
		});
	});

	test("a duplicate delivery reaches the gate only marked duplicate", async () => {
		await withTestDb(async (db) => {
			const seen: (boolean | undefined)[] = [];
			const body = prPayload();
			const wiring = {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				sopGate: async (delivery: { duplicate?: boolean }) => {
					seen.push(delivery.duplicate);
				},
			};
			await handleForgejoHook(hookRequest(body, "sop-dup"), wiring);
			const second = await handleForgejoHook(hookRequest(body, "sop-dup"), wiring);
			expect(second.status).toBe(200);
			await until(() => seen.length === 2, 2_000, "both deliveries reached the gate");
			expect(seen).toEqual([undefined, true]);
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
		});
	});

	test("a rejecting trigger still answers the webhook 202", async () => {
		await withTestDb(async (db) => {
			const body = prPayload();
			const gate = tracked(async () => {
				throw new Error("trigger exploded");
			});
			const res = await handleForgejoHook(hookRequest(body, "sop-reject"), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				sopGate: gate.sopGate,
			});
			expect(res.status).toBe(202);
			await gate.settled();
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
		});
	});

	test("an unwired sopGate leaves behavior exactly as before", async () => {
		await withTestDb(async (db) => {
			const body = prPayload();
			const res = await handleForgejoHook(hookRequest(body, "sop-none"), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(202);
		});
	});
});

/** A push payload for the enrolled content repo, overridable per test. */
function sitePushPayload(over: { ref?: unknown; after?: unknown; before?: unknown } = {}): unknown {
	// `in` rather than `??`, so an explicit null override stays null instead of
	// falling back to the valid default and quietly testing the happy path.
	return {
		ref: "ref" in over ? over.ref : "refs/heads/main",
		after: "after" in over ? over.after : HEAD_SHA,
		before: "before" in over ? over.before : MERGE_SHA,
	};
}

describe("site-publish allowlisted constant", () => {
	test("the enrolled content repository is the reviewed literal", () => {
		expect(SITE_PUBLISH_SOURCE_REPO).toBe("rtech/rtech-consulting");
	});
});

describe("createSopGateTrigger site-publish push-on-main", () => {
	test("posts site-publish pending on the SOURCE repo then dispatches, with exact paths and bodies", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SITE_PUBLISH_SOURCE_REPO,
			event: "push",
			payload: sitePushPayload(),
		});
		expect(calls.length).toBe(2);
		// Literals, never the module's own constants — see the PR-path note above.
		expect(calls[0]).toEqual({
			method: "POST",
			path: `https://forge.example.internal/api/v1/repos/rtech/rtech-consulting/statuses/${HEAD_SHA}`,
			body: {
				context: "site-publish",
				state: "pending",
				description: "site-publish queued",
				target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
			},
		});
		expect(calls[1]).toEqual({
			method: "POST",
			path: "https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/site-publish.yml/dispatches",
			body: { ref: "main", inputs: { source_sha: HEAD_SHA, before_sha: MERGE_SHA } },
		});
	});

	test("a before that is not a sha is forwarded as the empty string, never refused", async () => {
		// A branch-creation push carries the zero sha; a malformed or absent
		// before must still publish, with the workflow diffing against the parent.
		for (const before of [
			"0000000000000000000000000000000000000000",
			"deadbeef",
			"",
			42,
			null,
			undefined,
		]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SITE_PUBLISH_SOURCE_REPO,
				event: "push",
				payload: sitePushPayload({ before }),
			});
			expect(calls.length).toBe(2);
			expect(calls[1]?.body).toEqual({
				ref: "main",
				inputs: { source_sha: HEAD_SHA, before_sha: "" },
			});
		}
	});

	test("does nothing for a push on a ref other than refs/heads/main", async () => {
		for (const ref of ["refs/heads/seo-loop", "refs/tags/v1", "main"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SITE_PUBLISH_SOURCE_REPO,
				event: "push",
				payload: sitePushPayload({ ref }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("does nothing for a push on a repository that is not enrolled", async () => {
		// The web repo the publish WRITES to must never re-trigger a publish.
		for (const repository of ["rtech/web-rtech-consulting", "rodaddy/software-factory"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository,
				event: "push",
				payload: sitePushPayload(),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("does nothing for a pull_request event on the enrolled repository", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SITE_PUBLISH_SOURCE_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload({ repo: SITE_PUBLISH_SOURCE_REPO })),
		});
		expect(calls.length).toBe(0);
	});

	test("does nothing for a malformed source sha", async () => {
		for (const after of [
			"0000000000000000000000000000000000000000",
			"DEADBEEF0123456789abcdef0123456789abcdef",
			"deadbeef",
			"",
			12345,
			null,
			undefined,
		]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: SITE_PUBLISH_SOURCE_REPO,
				event: "push",
				payload: sitePushPayload({ after }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("a failing pending status still leaves the site-publish trigger resolved", async () => {
		const { calls, write } = recorder(true);
		await createSopGateTrigger(write)({
			repository: SITE_PUBLISH_SOURCE_REPO,
			event: "push",
			payload: sitePushPayload(),
		});
		expect(calls.length).toBe(1);
	});

	test("a failing dispatch after a successful pending still resolves on the site-publish path", async () => {
		const calls: RecordedWrite[] = [];
		const write: SopGateWrite = async (method, path, body) => {
			calls.push({ method, path, body });
			if (calls.length > 1) {
				throw new Error("forge unreachable");
			}
			return { status: 201, data: null, link: null, rateRemaining: null };
		};
		await createSopGateTrigger(write)({
			repository: SITE_PUBLISH_SOURCE_REPO,
			event: "push",
			payload: sitePushPayload(),
		});
		expect(calls.length).toBe(2);
		expect(calls[1]?.path).toContain("/actions/workflows/site-publish.yml/");
	});
});

/** A push payload for the hosted-app registry repo, overridable per test. */
function hostedAppPushPayload(over: { ref?: unknown; after?: unknown } = {}): unknown {
	// `in` rather than `??`, so an explicit null override stays null instead of
	// falling back to the valid default and quietly testing the happy path.
	return {
		ref: "ref" in over ? over.ref : "refs/heads/main",
		after: "after" in over ? over.after : HEAD_SHA,
	};
}

describe("hosted-app-render allowlisted constant", () => {
	test("the hosted-app registry repository is the reviewed literal", () => {
		expect(HOSTED_APP_REGISTRY_REPO).toBe("rtech/hosted-apps");
	});
});

describe("createSopGateTrigger hosted-app-render push-on-main", () => {
	test("posts hosted-app-render pending on the REGISTRY repo then dispatches, with exact paths and bodies", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: HOSTED_APP_REGISTRY_REPO,
			event: "push",
			payload: hostedAppPushPayload(),
		});
		expect(calls.length).toBe(2);
		// Literals, never the module's own constants — see the PR-path note above.
		expect(calls[0]).toEqual({
			method: "POST",
			path: `https://forge.example.internal/api/v1/repos/rtech/hosted-apps/statuses/${HEAD_SHA}`,
			body: {
				context: "hosted-app-render",
				state: "pending",
				description: "hosted-app-render queued",
				target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
			},
		});
		expect(calls[1]).toEqual({
			method: "POST",
			path: "https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/hosted-app-render.yml/dispatches",
			body: { ref: "main", inputs: { registry_sha: HEAD_SHA } },
		});
	});

	test("does nothing for a push on a ref other than refs/heads/main", async () => {
		for (const ref of ["refs/heads/registry-wip", "refs/tags/v1", "main"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: HOSTED_APP_REGISTRY_REPO,
				event: "push",
				payload: hostedAppPushPayload({ ref }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("does nothing for a push on a repository that is not the registry", async () => {
		for (const repository of ["rtech/web-rtech-consulting", "rodaddy/software-factory"]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository,
				event: "push",
				payload: hostedAppPushPayload(),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("the first three shapes still take THEIR paths, not this one", async () => {
		// The gated repo's push takes the sop-verify path.
		const verify = recorder();
		await createSopGateTrigger(verify.write)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: hostedAppPushPayload(),
		});
		expect(verify.calls.length).toBe(2);
		expect(verify.calls[1]?.path).toContain("/actions/workflows/sop-verify.yml/");

		// The enrolled content repo's push takes the site-publish path.
		const publish = recorder();
		await createSopGateTrigger(publish.write)({
			repository: SITE_PUBLISH_SOURCE_REPO,
			event: "push",
			payload: sitePushPayload(),
		});
		expect(publish.calls.length).toBe(2);
		expect(publish.calls[1]?.path).toContain("/actions/workflows/site-publish.yml/");

		// The gated repo's pull_request still takes the sop-gate path.
		const gate = recorder();
		await createSopGateTrigger(gate.write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
		});
		expect(gate.calls.length).toBe(2);
		expect(gate.calls[1]?.path).toContain("/actions/workflows/sop-gate.yml/");
	});

	test("does nothing for a pull_request event on the registry repository", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: HOSTED_APP_REGISTRY_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload({ repo: HOSTED_APP_REGISTRY_REPO })),
		});
		expect(calls.length).toBe(0);
	});

	test("does nothing for a malformed registry sha", async () => {
		for (const after of [
			"0000000000000000000000000000000000000000",
			"DEADBEEF0123456789abcdef0123456789abcdef",
			"deadbeef",
			"",
			12345,
			null,
			undefined,
		]) {
			const { calls, write } = recorder();
			await createSopGateTrigger(write)({
				repository: HOSTED_APP_REGISTRY_REPO,
				event: "push",
				payload: hostedAppPushPayload({ after }),
			});
			expect(calls.length).toBe(0);
		}
	});

	test("a failing pending status still leaves the hosted-app-render trigger resolved", async () => {
		const { calls, write } = recorder(true);
		await createSopGateTrigger(write)({
			repository: HOSTED_APP_REGISTRY_REPO,
			event: "push",
			payload: hostedAppPushPayload(),
		});
		expect(calls.length).toBe(1);
	});

	test("a failing dispatch after a successful pending still resolves on the hosted-app-render path", async () => {
		const calls: RecordedWrite[] = [];
		const write: SopGateWrite = async (method, path, body) => {
			calls.push({ method, path, body });
			if (calls.length > 1) {
				throw new Error("forge unreachable");
			}
			return { status: 201, data: null, link: null, rateRemaining: null };
		};
		await createSopGateTrigger(write)({
			repository: HOSTED_APP_REGISTRY_REPO,
			event: "push",
			payload: hostedAppPushPayload(),
		});
		expect(calls.length).toBe(2);
		expect(calls[1]?.path).toContain("/actions/workflows/hosted-app-render.yml/");
	});
});

/** The fake insert builder: explicitly typed because it refers to itself (TS7022). */
interface InsertChain {
	values: () => InsertChain;
	onConflictDoNothing: () => InsertChain;
	returning: () => Promise<{ id: number }[]>;
}

/** A db whose every insert rejects, as Drizzle does when postgres is down. */
function downDb(): Parameters<typeof handleForgejoHook>[1]["db"] {
	const chain: InsertChain = {
		values: () => chain,
		onConflictDoNothing: () => chain,
		returning: () => Promise.reject(new Error("DrizzleQueryError: connection refused")),
	};
	return { insert: () => chain } as unknown as Parameters<typeof handleForgejoHook>[1]["db"];
}

describe("sop-gate when its database is down", () => {
	const ERROR_BODY = {
		context: "sop-gate",
		state: "error",
		description: "sop-gate database unavailable; re-run after recovery",
		target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
	};

	test("the trigger posts an error status and dispatches nothing", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
			dbUnavailable: true,
		});
		expect(calls).toEqual([
			{
				method: "POST",
				path: `https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${HEAD_SHA}`,
				body: ERROR_BODY,
			},
		]);
	});

	test("a failing error-status post still resolves", async () => {
		const { calls, write } = recorder(true);
		await createSopGateTrigger(write)({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: JSON.parse(prPayload()),
			dbUnavailable: true,
		});
		expect(calls.length).toBe(1);
	});

	test("a throwing delivery insert posts the error status and the hook does not throw", async () => {
		const { calls, write } = recorder();
		const gate = tracked(createSopGateTrigger(write));
		const res = await handleForgejoHook(hookRequest(prPayload(), "sop-db-down"), {
			secret: SECRET,
			db: downDb(),
			config: config(),
			wake: () => {},
			sopGate: gate.sopGate,
		});
		expect(res.status).toBe(503);
		await gate.settled();
		expect(calls.length).toBe(1);
		expect(calls[0]?.body).toEqual(ERROR_BODY);
	});
});

/** A db whose every insert returns no row: the delivery id is already recorded. */
function duplicateDb(): Parameters<typeof handleForgejoHook>[1]["db"] {
	const chain: InsertChain = {
		values: () => chain,
		onConflictDoNothing: () => chain,
		returning: () => Promise.resolve([]),
	};
	return { insert: () => chain } as unknown as Parameters<typeof handleForgejoHook>[1]["db"];
}

/** A read seam answering one fixed sop-gate row for every commit. */
function statusRead(row: { status: string; description: string }): SopGateRead {
	return async () => ({
		status: 200,
		data: { statuses: [{ context: "sop-gate", ...row }] },
		link: null,
		rateRemaining: null,
	});
}

describe("sop-gate on a redelivery after a database outage", () => {
	const DB_DOWN = "sop-gate database unavailable; re-run after recovery";
	/** A guard sleep that never wakes, so no detached watch runs in these tests. */
	const inertGuard = { sleep: () => new Promise<void>(() => {}) };

	async function redeliver(read: SopGateRead): Promise<{ res: Response; calls: RecordedWrite[] }> {
		const { calls, write } = recorder();
		const gate = tracked(createSopGateTrigger(write, read, inertGuard));
		const res = await handleForgejoHook(hookRequest(prPayload(), "sop-redelivered"), {
			secret: SECRET,
			db: duplicateDb(),
			config: config(),
			wake: () => {},
			sopGate: gate.sopGate,
		});
		await gate.settled();
		return { res, calls };
	}

	test("a duplicate whose head carries our db-unavailable error runs the gate", async () => {
		const { res, calls } = await redeliver(statusRead({ status: "error", description: DB_DOWN }));
		expect(res.status).toBe(200);
		expect(calls.length).toBe(2);
		expect(calls[0]?.body).toEqual({
			context: "sop-gate",
			state: "pending",
			description: "sop-gate queued",
			target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
		});
		expect(calls[1]?.path).toContain("/actions/workflows/sop-gate.yml/dispatches");
	});

	for (const status of ["pending", "success"]) {
		test(`a duplicate whose head sop-gate status is ${status} triggers nothing`, async () => {
			const { res, calls } = await redeliver(statusRead({ status, description: "x" }));
			expect(res.status).toBe(200);
			expect(calls.length).toBe(0);
		});
	}

	test("a duplicate with an error of a different description triggers nothing", async () => {
		const { calls } = await redeliver(statusRead({ status: "error", description: "other" }));
		expect(calls.length).toBe(0);
	});

	test("a duplicate whose status read throws does not throw and triggers nothing", async () => {
		const { res, calls } = await redeliver(async () => {
			throw new Error("forge unreachable");
		});
		expect(res.status).toBe(200);
		expect(calls.length).toBe(0);
	});

	test("a duplicate push on main triggers nothing", async () => {
		const { calls, write } = recorder();
		await createSopGateTrigger(
			write,
			statusRead({ status: "error", description: DB_DOWN }),
		)({
			repository: SOP_GATE_GATED_REPO,
			event: "push",
			payload: pushPayload(),
			duplicate: true,
		});
		expect(calls.length).toBe(0);
	});
});
