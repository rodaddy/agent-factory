// Plain ESM UI for rodaddy.crew; react and the SDK UI are provided by the host.
import { createElement as h } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const round = (px) => ({ width: px, height: px, borderRadius: "50%", objectFit: "cover" });

// A member without a portrait gets an initials circle, never a broken image.
const initials = (name) =>
	String(name ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase())
		.slice(0, 2)
		.join("") || "?";
const portrait = (m, px) =>
	m.avatar
		? h("img", { src: m.avatar, alt: m.name, style: round(px) })
		: h(
				"div",
				{
					"aria-label": m.name,
					style: {
						...round(px),
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "#444",
						color: "#fff",
						fontWeight: 700,
						fontSize: Math.round(px * 0.38),
					},
				},
				initials(m.name),
			);

export function CrewCard({ context }) {
	const { data, loading, error } = usePluginData("crew-card", {
		agentId: context.entityId,
		companyId: context.companyId,
	});
	if (loading) return h("div", null, "Loading crew card...");
	if (error) return h("div", null, `Crew card unavailable: ${error.message ?? error}`);
	if (!data) return h("div", null, "This agent is not on the crew roster.");
	return h(
		"div",
		{
			style: {
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 8,
				padding: 16,
			},
		},
		portrait(data, 256),
		h("strong", { style: { fontSize: 20 } }, data.name),
		h("div", null, data.role),
		h("p", { style: { maxWidth: 480, textAlign: "center" } }, data.bio),
		h("a", { href: data.profile, target: "_blank", rel: "noreferrer" }, `Forge: ${data.login}`),
	);
}

export function TheCrew({ context }) {
	const { data, loading, error } = usePluginData("roster", { companyId: context.companyId });
	if (loading) return h("div", null, "Loading crew...");
	if (error || !Array.isArray(data)) return h("div", null, "Crew unavailable.");
	const prefix = context.companyPrefix;
	return h(
		"div",
		{
			style: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
				gap: 16,
			},
		},
		...data.map((c) => {
			const href = prefix
				? `/${prefix}/agents/${encodeURIComponent(c.name.toLowerCase())}`
				: c.profile;
			return h(
				"a",
				{
					key: c.key,
					href,
					style: {
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						textDecoration: "none",
						color: "inherit",
					},
				},
				portrait(c, 96),
				h("strong", null, c.name),
				h("small", null, c.role),
			);
		}),
	);
}
