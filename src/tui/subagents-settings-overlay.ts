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
import { THINKING_LEVELS as SUPPORTED_THINKING_LEVELS } from "../shared/model-info.ts";

const OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "90%" as const,
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

export const THINKING_CHOICES = [undefined, ...SUPPORTED_THINKING_LEVELS] as const;

function valueLabel(value: string | undefined): string {
	return value && value.trim() ? value : "(unset)";
}

function fallbackLabel(values: string[] | undefined): string {
	return values?.length ? values.join(", ") : "(none)";
}

function registryModelChoices(ctx: ExtensionContext): ModelChoice[] {
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	const seen = new Set<string>();
	const choices: ModelChoice[] = [];
	for (const model of available as Array<{ provider?: string; id?: string; name?: string }>) {
		if (!model?.id) continue;
		const value = model.provider ? `${model.provider}/${model.id}` : model.id;
		if (seen.has(value)) continue;
		seen.add(value);
		choices.push({ value, label: model.provider ? `${model.provider}/${model.id}` : model.id });
	}
	return choices.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildDefaultModelChoices(ctx: ExtensionContext, agent: AgentConfig): ModelChoice[] {
	const baseModel = agent.source === "builtin" ? builtinBase(agent).model : undefined;
	const defaultChoice: ModelChoice = agent.source === "builtin"
		? { value: baseModel, label: `Inherit builtin default (${valueLabel(baseModel)})` }
		: { value: undefined, label: "Clear default model (unset)" };
	const choices = registryModelChoices(ctx).filter((choice) => choice.value !== defaultChoice.value);
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
		completionGuard: agent.completionGuard,
	};
}

export function buildSettingsRows(agents: AgentConfig[]): Row[] {
	const rows: Row[] = [];
	for (const agent of agents) {
		rows.push({ agent, field: "model", label: "Default model", value: valueLabel(agent.model) });
		rows.push({ agent, field: "fallbackModels", label: "Fallback models", value: fallbackLabel(agent.fallbackModels) });
		rows.push({ agent, field: "thinking", label: "Thinking level", value: valueLabel(agent.thinking) });
	}
	return rows;
}

export function renderSubagentsSettingsOverlay(input: {
	view: SettingsView;
	rows: Row[];
	selected: number;
	theme: Theme;
	width: number;
	message?: string;
	picker?: { title: string; choices: Array<{ label: string; selected?: boolean }>; selected: number; multi: boolean };
}): string[] {
	const innerWidth = Math.max(40, Math.min(input.width - 4, 120));
	const lines: string[] = [];
	const tabUser = input.view === "user" ? input.theme.bold("User agents") : "User agents";
	const tabBuiltin = input.view === "builtin" ? input.theme.bold("Builtin agents") : "Builtin agents";
	lines.push(`Subagent settings  [${tabUser}] [${tabBuiltin}]`);
	lines.push("Tab/←/→ switch views · ↑/↓ move · Enter edit · Esc close");
	if (input.message) lines.push(input.theme.fg("dim", input.message));
	if (input.picker) {
		lines.push("");
		lines.push(input.theme.bold(input.picker.title));
		lines.push(input.picker.multi ? "Space toggles · Enter saves · Esc cancels" : "Enter selects · Esc cancels");
		for (let i = 0; i < input.picker.choices.length; i++) {
			const choice = input.picker.choices[i]!;
			const cursor = i === input.picker.selected ? "›" : " ";
			const mark = input.picker.multi ? (choice.selected ? "[x]" : "[ ]") : "";
			lines.push(`${cursor} ${mark} ${choice.label}`.trimEnd());
		}
	} else if (input.rows.length === 0) {
		lines.push("");
		lines.push(input.view === "user" ? "No user-scope agents found." : "No builtin agents found.");
	} else {
		let lastAgent = "";
		for (let i = 0; i < input.rows.length; i++) {
			const row = input.rows[i]!;
			if (row.agent.name !== lastAgent) {
				lastAgent = row.agent.name;
				lines.push("");
				const source = row.agent.override?.scope ? ` · ${row.agent.override.scope} override` : "";
				lines.push(input.theme.bold(`${row.agent.name}${source}`));
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
	private picker: { field: FieldKey; selected: number; choices: ModelChoice[]; chosen: Set<string> } | undefined;

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
		const discovered = discoverAgentsAll(this.ctx.cwd);
		for (const agent of [...discovered.user, ...discovered.builtin]) {
			if (agent.source !== "user" && agent.source !== "builtin") continue;
			this.drafts.set(`${agent.source}:${agent.name}`, cloneAgent(agent));
		}
		this.clamp();
	}

	private agents(): AgentConfig[] {
		return [...this.drafts.values()]
			.filter((agent) => agent.source === this.view)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private rows(): Row[] {
		return buildSettingsRows(this.agents());
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
		const choices = row.field === "model" ? buildDefaultModelChoices(this.ctx, row.agent) : registryModelChoices(this.ctx);
		if (choices.length === 0) {
			this.message = "No models are available in the current model registry.";
			this.invalidate();
			return;
		}
		const chosen = new Set(row.field === "fallbackModels" ? (row.agent.fallbackModels ?? []) : [row.agent.model]);
		const currentIndex = choices.findIndex((choice) => chosen.has(choice.value));
		this.picker = { field: row.field, choices, chosen, selected: Math.max(0, currentIndex) };
		this.invalidate();
	}

	private cycleThinking(row: Row): void {
		const index = THINKING_CHOICES.findIndex((level) => level === row.agent.thinking);
		row.agent.thinking = THINKING_CHOICES[(index + 1 + THINKING_CHOICES.length) % THINKING_CHOICES.length];
		this.save(row.agent);
	}

	private editSelected(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.field === "thinking") this.cycleThinking(row);
		else this.openPicker(row);
	}

	private save(agent: AgentConfig): void {
		try {
			if (agent.source === "user") {
				fs.writeFileSync(agent.filePath, serializeAgent(agent), "utf-8");
				this.message = `Saved ${agent.name} to ${agent.filePath}`;
			} else if (agent.source === "builtin") {
				const base = builtinBase(agent);
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

	private handlePickerInput(data: string): void {
		if (!this.picker) return;
		if (matchesKey(data, "escape")) {
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
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const row = this.selectedRow();
			if (row) {
				if (this.picker.field === "fallbackModels") row.agent.fallbackModels = this.picker.choices.map((c) => c.value).filter((v): v is string => typeof v === "string" && this.picker!.chosen.has(v));
				else row.agent.model = this.picker.choices[this.picker.selected]?.value;
				this.save(row.agent);
			}
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
			picker: this.picker ? {
				title: this.picker.field === "fallbackModels" ? "Choose fallback models" : "Choose default model",
				choices: this.picker.choices.map((choice) => ({ label: choice.label, selected: this.picker!.chosen.has(choice.value) })),
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
