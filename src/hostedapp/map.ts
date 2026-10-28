/**
 * @module hostedapp/map
 * @description Build the declared / rendered / running model behind
 *   `hosted-app map`. Three independent sources are read at the boundary — the
 *   registry checkout (what was ACCEPTED), the k3s-deploy checkout (what is
 *   RENDERED), and an optional `kubectl get applications.argoproj.io -o json`
 *   snapshot (what is RUNNING) — and the disagreements between them are
 *   COMPUTED rather than left for an operator to eyeball across three tabs.
 *
 *   Model building is pure: `buildMap` takes already-read inputs and returns a
 *   `MapModel`, so every disagreement class is constructible in a test without
 *   a filesystem. The I/O lives in `collectMapInputs`, and the rendering lives
 *   in `./map-html` — a split that also keeps both files inside this repo's
 *   50-line-function / 500-line-file lint budget.
 *
 *   NO CLUSTER CALLS. The snapshot is a file the operator produced; this
 *   command never runs `kubectl` or `git`. An absent snapshot is a legitimate
 *   state (every Running cell reads `unknown (no cluster snapshot)`), not an
 *   error — the page's job is to say which of the three facts it actually has.
 *
 * @outputs
 *   - `buildMap` -- pure inputs -> `MapModel`
 *   - `collectMapInputs` -- read the two checkouts and the optional snapshot
 *   - `runHostedAppMap` -- the `hosted-app map` CLI subcommand
 *
 * @dependencies
 *   - yaml -- parse registry entries and rendered deployments
 *   - ./validate -- `validateRegistryEntry`
 *   - ./map-html -- the renderer
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { traced } from "../log";
import { renderMapHtml } from "./map-html";
import type { RegistryEntry } from "./schema";
import { validateRegistryEntry } from "./validate";

/** The text every Running cell carries when no cluster snapshot was supplied. */
export const NO_SNAPSHOT = "unknown (no cluster snapshot)";

/** One disagreement class, as it is badged in a row and counted at the top. */
export type Disagreement =
	| "rendered image != accepted image"
	| "running image != rendered image"
	| "rendered but not running"
	| "running but not in registry";

/** A registry file as read from disk: its name, and its validated content. */
export type RegistryFile =
	| { file: string; ok: true; entry: RegistryEntry }
	| { file: string; ok: false; problem: string };

/** What the k3s-deploy checkout holds for one `<name>-<target>` directory. */
export type RenderedApp = {
	/** `apps/<name>-<target>.yaml` exists. */
	application: boolean;
	/** `manifests/apps/<name>-<target>/` exists. */
	manifests: boolean;
	/** First container image in that directory's `deployment.yaml`, if any. */
	image?: string;
};

/** One Argo Application as read from the snapshot, reduced to what we show. */
export type RunningApp = {
	name: string;
	sync: string;
	health: string;
	revision: string;
	images: string[];
};

/** Everything `buildMap` needs, already read from disk. */
export type MapInputs = {
	registry: RegistryFile[];
	rendered: Map<string, RenderedApp>;
	/** `undefined` means no snapshot was supplied, which is not the same as empty. */
	running?: Map<string, RunningApp>;
	generatedAt: string;
	registrySha?: string;
	k3sDeploySha?: string;
};

/** One (app, target) row: the three facts side by side, plus its badges. */
export type MapRow = {
	app: string;
	target: string;
	verdict: "ok" | "invalid";
	problem?: string;
	declared: {
		repo: string;
		ref: string;
		on: string;
		by: string;
		state: string;
		merge: string;
		image: string;
	};
	rendered: { application: boolean; manifests: boolean; image?: string };
	running?: RunningApp;
	disagreements: Disagreement[];
};

/** An Argo Application running under a `<name>-<target>` the registry dropped. */
export type UnregisteredRow = { app: RunningApp; matchedApp: string; target: string };

