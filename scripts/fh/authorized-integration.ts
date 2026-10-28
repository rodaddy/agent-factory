/**
 * @module scripts/fh/authorized-integration
 * @description Create a "Forgejo Actions (Local)" Authorized Integration on
 *   forge.example.internal, and print the resulting integration URL and its Audience.
 *
 *   WHY THIS DRIVES THE WEB FORM. Forgejo 16.0.1 exposes NO API for Authorized
 *   Integrations — not under `/api/v1/user`, not under the admin routes — so the
 *   only surface that can create one is the settings form. This script is
 *   therefore the factory-side automation for a thing the forge did not make
 *   automatable: it logs in with a stored credential, GETs the form, and POSTs
 *   it back. That is also why it is here in `scripts/fh/` and not in `src/`:
 *   it is an operator tool run by hand, not part of the service.
 *
 *   The POST is ORIGIN-CHECKED rather than CSRF-token-bearing: Forgejo 16
 *   accepts the form when `Origin`, `Referer` and the `Sec-Fetch-*` headers say
 *   same-origin, and the `_csrf` field is sent as well when the form carries
 *   one. Both paths are covered because which one applies is a server-version
 *   detail, not a choice.
 *
 *   SECRETS. The credential arrives as a Vaultwarden export on argv — a path to
 *   a JSON file, never the password itself (argv is world-readable in `ps`).
 *   Read it with `mcp2cli` / the `vaultwarden` skill from the item
 *   `Forgejo - factory`. Nothing here prints a password, a session cookie, or
 *   an Authorization header; the Audience IS printed, because an audience names
 *   an integration and authorizes nothing on its own.
 *
 * @outputs
 *   CLI: `bun scripts/fh/authorized-integration.ts <credential.json> <out.html>`
 *     env `FH_NAME`, `FH_REPO`, `FH_SCOPES` override the defaults.
 *     Exit 0 on success, 1 when the form was refused (the flash text is
 *     printed), non-zero from a thrown login failure.
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://forge.example.internal";

/** A Vaultwarden export, either bare or wrapped in the client's `result` envelope. */
export type CredentialFields = {
	username: string;
	password: string;
};

/** The `_csrf` token, from the form field, the meta tag, or the cookie. */
export function csrfOf(html: string, jarGet: (name: string) => string | undefined): string {
	return (
		html.match(/name="_csrf"\s+(?:content|value)="([^"]+)"/)?.[1] ??
		html.match(/<meta name="_csrf" content="([^"]+)"/)?.[1] ??
		jarGet("_csrf") ??
		""
	);
}

/** Parse the name and value pair at the start of a Set-Cookie line. */
export function cookiePairOf(setCookieLine: string): readonly [string, string] | undefined {
	const pair = setCookieLine.split(";")[0] ?? "";
	const eq = pair.indexOf("=");
	if (eq <= 0) return undefined;
	return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** Absorb valid Set-Cookie pairs into the session jar. */
export function absorbInto(jar: Map<string, string>, res: Response): void {
	for (const cookie of res.headers.getSetCookie?.() ?? []) {
		const pair = cookiePairOf(cookie);
		if (pair === undefined) continue;
		jar.set(pair[0], pair[1]);
	}
}

/** Extract up to four Forgejo flash, negative, or error messages. */
export function flashOf(html: string): string[] {
	return [...html.matchAll(/class="[^"]*(?:flash|negative|error)[^"]*"[^>]*>\s*([^<]{3,200})/g)]
		.map((match) => (match[1] ?? "").trim())
		.slice(0, 4);
}

/** Extract the Authorized Integration audience from its edit form. */
export function audienceOf(editHtml: string): string {
	return (
		editHtml.match(/name="audience"[^>]*value="([^"]+)"/)?.[1] ??
		editHtml.match(/(u:\d+:[0-9a-f-]{36})/)?.[1] ??
		""
	);
}

/** Extract the Authorized Integration name from its edit form. */
export function nameOf(editHtml: string): string {
	return editHtml.match(/name="name"[^>]*value="([^"]*)"/)?.[1] ?? "";
}

/** Strip `base` from an absolute redirect while preserving a bare path. */
export function asPath(location: string, base: string): string {
	return location.startsWith("http") ? location.slice(base.length) : location;
}

export type CreateBodyOptions = {
	csrf: string;
	name: string;
	description: string;
	repo: string;
	scopes: readonly string[];
};

