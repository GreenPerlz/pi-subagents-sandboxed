import type { AgentConfig } from "../../agents/agents.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../../shared/settings.ts";
import type { AcceptanceInput } from "../../shared/types.ts";

/** Canonical paths whose values can be changed for a particular child agent at run time. */
export const GUARDED_AGENT_OVERRIDE_PATHS = [
	"cwd",
	"context",
	"model",
	"skills",
	"output",
	"outputMode",
	"reads",
	"progress",
	"outputSchema",
	"share",
	"maxSubagentDepth",
	"acceptance.*",
	"sandbox.*",
] as const;

/** Concrete leaves used to reject policy patterns that cannot match the public override surface. */
export const GUARDED_AGENT_OVERRIDE_LEAVES = [
	"cwd",
	"context",
	"model",
	"skills",
	"output",
	"outputMode",
	"reads",
	"progress",
	"outputSchema",
	"share",
	"maxSubagentDepth",
	"acceptance.criteria",
	"acceptance.evidence",
	"acceptance.verify",
	"acceptance.review",
	"acceptance.stopRules",
	"acceptance.selfReview",
	"acceptance.maxFinalizationTurns",
	"sandbox.provider",
	"sandbox.profile",
	"sandbox.network",
	"sandbox.trustProject",
	"sandbox.bashWrite",
	"sandbox.auth",
	"sandbox.fallback",
	"sandbox.extraReadOnlyMounts",
	"sandbox.extraWritableMounts",
	"sandbox.packageDiscovery",
] as const;

export interface AgentOverridePolicyParams {
	agent?: string;
	task?: string;
	cwd?: unknown;
	context?: unknown;
	model?: unknown;
	skill?: unknown;
	output?: unknown;
	outputMode?: unknown;
	reads?: unknown;
	progress?: unknown;
	outputSchema?: unknown;
	share?: unknown;
	maxSubagentDepth?: unknown;
	acceptance?: AcceptanceInput;
	sandbox?: unknown;
	tasks?: readonly unknown[];
	chain?: readonly ChainStep[];
}

export interface AgentOverridePolicyTarget {
	agent: AgentConfig;
	paths: readonly string[];
}

export interface AgentOverridePolicyViolation {
	agent: string;
	paths: string[];
	allowed: string[];
}

