import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveModelDisplay, findModelInfo, getSupportedThinkingLevels, resolveEffectiveThinking, type ModelInfo } from "../../src/shared/model-info.ts";

describe("model info helpers", () => {
	const ambiguousModels: ModelInfo[] = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true, thinkingLevelMap: { high: "high" } },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini", reasoning: true, thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh" } },
	];

	it("does not choose arbitrary metadata for ambiguous bare model ids", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels), undefined);
	});

	it("uses the preferred provider for ambiguous bare model metadata", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels, "github-copilot")?.fullId, "github-copilot/gpt-5-mini");
	});

	it("matches provider-qualified model metadata before bare ids", () => {
		assert.equal(findModelInfo("openai/gpt-5-mini:high", ambiguousModels, "github-copilot")?.fullId, "openai/gpt-5-mini");
	});

	it("keeps the legacy full thinking list for reasoning models without per-level metadata", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: true }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
	});

	it("keeps the legacy full thinking list when older model metadata omits reasoning", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
	});

	it("filters levels only when per-level metadata is present", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "deepseek",
				id: "deepseek-v4-pro",
				fullId: "deepseek/deepseek-v4-pro",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
			}),
			["off", "high", "xhigh"],
		);
	});

	it("honors metadata that marks off unsupported", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "always-thinking",
				id: "model",
				fullId: "always-thinking/model",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
			}),
			["high"],
		);
	});

	describe("effectiveModelDisplay", () => {
		const availableModels: ModelInfo[] = [
			{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true },
			{ provider: "deepseek", id: "v4", fullId: "deepseek/v4", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
			{ provider: "openai", id: "gpt-4o", fullId: "openai/gpt-4o", reasoning: false },
		];

		it("returns undefined for undefined model", () => {
			assert.equal(effectiveModelDisplay(undefined, "high", availableModels), undefined);
		});

		it("returns bare model when thinking is off", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-5-mini", "off", availableModels), "openai/gpt-5-mini");
		});

		it("returns bare model when thinking is undefined", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-5-mini", undefined, availableModels), "openai/gpt-5-mini");
		});

		it("returns bare model when availableModels is not provided (undefined)", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-5-mini", "high", undefined), "openai/gpt-5-mini");
		});

		it("appends thinking suffix when model supports the level", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-5-mini", "high", availableModels), "openai/gpt-5-mini:high");
		});

		it("returns bare model when model does not support the thinking level", () => {
			assert.equal(effectiveModelDisplay("deepseek/v4", "minimal", availableModels), "deepseek/v4");
		});

		it("appends suffix for model that supports the specific level", () => {
			assert.equal(effectiveModelDisplay("deepseek/v4", "high", availableModels), "deepseek/v4:high");
		});

		it("preserves existing thinking suffix on model", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-5-mini:medium", "high", availableModels), "openai/gpt-5-mini:medium");
		});

		it("returns bare model for non-reasoning model", () => {
			assert.equal(effectiveModelDisplay("openai/gpt-4o", "high", availableModels), "openai/gpt-4o");
		});

		it("appends suffix for model not in registry when availableModels is empty array", () => {
			assert.equal(effectiveModelDisplay("unknown/model", "high", []), "unknown/model:high");
		});
	});

	describe("resolveEffectiveThinking", () => {
		it("returns undefined when there is no model and no config thinking", () => {
			assert.equal(resolveEffectiveThinking(undefined, undefined), undefined);
		});

		it("preserves config-derived thinking even when no model is known yet", () => {
			assert.equal(resolveEffectiveThinking(undefined, "high"), "high");
			assert.equal(resolveEffectiveThinking(undefined, "medium"), "medium");
		});

		it("ignores unrecognized config thinking even when no model is known", () => {
			assert.equal(resolveEffectiveThinking(undefined, "extreme"), undefined);
		});

		it("prefers the model suffix over the config thinking", () => {
			assert.equal(resolveEffectiveThinking("openai/gpt-4o:high", "low"), "high");
		});

		it("falls back to config thinking when the model has no recognized suffix", () => {
			assert.equal(resolveEffectiveThinking("openai/gpt-4o", "low"), "low");
		});

		it("returns undefined for an invalid config when the model has no recognized suffix", () => {
			assert.equal(resolveEffectiveThinking("openai/gpt-4o", "extreme"), undefined);
		});
	});
});
