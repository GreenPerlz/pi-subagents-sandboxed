import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
	buildBuiltinOverrideConfig,
	discoverAgentsAll,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
	type AgentConfig,
	type BuiltinAgentOverrideBase,
} from "../agents/agents.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { effectiveModelDisplay, findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, toModelInfo, THINKING_LEVELS as SUPPORTED_THINKING_LEVELS, type ModelInfo } from "../shared/model-info.ts";

const OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "84%" as const,
	minWidth: 84,
	maxHeight: "80%" as const,
};

type Theme = ExtensionContext["ui"]["theme"];
type SettingsView = "user" | "builtin";
type FieldKey = "model" | "fallbackModels" | "thinking";

export interface ModelChoice {
	value: string | undefined;
	label: string;
}

interface Row {
	agent: AgentConfig;
	field: FieldKey;
	label: string;
	value: string;
}

interface ShadowingAgentInfo {
	source: "user" | "project";
	filePath: string;
}

export const THINKING_CHOICES = [undefined, ...SUPPORTED_THINKING_LEVELS] as const;

export function getAgentThinkingChoices(agent: AgentConfig, registryModels: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>): (string | undefined)[] {
	if (!agent.model) return [undefined, ...SUPPORTED_THINKING_LEVELS];
	const modelInfos = registryModels.map((m) => toModelInfo(m));
	const modelInfo = findModelInfo(agent.model, modelInfos);
	const levels = getSupportedThinkingLevels(modelInfo);
	return [undefined, ...levels];
}

function modelInfosFromRegistry(registryModels: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>): ModelInfo[] {
	return registryModels.filter((m) => m?.provider && m?.id).map((m) => toModelInfo(m));
}

export function getFallbackThinkingChoices(model: string, registryModels: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>): (string | undefined)[] {
	const modelInfo = findModelInfo(model, modelInfosFromRegistry(registryModels));
	return [undefined, ...getSupportedThinkingLevels(modelInfo)];
}

export function cycleFallbackThinking(model: string, current: string | undefined, registryModels: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>): string | undefined {
	const choices = getFallbackThinkingChoices(model, registryModels);
	const index = choices.findIndex((level) => level === current);
	return choices[(index + 1 + choices.length) % choices.length];
}

function fallbackModelWithThinking(model: string, thinking: string | undefined): string {
	return thinking ? `${model}:${thinking}` : model;
}

function valueLabel(value: string | undefined): string {
	return value && value.trim() ? value : "(unset)";
}

function fallbackLabel(values: string[] | undefined): string {
	return values?.length ? values.join(", ") : "(none)";
}

function registryModelChoices(ctx: ExtensionContext, thinking?: string): ModelChoice[] {
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	const seen = new Set<string>();
	const choices: ModelChoice[] = [];
	for (const model of available as Array<{ provider?: string; id?: string; name?: string; reasoning?: boolean; thinkingLevelMap?: any }>) {
		if (!model?.id) continue;
		const value = model.provider ? `${model.provider}/${model.id}` : model.id;
		if (seen.has(value)) continue;
		seen.add(value);
		let label = value;
		if (thinking && thinking !== "off" && model.provider) {
			const modelInfo = toModelInfo({ provider: model.provider, id: model.id, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap });
			const supported = getSupportedThinkingLevels(modelInfo);
			if (supported.some((l) => l === thinking)) {
				label = `${value}:${thinking}`;
			}
		}
		choices.push({ value, label });
	}
	return choices.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildDefaultModelChoices(ctx: ExtensionContext, agent: AgentConfig, thinking?: string): ModelChoice[] {
	const baseModel = agent.source === "builtin" ? builtinBase(agent).model : undefined;
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	const registryModels = (available as Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>).filter((m) => m?.provider && m?.id);
	const availableModels = registryModels.map((m) => toModelInfo(m));
	const effectiveBase = effectiveModelDisplay(baseModel, thinking, availableModels);
	const defaultChoice: ModelChoice = agent.source === "builtin"
		? { value: baseModel, label: `Inherit builtin default (${valueLabel(effectiveBase)})` }
		: { value: undefined, label: "Clear default model (unset)" };
	const choices = registryModelChoices(ctx, thinking).filter((choice) => choice.value !== defaultChoice.value);
	return [defaultChoice, ...choices];
}

function cloneAgent(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		skills: agent.skills ? [...agent.skills] : undefined,
	};
}

function builtinBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return agent.override?.base ?? {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
	};
}

