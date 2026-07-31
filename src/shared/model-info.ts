export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
const STANDARD_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface RegistryModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. the model has no suffix and no config was provided, or the config is not a recognized level).
 *
 * When `model` is unspecified, the config-derived thinking is still returned so that async runs
 * can preserve it through startup and pair it with the runtime model once it becomes known. */
export function resolveEffectiveThinking(model: string | undefined, configThinking: string | undefined): string | undefined {
	const { thinkingSuffix } = splitKnownThinkingSuffix(model ?? "");
	if (thinkingSuffix) return thinkingSuffix.slice(1);
	return THINKING_LEVELS.find((level) => level === configThinking);
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: `:${suffix}`,
	};
}

export function findModelInfo(model: string | undefined, availableModels: ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined {
	if (!model || !availableModels || availableModels.length === 0) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact;

	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferred = matches.find((entry) => entry.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model) return [...STANDARD_THINKING_LEVELS];
	if (model.reasoning === false) return ["off"];

	const levels = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
	return levels;
}

/** Returns the model string with thinking suffix appended when the model supports the thinking level.
 * If thinking is off/unset, the model already has a known suffix, or availableModels is not provided,
 * returns the bare model string. Returns undefined if model is undefined.
 *
 * Matches the runtime logic in buildModelCandidates so the overlay shows what will actually be sent. */
export function effectiveModelDisplay(
	model: string | undefined,
	thinking: string | undefined,
	availableModels: ModelInfo[] | undefined,
): string | undefined {
	if (!model) return undefined;
	if (!thinking || thinking === "off") return model;
	if (availableModels === undefined) return model;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	if (thinkingSuffix) return model;
	const modelInfo = findModelInfo(model, availableModels);
	const supported = getSupportedThinkingLevels(modelInfo);
	if (supported.some((l) => l === thinking)) {
		return `${model}:${thinking}`;
	}
	return model;
}
