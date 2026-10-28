/**
 * @module tests/fleet/ensure-labels
 * @description `fleet/bin/ensure-labels` against a fake
 *   board on loopback: a dry run creates nothing, --apply creates only the
 *   missing company labels.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("fleet/bin/ensure-labels", () => {
	const SCRIPT = resolve(import.meta.dir, "../../fleet/bin/ensure-labels");
	const posts: unknown[] = [];
	let labels: Array<{ id: string; name: string }> = [];
	let server: ReturnType<typeof Bun.serve> | undefined;
	for (let port = 7175; port <= 7179 && !server; port++) {
		try {
			server = Bun.serve({
				port,
				hostname: "127.0.0.1",
				async fetch(req) {
					if (new URL(req.url).pathname !== "/api/companies/co-1/labels")
						return new Response("no", { status: 404 });
					if (req.method === "GET") return Response.json(labels);
					const body = (await req.json()) as { name: string };
					posts.push(body);
					return Response.json({ id: `new-${body.name}`, name: body.name });
				},
			});
		} catch {}
	}
	afterAll(() => server?.stop());
	const run = async (args: string[]) => {
		const p = Bun.spawn([SCRIPT, ...args], {
			env: {
				PATH: process.env.PATH,
				PAPERCLIP_API_URL: `http://127.0.0.1:${server?.port}`,
				PAPERCLIP_API_KEY: "k-1",
				PAPERCLIP_COMPANY_ID: "co-1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(p.stdout).text();
		return { code: await p.exited, stdout };
	};
	test("a dry run creates nothing; --apply creates only the missing labels", async () => {
		labels = [
			{ id: "id-1", name: "tier-1" },
			{ id: "id-p", name: "priority" },
		];
		const dry = await run([]);
		expect(dry.code).toBe(0);
		expect(dry.stdout).toContain("tier-1 id-1");
		expect(dry.stdout).toContain("priority id-p");
		expect(dry.stdout).toContain("tier-0 missing");
		expect(posts).toEqual([]);
		const apply = await run(["--apply"]);
		expect(apply.code).toBe(0);
		expect(posts.map((p) => (p as { name: string }).name)).toEqual([
			"tier-0",
			"tier-2",
			"tier-3",
			"tier-4",
			"tier-5",
		]);
		expect(apply.stdout).toContain("tier-3 new-tier-3");
	});
});
