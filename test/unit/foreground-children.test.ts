/**
 * Unit tests for foregroundChildrenFromResults to ensure completed/persisted
 * foreground children retain known thinking when execution knew it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foregroundChildrenFromResults, resolveNestedTerminalState } from "../../src/runs/foreground/subagent-executor.ts";

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

	it("persists cleanup recovery as a failed indexed child projection", () => {
		const children = foregroundChildrenFromResults([{
			agent: "writer",
			task: "write safely",
			flatIndex: 2,
			exitCode: 1,
			success: false,
			error: "Isolated Git cleanup failed after export; recover isolated worktree at /tmp/runtime",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		}] as any);
		assert.equal(children[0]?.index, 2);
		assert.equal(children[0]?.status, "failed");
		assert.match(children[0]?.error ?? "", /recover isolated worktree/);
	});

	it("preserves group diagnostics without assigning a child index", () => {
		const children = foregroundChildrenFromResults([{
			agent: "reviewer",
			task: "group validation",
			exitCode: 1,
			groupId: "dynamic-group-2",
			finalOutput: "aggregate validation failed",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		}] as any);
		assert.equal(children[0]?.groupId, "dynamic-group-2");
		assert.equal(children[0]?.index, undefined);
		assert.equal(children[0]?.finalOutput, "aggregate validation failed");
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

	it("retains pending sibling placeholders as pending instead of failed", () => {
		const children = foregroundChildrenFromResults([{
			agent: "waiting",
			task: "pending sibling",
			flatIndex: 1,
			progress: {
				index: 1,
				agent: "waiting",
				status: "pending",
				task: "pending sibling",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			},
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		}] as any);
		assert.equal(children[0]?.status, "pending");
		assert.equal(children[0]?.index, 1);
	});

	it("publishes a cancelled nested terminal result despite its nonzero exit code", () => {
		const result = {
			agent: "worker",
			task: "cancelled work",
			exitCode: 1,
			cancelled: true,
			error: "Cancelled by parent.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
		assert.equal(resolveNestedTerminalState([result] as any, true), "cancelled");
	});
});