export function buildSettingsRows(agents: AgentConfig[], availableModels?: ModelInfo[]): Row[] {
	const rows: Row[] = [];
	for (const agent of agents) {
		const effectiveModel = effectiveModelDisplay(agent.model, agent.thinking, availableModels);
		const effectiveFallbacks = agent.fallbackModels?.map(
			(m) => effectiveModelDisplay(m, agent.thinking, availableModels) ?? m,
		);
		rows.push({ agent, field: "model", label: "Default model", value: valueLabel(effectiveModel) });
		rows.push({ agent, field: "fallbackModels", label: "Fallback models", value: fallbackLabel(effectiveFallbacks) });
		rows.push({ agent, field: "thinking", label: "Thinking level", value: valueLabel(agent.thinking) });
	}
	return rows;
}

export function getBuiltinShadowingWarning(agent: AgentConfig, shadowedBy: ShadowingAgentInfo | undefined): string[] {
	if (agent.source !== "builtin" || !shadowedBy) return [];
	return [`builtin model won't be used; overshadowed by user/local agent: ${shadowedBy.filePath}`];
}

export function getShadowingBuiltinWarning(agent: AgentConfig, builtinAgentNames: Set<string>): string[] {
	if (agent.source === "builtin" || !builtinAgentNames.has(agent.name)) return [];
	return ["shadows builtin agent"];
}

export function renderSubagentsSettingsOverlay(input: {
	view: SettingsView;
	rows: Row[];
	selected: number;
	theme: Theme;
	width: number;
	message?: string;
	shadowingAgents?: Map<string, ShadowingAgentInfo>;
	builtinAgentNames?: Set<string>;
	picker?: { title: string; choices: Array<{ label: string; selected?: boolean }>; selected: number; multi: boolean };
}): string[] {
	const innerWidth = Math.max(40, input.width - 4);
	const lines: string[] = [];
	const tabUser = input.view === "user" ? input.theme.bold("User/local agents") : "User/local agents";
	const tabBuiltin = input.view === "builtin" ? input.theme.bold("Builtin agents") : "Builtin agents";
	lines.push(`Subagent settings  [${tabUser}] [${tabBuiltin}]`);
	lines.push("Tab/←/→ switch views · ↑/↓ move · Enter edit · t cycle thinking · Esc close");
	if (input.message) lines.push(input.theme.fg("dim", input.message));
	if (input.picker) {
		lines.push("");
		lines.push(input.theme.bold(input.picker.title));
		lines.push(input.picker.multi ? "Space toggles · t cycles highlighted thinking · Enter saves · Esc saves & backs" : "Enter selects · Esc cancels");
		for (let i = 0; i < input.picker.choices.length; i++) {
			const choice = input.picker.choices[i]!;
			const cursor = i === input.picker.selected ? "›" : " ";
			const mark = input.picker.multi ? (choice.selected ? "[x]" : "[ ]") : "";
			lines.push(`${cursor} ${mark} ${choice.label}`.trimEnd());
		}
	} else if (input.rows.length === 0) {
		lines.push("");
		lines.push(input.view === "user" ? "No user/local agents found." : "No builtin agents found.");
	} else {
		let lastAgentKey = "";
		for (let i = 0; i < input.rows.length; i++) {
			const row = input.rows[i]!;
			const agentKey = `${row.agent.source}:${row.agent.name}:${row.agent.filePath}`;
			if (agentKey !== lastAgentKey) {
				lastAgentKey = agentKey;
				lines.push("");
				const source = row.agent.source === "project"
					? " · local"
					: row.agent.source === "user"
						? " · user"
						: row.agent.override?.scope
							? ` · ${row.agent.override.scope} override`
							: "";
				lines.push(input.theme.bold(`${row.agent.name}${source}`));
				for (const warning of getBuiltinShadowingWarning(row.agent, input.shadowingAgents?.get(row.agent.name))) {
					lines.push(input.theme.fg("warning", warning));
				}
				for (const warning of getShadowingBuiltinWarning(row.agent, input.builtinAgentNames ?? new Set<string>())) {
					lines.push(input.theme.fg("warning", warning));
				}
			}
			const cursor = i === input.selected ? "›" : " ";
			lines.push(`${cursor} ${row.label.padEnd(16)} ${row.value}`);
		}
	}
	const clipped = lines.map((line) => truncateToWidth(line, innerWidth));
	const borderTop = `╭${"─".repeat(innerWidth + 2)}╮`;
	const borderBottom = `╰${"─".repeat(innerWidth + 2)}╯`;
	return [borderTop, ...clipped.map((line) => `│ ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} │`), borderBottom];
}

class SubagentsSettingsOverlay {
	private readonly ctx: ExtensionContext;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private view: SettingsView = "user";
	private selected = 0;
	private drafts = new Map<string, AgentConfig>();
	private message = "Edits are saved to user scope only.";
	private shadowingAgents = new Map<string, ShadowingAgentInfo>();
	private builtinAgentNames = new Set<string>();
	private picker: { field: FieldKey; selected: number; choices: ModelChoice[]; chosen: Set<string | undefined>; fallbackThinking?: Map<string, string | undefined> } | undefined;

