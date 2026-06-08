import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { buildBuiltinOverrideConfig } from "../../src/agents/agents.ts";
import { THINKING_CHOICES, buildDefaultModelChoices, buildSettingsRows, getAgentThinkingChoices, registerSubagentsSettingsCommand, renderSubagentsSettingsOverlay } from "../../src/tui/subagents-settings-overlay.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
};

function agent(partial: Partial<AgentConfig>): AgentConfig {
	return {
		name: partial.name ?? "worker",
		description: "Worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Work",
		source: partial.source ?? "user",
		filePath: partial.filePath ?? "/tmp/worker.md",
		...partial,
	};
}

describe("subagents settings overlay", () => {
	it("builds editable rows for model, fallback models, and thinking", () => {
		const rows = buildSettingsRows([
			agent({ name: "worker", model: "openai/gpt-5", fallbackModels: ["anthropic/claude"], thinking: "high" }),
		]);

		assert.deepEqual(rows.map((row) => [row.field, row.value]), [
			["model", "openai/gpt-5"],
			["fallbackModels", "anthropic/claude"],
			["thinking", "high"],
		]);
	});

	it("offers an unset choice for user default model editing", () => {
		const choices = buildDefaultModelChoices({
			modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5" }] },
		} as any, agent({ model: "openai/gpt-5" }));

		assert.deepEqual(choices.map((choice) => [choice.value, choice.label]), [
			[undefined, "Clear default model (unset)"],
			["openai/gpt-5", "openai/gpt-5"],
		]);
	});

	it("offers builtin inherit choice so model-only overrides can be removed", () => {
		const builtin = agent({
			name: "reviewer",
			source: "builtin",
			model: "anthropic/override",
			override: {
				scope: "user",
				path: "/tmp/settings.json",
				base: {
					model: "openai/base",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					systemPrompt: "Work",
				},
			},
		});
		const choices = buildDefaultModelChoices({ modelRegistry: { getAvailable: () => [] } } as any, builtin);

		assert.deepEqual(choices, [{ value: "openai/base", label: "Inherit builtin default (openai/base)" }]);
		assert.equal(buildBuiltinOverrideConfig(builtin.override!.base, { ...builtin, model: choices[0]!.value }), undefined);
	});

	it("renders user/builtin tabs and picker choices supplied from available models", () => {
		const lines = renderSubagentsSettingsOverlay({
			view: "builtin",
			rows: buildSettingsRows([agent({ name: "reviewer", source: "builtin", model: "openai/gpt-5" })]),
			selected: 0,
			theme: theme as never,
			width: 100,
			picker: {
				title: "Choose default model",
				selected: 0,
				multi: false,
				choices: [{ label: "openai/gpt-5" }, { label: "anthropic/claude-sonnet" }],
			},
		});
		const text = lines.join("\n");

		assert.ok(text.includes("User agents"));
		assert.ok(text.includes("Builtin agents"));
		assert.ok(text.includes("Choose default model"));
		assert.ok(text.includes("openai/gpt-5"));
		assert.ok(text.includes("anthropic/claude-sonnet"));
	});

	it("shows t cycle thinking shortcut in help text", () => {
		const lines = renderSubagentsSettingsOverlay({
			view: "user",
			rows: buildSettingsRows([agent({ name: "worker", source: "user", model: "openai/gpt-5" })]),
			selected: 0,
			theme: theme as never,
			width: 100,
		});
		const text = lines.join("\n");

		assert.ok(text.includes("t cycle thinking"));
	});

	it("uses shared thinking choices including minimal and xhigh", () => {
		assert.deepEqual(THINKING_CHOICES, [undefined, "off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("getAgentThinkingChoices returns all levels when no model is set", () => {
		const a = agent({ model: undefined });
		const choices = getAgentThinkingChoices(a, []);
		assert.deepEqual(choices, [undefined, "off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("getAgentThinkingChoices returns all levels for model without thinkingLevelMap", () => {
		const a = agent({ model: "openai/gpt-5-mini" });
		const registry = [{ provider: "openai", id: "gpt-5-mini" }];
		const choices = getAgentThinkingChoices(a, registry);
		assert.deepEqual(choices, [undefined, "off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("getAgentThinkingChoices filters to supported levels for restricted model", () => {
		const a = agent({ model: "deepseek/deepseek-v4-pro" });
		const registry = [{
			provider: "deepseek",
			id: "deepseek-v4-pro",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		}];
		const choices = getAgentThinkingChoices(a, registry);
		assert.deepEqual(choices, [undefined, "off", "high", "xhigh"]);
	});

	it("getAgentThinkingChoices returns only off for non-reasoning model", () => {
		const a = agent({ model: "openai/gpt-4o" });
		const registry = [{ provider: "openai", id: "gpt-4o", reasoning: false }];
		const choices = getAgentThinkingChoices(a, registry);
		assert.deepEqual(choices, [undefined, "off"]);
	});

	it("t cycling skips unsupported thinking levels for restricted model", () => {
		const a = agent({ model: "deepseek/deepseek-v4-pro", thinking: undefined });
		const registry = [{
			provider: "deepseek",
			id: "deepseek-v4-pro",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		}];
		const choices = getAgentThinkingChoices(a, registry);
		// Simulate cycling through all choices
		const cycleResults: (string | undefined)[] = [];
		let current: string | undefined = a.thinking;
		for (let i = 0; i < choices.length; i++) {
			const idx = choices.findIndex((l) => l === current);
			current = choices[(idx + 1 + choices.length) % choices.length];
			cycleResults.push(current);
		}
		// Should cycle through: off, high, xhigh, undefined (wraps)
		assert.deepEqual(cycleResults, ["off", "high", "xhigh", undefined]);
		// None of the intermediate values should be minimal/low/medium
		assert.ok(!cycleResults.includes("minimal"));
		assert.ok(!cycleResults.includes("low"));
		assert.ok(!cycleResults.includes("medium"));
	});

	it("persists explicit user-agent thinking off through frontmatter serialization", () => {
		const serialized = serializeAgent(agent({ thinking: "off" }));
		const { frontmatter } = parseFrontmatter(serialized);

		assert.match(serialized, /^thinking: off$/m);
		assert.equal(frontmatter.thinking, "off");
	});

	const availableModels: ModelInfo[] = [
		{ provider: "xiaomi-token-plan-ams", id: "mimo-v2.5-pro", fullId: "xiaomi-token-plan-ams/mimo-v2.5-pro", reasoning: true },
		{ provider: "kimi-coding", id: "kimi-for-coding", fullId: "kimi-coding/kimi-for-coding", reasoning: true },
		{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4", reasoning: true },
		{ provider: "openai", id: "gpt-4o", fullId: "openai/gpt-4o", reasoning: false },
		{ provider: "deepseek", id: "v4", fullId: "deepseek/v4", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
	];

	describe("buildSettingsRows with effective display", () => {
		it("shows effective thinking-suffixed model string for supported model", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "xiaomi-token-plan-ams/mimo-v2.5-pro", thinking: "high" }),
			], availableModels);
			const modelRow = rows.find((r) => r.field === "model")!;
			assert.equal(modelRow.value, "xiaomi-token-plan-ams/mimo-v2.5-pro:high");
		});

		it("shows effective thinking-suffixed fallback models", () => {
			const rows = buildSettingsRows([
				agent({
					name: "worker",
					model: "xiaomi-token-plan-ams/mimo-v2.5-pro",
					fallbackModels: ["kimi-coding/kimi-for-coding", "openai-codex/gpt-5.4"],
					thinking: "high",
				}),
			], availableModels);
			const fallbackRow = rows.find((r) => r.field === "fallbackModels")!;
			assert.equal(fallbackRow.value, "kimi-coding/kimi-for-coding:high, openai-codex/gpt-5.4:high");
		});

		it("shows bare model for unsupported thinking level", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "deepseek/v4", thinking: "minimal" }),
			], availableModels);
			const modelRow = rows.find((r) => r.field === "model")!;
			assert.equal(modelRow.value, "deepseek/v4");
		});

		it("shows bare model for non-reasoning model even with thinking set", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "openai/gpt-4o", thinking: "high" }),
			], availableModels);
			const modelRow = rows.find((r) => r.field === "model")!;
			assert.equal(modelRow.value, "openai/gpt-4o");
		});

		it("shows mixed suffixed and bare fallback models based on support", () => {
			const rows = buildSettingsRows([
				agent({
					name: "worker",
					model: "openai/gpt-4o",
					fallbackModels: ["deepseek/v4", "openai-codex/gpt-5.4"],
					thinking: "high",
				}),
			], availableModels);
			const fallbackRow = rows.find((r) => r.field === "fallbackModels")!;
			assert.equal(fallbackRow.value, "deepseek/v4:high, openai-codex/gpt-5.4:high");
		});

		it("shows bare values when no availableModels are passed (backward compatible)", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "openai/gpt-5", fallbackModels: ["anthropic/claude"], thinking: "high" }),
			]);
			assert.deepEqual(rows.map((row) => [row.field, row.value]), [
				["model", "openai/gpt-5"],
				["fallbackModels", "anthropic/claude"],
				["thinking", "high"],
			]);
		});

		it("shows bare values when thinking is off", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "xiaomi-token-plan-ams/mimo-v2.5-pro", thinking: "off" }),
			], availableModels);
			const modelRow = rows.find((r) => r.field === "model")!;
			assert.equal(modelRow.value, "xiaomi-token-plan-ams/mimo-v2.5-pro");
		});

		it("preserves thinking row as separate editable field", () => {
			const rows = buildSettingsRows([
				agent({ name: "worker", model: "xiaomi-token-plan-ams/mimo-v2.5-pro", thinking: "high" }),
			], availableModels);
			const thinkingRow = rows.find((r) => r.field === "thinking")!;
			assert.equal(thinkingRow.label, "Thinking level");
			assert.equal(thinkingRow.value, "high");
		});
	});

	describe("buildDefaultModelChoices with thinking suffix preview", () => {
		it("shows effective suffixed labels in picker choices when thinking is set", () => {
			const choices = buildDefaultModelChoices(
				{ modelRegistry: { getAvailable: () => availableModels.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap })) } } as any,
				agent({ model: "openai/gpt-4o" }),
				"high",
			);
			const deepseekChoice = choices.find((c) => c.value === "deepseek/v4")!;
			assert.equal(deepseekChoice.label, "deepseek/v4:high", "supporting model should have suffix");
			const gpt4oChoice = choices.find((c) => c.value === "openai/gpt-4o")!;
			assert.equal(gpt4oChoice.label, "openai/gpt-4o", "non-reasoning model should be bare");
		});

		it("shows bare labels when thinking is off", () => {
			const choices = buildDefaultModelChoices(
				{ modelRegistry: { getAvailable: () => availableModels.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap })) } } as any,
				agent({ model: "openai/gpt-4o" }),
				"off",
			);
			const deepseekChoice = choices.find((c) => c.value === "deepseek/v4")!;
			assert.equal(deepseekChoice.label, "deepseek/v4");
		});

		it("shows bare labels when thinking is undefined", () => {
			const choices = buildDefaultModelChoices(
				{ modelRegistry: { getAvailable: () => availableModels.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap })) } } as any,
				agent({ model: "openai/gpt-4o" }),
			);
			const deepseekChoice = choices.find((c) => c.value === "deepseek/v4")!;
			assert.equal(deepseekChoice.label, "deepseek/v4");
		});
	});

	describe("picker rendering with effective suffixed values", () => {
		it("renders fallback picker choices with effective suffixed labels", () => {
			const lines = renderSubagentsSettingsOverlay({
				view: "user",
				rows: buildSettingsRows([agent({ name: "worker", source: "user", model: "openai/gpt-4o" })]),
				selected: 0,
				theme: theme as never,
				width: 100,
				picker: {
					title: "Choose fallback models",
					selected: 0,
					multi: true,
					choices: [
						{ label: "kimi-coding/kimi-for-coding:high" },
						{ label: "openai-codex/gpt-5.4:high" },
						{ label: "openai/gpt-4o" },
					],
				},
			});
			const text = lines.join("\n");
			assert.ok(text.includes("kimi-coding/kimi-for-coding:high"));
			assert.ok(text.includes("openai-codex/gpt-5.4:high"));
			assert.ok(text.includes("openai/gpt-4o"), "non-reasoning model should be bare in picker");
		});

		it("renders default model picker choices with effective suffixed labels", () => {
			const lines = renderSubagentsSettingsOverlay({
				view: "user",
				rows: buildSettingsRows([agent({ name: "worker", source: "user", model: "openai/gpt-4o" })]),
				selected: 0,
				theme: theme as never,
				width: 100,
				picker: {
					title: "Choose default model",
					selected: 0,
					multi: false,
					choices: [
						{ label: "xiaomi-token-plan-ams/mimo-v2.5-pro:high" },
						{ label: "deepseek/v4" },
					],
				},
			});
			const text = lines.join("\n");
			assert.ok(text.includes("xiaomi-token-plan-ams/mimo-v2.5-pro:high"));
			assert.ok(text.includes("deepseek/v4"), "unsupported model should be bare");
		});
	});

	it("registers the /subagents-settings command and rejects non-TUI mode", async () => {
		let registered: { description: string; handler: (args: string, ctx: any) => Promise<void> } | undefined;
		registerSubagentsSettingsCommand({
			registerCommand(name: string, command: any) {
				assert.equal(name, "subagents-settings");
				registered = command;
			},
		} as any);

		let notified = "";
		await registered!.handler("", {
			mode: "text",
			ui: { notify(message: string) { notified = message; } },
			cwd: process.cwd(),
			modelRegistry: { getAvailable: () => [] },
		});

		assert.ok(registered!.description.includes("Configure"));
		assert.ok(notified.includes("requires TUI mode"));
	});
});