function hasOwn(value: unknown, key: string): boolean {
	return Boolean(value && typeof value === "object" && Object.hasOwn(value, key));
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Match a policy pattern against a canonical path by segments. `*` matches one
 * segment, while a pattern consisting only of `*` is the explicit all-path
 * escape hatch. This deliberately avoids substring matching (`model` does not
 * match `modelOverride`).
 */
export function overridePathMatches(pattern: string, path: string): boolean {
	const normalizedPattern = pattern.trim();
	const normalizedPath = path.trim();
	if (!normalizedPattern || !normalizedPath) return false;
	if (normalizedPattern === "*") return true;
	const patternSegments = normalizedPattern.split(".");
	const pathSegments = normalizedPath.split(".");
	if (patternSegments.length !== pathSegments.length) return false;
	return patternSegments.every((segment, index) => segment === "*" || segment === pathSegments[index]);
}

export function isKnownAgentOverridePattern(pattern: string): boolean {
	const normalized = pattern.trim();
	return normalized.length > 0
		&& GUARDED_AGENT_OVERRIDE_LEAVES.some((path) => overridePathMatches(normalized, path));
}

export function invalidAgentOverridePatterns(patterns: readonly string[]): string[] {
	return [...new Set(patterns.map((pattern) => pattern.trim()).filter((pattern) => !isKnownAgentOverridePattern(pattern)))];
}

export function isAgentOverrideAllowed(agent: AgentConfig, path: string): boolean {
	return (agent.canBeChangedByAgent ?? []).some((pattern) => overridePathMatches(pattern, path));
}

function addPath(paths: Set<string>, value: unknown, key: string): void {
	const source = record(value);
	if (source && hasOwn(source, key) && source[key] !== undefined) paths.add(key);
}

function addAcceptancePaths(paths: Set<string>, acceptance: unknown): void {
	const value = record(acceptance);
	if (!value) return;
	for (const key of Object.keys(value)) {
		if (value[key] !== undefined) paths.add(`acceptance.${key}`);
	}
}

function addSandboxPaths(paths: Set<string>, sandbox: unknown): void {
	const value = record(sandbox);
	if (!value) return;
	for (const key of Object.keys(value)) {
		if (value[key] !== undefined) paths.add(`sandbox.${key}`);
	}
}

function addAgentScopedPaths(paths: Set<string>, value: unknown): void {
	for (const key of ["cwd", "context", "model", "output", "outputMode", "reads", "progress", "outputSchema", "share", "maxSubagentDepth"]) {
		addPath(paths, value, key);
	}
	if ((hasOwn(value, "skill") && value.skill !== undefined) || (hasOwn(value, "skills") && value.skills !== undefined)) paths.add("skills");
	addAcceptancePaths(paths, record(value)?.acceptance);
	addSandboxPaths(paths, record(value)?.sandbox);
}

function addTopLevelPaths(paths: Set<string>, params: AgentOverridePolicyParams): void {
	// These values are shared by every affected child in a multi-agent launch.
	for (const key of ["cwd", "context", "share", "maxSubagentDepth"]) addPath(paths, params, key);
	addSandboxPaths(paths, params.sandbox);
}

function targetName(value: unknown): string | undefined {
	const name = record(value)?.agent;
	return typeof name === "string" ? name : undefined;
}

/**
 * Collect raw, explicitly supplied override paths by affected agent. Defaults
 * resolved from frontmatter/config are intentionally never inspected here.
 */
export function collectAgentOverridePaths(params: AgentOverridePolicyParams): Map<string, Set<string>> {
	const pathsByAgent = new Map<string, Set<string>>();
	const addFor = (agentName: string | undefined, paths: Iterable<string>): void => {
		if (!agentName) return;
		let target = pathsByAgent.get(agentName);
		if (!target) {
			target = new Set<string>();
			pathsByAgent.set(agentName, target);
		}
		for (const path of paths) target.add(path);
	};

	const shared = new Set<string>();
	addTopLevelPaths(shared, params);
	const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
	const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
	const hasSingle = !hasTasks && !hasChain && typeof params.agent === "string";

	// Top-level agent fields are single-agent overrides in single mode. In
	// multi-agent modes they are shared attempted overrides and therefore must
	// be allowed by every affected agent. This also covers chain-wide `skill`,
	// which is applied to every chain child.
	if (hasTasks || hasChain) addAgentScopedPaths(shared, params);

	if (hasSingle) {
		const paths = new Set(shared);
		addAgentScopedPaths(paths, params);
		addFor(params.agent, paths);
	}

	if (hasTasks) {
		for (const task of params.tasks ?? []) {
			const paths = new Set(shared);
			addAgentScopedPaths(paths, task);
			addFor(targetName(task), paths);
		}
	}

	if (hasChain) {
		for (const step of params.chain ?? []) {
			if (isParallelStep(step)) {
				const groupPaths = new Set<string>();
				addAgentScopedPaths(groupPaths, step);
				for (const task of step.parallel) {
					const paths = new Set([...shared, ...groupPaths]);
					addAgentScopedPaths(paths, task);
					addFor(task.agent, paths);
				}
				continue;
			}
			if (isDynamicParallelStep(step)) {
				const paths = new Set(shared);
				addAgentScopedPaths(paths, step);
				addAgentScopedPaths(paths, step.parallel);
				addFor(step.parallel.agent, paths);
				continue;
			}
			const paths = new Set(shared);
			addAgentScopedPaths(paths, step);
			addFor(step.agent, paths);
		}
	}

	return pathsByAgent;
}

export function findAgentOverridePolicyViolations(
	targets: readonly AgentOverridePolicyTarget[],
): AgentOverridePolicyViolation[] {
	const violations: AgentOverridePolicyViolation[] = [];
	for (const target of targets) {
		const denied = [...new Set(target.paths)]
			.filter((path) => !isAgentOverrideAllowed(target.agent, path))
			.sort((a, b) => a.localeCompare(b));
		if (denied.length > 0) {
			violations.push({
				agent: target.agent.name,
				paths: denied,
				allowed: [...(target.agent.canBeChangedByAgent ?? [])],
			});
		}
	}
	return violations;
}

export function validateAgentOverridePolicy(
	params: AgentOverridePolicyParams,
	agents: readonly AgentConfig[],
): AgentOverridePolicyViolation[] {
	const pathsByAgent = collectAgentOverridePaths(params);
	const targets: AgentOverridePolicyTarget[] = [];
	for (const [agentName, paths] of pathsByAgent) {
		const agent = agents.find((candidate) => candidate.name === agentName);
		if (agent) targets.push({ agent, paths: [...paths] });
	}
	return findAgentOverridePolicyViolations(targets);
}

export function formatAgentOverridePolicyError(violations: readonly AgentOverridePolicyViolation[]): string {
	if (violations.length === 0) return "";
	const lines = ["Agent override policy denied this launch before any child was spawned:"];
	for (const violation of violations) {
		lines.push(`- ${violation.agent}: denied ${violation.paths.join(", ")}`);
		lines.push(`  Allowed paths in this agent definition: ${violation.allowed.length > 0 ? violation.allowed.join(", ") : "(none; deny by default)"}`);
	}
	lines.push("The parent may remove the denied overrides or recommend an agent-definition change to the user.");
	return lines.join("\n");
}

export function validateAndFormatAgentOverridePolicy(
	params: AgentOverridePolicyParams,
	agents: readonly AgentConfig[],
): string | undefined {
	return formatAgentOverridePolicyError(validateAgentOverridePolicy(params, agents)) || undefined;
}
