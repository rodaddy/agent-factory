import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type * as Logic from "../../fleet/plugins/alerts/logic.js";

// Alerts fold by root cause (D10). ALERTS_PLUGIN_UNDER_TEST
// points the suite at a mutated copy (RED proof).
const target = process.env.ALERTS_PLUGIN_UNDER_TEST ?? "../../fleet/plugins/alerts/logic.js";
const { handleDelivery } = (await import(target)) as typeof Logic;

const SECRET = ["am", "hook", String(4 * 1000 + 211)].join("-");
const AUTH = { "x-alerts-token": SECRET };
const T0 = Date.parse("2026-10-07T02:00:00Z");
const MIN = 60_000;

// The 02Z burst of 2026-10-07, 186 titles `Infra: alert:<alertname>:<where>`
// stored one line per alertname: `<alertname>\t<where> <where> ...`.
const BURST = readFileSync(new URL("./fixtures/alerts-burst-02z.txt", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.flatMap((line) => {
		const [alertname, wheres = ""] = line.split("\t") as [string, string?];
		return wheres.split(" ").map((where) => ({ alertname, where }));
	});

interface Issue {
	id: string;
	title: string;
	status: string;
	description?: string;
}

function fakeBoard(seed: Issue[] = []) {
	const issues: Issue[] = [...seed];
	const comments: { issueId: string; body: string; createdAt: string }[] = [];
	let clock = T0;
	const board: Logic.Board = {
		listIssues: async () => issues.map((i) => ({ ...i })),
		listComments: async (id) => comments.filter((c) => c.issueId === id),
		createIssue: async (task) => {
			const issue = { id: `i${issues.length + 1}`, ...task };
			issues.push(issue);
			return issue;
		},
		addComment: async (issueId, body) => {
			comments.push({ issueId, body, createdAt: new Date(clock).toISOString() });
		},
		updateIssue: async (id, patch) => {
			const i = issues.find((x) => x.id === id);
			if (i) Object.assign(i, patch);
		},
	};
	return { issues, comments, board, at: (ms: number) => (clock = ms) };
}

const fv = (where: string, status = "firing") => ({
	status,
	labels: { alertname: "fleet-verify", instance: where, severity: "warning" },
	annotations: { summary: `finding ${where}` },
	startsAt: "2026-10-07T01:55:00Z",
	endsAt: status === "resolved" ? "2026-10-07T02:30:00Z" : "0001-01-01T00:00:00Z",
});

function deliver(f: ReturnType<typeof fakeBoard>, ms: number, ...alerts: unknown[]) {
	f.at(ms);
	return handleDelivery({
		headers: AUTH,
		body: { version: "4", alerts },
		secret: SECRET,
		cfg: { assigneeAgentId: "nagatha" },
		board: f.board,
		now: () => ms,
	});
}

const X = "Infra: alert:fleet-verify:chk";

describe("fold by alert rule plus host group", () => {
	test("replaying the 02Z burst one alert per delivery opens at most 15 tasks", async () => {
		expect(BURST.length).toBe(186);
		const f = fakeBoard();
		for (const [n, b] of BURST.entries())
			await deliver(f, T0 + n * 1000, {
				...fv(b.where),
				labels: { alertname: b.alertname, instance: b.where },
			});
		expect(f.issues.length).toBeLessThanOrEqual(15);
		expect(f.issues.every((i) => i.title.startsWith("Infra: alert:"))).toBe(true);
		expect(f.issues.map((i) => i.title)).toContain("Infra: alert:PiholeWrongAnswer:pihole");
		expect(f.issues.map((i) => i.title)).toContain("Infra: alert:fleet-verify:logs-signatures");
	});

	test("a new instance under an open key is a comment, not a task", async () => {
		const f = fakeBoard();
		expect(await deliver(f, T0, fv("chk/a"))).toEqual([{ key: X.slice(7), action: "create" }]);
		expect(await deliver(f, T0 + MIN, fv("chk/b"))).toEqual([
			{ key: X.slice(7), action: "comment" },
		]);
		expect(f.issues.length).toBe(1);
		expect(f.issues[0]?.title).toBe(X);
		expect(f.issues[0]?.description).toContain("- chk/a: firing");
		expect(f.comments.length).toBe(1);
		expect(f.comments[0]?.body).toContain("- chk/b: firing");
	});

	test("a firing key whose task is done re-opens it with the new instance list", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"));
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		expect(f.issues[0]?.status).toBe("done");
		expect(await deliver(f, T0 + 2 * MIN, fv("chk/c"))).toEqual([
			{ key: X.slice(7), action: "reopen" },
		]);
		expect(f.issues.length).toBe(1);
		expect(f.issues[0]?.status).toBe("todo");
		expect(f.comments.at(-1)?.body).toContain("- chk/c: firing");
	});
});

describe("close only when every tracked instance is currently resolved", () => {
	test("P1 #1: an old resolve of a re-fired instance does not close the task", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"), fv("chk/b"), fv("chk/c"), fv("chk/d"));
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		// Inside the quiet window: the re-fire must still count.
		await deliver(f, T0 + 2 * MIN, fv("chk/a"));
		await deliver(
			f,
			T0 + 3 * MIN,
			fv("chk/b", "resolved"),
			fv("chk/c", "resolved"),
			fv("chk/d", "resolved"),
		);
		expect(f.issues[0]?.status).toBe("todo");
		await deliver(f, T0 + 4 * MIN, fv("chk/a", "resolved"));
		expect(f.issues[0]?.status).toBe("done");
	});

	test("P1 #2: an instance already resolved on the first delivery is tracked", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a", "resolved"), fv("chk/b"), fv("chk/c"), fv("chk/d"));
		expect(f.issues.length).toBe(1);
		await deliver(
			f,
			T0 + MIN,
			fv("chk/b", "resolved"),
			fv("chk/c", "resolved"),
			fv("chk/d", "resolved"),
		);
		expect(f.issues[0]?.status).toBe("done");
	});

	test("P1-a: a resolve replayed after the quiet window does not close while one fires", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"), fv("chk/b"));
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		expect(await deliver(f, T0 + 40 * MIN, fv("chk/a", "resolved"))).toEqual([
			{ key: X.slice(7), action: "skip" },
		]);
		expect(f.issues[0]?.status).toBe("todo");
	});

	test("P1-b: two concurrent deliveries on one fold both land in its state", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"));
		await Promise.all([deliver(f, T0 + MIN, fv("chk/b")), deliver(f, T0 + MIN, fv("chk/c"))]);
		await deliver(f, T0 + 2 * MIN, fv("chk/a", "resolved"), fv("chk/c", "resolved"));
		expect(f.issues[0]?.status).toBe("todo");
		expect(f.comments.at(-1)?.body).toContain("- chk/b: firing");
	});

	test("all instances resolved closes a todo task once; in_progress only comments", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"), fv("chk/b"));
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		expect(f.issues[0]?.status).toBe("todo");
		await deliver(f, T0 + 2 * MIN, fv("chk/b", "resolved"));
		expect(f.issues[0]?.status).toBe("done");
		const g = fakeBoard();
		await deliver(g, T0, fv("chk/a"));
		(g.issues[0] as Issue).status = "in_progress";
		await deliver(g, T0 + MIN, fv("chk/a", "resolved"));
		expect(g.issues[0]?.status).toBe("in_progress");
		expect(g.comments.at(-1)?.body).toContain("RESOLVED");
	});

	// SOF-10340: the resolved state is persisted in the comment before the
	// status update. A 503 on that update must not leave the todo open forever:
	// the same resolved delivery, redelivered, retries the close.
	test("a failed close is retried by the same resolved delivery", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"), fv("chk/b"));
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		const update = f.board.updateIssue;
		let fails = 1;
		f.board.updateIssue = async (id, patch) => {
			if (fails-- > 0) throw new Error("503 Service Unavailable");
			return update(id, patch);
		};
		await expect(deliver(f, T0 + 2 * MIN, fv("chk/b", "resolved"))).rejects.toThrow("503");
		expect(f.comments.at(-1)?.body).toContain("- chk/b: resolved");
		expect(f.issues[0]?.status).toBe("todo");
		const comments = f.comments.length;
		expect(await deliver(f, T0 + 3 * MIN, fv("chk/b", "resolved"))).toEqual([
			{ key: X.slice(7), action: "close" },
		]);
		expect(f.issues[0]?.status).toBe("done");
		expect(f.comments.length).toBe(comments);
	});

	test("an unchanged resolve on an in_progress task neither closes nor comments again", async () => {
		const f = fakeBoard();
		await deliver(f, T0, fv("chk/a"));
		(f.issues[0] as Issue).status = "in_progress";
		await deliver(f, T0 + MIN, fv("chk/a", "resolved"));
		const comments = f.comments.length;
		expect(await deliver(f, T0 + 2 * MIN, fv("chk/a", "resolved"))).toEqual([
			{ key: X.slice(7), action: "skip" },
		]);
		expect(f.issues[0]?.status).toBe("in_progress");
		expect(f.comments.length).toBe(comments);
	});
});
