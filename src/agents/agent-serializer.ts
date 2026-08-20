import type { AgentConfig } from "./agents.ts";
import { frontmatterNameForConfig } from "./identity.ts";

export const KNOWN_FIELDS = new Set([
	"name",
	"package",
	"description",
	"tools",
	"model",
	"fastMode",
	"fallbackModels",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"defaultContext",
	"skill",
	"skills",
	"extensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
	"acceptanceSelfReview",
	"acceptanceMaxFinalizationTurns",
	"canBeChangedByAgent",
	"sandboxProvider",
	"sandboxGitMode",
	"sandboxProfile",
	"sandboxNetwork",
	"sandboxTrustProject",
	"sandboxBashWrite",
	"sandboxAuth",
	"sandboxFallback",
	"sandboxExtraReadOnlyMounts",
	"sandboxExtraWritableMounts",
	"sandboxPackageDiscovery",
]);

function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

export function serializeAgent(config: AgentConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${frontmatterNameForConfig(config)}`);
	if (config.packageName) lines.push(`package: ${config.packageName}`);
	lines.push(`description: ${config.description}`);

	const tools = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	const toolsValue = joinComma(tools);
	if (toolsValue) lines.push(`tools: ${toolsValue}`);

	if (config.model) lines.push(`model: ${config.model}`);
	if (config.fastMode) lines.push("fastMode: true");
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue) lines.push(`fallbackModels: ${fallbackModelsValue}`);
	if (config.thinking) lines.push(`thinking: ${config.thinking}`);
	lines.push(`systemPromptMode: ${config.systemPromptMode}`);
	lines.push(`inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`);
	lines.push(`inheritSkills: ${config.inheritSkills ? "true" : "false"}`);
	if (config.defaultContext) lines.push(`defaultContext: ${config.defaultContext}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue) lines.push(`skills: ${skillsValue}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");
	const maxSubagentDepth = config.maxSubagentDepth;
	if (typeof maxSubagentDepth === "number" && Number.isInteger(maxSubagentDepth) && maxSubagentDepth >= 0) {
		lines.push(`maxSubagentDepth: ${maxSubagentDepth}`);
	}
	lines.push(`acceptanceSelfReview: ${config.acceptanceSelfReview === true ? "true" : "false"}`);
	const acceptanceMaxFinalizationTurns = typeof config.acceptanceMaxFinalizationTurns === "number"
		&& Number.isInteger(config.acceptanceMaxFinalizationTurns)
		&& config.acceptanceMaxFinalizationTurns >= 1
		&& config.acceptanceMaxFinalizationTurns <= 10
		? config.acceptanceMaxFinalizationTurns
		: 3;
	lines.push(`acceptanceMaxFinalizationTurns: ${acceptanceMaxFinalizationTurns}`);
	const canBeChangedByAgent = joinComma(config.canBeChangedByAgent);
	if (canBeChangedByAgent) lines.push(`canBeChangedByAgent: ${canBeChangedByAgent}`);
	if (config.sandbox?.provider) lines.push(`sandboxProvider: ${config.sandbox.provider}`);
	if (config.sandbox?.gitMode) lines.push(`sandboxGitMode: ${config.sandbox.gitMode}`);
	if (config.sandbox?.profile) lines.push(`sandboxProfile: ${config.sandbox.profile}`);
	if (config.sandbox?.network) lines.push(`sandboxNetwork: ${config.sandbox.network}`);
	if (config.sandbox?.trustProject !== undefined) lines.push(`sandboxTrustProject: ${config.sandbox.trustProject ? "true" : "false"}`);
	if (config.sandbox?.bashWrite !== undefined) lines.push(`sandboxBashWrite: ${config.sandbox.bashWrite ? "true" : "false"}`);
	if (config.sandbox?.auth) lines.push(`sandboxAuth: ${config.sandbox.auth}`);
	if (config.sandbox?.fallback) lines.push(`sandboxFallback: ${config.sandbox.fallback}`);
	if (config.sandbox?.extraReadOnlyMounts?.length) lines.push(`sandboxExtraReadOnlyMounts: ${config.sandbox.extraReadOnlyMounts.join(",")}`);
	if (config.sandbox?.extraWritableMounts?.length) lines.push(`sandboxExtraWritableMounts: ${config.sandbox.extraWritableMounts.join(",")}`);
	if (config.sandbox?.packageDiscovery) lines.push(`sandboxPackageDiscovery: ${config.sandbox.packageDiscovery}`);

	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (KNOWN_FIELDS.has(key)) continue;
			lines.push(`${key}: ${value}`);
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}