/** The whole page, ready to render. */
export type MapModel = {
	generatedAt: string;
	registrySha?: string;
	k3sDeploySha?: string;
	rows: MapRow[];
	unregistered: UnregisteredRow[];
	counts: {
		apps: number;
		targets: number;
		rendered: number;
		runningHealthy: number;
		disagreements: number;
		invalid: number;
	};
	/** `false` when no snapshot was supplied: every Running cell is unknown. */
	hasSnapshot: boolean;
};

/** Shorten a git-style ref to its first 8 characters; short refs pass through. */
export const shortRef = traced("hostedapp.shortRef", function shortRef(ref: string): string {
	return ref.length > 8 ? ref.slice(0, 8) : ref;
});

/** The `<name>-<target>` key both the k3s-deploy checkout and Argo use. */
export const slugFor = traced(
	"hostedapp.slugFor",
	function slugFor(app: string, target: string): string {
		return `${app}-${target}`;
	},
);

/** The rows one valid registry entry contributes: one per declared target. */
function rowsForEntry(entry: RegistryEntry, inputs: MapInputs): MapRow[] {
	return entry.targets.map((target) => {
		const slug = slugFor(entry.name, target.name);
		const rendered = inputs.rendered.get(slug) ?? { application: false, manifests: false };
		const running = inputs.running?.get(slug);
		const accepted = entry.accepted.images[target.name]?.image ?? "";
		return {
			app: entry.name,
			target: target.name,
			verdict: "ok" as const,
			declared: {
				repo: entry.repo,
				ref: shortRef(entry.accepted.ref),
				on: entry.accepted.on,
				by: entry.accepted.by,
				state: entry.state,
				merge: target.merge,
				image: accepted,
			},
			rendered,
			running,
			disagreements: disagreementsFor(accepted, rendered, running, inputs.running !== undefined),
		};
	});
}

/**
 * Compute the disagreements for one row.
 *
 * Each comparison is skipped when the fact it needs is absent, so a missing
 * render never reports an image mismatch it cannot have observed. The
 * `rendered but not running` class needs a snapshot to be a claim at all: with
 * no snapshot, "not running" is unknown rather than false.
 */
function disagreementsFor(
	accepted: string,
	rendered: RenderedApp,
	running: RunningApp | undefined,
	hasSnapshot: boolean,
): Disagreement[] {
	const out: Disagreement[] = [];
	if (rendered.image !== undefined && accepted !== "" && rendered.image !== accepted) {
		out.push("rendered image != accepted image");
	}
	const isRendered = rendered.application || rendered.manifests;
	if (hasSnapshot && isRendered && running === undefined) {
		out.push("rendered but not running");
	}
	if (running !== undefined && rendered.image !== undefined && running.images.length > 0) {
		if (!running.images.includes(rendered.image)) out.push("running image != rendered image");
	}
	return out;
}

/** The row an invalid registry file contributes: one, carrying its first problem. */
function invalidRow(file: RegistryFile & { ok: false }): MapRow {
	return {
		app: file.file,
		target: "—",
		verdict: "invalid",
		problem: file.problem,
		declared: { repo: "—", ref: "—", on: "—", by: "—", state: "—", merge: "—", image: "—" },
		rendered: { application: false, manifests: false },
		disagreements: [],
	};
}

/**
 * Find Argo Applications whose `<something>-<target>` names a registry app that
 * no longer lists that target. An Application that matches no registry app at
 * all is somebody else's workload, not this registry's problem, so it is left
 * out rather than reported as drift.
 */
function unregisteredFor(inputs: MapInputs, entries: RegistryEntry[]): UnregisteredRow[] {
	if (inputs.running === undefined) return [];
	const known = new Set(entries.flatMap((e) => e.targets.map((t) => slugFor(e.name, t.name))));
	const out: UnregisteredRow[] = [];
	for (const app of inputs.running.values()) {
		if (known.has(app.name)) continue;
		const match = entries.find((e) => app.name.startsWith(`${e.name}-`));
		if (match === undefined) continue;
		out.push({ app, matchedApp: match.name, target: app.name.slice(match.name.length + 1) });
	}
	return out;
}

