// Review-state labels on PRs: `pr create` adds review:requested, `pr review`
// swaps approved/changes. Never a gate: a labelling failure is one stderr warning and the verb's
// exit code stands. needs-rico is never set here; `label add` only creates it when missing.
// forge hands over its request and allLabels, so this file imports nothing from forge.

const LABELS = {
	"review:requested": ["#fbca04", "PR waiting for review"],
	"review:approved": ["#0e8a16", "Review approved"],
	"review:changes": ["#d93f0b", "Review asked for changes"],
	"needs-rico": ["#b60205", "Needs Rico's decision"],
};
const SWAP = { approve: "review:approved", "request-changes": "review:changes" };
const STATES = ["review:requested", "review:approved", "review:changes"];
/** forge's stderr is the log: one line per warning. */
const log = { warn: (ctx, msg) => ctx.stderr(`forge: warning: ${msg}`) };

export function reviewLabels({ request, allLabels }) {
	/** The label's id, repo then org labels; a review label that is missing is created in the repo. */
	async function ensure(ctx, repo, name) {
		const found = (await allLabels(ctx, repo)).find((l) => l.name === name);
		if (found) return found.id;
		const [color, description] = LABELS[name];
		return (await request(ctx, "POST", `/repos/${repo}/labels`, { name, color, description })).id;
	}

	async function warnOnly(ctx, work) {
		try {
			await work();
		} catch (err) {
			log.warn(ctx, `review label not set: ${String(err?.message ?? err).replace(/\s*\n\s*/g, " ")}`);
		}
	}

	/** After forge-pr-open exits 0 (and not --check-only): review:requested on the newest open PR from --head. */
	async function afterCreate(ctx, args, code) {
		if (code !== 0 || args.includes("--check-only")) return code;
		const value = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
		const [repo, head] = [value("--repo"), value("--head")];
		await warnOnly(ctx, async () => {
			const prs = await request(ctx, "GET", `/repos/${repo}/pulls?state=open&limit=50`);
			const pr = prs.filter((p) => p.head?.ref === head).sort((a, b) => b.number - a.number)[0];
			if (!pr) throw new Error(`no open PR from '${head}' on ${repo}`);
			const id = await ensure(ctx, repo, "review:requested");
			await request(ctx, "POST", `/repos/${repo}/issues/${pr.number}/labels`, { labels: [id] }, { expect: "array" });
		});
		return code;
	}

	/** After a posted review: approve or request-changes adds its label and removes the other two. */
	async function afterReview(ctx, repo, n, event) {
		const add = SWAP[event];
		if (!add) return;
		await warnOnly(ctx, async () => {
			const current = await request(ctx, "GET", `/repos/${repo}/issues/${n}/labels`);
			const id = await ensure(ctx, repo, add);
			await request(ctx, "POST", `/repos/${repo}/issues/${n}/labels`, { labels: [id] }, { expect: "array" });
			for (const l of current ?? []) {
				if (l.name !== add && STATES.includes(l.name)) await request(ctx, "DELETE", `/repos/${repo}/issues/${n}/labels/${l.id}`);
			}
		});
	}

	/** `label add`: create any of the four review labels that is missing; other names are left alone. */
	async function ensureNamed(ctx, repo, names) {
		for (const name of names) if (Object.hasOwn(LABELS, name)) await ensure(ctx, repo, name);
	}

	return { afterCreate, afterReview, ensureNamed };
}
