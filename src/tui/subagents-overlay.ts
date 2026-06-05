/**
 * /subagents overlay – shows a live nested run tree for the current Pi session.
 *
 * Non-TUI modes receive a short message pointing to `subagent({ action: "status" })`.
 * In TUI mode the overlay renders as a border-box list that refreshes via `requestRender()`
 * while the user navigates with the configured selection keybindings; Escape closes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { collectRunTree, type OverlayNestedChild, type OverlayRun, type OverlayStep } from "./run-tree-collector.ts";
import type { SubagentState } from "../shared/types.ts";

type Theme = ExtensionContext["ui"]["theme"];

// ---------------------------------------------------------------------------
// Overlay rendering helpers
// ---------------------------------------------------------------------------

function stateGlyph(state: OverlayRun | OverlayStep | OverlayNestedChild["state"], theme: Theme): string {
	const s = typeof state === "string" ? state : state.state;
	switch (s) {
		case "running": return theme.fg("accent", "●");
		case "complete": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "paused": return theme.fg("warning", "■");
		case "queued": return theme.fg("muted", "◦");
	}
}

function stateLabel(state: string, theme: Theme): string {
	switch (state) {
		case "running": return theme.fg("accent", "running");
		case "complete": return theme.fg("success", "complete");
		case "failed": return theme.fg("error", "failed");
		case "paused": return theme.fg("warning", "paused");
		case "queued": return theme.fg("dim", "queued");
		default: return theme.fg("dim", state);
	}
}

function sourceBadge(source: "foreground" | "async", theme: Theme): string {
	return source === "foreground"
		? theme.fg("dim", "fg")
		: theme.fg("dim", "bg");
}

function indent(depth: number): string {
	return "  ".repeat(depth);
}

function pathDetail(input: { sessionFile?: string; artifactPath?: string }, theme: Theme): string {
	const parts: string[] = [];
	if (input.sessionFile) parts.push(`session ${input.sessionFile}`);
	if (input.artifactPath) parts.push(`artifact ${input.artifactPath}`);
	return parts.length ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
}

function renderNestedChildren(
	children: OverlayNestedChild[],
	theme: Theme,
	width: number,
	depth: number,
	lines: string[],
): void {
	for (const child of children) {
		if (lines.length > 200) return; // line budget
		const prefix = indent(depth);
		const glyph = stateGlyph(child.state, theme);
		const tool = child.currentTool ? theme.fg("dim", ` · ${child.currentTool}`) : "";
		const elapsed = child.elapsed ? theme.fg("dim", ` · ${child.elapsed}`) : "";
		const line = `${prefix}${glyph} ${child.agent} ${stateLabel(child.state, theme)} · ${child.id}${tool}${elapsed}${pathDetail(child, theme)}`;
		lines.push(truncateToWidth(line, width));
		if (child.children.length) {
			renderNestedChildren(child.children, theme, width, depth + 1, lines);
		}
	}
}

function renderStep(step: OverlayStep, theme: Theme, width: number, depth: number, lines: string[]): void {
	const prefix = indent(depth);
	const glyph = stateGlyph(step.state, theme);
	const tool = step.currentTool ? theme.fg("dim", ` · ${step.currentTool}`) : "";
	const elapsed = step.elapsed ? theme.fg("dim", ` · ${step.elapsed}`) : "";
	const line = `${prefix}${glyph} ${step.agent} ${stateLabel(step.state, theme)}${tool}${elapsed}${pathDetail(step, theme)}`;
	lines.push(truncateToWidth(line, width));
	renderNestedChildren(step.children, theme, width, depth + 1, lines);
}

function renderRun(run: OverlayRun, theme: Theme, width: number, lines: string[], selected: boolean): void {
	const glyph = stateGlyph(run, theme);
	const badge = sourceBadge(run.source, theme);
	const elapsed = run.elapsed ? theme.fg("dim", ` · ${run.elapsed}`) : "";
	const agents = run.agents.length <= 3
		? run.agents.join(", ")
		: `${run.agents.slice(0, 2).join(", ")} +${run.agents.length - 2}`;
	const selector = selected ? theme.fg("accent", "> ") : "  ";
	const header = `${selector}${glyph} ${agents || run.id} ${stateLabel(run.state, theme)} ${badge} · ${run.id}${elapsed}${pathDetail(run, theme)}`;
	lines.push(truncateToWidth(header, width));
	for (const step of run.steps) {
		renderStep(step, theme, width, 1, lines);
	}
}

function renderEmptyState(theme: Theme, width: number): string[] {
	const innerW = width - 2;
	const lines: string[] = [];
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");

	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	lines.push(row(` ${theme.fg("accent", "Subagents")}`));
	lines.push(row(""));
	lines.push(row(` ${theme.fg("dim", "No subagents known/running.")}`));
	lines.push(row(""));
	lines.push(row(` ${theme.fg("dim", "Use /run, /chain, /parallel, or")}`));
	lines.push(row(` ${theme.fg("dim", "subagent({ ... }) to start a run.")}`));
	lines.push(row(""));
	lines.push(row(` ${theme.fg("dim", "For text-mode status, use:")}`));
	lines.push(row(` ${theme.fg("dim", '  subagent({ action: "status" })')}`));
	lines.push(row(""));
	lines.push(row(` ${theme.fg("dim", "Esc to close")}`));
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return lines;
}

export function renderOverlay(runs: OverlayRun[], theme: Theme, width: number, selectedRunIndex = 0): string[] {
	const innerW = width - 2;
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");

	if (runs.length === 0) return renderEmptyState(theme, width);

	const contentLines: string[] = [];
	contentLines.push(` ${theme.fg("accent", "Subagents")} ${theme.fg("dim", "· live run tree")}`);
	contentLines.push("");
	for (const [index, run] of runs.entries()) {
		renderRun(run, theme, innerW - 1, contentLines, index === selectedRunIndex);
		contentLines.push("");
	}
	// Remove trailing blank
	if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
		contentLines.pop();
	}
	contentLines.push(` ${theme.fg("dim", "↑↓ navigate · Esc close")}`);

	const lines: string[] = [];
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	for (const line of contentLines) {
		lines.push(row(line));
	}
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return lines;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

export class SubagentsOverlay {
	private runs: OverlayRun[] = [];
	private selectedRunIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private readonly theme: Theme;
	private readonly state: SubagentState;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly keybindings: KeybindingsManager;

	constructor(
		theme: Theme,
		state: SubagentState,
		done: () => void,
		requestRender: () => void,
		keybindings: KeybindingsManager,
	) {
		this.theme = theme;
		this.state = state;
		this.done = done;
		this.requestRender = requestRender;
		this.keybindings = keybindings;
		this.refresh();
		// Periodic refresh while overlay is open
		this.refreshTimer = setInterval(() => {
			this.refresh();
		}, 1000);
	}

	private refresh(): void {
		this.runs = collectRunTree(this.state);
		if (this.runs.length === 0) {
			this.selectedRunIndex = 0;
		} else if (this.selectedRunIndex >= this.runs.length) {
			this.selectedRunIndex = this.runs.length - 1;
		}
		this.invalidate();
		this.requestRender();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			this.dispose();
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedRunIndex = Math.max(0, this.selectedRunIndex - 1);
			this.invalidate();
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedRunIndex = Math.min(this.runs.length - 1, this.selectedRunIndex + 1);
			this.invalidate();
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedLines = renderOverlay(this.runs, this.theme, width, this.selectedRunIndex);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSubagentsOverlayCommand(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	pi.registerCommand("subagents", {
		description: "Show live subagent run tree overlay",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`/subagents overlay requires TUI mode. For text status, use: subagent({ action: "status" })`,
					"info",
				);
				return;
			}

			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				const requestRender = () => { (tui as { requestRender?: () => void }).requestRender?.(); };
				const overlay = new SubagentsOverlay(
					theme,
					state,
					done,
					requestRender,
					keybindings,
				);
				return {
					render: (w: number) => overlay.render(w),
					invalidate: () => overlay.invalidate(),
					handleInput: (data: string) => overlay.handleInput(data),
					dispose: () => overlay.dispose(),
				};
			}, { overlay: true });
		},
	});
}
