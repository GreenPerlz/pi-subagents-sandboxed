import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { buildBuiltinOverrideConfig } from "../../src/agents/agents.ts";
import { THINKING_CHOICES, buildDefaultModelChoices, buildSettingsRows, cycleFallbackThinking, getAgentThinkingChoices, getBuiltinShadowingWarning, getFallbackThinkingChoices, getShadowingBuiltinWarning, registerSubagentsSettingsCommand, renderSubagentsSettingsOverlay } from "../../src/tui/subagents-settings-overlay.ts";
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

		assert.ok(text.includes("User/local agents"));
		assert.ok(text.includes("Builtin agents"));
		assert.ok(text.includes("Choose default model"));
		assert.ok(text.includes("openai/gpt-5"));
		assert.ok(text.includes("anthropic/claude-sonnet"));
	});

	it("shows subtle builtin shadowing warning with the shadowing path", () => {
		const builtin = agent({ name: "worker", source: "builtin", model: "openai/gpt-5" });
		const lines = renderSubagentsSettingsOverlay({
			view: "builtin",
			rows: buildSettingsRows([builtin]),
			selected: 0,
			theme: theme as never,
			width: 120,
			shadowingAgents: new Map([["worker", { source: "project", filePath: "/tmp/.pi/agents/worker.md" }]]),
			builtinAgentNames: new Set(["worker"]),
		});
		const text = lines.join("\n");

		assert.deepEqual(getBuiltinShadowingWarning(builtin, { source: "project", filePath: "/tmp/.pi/agents/worker.md" }), ["builtin model won't be used; overshadowed by user/local agent: /tmp/.pi/agents/worker.md"]);
		assert.ok(text.includes("builtin model won't be used; overshadowed by user/local agent: /tmp/.pi/agents/worker.md"));
	});

	it("shows subtle note when a user/local agent shadows a builtin agent", () => {
		const shadowingAgent = agent({ name: "worker", source: "project", model: "openai/gpt-5", filePath: "/tmp/.pi/agents/worker.md" });
		const lines = renderSubagentsSettingsOverlay({
			view: "user",
			rows: buildSettingsRows([shadowingAgent]),
			selected: 0,
			theme: theme as never,
			width: 120,
			builtinAgentNames: new Set(["worker"]),
		});
		const text = lines.join("\n");

		assert.deepEqual(getShadowingBuiltinWarning(shadowingAgent, new Set(["worker"])), ["shadows builtin agent"]);
		assert.ok(text.includes("worker · local"));
		assert.ok(text.includes("shadows builtin agent"));
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

	it("uses the available overlay width instead of hard-capping to a narrow box", () => {
		const lines = renderSubagentsSettingsOverlay({
			view: "user",
			rows: buildSettingsRows([agent({ name: "worker", source: "user", model: "openai/gpt-5" })]),
			selected: 0,
			theme: theme as never,
			width: 160,
		});

		assert.equal(lines[0]?.length, 160);
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

	it("fallback thinking choices are per fallback model and filter unsupported levels", () => {
		const registry = [{
			provider: "deepseek",
			id: "deepseek-v4-pro",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		}];

		assert.deepEqual(getFallbackThinkingChoices("deepseek/deepseek-v4-pro", registry), [undefined, "off", "high", "xhigh"]);
		assert.equal(cycleFallbackThinking("deepseek/deepseek-v4-pro", undefined, registry), "off");
		assert.equal(cycleFallbackThinking("deepseek/deepseek-v4-pro", "off", registry), "high");
		assert.equal(cycleFallbackThinking("deepseek/deepseek-v4-pro", "high", registry), "xhigh");
		assert.equal(cycleFallbackThinking("deepseek/deepseek-v4-pro", "xhigh", registry), undefined);
	});

	it("serializes suffixed fallback thinking while preserving unsuffixed inherited fallbacks", () => {
		const serialized = serializeAgent(agent({
			fallbackModels: ["kimi-coding/kimi-for-coding", "openai-codex/gpt-5.4:high"],
			thinking: "medium",
		}));
		const { frontmatter } = parseFrontmatter(serialized);

		assert.match(serialized, /^fallbackModels: kimi-coding\/kimi-for-coding, openai-codex\/gpt-5\.4:high$/m);
		assert.equal(frontmatter.fallbackModels, "kimi-coding/kimi-for-coding, openai-codex/gpt-5.4:high");
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

	async function withUserAgentFile(fallbackModels: string[], run: (agentPath: string) => Promise<void>): Promise<void> {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-overlay-"));
		try {
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;
			const agentDir = path.join(tempHome, ".agents");
			fs.mkdirSync(agentDir, { recursive: true });
			const agentPath = path.join(agentDir, "worker.md");
			fs.writeFileSync(agentPath, `---
name: worker
description: Worker
model: openai/gpt-4o
fallbackModels: ${fallbackModels.join(", ")}
---

Work
`, "utf-8");
			await run(agentPath);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	}

	async function openSettingsOverlay(cwd: string): Promise<any> {
		let registered: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
		let overlay: any;
		registerSubagentsSettingsCommand({
			registerCommand(name: string, command: any) {
				assert.equal(name, "subagents-settings");
				registered = command;
			},
		} as any);
		await registered!.handler("", {
			mode: "tui",
			cwd,
			modelRegistry: {
				getAvailable: () => availableModels.map((model) => ({
					provider: model.provider,
					id: model.id,
					reasoning: model.reasoning,
					thinkingLevelMap: model.thinkingLevelMap,
				})),
			},
			ui: {
				theme,
				notify() {},
				custom(callback: any) {
					overlay = callback({ requestRender() {} }, theme, {
						matches(data: string, action: string) {
							if (action === "tui.select.down") return data === "\x1B[B";
							if (action === "tui.select.up") return data === "\x1B[A";
							if (action === "tui.select.cancel") return data === "\x1B";
							return false;
						},
					}, () => {});
				},
			},
		});
		assert.ok(overlay, "overlay should open in TUI mode");
		return overlay;
	}

	it("cycling t for a highlighted fallback then saving persists a suffixed fallback", async () => {
		await withUserAgentFile(["kimi-coding/kimi-for-coding"], async (agentPath) => {
			const overlay = await openSettingsOverlay(path.dirname(agentPath));

			overlay.handleInput("\x1B[B"); // fallbackModels row
			overlay.handleInput("\r"); // open fallback picker with existing fallback highlighted
			overlay.handleInput("t");
			overlay.handleInput("\r"); // save picker

			const saved = fs.readFileSync(agentPath, "utf-8");
			assert.match(saved, /^fallbackModels: kimi-coding\/kimi-for-coding:off$/m);
		});
	});

	it("cycling t for a highlighted fallback then escaping also persists the suffixed fallback", async () => {
		await withUserAgentFile(["kimi-coding/kimi-for-coding"], async (agentPath) => {
			const overlay = await openSettingsOverlay(path.dirname(agentPath));

			overlay.handleInput("\x1B[B"); // fallbackModels row
			overlay.handleInput("\r"); // open fallback picker with existing fallback highlighted
			overlay.handleInput("t");
			overlay.handleInput("\x1B"); // back out of picker

			const saved = fs.readFileSync(agentPath, "utf-8");
			assert.match(saved, /^fallbackModels: kimi-coding\/kimi-for-coding:off$/m);
		});
	});

	it("opening and saving an existing unsuffixed fallback keeps it unsuffixed", async () => {
		await withUserAgentFile(["kimi-coding/kimi-for-coding"], async (agentPath) => {
			const overlay = await openSettingsOverlay(path.dirname(agentPath));

			overlay.handleInput("\x1B[B"); // fallbackModels row
			overlay.handleInput("\r"); // open fallback picker
			overlay.handleInput("\r"); // save without cycling thinking

			const saved = fs.readFileSync(agentPath, "utf-8");
			assert.match(saved, /^fallbackModels: kimi-coding\/kimi-for-coding$/m);
			assert.doesNotMatch(saved, /^fallbackModels: kimi-coding\/kimi-for-coding:/m);
		});
	});

	it("escaping the default model picker still cancels without changing the saved model", async () => {
		await withUserAgentFile(["kimi-coding/kimi-for-coding"], async (agentPath) => {
			const overlay = await openSettingsOverlay(path.dirname(agentPath));

			overlay.handleInput("\r"); // open default model picker
			overlay.handleInput("\x1B[B"); // move to another model choice
			overlay.handleInput("\x1B"); // cancel picker

			const saved = fs.readFileSync(agentPath, "utf-8");
			assert.match(saved, /^model: openai\/gpt-4o$/m);
		});
	});

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

	it("saves builtin overrides from the overlay into user subagents.json", async () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-builtin-"));
		try {
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;
			const overlay = await openSettingsOverlay(process.cwd());

			overlay.handleInput("\t"); // switch to builtin view
			overlay.handleInput("\r"); // open default model picker for first builtin/model row
			overlay.handleInput("\x1B[B"); // choose first concrete model instead of inherit/unset
			overlay.handleInput("\r"); // save

			const subagentsPath = path.join(tempHome, ".pi", "agent", "subagents.json");
			const saved = JSON.parse(fs.readFileSync(subagentsPath, "utf-8"));
			assert.equal(typeof saved.agentOverrides?.explore?.model, "string");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
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
