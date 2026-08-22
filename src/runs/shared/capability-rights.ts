import type { ResolvedSandboxConfig } from "../../sandbox/types.ts";
import type { PackagedAgentRole } from "./agent-role.ts";

export type CapabilityRights = "writer" | "read-only";

/**
 * Inputs to the one capability-rights policy.  This intentionally receives
 * resolved sandbox policy, rather than raw overrides, so callers cannot grant
 * checkout authority before tool/mount policy is known.
 */
export interface CapabilityRightsInput {
	packagedRole?: PackagedAgentRole;
	agentTools?: readonly string[];
	sandbox?: Pick<ResolvedSandboxConfig, "gitMode" | "bashWrite" | "extraWritableMounts">;
	taskMutationProhibited?: boolean;
	parentRights?: CapabilityRights;
	/** Whether the caller has an exclusive writer lease available. */
	exclusiveLease?: boolean;
	/** Resolved cwd/mount decision; defaults to the tool/mount policy below. */
	writableCwd?: boolean;
}

function hasTool(tools: readonly string[] | undefined, name: string): boolean {
	return tools?.some((tool) => tool.trim() === name) === true;
}

/**
 * Resolve the maximum rights a child may receive.  Read-only is the safe
 * default and every narrowing input is monotonic.  Task prose is represented
 * only as an explicit prohibition: it can remove writer authority, never grant
 * it.
 */
export function resolveCapabilityRights(input: CapabilityRightsInput): CapabilityRights {
	if (input.parentRights === "read-only") return "read-only";
	if (input.packagedRole === "explore" || input.packagedRole === "review") return "read-only";
	if (input.taskMutationProhibited === true) return "read-only";

	if (input.sandbox?.bashWrite === false) return "read-only";
	const tools = input.agentTools;
	// Omitted tools means the child receives the agent's default toolset. Keep
	// this aligned with sandbox mount inference: it is writer-capable, while an
	// explicitly empty/limited tool list is not. bashWrite only narrows an
	// explicitly declared bash tool; it must not accidentally deny default edit.
	const hasMutationTool = tools === undefined || hasTool(tools, "edit") || hasTool(tools, "write");
	const hasWritableBash = input.sandbox?.bashWrite === true && hasTool(tools, "bash");
	const writableByTools = hasMutationTool || hasWritableBash;
	if (!writableByTools) return "read-only";
	if (input.sandbox?.gitMode !== "isolated") return "read-only";
	if (input.writableCwd === false) return "read-only";
	if (input.exclusiveLease === false) return "read-only";
	return "writer";
}
