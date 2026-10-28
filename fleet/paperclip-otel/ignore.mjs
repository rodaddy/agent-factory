// Incoming requests the preload does not trace. The health probe and
// better-auth's session check (`/api/auth/get-session`, called on every page
// and API hit) were ~7,900 traces an hour and nothing else.
export function ignoreIncomingRequest(url) {
	const path = String(url ?? "").split("?")[0];
	return path.startsWith("/api/health") || path.endsWith("/get-session");
}
