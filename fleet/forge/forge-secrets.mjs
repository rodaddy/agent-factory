// forge's Actions secret verbs: list, set, delete on a repo or an org. forge wires them in and hands
// over its helpers, so this file imports nothing from forge and no cycle forms.
// A secret value comes only from --value-file (a path, or - for stdin): never argv, never printed,
// redacted from every error, the HTTP one included.

const PAGE = 50;
const MAX_PAGES = 20;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = /^(GITHUB_|GITEA_|FORGEJO_)/i;

/** The verbs, built over forge's own request, show, positionals and Usage. */
export function secrets({ request, show, positionals, Usage }) {
	/** [label, base path] for `owner/repo`, `.` or `org:<name>`. */
	const where = (ctx, t) => {
		if (!t.startsWith("org:")) {
			const repo = ctx.repo(t);
			return [repo, `/repos/${repo}/actions/secrets`];
		}
		const org = t.slice(4);
		if (!/^[\w.-]+$/.test(org) || /^\.\.?$/.test(org)) throw new Usage(`org:<name> needs a plain org name, got '${t}'`);
		return [t, `/orgs/${org}/actions/secrets`];
	};
	const secretName = (n) => {
		if (!NAME.test(n)) throw new Usage(`<NAME> must match ${NAME.source}, got '${n}'`);
		if (RESERVED.test(n)) throw new Usage(`<NAME> must not start with GITHUB_, GITEA_ or FORGEJO_, got '${n}'`);
		return n;
	};

	const SECRET = {
		async list(ctx, o) {
			const [t] = positionals(o, ["target"]);
			const [, base] = where(ctx, t);
			const all = [];
			for (let page = 1, got = []; page === 1 || (got.length === PAGE && page <= MAX_PAGES); page++) {
				got = (await request(ctx, "GET", `${base}?page=${page}&limit=${PAGE}`)) ?? [];
				all.push(...got);
			}
			return show(ctx, all, (ss) => ss.map((s) => `${s.name} ${s.created_at}`));
		},
		async set(ctx, o) {
			const [t, n] = positionals(o, ["target", "NAME"]);
			const [label, base] = where(ctx, t);
			const name = secretName(n);
			if (o["value-file"] === undefined) throw new Usage("secret set needs --value-file <path|->");
			const data = ctx.readText(o["value-file"]).replace(/\r?\n$/, "");
			if (!data) throw new Usage(`the value is empty (--value-file ${o["value-file"]})`);
			try {
				await request(ctx, "PUT", `${base}/${name}`, { data });
			} catch (err) {
				err.message = String(err?.message ?? "").split(data).join("***");
				throw err;
			}
			return show(ctx, null, () => `set ${name} on ${label}`);
		},
		async delete(ctx, o) {
			const [t, n] = positionals(o, ["target", "NAME"]);
			const [label, base] = where(ctx, t);
			const name = secretName(n);
			await request(ctx, "DELETE", `${base}/${name}`);
			return show(ctx, null, () => `deleted ${name} on ${label}`);
		},
	};

	/** --value would put the secret in argv and the process table: refused before anything else. */
	const noValueFlag = (args) => {
		if (args.some((a) => a === "--value" || a.startsWith("--value="))) {
			throw new Usage("secret set takes no --value (it would sit in argv): use --value-file <path|->");
		}
	};

	return { SECRET, noValueFlag };
}
