// Crew roster for the rodaddy.crew plugin. Pure logic, no SDK import.
import { readFileSync } from "node:fs";
import { CREW } from "./roster.data.js";

export const FORGE = "https://forge.example.internal";
export const profileUrl = (login) => `${FORGE}/${encodeURIComponent(login)}`;

// Portraits are bundled next to this file as avatars/<key>.png (192x192), never
// fetched from Forge: council seats have no Forge user, and a missing Forge
// avatar renders as a broken image. Read once per process; null when absent.
const AVATARS = new URL("./avatars/", import.meta.url);
const avatarCache = new Map();
export function avatarFor(key) {
	if (avatarCache.has(key)) return avatarCache.get(key);
	let uri = null;
	if (/^[a-z0-9-]+$/.test(key)) {
		try {
			uri = `data:image/png;base64,${readFileSync(new URL(`${key}.png`, AVATARS)).toString("base64")}`;
		} catch {
			uri = null;
		}
	}
	avatarCache.set(key, uri);
	return uri;
}

// crew.json shape: { [key]: { name, login, role, bio, oldName?, ... } }.
export function rosterFrom(crewJson) {
	if (!crewJson || typeof crewJson !== "object") return [];
	return Object.entries(crewJson)
		.filter(([, v]) => v && typeof v.name === "string" && typeof v.login === "string")
		.map(([key, v]) => ({
			key,
			name: v.name,
			login: v.login,
			oldName: typeof v.oldName === "string" ? v.oldName : null,
			role: typeof v.role === "string" ? v.role : "",
			bio: typeof v.bio === "string" ? v.bio : "",
			avatar: avatarFor(key),
			profile: profileUrl(v.login),
		}));
}

// Plugin config `crew` (object or JSON string) overrides the baked roster.
export function rosterFromConfig(config) {
	let c = config?.crew;
	if (typeof c === "string") {
		try {
			c = JSON.parse(c);
		} catch {
			c = null;
		}
	}
	const r = rosterFrom(c);
	return r.length ? r : rosterFrom(CREW);
}

export const roster = rosterFrom(CREW);

// Match a board agent by its name (current or pre-rename), case-insensitive.
export function findCrew(name, list = roster) {
	if (typeof name !== "string" || !name.trim()) return null;
	const n = name.trim().toLowerCase();
	// A current name always wins: after a swap one member's old name is another's current one.
	return (
		list.find((c) => c.name.toLowerCase() === n) ??
		list.find((c) => c.oldName?.toLowerCase() === n) ??
		null
	);
}
