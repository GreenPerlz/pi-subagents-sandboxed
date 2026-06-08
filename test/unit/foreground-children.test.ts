/**
 * Unit tests for foregroundChildrenFromResults to ensure completed/persisted
 * foreground children retain known thinking when execution knew it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foregroundChildrenFromResults } from "../../src/runs/foreground/subagent-executor.ts";

describe("foregroundChildrenFromResults", () => {
	it("preserves thinking from SingleResult into persisted foreground step", () => {
		const results = [
			{
				agent: "worker",
				task: "do work",
				exitCode: 0,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				model: "openai/gpt-4o",
				thinking: "high",
			},
		] as const;
		const children = foregroundChildrenFromResults(results as any);
		assert.strictEqual(children.length, 1);
		assert.strictEqual(children[0]!.agent, "worker");
		assert.strictEqual(children[0]!.model, "openai/gpt-4o");
		assert.strictEqual(children[0]!.thinking, "high");
	});

	it("omits thinking when SingleResult has no thinking", () => {
		const results = [
			{
				agent: "worker",
				task: "do work",
				exitCode: 0,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				model: "openai/gpt-4o",
			},
		] as const;
		const children = foregroundChildrenFromResults(results as any);
		assert.strictEqual(children[0]!.thinking, undefined);
	});

	it("retains configured thinking even if model text later changes", () => {
		const results = [
			{
				agent: "worker",
				task: "do work",
				exitCode: 0,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				model: "claude-sonnet:high",
				thinking: "high",
			},
		] as const;
		const children = foregroundChildrenFromResults(results as any);
		assert.strictEqual(children[0]!.model, "claude-sonnet:high");
		assert.strictEqual(children[0]!.thinking, "high");
	});
});
