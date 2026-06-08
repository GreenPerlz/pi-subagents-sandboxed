import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { buildBuiltinOverrideConfig } from "../../src/agents/agents.ts";
import { THINKING_CHOICES, buildDefaultModelChoices, buildSettingsRows, getAgentThinkingChoices, registerSubagentsSettingsCommand, renderSubagentsSettingsOverlay } from "../../src/tui/subagents-settings-overlay.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

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
