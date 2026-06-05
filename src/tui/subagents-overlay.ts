/**
 * /subagents overlay – shows a live nested run tree for the current Pi session.
 *
 * Non-TUI modes receive a short message pointing to `subagent({ action: "status" })`.
 * In TUI mode the overlay renders as a border-box list that refreshes via `requestRender()`
 * while the user navigates with the configured selection keybindings; Escape closes.
 *
 * Detail pane (issue #21):
 *   Enter/Space on a run opens an in-overlay detail pane showing that child session's
 *   persisted session file or best available log. Detail pane has independent scrolling,
 *   a thinking toggle (t), and Back/Left returns to the list without closing the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { collectRunTree, type OverlayNestedChild, type OverlayRun, type OverlayStep } from "./run-tree-collector.ts";
import { readSessionFile, resolveSessionPath, type FormattedLine } from "./session-reader.ts";
import type { SubagentState } from "../shared/types.ts";

type Theme = ExtensionContext["ui"]["theme"];
export type SubagentsOverlayView = "running" | "completed";

function isRunningViewState(state: OverlayRun["state"]): boolean {
	return state === "running" || state === "queued";
}

function runMatchesView(run: OverlayRun, view: SubagentsOverlayView): boolean {
	const isRunning = isRunningViewState(run.state);
	return view === "running" ? isRunning : !isRunning;
}

function countRunsByView(runs: OverlayRun[]): { running: number; completed: number } {
	let running = 0;
	let completed = 0;
	for (const run of runs) {
		if (isRunningViewState(run.state)) running++;
		else completed++;
	}
	return { running, completed };
}

export function filterRunsForView(runs: OverlayRun[], view: SubagentsOverlayView): OverlayRun[] {
	return runs.filter((run) => runMatchesView(run, view));
}

interface RenderOverlayOptions {
	view?: SubagentsOverlayView;
	runningCount?: number;
	completedCount?: number;
}

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

function pathDetail(input: { sessionFile?: string; logPath?: string; artifactPath?: string; asyncDir?: string }, theme: Theme): string {
	const parts: string[] = [];
	if (input.sessionFile) parts.push(`session ${input.sessionFile}`);
	if (input.logPath && input.logPath !== input.artifactPath) parts.push(`log ${input.logPath}`);
	if (input.artifactPath) parts.push(`artifact ${input.artifactPath}`);
	if (input.asyncDir && input.asyncDir !== input.artifactPath && input.asyncDir !== input.logPath) parts.push(`dir ${input.asyncDir}`);
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
		if (child.steps?.length) {
			for (const [stepIndex, step] of child.steps.entries()) {
				renderStep(step, stepIndex, theme, width, depth + 1, lines);
			}
		}
		if (child.children.length) {
			renderNestedChildren(child.children, theme, width, depth + 1, lines);
		}
	}
}

function renderStep(step: OverlayStep, stepIndex: number, theme: Theme, width: number, depth: number, lines: string[]): void {
	const prefix = indent(depth);
	const glyph = stateGlyph(step.state, theme);
	const stepNum = `${stepIndex + 1}.`;
	const tool = step.currentTool ? theme.fg("dim", ` · ${step.currentTool}`) : "";
	const elapsed = step.elapsed ? theme.fg("dim", ` · ${step.elapsed}`) : "";
	const line = `${prefix}${glyph} ${stepNum} ${step.agent} ${stateLabel(step.state, theme)}${tool}${elapsed}${pathDetail(step, theme)}`;
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
	const modePrefix = run.mode !== "single" ? `${run.mode}: ` : "";
	const selector = selected ? theme.fg("accent", "> ") : "  ";
	const tool = run.currentTool ? theme.fg("dim", ` · ${run.currentTool}`) : "";
	const header = `${selector}${glyph} ${modePrefix}${agents || run.id} ${stateLabel(run.state, theme)} ${badge} · ${run.id}${tool}${elapsed}${pathDetail(run, theme)}`;
	lines.push(truncateToWidth(header, width));
	for (const [stepIndex, step] of run.steps.entries()) {
		// Skip redundant step line for single foreground runs where the step
		// duplicates the run header (same agent). Still render nested children
		// directly under the run header so they are not lost.
		const isRedundant =
			run.source === "foreground" &&
			run.mode === "single" &&
			run.steps.length === 1 &&
			step.agent === (run.agents[0] ?? run.id);
		if (isRedundant) {
			if (step.children.length > 0) {
				renderNestedChildren(step.children, theme, width, 1, lines);
			}
			continue;
		}
		renderStep(step, stepIndex, theme, width, 1, lines);
	}
}

function renderViewSwitch(theme: Theme, options?: RenderOverlayOptions): string {
	if (!options?.view) return theme.fg("dim", "· live run tree");
	const runningCount = options.runningCount ?? 0;
	const completedCount = options.completedCount ?? 0;
	const running = options.view === "running"
		? theme.fg("accent", theme.bold(`running ${runningCount}`))
		: theme.fg("dim", `running ${runningCount}`);
	const completed = options.view === "completed"
		? theme.fg("accent", theme.bold(`completed ${completedCount}`))
		: theme.fg("dim", `completed ${completedCount}`);
	return `${theme.fg("dim", "·")} ${running} ${theme.fg("dim", "|")} ${completed}`;
}

function renderEmptyState(theme: Theme, width: number, options?: RenderOverlayOptions): string[] {
	const innerW = width - 2;
	const lines: string[] = [];
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");

	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	lines.push(row(` ${theme.fg("accent", "Subagents")} ${renderViewSwitch(theme, options)}`));
	lines.push(row(""));
	if (options?.view) {
		const emptyMessage = options.view === "running"
			? "No running subagents."
			: "No completed subagent runs.";
		lines.push(row(` ${theme.fg("dim", emptyMessage)}`));
		lines.push(row(""));
		lines.push(row(` ${theme.fg("dim", "Tab/←/→ switch view · Esc close")}`));
	} else {
		lines.push(row(` ${theme.fg("dim", "No subagents known/running.")}`));
		lines.push(row(""));
		lines.push(row(` ${theme.fg("dim", "Use /run, /chain, /parallel, or")}`));
		lines.push(row(` ${theme.fg("dim", "subagent({ ... }) to start a run.")}`));
		lines.push(row(""));
		lines.push(row(` ${theme.fg("dim", "For text-mode status, use:")}`));
		lines.push(row(` ${theme.fg("dim", '  subagent({ action: "status" })')}`));
		lines.push(row(""));
		lines.push(row(` ${theme.fg("dim", "Esc to close")}`));
	}
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return lines;
}

export function renderOverlay(runs: OverlayRun[], theme: Theme, width: number, selectedRunIndex = 0, options?: RenderOverlayOptions): string[] {
	const innerW = width - 2;
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");

	if (runs.length === 0) return renderEmptyState(theme, width, options);

	const contentLines: string[] = [];
	contentLines.push(` ${theme.fg("accent", "Subagents")} ${renderViewSwitch(theme, options)}`);
	contentLines.push("");
	for (const [index, run] of runs.entries()) {
		renderRun(run, theme, innerW - 1, contentLines, index === selectedRunIndex);
		contentLines.push("");
	}
	// Remove trailing blank
	if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
		contentLines.pop();
	}
	const switchHint = options?.view ? " · Tab/←/→ switch" : "";
	contentLines.push(truncateToWidth(` ${theme.fg("dim", `↑↓ navigate · Enter detail${switchHint} · Esc close`)}`, innerW));

	const lines: string[] = [];
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	for (const line of contentLines) {
		lines.push(row(line));
	}
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return lines;
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

interface DetailPaneTarget {
	id: string;
	label: string;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
}

function buildDetailTargets(run: OverlayRun): DetailPaneTarget[] {
	const targets: DetailPaneTarget[] = [];
	targets.push({
		id: run.id,
		label: run.agents.join(", ") || run.id,
		sessionFile: run.sessionFile,
		logPath: run.logPath,
		artifactPath: run.artifactPath,
		asyncDir: run.asyncDir,
	});
	for (const [stepIndex, step] of run.steps.entries()) {
		targets.push({
			id: `${run.id}:step:${stepIndex}`,
			label: `${step.agent} (step ${stepIndex + 1})`,
			sessionFile: step.sessionFile,
			logPath: step.logPath,
			artifactPath: step.artifactPath,
			asyncDir: step.asyncDir ?? run.asyncDir,
		});
		addNestedChildren(step.children, `${step.agent}`, targets);
	}
	function addNestedChildren(children: OverlayNestedChild[], prefix: string, acc: DetailPaneTarget[]): void {
		for (const child of children) {
			acc.push({
				id: child.id,
				label: prefix ? `${prefix} → ${child.agent}` : child.agent,
				sessionFile: child.sessionFile,
				logPath: child.logPath,
				artifactPath: child.artifactPath,
				asyncDir: child.asyncDir,
			});
			const childPrefix = prefix ? `${prefix} → ${child.agent}` : child.agent;
			if (child.steps) {
				for (const [stepIndex, step] of child.steps.entries()) {
					acc.push({
						id: `${child.id}:step:${stepIndex}`,
						label: `${childPrefix} → ${step.agent} (step ${stepIndex + 1})`,
						sessionFile: step.sessionFile,
						logPath: step.logPath,
						artifactPath: step.artifactPath,
						asyncDir: step.asyncDir ?? child.asyncDir,
					});
					addNestedChildren(step.children, `${childPrefix} → ${step.agent}`, acc);
				}
			}
			addNestedChildren(child.children, childPrefix, acc);
		}
	}
	return targets;
}

export class SubagentDetailPane {
	private run: OverlayRun;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private candidates: DetailPaneTarget[];
	private candidateIndex: number;
	private showThinking = false;
	private scrollOffset = 0;
	private contentLines: FormattedLine[] = [];
	private lastLineCount = 0;
	private lastRenderWidth = 200;
	private lastRenderHeight = 24;
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	private error?: string;

	constructor(run: OverlayRun, theme: Theme, requestRender: () => void) {
		this.run = run;
		this.theme = theme;
		this.requestRender = requestRender;
		this.candidates = buildDetailTargets(run);
		// Start at the first candidate with a resolvable session path
		this.candidateIndex = 0;
		for (let i = 0; i < this.candidates.length; i++) {
			if (resolveSessionPath(this.candidates[i]!)) {
				this.candidateIndex = i;
				break;
			}
		}
		this.refresh();
	}

	getRunId(): string {
		return this.run.id;
	}

	updateRun(run: OverlayRun): void {
		const oldId = this.candidates[this.candidateIndex]?.id;
		this.run = run;
		this.candidates = buildDetailTargets(run);
		const newIndex = this.candidates.findIndex((c) => c.id === oldId);
		this.candidateIndex = newIndex >= 0 ? newIndex : Math.min(this.candidateIndex, Math.max(0, this.candidates.length - 1));
		this.invalidate();
	}

	private currentTarget(): DetailPaneTarget {
		return this.candidates[this.candidateIndex] ?? { id: this.run.id, label: this.run.agents.join(", ") || "subagent" };
	}

	nextCandidate(): void {
		if (this.candidates.length <= 1) return;
		this.candidateIndex = (this.candidateIndex + 1) % this.candidates.length;
		this.scrollOffset = 0;
		this.refresh();
	}

	prevCandidate(): void {
		if (this.candidates.length <= 1) return;
		this.candidateIndex = (this.candidateIndex - 1 + this.candidates.length) % this.candidates.length;
		this.scrollOffset = 0;
		this.refresh();
	}

	refresh(): void {
		const target = this.currentTarget();
		const sessionPath = resolveSessionPath(target);
		if (!sessionPath) {
			this.error = "No session file or log available for this run yet.";
			this.contentLines = [];
			this.invalidate();
			return;
		}

		// Capture whether user was at bottom BEFORE content changes
		const wasAtBottom = this.lastLineCount === 0 || this.scrollOffset >= Math.max(0, this.lastLineCount - this.viewportLines(this.lastRenderHeight));

		const result = readSessionFile(sessionPath, this.theme, this.lastRenderWidth, this.showThinking);
		if (result.error) {
			// Preserve prior content during transient read errors (e.g., file
			// temporarily empty during a model/tool-call transition) so the
			// detail pane does not flicker to an empty state.
			if (this.contentLines.length === 0) {
				this.error = result.error;
				this.contentLines = [];
			}
		} else {
			this.error = undefined;
			this.contentLines = result.lines;
		}

		// Auto-scroll to bottom on first load or if user was already at bottom
		if (wasAtBottom) {
			this.scrollToBottom();
		}
		this.lastLineCount = this.contentLines.length;
		this.invalidate();
		this.requestRender();
	}

	private isAtBottom(): boolean {
		return this.scrollOffset >= Math.max(0, this.contentLines.length - this.viewportLines(this.lastRenderHeight));
	}

	private scrollToBottom(): void {
		const viewport = this.viewportLines(this.lastRenderHeight);
		this.scrollOffset = Math.max(0, this.contentLines.length - viewport);
	}

	private viewportLines(height: number): number {
		// Account for header/footer borders: 5 lines (top border, header, separator, scroll hint, bottom border)
		return Math.max(1, height - 5);
	}

	toggleThinking(): void {
		this.showThinking = !this.showThinking;
		this.refresh();
	}

	scrollUp(amount = 3): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - amount);
		this.invalidate();
		this.requestRender();
	}

	scrollDown(amount = 3): void {
		const viewport = this.viewportLines(this.lastRenderHeight);
		const maxOffset = Math.max(0, this.contentLines.length - viewport);
		this.scrollOffset = Math.min(maxOffset, this.scrollOffset + amount);
		this.invalidate();
		this.requestRender();
	}

	getShowThinking(): boolean {
		return this.showThinking;
	}

	render(width: number, height: number): string[] {
		const widthChanged = this.lastRenderWidth !== width;
		this.lastRenderWidth = width;
		this.lastRenderHeight = height;
		if (widthChanged) {
			this.refresh();
		}
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedLines = this.doRender(width, height);
		return this.cachedLines;
	}

	private doRender(width: number, height: number): string[] {
		const innerW = width - 2;
		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => this.theme.fg("border", "│") + pad(content, innerW) + this.theme.fg("border", "│");

		const lines: string[] = [];
		const target = this.currentTarget();
		const title = `${target.id} · ${target.label}`;
		const titleTrunc = truncateToWidth(title, innerW);
		const titlePad = Math.max(0, innerW - visibleWidth(titleTrunc));
		lines.push(this.theme.fg("border", "╭") + this.theme.fg("accent", titleTrunc) + this.theme.fg("border", "─".repeat(titlePad) + "╮"));

		// Show thinking indicator in header
		const thinkingStatus = this.showThinking
			? this.theme.fg("dim", "thinking: shown")
			: this.theme.fg("dim", "thinking: hidden");
		const hasMultiple = this.candidates.length > 1;
		const navHint = hasMultiple ? ` · ←/→ ${this.candidateIndex + 1}/${this.candidates.length}` : "";
		const headerLine = ` ${thinkingStatus} ${this.theme.fg("dim", `· t toggle · ↑↓ scroll${navHint} · Esc back`)}`;
		lines.push(row(truncateToWidth(headerLine, innerW)));
		lines.push(row(this.theme.fg("border", "─".repeat(innerW))));

		const contentHeight = Math.max(1, height - 5);

		if (this.error) {
			lines.push(row(this.theme.fg("warning", ` ${this.error}`)));
			for (let i = 1; i < contentHeight; i++) lines.push(row(""));
		} else if (this.contentLines.length === 0) {
			lines.push(row(this.theme.fg("dim", " No session content available yet.")));
			for (let i = 1; i < contentHeight; i++) lines.push(row(""));
		} else {
			const visible = this.contentLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
			for (let i = 0; i < contentHeight; i++) {
				if (i < visible.length) {
					const line = visible[i]!;
					lines.push(row(truncateToWidth(" " + line.text, innerW)));
				} else {
					lines.push(row(""));
				}
			}
		}

		const scrollHint = this.buildScrollHint();
		lines.push(row(truncateToWidth(scrollHint, innerW)));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	private buildScrollHint(): string {
		const parts: string[] = [];
		if (this.scrollOffset > 0) parts.push(`↑ ${this.scrollOffset} more`);
		const viewport = this.viewportLines(this.lastRenderHeight);
		const below = Math.max(0, this.contentLines.length - this.scrollOffset - viewport);
		if (below > 0) parts.push(`↓ ${below} more`);
		if (parts.length === 0) parts.push("end of content");
		return ` ${this.theme.fg("dim", parts.join("  "))}`;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

type OverlayMode = "list" | "detail";

export class SubagentsOverlay {
	private runs: OverlayRun[] = [];
	private selectedRunIndex = 0;
	private view: SubagentsOverlayView = "running";
	private viewInitialized = false;
	private mode: OverlayMode = "list";
	private detailPane?: SubagentDetailPane;
	private cachedWidth?: number;
	private cachedHeight?: number;
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
		if (!this.viewInitialized) {
			const counts = countRunsByView(this.runs);
			if (counts.running === 0 && counts.completed > 0) this.view = "completed";
			this.viewInitialized = true;
		}
		this.clampSelection();
		// Refresh detail pane content if open (handles growing logs and newly
		// discovered session/log paths on the refreshed run tree).
		if (this.mode === "detail" && this.detailPane) {
			const detailRunId = this.detailPane.getRunId();
			const refreshedRun = this.runs.find((run) => run.id === detailRunId);
			if (refreshedRun) this.detailPane.updateRun(refreshedRun);
			this.detailPane.refresh();
		}
		this.invalidate();
		this.requestRender();
	}

	private visibleRuns(): OverlayRun[] {
		return filterRunsForView(this.runs, this.view);
	}

	private clampSelection(): void {
		const visibleRuns = this.visibleRuns();
		if (visibleRuns.length === 0) {
			this.selectedRunIndex = 0;
		} else if (this.selectedRunIndex >= visibleRuns.length) {
			this.selectedRunIndex = visibleRuns.length - 1;
		}
	}

	private setView(view: SubagentsOverlayView): void {
		if (this.view === view) return;
		this.view = view;
		this.selectedRunIndex = 0;
		this.clampSelection();
		this.invalidate();
		this.requestRender();
	}

	private toggleView(): void {
		this.setView(this.view === "running" ? "completed" : "running");
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	handleInput(data: string): void {
		if (this.mode === "detail" && this.detailPane) {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			this.dispose();
			this.done();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.toggleView();
			return;
		}
		if (data === "r" || data === "R") {
			this.setView("running");
			return;
		}
		if (data === "c" || data === "C") {
			this.setView("completed");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedRunIndex = Math.max(0, this.selectedRunIndex - 1);
			this.invalidate();
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			const visibleRuns = this.visibleRuns();
			this.selectedRunIndex = visibleRuns.length === 0 ? 0 : Math.min(visibleRuns.length - 1, this.selectedRunIndex + 1);
			this.invalidate();
			this.requestRender();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter") || matchesKey(data, "space")) {
			this.openDetail();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			this.closeDetail();
			return;
		}
		if (matchesKey(data, "left")) {
			this.detailPane?.prevCandidate();
			return;
		}
		if (matchesKey(data, "right")) {
			this.detailPane?.nextCandidate();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.detailPane?.scrollUp();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.detailPane?.scrollDown();
		} else if (data === "t" || data === "T") {
			this.detailPane?.toggleThinking();
		}
	}

	private openDetail(): void {
		const visibleRuns = this.visibleRuns();
		if (visibleRuns.length === 0) return;
		const run = visibleRuns[this.selectedRunIndex];
		if (!run) return;
		this.mode = "detail";
		this.detailPane = new SubagentDetailPane(run, this.theme, this.requestRender);
		this.invalidate();
		this.requestRender();
	}

	private closeDetail(): void {
		this.mode = "list";
		this.detailPane = undefined;
		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		const height = process.stdout.rows || 24;
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedHeight = height;

		if (this.mode === "detail" && this.detailPane) {
			this.cachedLines = this.detailPane.render(width, height);
		} else {
			const counts = countRunsByView(this.runs);
			this.cachedLines = renderOverlay(this.visibleRuns(), this.theme, width, this.selectedRunIndex, {
				view: this.view,
				runningCount: counts.running,
				completedCount: counts.completed,
			});
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.detailPane?.invalidate();
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
