// forge's CI, PR-files, comment, repo and branch verbs. forge wires them
// in and hands over its helpers, so this file imports nothing from forge and no cycle forms.

const PAGE = 50;
const PENDING = new Set(["running", "waiting", "blocked"]);
const GREEN = new Set(["success", "skipped"]);
const MAX_PAGES = 20;

/** The verbs, built over forge's own request, show, positionals, num, target, bodyOf, Usage and forge-op's segments. */
export function verbs({ request, show, positionals, num, target, bodyOf, segments, Usage }) {
	// Field names as ListActionRuns and ActionRun return them (prettyref, commit_sha, title).
	const runLine = (r) => `${r.id} ${r.status} ${r.event} ${r.prettyref} ${String(r.commit_sha ?? "").slice(0, 7)} ${r.title}`;

	const jobsOf = (jobs) => (Array.isArray(jobs) ? jobs : (jobs?.jobs ?? []));

	/** Every run for one <repo> <sha> pair, each with its jobs; done once a run matched and no job is pending.
	 * Every page is read, never only up to the first match: a failed same-sha run can sit on a later page. */
	async function pairState(ctx, p) {
		const matched = [];
		let got = [];
		for (let page = 1; page === 1 || (got.length === PAGE && page <= MAX_PAGES); page++) {
			got = (await request(ctx, "GET", `/repos/${p.repo}/actions/runs?page=${page}&limit=${PAGE}`))?.workflow_runs ?? [];
			matched.push(...got.filter((r) => String(r.commit_sha ?? "").toLowerCase().startsWith(p.sha)));
		}
		if (got.length === PAGE) throw new Error(`runs ${p.repo} ${p.sha}: more than ${PAGE * MAX_PAGES} records; refusing a partial verdict`);
		const runs = [];
		for (const run of matched) runs.push({ run, jobs: jobsOf(await request(ctx, "GET", `/repos/${p.repo}/actions/runs/${run.id}/jobs`)) });
		// Judged by the jobs, never the run: Forgejo can flip a run to failure while a job still runs.
		const done = runs.length > 0 && runs.every((x) => x.jobs.length > 0 && x.jobs.every((j) => !PENDING.has(j.status)));
		return { repo: p.repo, sha: p.sha, runs, done };
	}

	const RUN = {
		async list(ctx, o) {
			const [r] = positionals(o, ["repo"]);
			// Forgejo ignores limit without page.
			const q = new URLSearchParams({ page: "1", limit: o.limit === undefined ? "20" : num(o.limit) });
			if (o.status !== undefined) q.set("status", o.status);
			const path = `/repos/${ctx.repo(r)}/actions/runs?${q}`;
			return show(ctx, await request(ctx, "GET", path), (x) => (x.workflow_runs ?? []).map(runLine));
		},
		async view(ctx, o) {
			const [repo, id] = target(ctx, o);
			const base = `/repos/${repo}/actions/runs/${id}`;
			const run = await request(ctx, "GET", base);
			const jobs = await request(ctx, "GET", `${base}/jobs`);
			const jobLines = (Array.isArray(jobs) ? jobs : (jobs?.jobs ?? [])).map((j) => `  job ${j.id} ${j.status} ${j.name}`);
			return show(ctx, { run, jobs }, () => [runLine(run), ...jobLines]);
		},
		/** Block until every <repo> <sha> pair's CI jobs are done. Time is counted in slept intervals. */
		async wait(ctx, o) {
			if (o._.length === 0 || o._.length % 2) throw new Usage(`expected <repo> <sha> [<repo> <sha>]..., got ${o._.length} argument(s)`);
			const interval = o.interval === undefined ? 60 : Number(num(o.interval));
			if (interval < 10) throw new Usage(`--interval must be at least 10 seconds, got ${interval}`);
			const minutes = o.timeout === undefined ? 30 : Number(num(o.timeout));
			const pairs = [];
			for (let i = 0; i < o._.length; i += 2) {
				const sha = o._[i + 1];
				if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Usage(`<sha> must be 7 to 40 hex characters, got '${sha}'`);
				pairs.push({ repo: ctx.repo(o._[i]), sha: sha.toLowerCase() });
			}
			const state = new Array(pairs.length);
			let timedOut = false;
			for (let elapsed = 0; ; elapsed += interval) {
				// Every pair is re-read each poll: a done pair can gain a failed run while another still runs.
				for (let i = 0; i < pairs.length; i++) state[i] = await pairState(ctx, pairs[i]);
				if (state.every((s) => s.done)) break;
				if (elapsed + interval > minutes * 60) {
					timedOut = true;
					break;
				}
				await ctx.sleep(interval);
			}
			const jobs = state.flatMap((s) => s.runs.flatMap((x) => x.jobs));
			const code = timedOut ? 2 : jobs.every((j) => GREEN.has(j.status)) ? 0 : 1;
			const human = (ss) => ss.flatMap((s) => (s.runs.length === 0 ? [`${s.repo} ${s.sha.slice(0, 7)} no run`]
				: s.runs.flatMap((x) => [runLine(x.run), ...x.jobs.map((j) => `  job ${j.id} ${j.status} ${j.name}`)])));
			show(ctx, state.map(({ repo, sha, runs }) => ({ repo, sha, runs })), human);
			if (timedOut) ctx.stderr(`forge: run wait timed out after ${minutes} min`);
			return code;
		},
		async log(ctx, o) {
			const [repo, id] = target(ctx, o);
			const tail = o.tail === undefined ? undefined : Number(num(o.tail));
			const out = await request(ctx, "GET", `/repos/${repo}/actions/jobs/${id}/logs`, undefined, { text: true });
			const lines = (typeof out === "string" ? out : JSON.stringify(out ?? "")).replace(/\n$/, "").split("\n");
			ctx.stdout((tail === undefined ? lines : lines.slice(-tail)).join("\n"));
			return 0;
		},
	};

	/** Every changed file of a PR, page by page until a short page (or MAX_PAGES), then a total. */
	async function files(ctx, o) {
		const [repo, n] = target(ctx, o);
		const all = [];
		for (let page = 1, got = []; page === 1 || (got.length === PAGE && page <= MAX_PAGES); page++) {
			got = (await request(ctx, "GET", `/repos/${repo}/pulls/${n}/files?page=${page}&limit=${PAGE}`)) ?? [];
			all.push(...got);
		}
		const sum = (k) => all.reduce((s, f) => s + (f[k] ?? 0), 0);
		return show(ctx, all, (fs) => [...fs.map((f) => `${f.status} +${f.additions} -${f.deletions} ${f.filename}`),
			`${fs.length} files, +${sum("additions")} -${sum("deletions")}`]);
	}

	const COMMENT = {
		async view(ctx, o) {
			const [repo, id] = target(ctx, o);
			const c = await request(ctx, "GET", `/repos/${repo}/issues/comments/${id}`);
			return show(ctx, c, (x) => [x.html_url, `user: ${x.user?.login}  updated: ${x.updated_at}`, "", x.body]);
		},
		async edit(ctx, o) {
			const [repo, id] = target(ctx, o);
			const c = await request(ctx, "PATCH", `/repos/${repo}/issues/comments/${id}`, { body: bodyOf(ctx, o, true) });
			return show(ctx, c, (x) => x.html_url);
		},
	};

	const REPO = {
		async view(ctx, o) {
			const [r] = positionals(o, ["repo"]);
			return show(ctx, await request(ctx, "GET", `/repos/${ctx.repo(r)}`), (x) => [x.full_name,
				`default: ${x.default_branch}  private: ${x.private}  archived: ${x.archived}`, `url: ${x.html_url}`,
				...(x.description ? [`description: ${x.description}`] : [])]);
		},
		async search(ctx, o) {
			const [q] = positionals(o, ["word"]);
			const query = new URLSearchParams({ q, limit: o.limit === undefined ? "20" : num(o.limit), page: "1" });
			const line = (x) => `${x.full_name} ${x.private ? "private" : "public"} ${x.description ?? ""}`.trimEnd();
			return show(ctx, await request(ctx, "GET", `/repos/search?${query}`), (x) => (x?.data ?? []).map(line));
		},
	};

	// A branch name may hold a `/`: each segment is encoded on its own.
	const named = (ctx, o, more = []) => {
		const [r, name] = positionals(o, ["repo", "name", ...more]);
		const repo = ctx.repo(r);
		return [repo, name, `/repos/${repo}/branches/${segments("name", name, true)}`];
	};
	const sha7 = (b) => String(b.commit?.id ?? "").slice(0, 7);
	const BRANCH = {
		async list(ctx, o) {
			const [r] = positionals(o, ["repo"]);
			const q = new URLSearchParams({ page: "1", limit: o.limit === undefined ? "50" : num(o.limit) });
			const line = (b) => `${b.name} ${sha7(b)} ${b.protected ? "protected" : "-"}`;
			return show(ctx, await request(ctx, "GET", `/repos/${ctx.repo(r)}/branches?${q}`), (bs) => bs.map(line));
		},
		async view(ctx, o) {
			const [, , path] = named(ctx, o);
			const line = (b) => `${b.name} ${b.commit?.id} protected: ${b.protected} user_can_push: ${b.user_can_push}`;
			return show(ctx, await request(ctx, "GET", path), line);
		},
		async create(ctx, o) {
			const [repo, name] = named(ctx, o);
			const from = o.from ?? (await request(ctx, "GET", `/repos/${repo}`))?.default_branch;
			const body = { new_branch_name: name, old_ref_name: from };
			return show(ctx, await request(ctx, "POST", `/repos/${repo}/branches`, body), (b) => `${b.name} ${sha7(b)}`);
		},
		async delete(ctx, o) {
			const [, name, path] = named(ctx, o);
			await request(ctx, "DELETE", path);
			return show(ctx, null, () => `deleted ${name}`);
		},
	};

	return { RUN, files, COMMENT, REPO, BRANCH };
}