/** Build the Authorized Integration form body in the CLI's existing field order. */
export function buildCreateBody({
	csrf,
	name,
	description,
	repo,
	scopes,
}: CreateBodyOptions): URLSearchParams {
	const body = new URLSearchParams();
	if (csrf) body.set("_csrf", csrf);
	body.set("name", name);
	body.set("description", description);
	body.set("source_repo", repo);
	body.set("workflow_file", "");
	body.set("git_ref", "");
	body.set("resource", "repo-specific");
	body.append("selected_repo", repo);
	for (const scope of scopes) body.append("scope", scope);
	return body;
}

if (import.meta.main) {
	const credentialPath = process.argv[2];
	const outPath = process.argv[3];
	if (credentialPath === undefined || outPath === undefined) {
		process.stderr.write(
			"usage: bun scripts/fh/authorized-integration.ts <credential.json> <out.html>\n",
		);
		process.exit(2);
	}

	const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
	const fields = (credential.result ?? credential).fields as CredentialFields;
	const username = fields.username;
	const password = fields.password;

	const NAME = process.env.FH_NAME ?? "software-factory lanes";
	const REPO = process.env.FH_REPO ?? "rodaddy/software-factory";
	const SCOPES = (process.env.FH_SCOPES ?? "write:issue,write:repository").split(",");

	/** The session cookie jar. Its contents are never printed. */
	const jar = new Map<string, string>();
	const cookieHeader = (): string =>
		[...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");

	async function get(path: string): Promise<Response> {
		const res = await fetch(BASE + path, {
			headers: { Cookie: cookieHeader() },
			redirect: "manual",
		});
		absorbInto(jar, res);
		return res;
	}

	/** A same-origin form POST: the header set is what Forgejo 16 checks. */
	async function postForm(path: string, body: URLSearchParams): Promise<Response> {
		const res = await fetch(BASE + path, {
			method: "POST",
			headers: {
				Cookie: cookieHeader(),
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: BASE,
				Referer: BASE + path,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Dest": "document",
			},
			body,
			redirect: "manual",
		});
		absorbInto(jar, res);
		return res;
	}

	await get("/user/login");
	const login = await postForm(
		"/user/login",
		new URLSearchParams({ user_name: username, password, remember: "off" }),
	);
	if (login.status !== 303 || (login.headers.get("location") ?? "").includes("webauthn")) {
		// The status and the redirect target only: neither carries the password.
		throw new Error(`login failed: ${login.status} ${login.headers.get("location") ?? ""}`);
	}

	const NEW = "/user/settings/authorized-integrations/forgejo-actions-local/new";
	const form = await get(NEW);
	const csrf = csrfOf(await form.text(), (name) => jar.get(name));
	console.error(
		`form GET ${form.status} csrf=${csrf ? "present" : "absent (Forgejo 16: origin-checked)"}`,
	);

	const body = buildCreateBody({
		csrf,
		name: NAME,
		description: `Actions lanes (pr-review, issue-triage, factory-smoke) for ${REPO}; created by fh ${new Date().toISOString().slice(0, 10)} (sf#476)`,
		repo: REPO,
		scopes: SCOPES,
	});

	const created = await postForm(NEW, body);
	const location = created.headers.get("location") ?? "";
	console.error(`create POST ${created.status} location=${location}`);
	const html = await created.text();
	writeFileSync(outPath, html);
	if (created.status !== 303) {
		console.error(`flash: ${JSON.stringify(flashOf(html))}`);
		process.exit(1);
	}

	const page = await get(asPath(location, BASE));
	const pageHtml = await page.text();
	writeFileSync(`${outPath}.after.html`, pageHtml);
	const links = [
		...pageHtml.matchAll(/href="([^"]*authorized-integrations\/forgejo-actions-local\/\d+)"/g),
	].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
	console.error(`after GET ${page.status} integrations=${JSON.stringify([...new Set(links)])}`);

	for (const link of new Set(links)) {
		const edit = await get(
			link.startsWith("http") ? link.slice(BASE.length) : link.replace(/^\./, "/user/settings"),
		);
		const editHtml = await edit.text();
		// The Audience is NOT a secret: it names the integration and authorizes
		// nothing on its own. It is the value the workflows pass as `AUD`.
		const audience = audienceOf(editHtml);
		const name = nameOf(editHtml);
		console.error(`${link}: name=${JSON.stringify(name)} audience=${audience || "not found"}`);
	}
}
