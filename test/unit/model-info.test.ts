import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModelInfo, getSupportedThinkingLevels, resolveEffectiveThinking, type ModelInfo } from "../../src/shared/model-info.ts";

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