/**
 * Build the page model from already-read inputs.
 *
 * @param inputs - the three sources, plus generation metadata
 * @returns one row per (app, target), the unregistered table, and the counts
 */
export const buildMap = traced(
	"hostedapp.buildMap",
	function buildMap(inputs: MapInputs): MapModel {
		const valid = inputs.registry
			.filter((f) => f.ok)
			.map((f) => (f as { entry: RegistryEntry }).entry);
		const rows: MapRow[] = [];
		for (const file of inputs.registry) {
			if (file.ok) rows.push(...rowsForEntry(file.entry, inputs));
			else rows.push(invalidRow(file));
		}
		const unregistered = unregisteredFor(inputs, valid);
		const targetRows = rows.filter((r) => r.verdict === "ok");
		return {
			generatedAt: inputs.generatedAt,
			registrySha: inputs.registrySha,
			k3sDeploySha: inputs.k3sDeploySha,
			rows,
			unregistered,
			hasSnapshot: inputs.running !== undefined,
			counts: {
				apps: valid.length,
				targets: targetRows.length,
				rendered: targetRows.filter((r) => r.rendered.application || r.rendered.manifests).length,
				runningHealthy: targetRows.filter((r) => r.running?.health === "Healthy").length,
				disagreements:
					targetRows.reduce((n, r) => n + r.disagreements.length, 0) + unregistered.length,
				invalid: rows.filter((r) => r.verdict === "invalid").length,
			},
		};
	},
);

/** Read `apps/*.yaml` from the registry checkout, validating each entry. */
async function readRegistry(dir: string): Promise<RegistryFile[]> {
	const names = (await readdir(join(dir, "apps"))).filter((n) => n.endsWith(".yaml")).sort();
	const out: RegistryFile[] = [];
	for (const name of names) {
		const text = await readFile(join(dir, "apps", name), "utf8");
		const result = validateRegistryEntry(text);
		if (result.ok) out.push({ file: name, ok: true, entry: result.value });
		else {
			const problem = "harness" in result ? result.harness : describe(result.problems[0]);
			out.push({ file: name, ok: false, problem });
		}
	}
	return out;
}

/** Render the first problem as `<path> -- <message>`, or a placeholder. */
function describe(problem: { path: string; message: string } | undefined): string {
	return problem === undefined ? "invalid" : `${problem.path} -- ${problem.message}`;
}

/** The first container image of the Deployment document in a rendered dir. */
function deploymentImage(text: string): string | undefined {
	for (const doc of parseAllDocuments(text)) {
		const value = doc.toJS() as { kind?: string; spec?: unknown } | null;
		if (value === null || value.kind !== "Deployment") continue;
		const spec = value.spec as
			| { template?: { spec?: { containers?: { image?: unknown }[] } } }
			| undefined;
		const image = spec?.template?.spec?.containers?.[0]?.image;
		if (typeof image === "string") return image;
	}
	return undefined;
}

/** Read what the k3s-deploy checkout renders, keyed by `<name>-<target>`. */
async function readRendered(dir: string): Promise<Map<string, RenderedApp>> {
	// The checkout ROOT must exist: a missing root is a harness error, while a
	// missing apps/ or manifests/apps/ inside a real checkout is legitimately empty.
	await readdir(dir);
	const out = new Map<string, RenderedApp>();
	for (const name of await listDir(join(dir, "apps"))) {
		if (!name.endsWith(".yaml")) continue;
		out.set(name.slice(0, -".yaml".length), { application: true, manifests: false });
	}
	for (const slug of await listDir(join(dir, "manifests", "apps"))) {
		const entry = out.get(slug) ?? { application: false, manifests: false };
		entry.manifests = true;
		entry.image = await readDeploymentImage(join(dir, "manifests", "apps", slug));
		out.set(slug, entry);
	}
	return out;
}

