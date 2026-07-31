import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildModelCandidates,
	isRetryableModelFailure,
	resolveModelCandidate,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini:high", availableModels), "openai/gpt-5-mini:high");
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"), "anthropic/claude-sonnet-4");
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["gpt-5-mini", "anthropic/claude-sonnet-4"], ambiguous, "github-copilot"),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("propagates thinking suffix to all candidates when thinking is provided", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, "high"),
			["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:high"],
		);
	});

	it("preserves existing thinking suffix on candidates when thinking is provided", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini:medium", ["anthropic/claude-sonnet-4:low"], availableModels, undefined, "high"),
			["openai/gpt-5-mini:medium", "anthropic/claude-sonnet-4:low"],
		);
	});

	it("does not apply thinking suffix when thinking is off or undefined", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, "off"),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, undefined),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("deduplicates candidates after applying thinking suffix", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini"], availableModels, undefined, "high"),
			["openai/gpt-5-mini:high"],
		);
	});

	it("applies thinking suffix only when model supports the level", () => {
		const modelsWithSupport = [
			{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true },
			{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		];
		// Both models lack thinkingLevelMap, so all levels are supported
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], modelsWithSupport, undefined, "high"),
			["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:high"],
		);
	});

	it("skips thinking suffix for models that do not support the level", () => {
		const restrictedModels = [
			{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" } },
			{ provider: "deepseek", id: "v4", fullId: "deepseek/v4", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
		];
		// Neither model supports "minimal"
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["deepseek/v4"], restrictedModels, undefined, "minimal"),
			["openai/gpt-5-mini", "deepseek/v4"],
		);
	});

	it("applies max only to models that explicitly advertise it", () => {
		const modelsWithMaxSupport = [
			{ provider: "openai", id: "gpt-5.6-sol", fullId: "openai/gpt-5.6-sol", reasoning: true, thinkingLevelMap: { max: "max" } },
			{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4", reasoning: true },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5.6-sol", ["anthropic/claude-sonnet-4"], modelsWithMaxSupport, undefined, "max"),
			["openai/gpt-5.6-sol:max", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies suffix to primary but not unsupported fallback", () => {
		const mixedModels = [
			{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true },
			{ provider: "deepseek", id: "v4", fullId: "deepseek/v4", reasoning: true, thinkingLevelMap: { medium: null, high: "high", xhigh: "max" } },
		];
		// gpt-5-mini: no thinkingLevelMap => all levels supported ("medium" OK)
		// deepseek/v4: medium excluded by null, so no suffix
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["deepseek/v4"], mixedModels, undefined, "medium"),
			["openai/gpt-5-mini:medium", "deepseek/v4"],
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
		assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
		assert.equal(isRetryableModelFailure(undefined), false);
	});
});