	constructor(
		ctx: ExtensionContext,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
		requestRender: () => void,
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.requestRender = requestRender;
		this.reload();
	}

	private reload(): void {
		this.drafts.clear();
		this.shadowingAgents.clear();
		this.builtinAgentNames.clear();
		const discovered = discoverAgentsAll(this.ctx.cwd);
		for (const agent of [...discovered.user, ...discovered.project, ...discovered.builtin]) {
			if (agent.source !== "user" && agent.source !== "project" && agent.source !== "builtin") continue;
			this.drafts.set(`${agent.source}:${agent.name}:${agent.filePath}`, cloneAgent(agent));
		}
		for (const agent of discovered.builtin) this.builtinAgentNames.add(agent.name);
		for (const agent of discovered.user) {
			this.shadowingAgents.set(agent.name, { source: "user", filePath: agent.filePath });
		}
		for (const agent of discovered.project) {
			this.shadowingAgents.set(agent.name, { source: "project", filePath: agent.filePath });
		}
		this.clamp();
	}

	private agents(): AgentConfig[] {
		return [...this.drafts.values()]
			.filter((agent) => this.view === "user" ? agent.source === "user" || agent.source === "project" : agent.source === "builtin")
			.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.filePath.localeCompare(b.filePath));
	}

	private rows(): Row[] {
		const available = this.ctx.modelRegistry?.getAvailable?.() ?? [];
		const registryModels = (available as Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>).filter((m) => m?.provider && m?.id);
		const availableModels = registryModels.map((m) => toModelInfo(m));
		return buildSettingsRows(this.agents(), availableModels);
	}

	private clamp(): void {
		const rows = this.rows();
		this.selected = rows.length === 0 ? 0 : Math.min(this.selected, rows.length - 1);
	}

	private setView(view: SettingsView): void {
		if (this.view === view) return;
		this.view = view;
		this.selected = 0;
		this.picker = undefined;
		this.clamp();
		this.invalidate();
	}

	private toggleView(): void {
		this.setView(this.view === "user" ? "builtin" : "user");
	}

	private selectedRow(): Row | undefined {
		return this.rows()[this.selected];
	}

	private openPicker(row: Row): void {
		const thinking = row.agent.thinking;
		const choices = row.field === "model" ? buildDefaultModelChoices(this.ctx, row.agent, thinking) : registryModelChoices(this.ctx, thinking);
		if (choices.length === 0) {
			this.message = "No models are available in the current model registry.";
			this.invalidate();
			return;
		}
		const fallbackThinking = row.field === "fallbackModels" ? new Map<string, string | undefined>() : undefined;
		const chosen = new Set<string | undefined>();
		if (row.field === "fallbackModels") {
			for (const fallback of row.agent.fallbackModels ?? []) {
				const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(fallback);
				chosen.add(baseModel);
				fallbackThinking?.set(baseModel, thinkingSuffix ? thinkingSuffix.slice(1) : undefined);
			}
		} else {
			chosen.add(row.agent.model);
		}
		const currentIndex = choices.findIndex((choice) => chosen.has(choice.value));
		this.picker = { field: row.field, choices, chosen, fallbackThinking, selected: Math.max(0, currentIndex) };
		this.invalidate();
	}

	private cycleThinking(row: Row): void {
		const available = this.ctx.modelRegistry?.getAvailable?.() ?? [];
		const choices = getAgentThinkingChoices(row.agent, available as Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>);
		const index = choices.findIndex((level) => level === row.agent.thinking);
		row.agent.thinking = choices[(index + 1 + choices.length) % choices.length];
		this.save(row.agent);
	}

	private cycleSelectedFallbackThinking(): void {
		if (!this.picker || this.picker.field !== "fallbackModels") return;
		const value = this.picker.choices[this.picker.selected]?.value;
		if (!value) return;
		const current = this.picker.fallbackThinking?.get(value);
		const available = this.ctx.modelRegistry?.getAvailable?.() ?? [];
		const next = cycleFallbackThinking(value, current, available as Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: any }>);
		this.picker.chosen.add(value);
		if (next) this.picker.fallbackThinking?.set(value, next);
		else this.picker.fallbackThinking?.delete(value);
	}

	private pickerChoiceLabel(choice: ModelChoice): string {
		if (this.picker?.field !== "fallbackModels" || !choice.value || !this.picker.chosen.has(choice.value)) {
			return choice.label;
		}
		const thinking = this.picker.fallbackThinking?.get(choice.value);
		return thinking ? fallbackModelWithThinking(choice.value, thinking) : choice.label;
	}

	private editSelected(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.field === "thinking") this.cycleThinking(row);
		else this.openPicker(row);
	}

	private save(agent: AgentConfig): void {
		try {
			if (agent.source === "user" || agent.source === "project") {
				fs.writeFileSync(agent.filePath, serializeAgent(agent), "utf-8");
				this.message = `Saved ${agent.name} to ${agent.filePath}`;
			} else if (agent.source === "builtin") {
				const discoveredBuiltin = discoverAgentsAll(this.ctx.cwd).builtin.find(
					(candidate) => candidate.name === agent.name && candidate.filePath === agent.filePath,
				);
				const base = builtinBase(discoveredBuiltin ?? agent);
				const override = buildBuiltinOverrideConfig(base, agent);
				if (override) {
					const filePath = saveBuiltinAgentOverride(this.ctx.cwd, agent.name, "user", override);
					this.message = `Saved ${agent.name} user override to ${filePath}`;
				} else {
					const filePath = removeBuiltinAgentOverride(this.ctx.cwd, agent.name, "user");
					this.message = `${agent.name} matches builtin defaults; removed user override at ${filePath}`;
				}
			}
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
		}
		this.invalidate();
	}

	private applyPickerSelection(row: Row): void {
		if (this.picker?.field === "fallbackModels") {
			row.agent.fallbackModels = this.picker.choices
				.map((c) => c.value)
				.filter((v): v is string => typeof v === "string" && this.picker!.chosen.has(v))
				.map((v) => fallbackModelWithThinking(v, this.picker!.fallbackThinking?.get(v)));
		} else {
			row.agent.model = this.picker?.choices[this.picker.selected]?.value;
		}
		this.save(row.agent);
	}

	private handlePickerInput(data: string): void {
		if (!this.picker) return;
		if (matchesKey(data, "escape")) {
			const row = this.selectedRow();
			if (row && this.picker.field === "fallbackModels") this.applyPickerSelection(row);
			this.picker = undefined;
			this.invalidate();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.picker.selected = Math.max(0, this.picker.selected - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.picker.selected = Math.min(this.picker.choices.length - 1, this.picker.selected + 1);
		} else if (matchesKey(data, "space") && this.picker.field === "fallbackModels") {
			const value = this.picker.choices[this.picker.selected]?.value;
			if (value) this.picker.chosen.has(value) ? this.picker.chosen.delete(value) : this.picker.chosen.add(value);
		} else if (matchesKey(data, "t") && this.picker.field === "fallbackModels") {
			this.cycleSelectedFallbackThinking();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const row = this.selectedRow();
			if (row) this.applyPickerSelection(row);
			this.picker = undefined;
		}
		this.invalidate();
	}

	handleInput(data: string): void {
		if (this.picker) {
			this.handlePickerInput(data);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.toggleView();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.selected = Math.min(this.rows().length - 1, this.selected + 1);
		else if (matchesKey(data, "return") || matchesKey(data, "enter") || matchesKey(data, "space")) this.editSelected();
		else if (matchesKey(data, "t")) {
			const row = this.selectedRow();
			if (row) this.cycleThinking(row);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		return renderSubagentsSettingsOverlay({
			view: this.view,
			rows: this.rows(),
			selected: this.selected,
			theme: this.theme,
			width,
			message: this.message,
			shadowingAgents: this.shadowingAgents,
			builtinAgentNames: this.builtinAgentNames,
			picker: this.picker ? {
				title: this.picker.field === "fallbackModels" ? "Choose fallback models" : "Choose default model",
				choices: this.picker.choices.map((choice) => ({ label: this.pickerChoiceLabel(choice), selected: this.picker!.chosen.has(choice.value) })),
				selected: this.picker.selected,
				multi: this.picker.field === "fallbackModels",
			} : undefined,
		});
	}

	invalidate(): void {
		this.requestRender();
	}
}

async function openSubagentsSettingsOverlay(ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const requestRender = () => { (tui as { requestRender?: () => void }).requestRender?.(); };
		const overlay = new SubagentsSettingsOverlay(ctx, theme, keybindings, done, requestRender);
		return {
			render: (w: number) => overlay.render(w),
			invalidate: () => overlay.invalidate(),
			handleInput: (data: string) => overlay.handleInput(data),
		};
	}, { overlay: true, overlayOptions: OVERLAY_OPTIONS });
}

export function registerSubagentsSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagents-settings", {
		description: "Configure user-scope subagent agent defaults",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagents-settings requires TUI mode.", "info");
				return;
			}
			await openSubagentsSettingsOverlay(ctx);
		},
	});
}