/** True for the one error class that means "not there", as opposed to "unreadable". */
function isMissing(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** List a directory; an ABSENT one is empty, any other failure propagates. */
async function listDir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (err) {
		if (isMissing(err)) return [];
		throw err;
	}
}

/** Read one rendered directory's `deployment.yaml` image, if it has one. */
async function readDeploymentImage(dir: string): Promise<string | undefined> {
	try {
		return deploymentImage(await readFile(join(dir, "deployment.yaml"), "utf8"));
	} catch (err) {
		if (isMissing(err)) return undefined;
		throw err;
	}
}

/** One Argo Application item as the snapshot JSON carries it. */
type ArgoItem = {
	metadata?: { name?: unknown };
	status?: {
		sync?: { status?: unknown; revision?: unknown };
		health?: { status?: unknown };
		summary?: { images?: unknown };
	};
};

/** Reduce a `kubectl get applications -o json` payload to the running facts. */
export const parseArgoSnapshot = traced(
	"hostedapp.parseArgoSnapshot",
	function parseArgoSnapshot(text: string): Map<string, RunningApp> {
		const payload = JSON.parse(text) as { items?: unknown } | null;
		if (payload === null || typeof payload !== "object" || !Array.isArray(payload.items)) {
			throw new Error("argo snapshot is not a kubectl List: no items array");
		}
		const items = payload.items as ArgoItem[];
		const out = new Map<string, RunningApp>();
		for (const item of items) {
			const name = item.metadata?.name;
			if (typeof name !== "string" || name.length === 0) continue;
			const images = item.status?.summary?.images;
			out.set(name, {
				name,
				sync: text2(item.status?.sync?.status),
				health: text2(item.status?.health?.status),
				revision: shortRef(text2(item.status?.sync?.revision)),
				images: Array.isArray(images) ? images.filter((i) => typeof i === "string") : [],
			});
		}
		return out;
	},
	// ARG 0 ONLY. Arg 0 is a whole `kubectl get applications -o json` dump as one
	// string. This function reads four fields out of it, but the TRACE sees the
	// payload before that narrowing -- and an Argo Application's live manifest can
	// carry `spec.source.helm.parameters` and last-applied annotations, which is
	// cluster state nobody vetted for this log line. The RESULT is the narrowed
	// map: name, sync, health, short revision and image refs, all safe, and the
	// part worth seeing.
	{ redact: { args: [0] } },
);

