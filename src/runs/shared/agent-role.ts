/** Packaged role identity is the final component of an agent name. */
export type PackagedAgentRole = "explore" | "work" | "review";
export type PackagedAgentSource = "builtin" | "user" | "project";

/**
 * Resolve the role carried by a packaged agent name.  The final dotted
 * component is authoritative; task prose is deliberately not consulted here.
 */
export function resolvePackagedAgentRole(name: string | undefined, source?: PackagedAgentSource): PackagedAgentRole | undefined {
	if (!name) return undefined;
	const localName = name.split(".").at(-1)?.toLowerCase();
	const roleName = localName?.split("-").at(-1);
	// Runtime names are often dotted for custom project/user packages too.  The
	// source is the authority: without it (for example, stale async payloads),
	// fail closed rather than granting packaged writer rights by name.
	if (source !== "builtin") return undefined;
	if (roleName === "explore" || roleName === "research" || roleName === "explorer") return "explore";
	if (roleName === "work" || roleName === "worker") return "work";
	if (roleName === "review" || roleName === "reviewer") return "review";
	return undefined;
}

export function packagedAgentIsReadOnly(name: string | undefined, source?: PackagedAgentSource): boolean {
	const role = resolvePackagedAgentRole(name, source);
	return role === "explore" || role === "review";
}

export function packagedAgentIsWriter(name: string | undefined, source?: PackagedAgentSource): boolean {
	return resolvePackagedAgentRole(name, source) === "work";
}
