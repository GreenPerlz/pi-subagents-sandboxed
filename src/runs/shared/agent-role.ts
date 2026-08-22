/** Packaged role identity is the final component of an agent name. */
export type PackagedAgentRole = "explore" | "work" | "review";

/**
 * Resolve the role carried by a packaged agent name.  The final dotted
 * component is authoritative; task prose is deliberately not consulted here.
 */
export function resolvePackagedAgentRole(name: string | undefined): PackagedAgentRole | undefined {
	if (!name) return undefined;
	const localName = name.split(".").at(-1)?.toLowerCase();
	const roleName = localName?.split("-").at(-1);
	const packagedName = name.includes(".");
	if (roleName === "explore" || (packagedName && (roleName === "explorer" || roleName === "research"))) return "explore";
	if (roleName === "work" || roleName === "worker") return "work";
	if (roleName === "review" || (packagedName && roleName === "reviewer")) return "review";
	return undefined;
}

export function packagedAgentIsReadOnly(name: string | undefined): boolean {
	const role = resolvePackagedAgentRole(name);
	return role === "explore" || role === "review";
}

export function packagedAgentIsWriter(name: string | undefined): boolean {
	return resolvePackagedAgentRole(name) === "work";
}