/** Read an unknown as a string, falling back to `unknown` for anything else. */
function text2(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * Resolve a checkout's commit sha by READING `.git`, never by running git.
 *
 * @param dir - the checkout root
 * @returns the short sha, or `undefined` when `.git/HEAD` does not resolve
 */
export const readGitSha = traced(
	"hostedapp.readGitSha",
	async function readGitSha(dir: string): Promise<string | undefined> {
		try {
			const head = (await readFile(join(dir, ".git", "HEAD"), "utf8")).trim();
			if (!head.startsWith("ref: ")) return head.length > 0 ? shortRef(head) : undefined;
			const ref = head.slice("ref: ".length).trim();
			try {
				return shortRef((await readFile(join(dir, ".git", ref), "utf8")).trim());
			} catch {
				return await shaFromPackedRefs(join(dir, ".git", "packed-refs"), ref);
			}
		} catch {
			return undefined;
		}
	},
);

/** Look one ref up in `packed-refs`, where a fresh clone keeps its branches. */
async function shaFromPackedRefs(path: string, ref: string): Promise<string | undefined> {
	try {
		for (const line of (await readFile(path, "utf8")).split("\n")) {
			const [sha, name] = line.trim().split(" ");
			if (name === ref && sha !== undefined) return shortRef(sha);
		}
	} catch {
		/* no packed-refs: the sha is simply unknown */
	}
	return undefined;
}

/** Read every input the model needs. Any unreadable source throws. */
export const collectMapInputs = traced(
	"hostedapp.collectMapInputs",
	async function collectMapInputs(opts: {
		registryDir: string;
		k3sDeployDir: string;
		argoPath?: string;
		now?: string;
	}): Promise<MapInputs> {
		const running =
			opts.argoPath === undefined
				? undefined
				: parseArgoSnapshot(await readFile(opts.argoPath, "utf8"));
		return {
			registry: await readRegistry(opts.registryDir),
			rendered: await readRendered(opts.k3sDeployDir),
			running,
			generatedAt: opts.now ?? new Date().toISOString(),
			registrySha: await readGitSha(opts.registryDir),
			k3sDeploySha: await readGitSha(opts.k3sDeployDir),
		};
	},
	// RESULT ONLY. The args are four paths and a timestamp. The RESULT embeds the
	// parsed Argo snapshot (`running`) plus every validated registry entry, so it
	// re-exposes at `.exit` the cluster state masked at `parseArgoSnapshot`'s
	// `.enter` -- masking one and not the other would be theatre.
	{ redact: { result: true } },
);

const USAGE = `Usage:
  software-factory hosted-app map --registry-dir <dir> --k3s-deploy-dir <dir> \\
      [--argo <applications.json>] --out <file.html>

Exit codes: 0 page written, 3 harness error.`;

/** Parsed form of the `map` argument list. */
type MapArgs =
	| { ok: true; registryDir: string; k3sDeployDir: string; argoPath?: string; out: string }
	| { ok: false; error: string };

/** Parse the args after the `map` selector; every option takes one value. */
function parseMapArgs(args: readonly string[]): MapArgs {
	const values = new Map<string, string>();
	const known = new Set(["--registry-dir", "--k3s-deploy-dir", "--argo", "--out"]);
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) continue;
		if (!known.has(token)) return { ok: false, error: `unknown option: ${token}\n${USAGE}` };
		const value = args[i + 1];
		if (value === undefined) return { ok: false, error: `${token} requires a value\n${USAGE}` };
		values.set(token, value);
		i++;
	}
	const registryDir = values.get("--registry-dir");
	const k3sDeployDir = values.get("--k3s-deploy-dir");
	const out = values.get("--out");
	if (registryDir === undefined || k3sDeployDir === undefined || out === undefined) {
		return {
			ok: false,
			error: `--registry-dir, --k3s-deploy-dir and --out are required\n${USAGE}`,
		};
	}
	return { ok: true, registryDir, k3sDeployDir, out, argoPath: values.get("--argo") };
}

/**
 * Run `hosted-app map`.
 *
 * Disagreements are CONTENT, not failure: a page that reports six mismatches
 * exits 0, because the command's job is to produce the page. Exit 3 is reserved
 * for the harness errors that mean no page exists — an unreadable checkout, an
 * unparsable snapshot, an unwritable `--out`.
 *
 * @param args - the argument list after the `map` selector
 * @returns 0 page written, 3 harness error
 */
export const runHostedAppMap = traced(
	"hostedapp.runHostedAppMap",
	async function runHostedAppMap(args: readonly string[]): Promise<number> {
		const parsed = parseMapArgs(args);
		if (!parsed.ok) {
			process.stderr.write(`${parsed.error}\n`);
			return 3;
		}
		try {
			const model = buildMap(await collectMapInputs(parsed));
			await Bun.write(parsed.out, renderMapHtml(model));
			process.stdout.write(
				`RESULT PASS -- ${parsed.out}: ${model.counts.apps} app(s), ` +
					`${model.counts.targets} target(s), ${model.counts.disagreements} disagreement(s)\n`,
			);
			return 0;
		} catch (err) {
			process.stderr.write(`${err instanceof Error ? err.message : "hosted-app map failed"}\n`);
			return 3;
		}
	},
);
