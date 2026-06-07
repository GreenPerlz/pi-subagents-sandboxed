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
 *   thinking/tool-result toggles (t/r), and Back/Left returns to the list without closing the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import { collectRunTree, type OverlayNestedChild, type OverlayRun, type OverlayStep } from "./run-tree-collector.ts";
import { readSessionFile, resolveSessionPath, type FormattedLine } from "./session-reader.ts";
import type { SubagentState, ExtensionConfig } from "../shared/types.ts";
import {
	resolveTerminalCommand,
	launchTerminal,
	terminalUnavailableReason,
	type TerminalLaunchMetadata,
	type ResolvedTerminalCommand,
} from "./terminal-launcher.ts";

type Theme = ExtensionContext["ui"]["theme"];
export type SubagentsOverlayView = "running" | "completed";

function isRunningViewState(state: OverlayRun["state"]): boolean {
	return state === "running" || state === "queued";
}

function runMatchesView(run: OverlayRun, view: SubagentsOverlayView): boolean {
	const isRunning = isRunningViewState(run.state);
	return view === "running" ? isRunning : !isRunning;
}

function nestedChildToRun(parent: OverlayRun, child: OverlayNestedChild): OverlayRun {
	return {
		id: child.id,
		label: `${child.mode ?? "single"}: ${child.agent}`,
		state: child.state,
		mode: child.mode ?? "single",
		source: parent.source,
		agents: [child.agent],
		elapsed: child.elapsed,
		currentTool: child.currentTool,
		sessionFile: nestedChildSessionFile(child),
		logPath: child.logPath,
		artifactPath: child.artifactPath,
		asyncDir: child.asyncDir,
		steps: [],
	};
}

function collectNestedRunsForView(run: OverlayRun, view: SubagentsOverlayView): OverlayRun[] {
	const matches: OverlayRun[] = [];
	const visit = (children: OverlayNestedChild[]): void => {
		for (const child of children) {
			if (runMatchesView({ ...run, state: child.state }, view)) {
				matches.push(nestedChildToRun(run, child));
				continue;
			}
			if (child.steps?.length) {
				for (const step of child.steps) visit(step.children);
			}
			visit(child.children);
		}
	};
	for (const step of run.steps) visit(step.children);
	return matches;
}

function countRunsByView(runs: OverlayRun[]): { running: number; completed: number } {
	return {
		running: filterRunsForView(runs, "running").length,
		completed: filterRunsForView(runs, "completed").length,
	};
}

export function filterRunsForView(runs: OverlayRun[], view: SubagentsOverlayView): OverlayRun[] {
	const filtered: OverlayRun[] = [];
	for (const run of runs) {
		if (runMatchesView(run, view)) {
			filtered.push(run);
			continue;
		}
		filtered.push(...collectNestedRunsForView(run, view));
	}
	return filtered;
}

interface RenderOverlayOptions {
	view?: SubagentsOverlayView;
	runningCount?: number;
	completedCount?: number;
}

const SUBAGENTS_OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "90%" as const,
	minWidth: 84,
	maxHeight: "80%" as const,
};

function resolvePercent(value: string): number | undefined {
	if (!value.endsWith("%")) return undefined;
	const percent = Number(value.slice(0, -1));
	return Number.isFinite(percent) && percent > 0 ? percent : undefined;
}

function resolveOverlayRenderHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 24;
	const maxHeight = SUBAGENTS_OVERLAY_OPTIONS.maxHeight;
	if (typeof maxHeight === "string") {
		const percent = resolvePercent(maxHeight);
		if (percent !== undefined) return Math.max(1, Math.floor(rows * percent / 100));
	}
	return Math.max(1, rows);
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

function pathParts(input: { sessionFile?: string; logPath?: string; artifactPath?: string; asyncDir?: string }): string[] {
	const parts: string[] = [];
	if (input.sessionFile) parts.push(`session ${input.sessionFile}`);
	if (input.logPath && input.logPath !== input.artifactPath) parts.push(`log ${input.logPath}`);
	if (input.artifactPath) parts.push(`artifact ${input.artifactPath}`);
	if (input.asyncDir && input.asyncDir !== input.artifactPath && input.asyncDir !== input.logPath) parts.push(`dir ${input.asyncDir}`);
	return parts;
}

function pathDetail(input: { sessionFile?: string; logPath?: string; artifactPath?: string; asyncDir?: string }, theme: Theme): string {
	const parts = pathParts(input);
	return parts.length ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
}

function formatStartTime(ts: number | undefined): string | undefined {
	return ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : undefined;
}

function formatTokenTotal(tokens: { total?: number } | undefined): string | undefined {
	const total = tokens?.total;
	if (total === undefined) return undefined;
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
	if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tokens`;
	return `${total} tokens`;
}

function overviewMeta(input: { currentTool?: string; elapsed?: string; startedAt?: number; model?: string; tokens?: { total?: number } }, theme: Theme): string {
	const parts: string[] = [];
	if (input.currentTool) parts.push(input.currentTool);
	if (input.elapsed) parts.push(`ran ${input.elapsed}`);
	const start = formatStartTime(input.startedAt);
	if (start) parts.push(`started ${start}`);
	if (input.model) parts.push(`model ${input.model}`);
	const tokenTotal = formatTokenTotal(input.tokens);
	if (tokenTotal) parts.push(tokenTotal);
	return parts.length ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
}

interface RowCounter {
	index: number;
}

function renderNestedChildren(
	children: OverlayNestedChild[],
	theme: Theme,
	width: number,
	depth: number,
	lines: string[],
	selectedRowIndex: number,
	counter: RowCounter,
): void {
	for (const child of children) {
		if (lines.length > 200) return; // line budget
		if (isSoloNestedChildHeaderRedundant(child)) {
			const onlyStep = child.steps![0]!;
			const mergedStep: OverlayStep = {
				...onlyStep,
				currentTool: onlyStep.currentTool ?? child.currentTool,
				elapsed: onlyStep.elapsed ?? child.elapsed,
				startedAt: onlyStep.startedAt ?? child.startedAt,
				model: onlyStep.model ?? child.model,
				tokens: onlyStep.tokens ?? child.tokens,
				sessionFile: onlyStep.sessionFile ?? nestedChildSessionFile(child),
				logPath: onlyStep.logPath ?? child.logPath,
				artifactPath: onlyStep.artifactPath ?? child.artifactPath,
				asyncDir: onlyStep.asyncDir ?? child.asyncDir,
			};
			renderStep(mergedStep, 0, child.mode ?? "single", theme, width, depth, lines, selectedRowIndex, counter);
			if (child.children.length) renderNestedChildren(child.children, theme, width, depth + 1, lines, selectedRowIndex, counter);
			continue;
		}
		const prefix = indent(depth);
		const selector = counter.index === selectedRowIndex ? theme.fg("accent", "> ") : "  ";
		const glyph = stateGlyph(child.state, theme);
		const meta = overviewMeta(child, theme);
		const line = `${selector}${prefix}${glyph} ${child.agent} ${stateLabel(child.state, theme)} · ${child.id}${meta}`;
		lines.push(truncateToWidth(line, width));
		counter.index++;
		if (child.steps?.length) {
			for (const [stepIndex, step] of child.steps.entries()) {
				renderStep(step, stepIndex, child.mode ?? "single", theme, width, depth + 1, lines, selectedRowIndex, counter);
			}
		}
		if (child.children.length) {
			renderNestedChildren(child.children, theme, width, depth + 1, lines, selectedRowIndex, counter);
		}
	}
}

function isSoloAsyncRunHeaderRedundant(run: OverlayRun): boolean {
	const onlyStep = run.steps.length === 1 ? run.steps[0] : undefined;
	return run.source === "async"
		&& run.mode === "single"
		&& onlyStep !== undefined
		&& onlyStep.agent === (run.agents[0] ?? run.id);
}

function isSoloNestedChildHeaderRedundant(child: OverlayNestedChild): boolean {
	const onlyStep = child.steps?.length === 1 ? child.steps[0] : undefined;
	return (child.mode === undefined || child.mode === "single")
		&& onlyStep !== undefined
		&& onlyStep.agent === child.agent;
}

function groupRunLabel(run: OverlayRun): string {
	const agents = run.agents.length <= 3
		? run.agents.join(", ")
		: `${run.agents.slice(0, 2).join(", ")} +${run.agents.length - 2}`;
	if (run.mode === "chain" || run.mode === "parallel") return `${run.mode}(${agents || run.id})`;
	return agents || run.id;
}

function renderStep(step: OverlayStep, stepIndex: number, parentMode: OverlayRun["mode"] | undefined, theme: Theme, width: number, depth: number, lines: string[], selectedRowIndex: number, counter: RowCounter): void {
	const prefix = indent(depth);
	const selector = counter.index === selectedRowIndex ? theme.fg("accent", "> ") : "  ";
	const glyph = stateGlyph(step.state, theme);
	const stepMarker = parentMode === "chain" ? `${stepIndex + 1}.` : "*";
	const meta = overviewMeta(step, theme);
	const line = `${selector}${prefix}${glyph} ${stepMarker} ${step.agent} ${stateLabel(step.state, theme)}${meta}`;
	lines.push(truncateToWidth(line, width));
	counter.index++;
	renderNestedChildren(step.children, theme, width, depth + 1, lines, selectedRowIndex, counter);
}

function renderRun(run: OverlayRun, theme: Theme, width: number, lines: string[], selectedRowIndex: number, counter: RowCounter): void {
	if (isSoloAsyncRunHeaderRedundant(run)) {
		renderStep(run.steps[0]!, 0, run.mode, theme, width, 0, lines, selectedRowIndex, counter);
		return;
	}
	const glyph = stateGlyph(run, theme);
	const badge = sourceBadge(run.source, theme);
	const label = groupRunLabel(run);
	const selector = counter.index === selectedRowIndex ? theme.fg("accent", "> ") : "  ";
	const meta = overviewMeta(run, theme);
	const header = `${selector}${glyph} ${label} ${stateLabel(run.state, theme)} ${badge} · ${run.id}${meta}`;
	lines.push(truncateToWidth(header, width));
	counter.index++;
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
				renderNestedChildren(step.children, theme, width, 1, lines, selectedRowIndex, counter);
			}
			continue;
		}
		renderStep(step, stepIndex, run.mode, theme, width, 1, lines, selectedRowIndex, counter);
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

function capOverlayLines(lines: string[], maxHeight?: number): string[] {
	// Pi TUI slices overlay lines above overlayOptions.maxHeight. Keep our
	// returned line count within that cap so the bottom border/footer is not
	// sliced off by the compositor, including tiny terminals.
	if (maxHeight === undefined || lines.length <= maxHeight) return lines;
	const bottom = lines.pop()!;
	lines.length = Math.max(0, maxHeight - 1);
	if (maxHeight > 0) lines.push(bottom);
	return lines;
}

function renderEmptyState(theme: Theme, width: number, options?: RenderOverlayOptions, maxHeight?: number): string[] {
	const innerW = width - 2;
	const lines: string[] = [];
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => {
		const truncated = truncateToWidth(content, innerW);
		return theme.fg("border", "│") + pad(truncated, innerW) + theme.fg("border", "│");
	};

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
	return capOverlayLines(lines, maxHeight);
}

export function renderOverlay(
	runs: OverlayRun[],
	theme: Theme,
	width: number,
	selectedRowIndex = 0,
	options?: RenderOverlayOptions,
	terminalCommand?: ResolvedTerminalCommand,
	transientError?: string,
	maxHeight?: number,
): string[] {
	const innerW = width - 2;
	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};
	const row = (content: string) => {
		const truncated = truncateToWidth(content, innerW);
		return theme.fg("border", "│") + pad(truncated, innerW) + theme.fg("border", "│");
	};

	if (runs.length === 0) return renderEmptyState(theme, width, options, maxHeight);

	const contentLines: string[] = [];
	contentLines.push(` ${theme.fg("accent", "Subagents")} ${renderViewSwitch(theme, options)}`);
	contentLines.push("");
	const counter: RowCounter = { index: 0 };
	for (const run of runs) {
		renderRun(run, theme, innerW - 1, contentLines, selectedRowIndex, counter);
		contentLines.push("");
	}
	// Remove trailing blank
	if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
		contentLines.pop();
	}
	const switchHint = options?.view ? " · Tab/←/→ switch" : "";
	const terminalHint = terminalCommand ? " · o open terminal" : "";
	const navHint = truncateToWidth(` ${theme.fg("dim", `↑↓ navigate · Enter detail${switchHint}${terminalHint} · Esc close`)}`, innerW);
	contentLines.push(navHint);
	const errorRows = transientError ? 1 : 0;
	const maxContentLines = maxHeight ? Math.max(0, maxHeight - 2 - errorRows) : undefined;
	if (maxContentLines !== undefined && contentLines.length > maxContentLines) {
		if (maxContentLines >= 2) {
			const omitted = contentLines.length - maxContentLines;
			const keep = Math.max(0, maxContentLines - 2);
			contentLines.splice(keep, contentLines.length - keep, truncateToWidth(` ${theme.fg("dim", `… ${omitted} more rows hidden`)}`, innerW), navHint);
		} else if (maxContentLines === 1) {
			contentLines.length = 1;
			contentLines[0] = navHint;
		} else {
			contentLines.length = 0;
		}
	}

	const lines: string[] = [];
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	for (const line of contentLines) {
		lines.push(row(line));
	}
	if (transientError) {
		lines.push(row(theme.fg("error", ` ${truncateToWidth(transientError, innerW - 1)}`)));
	}
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return capOverlayLines(lines, maxHeight);
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

function nestedChildSessionFile(child: OverlayNestedChild): string | undefined {
	return child.sessionFile
		?? (child.steps?.length === 1 ? child.steps[0]?.sessionFile : undefined)
		?? (child.children.length === 1 ? nestedChildSessionFile(child.children[0]!) : undefined);
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
				sessionFile: nestedChildSessionFile(child),
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

// ---------------------------------------------------------------------------
// Flattened selectable rows (issue #30)
// ---------------------------------------------------------------------------

export interface FlattenedRow {
	type: "run" | "step" | "nested";
	run: OverlayRun;
	target: DetailPaneTarget;
	stepIndex?: number;
	step?: OverlayStep;
	nestedChild?: OverlayNestedChild;
}

export function flattenRows(runs: OverlayRun[]): FlattenedRow[] {
	const rows: FlattenedRow[] = [];
	for (const run of runs) {
		if (!isSoloAsyncRunHeaderRedundant(run)) {
			rows.push({
				type: "run",
				run,
				target: {
					id: run.id,
					label: run.agents.join(", ") || run.id,
					sessionFile: run.sessionFile,
					logPath: run.logPath,
					artifactPath: run.artifactPath,
					asyncDir: run.asyncDir,
				},
			});
		}
		for (const [stepIndex, step] of run.steps.entries()) {
			const isRedundant =
				run.source === "foreground" &&
				run.mode === "single" &&
				run.steps.length === 1 &&
				step.agent === (run.agents[0] ?? run.id);
			if (isRedundant) {
				flattenNestedChildren(step.children, run, rows, step.agent);
				continue;
			}
			rows.push({
				type: "step",
				run,
				stepIndex,
				step,
				target: {
					id: `${run.id}:step:${stepIndex}`,
					label: `${step.agent} (step ${stepIndex + 1})`,
					sessionFile: step.sessionFile,
					logPath: step.logPath,
					artifactPath: step.artifactPath,
					asyncDir: step.asyncDir ?? run.asyncDir,
				},
			});
			flattenNestedChildren(step.children, run, rows, step.agent);
		}
	}
	return rows;
}

function flattenNestedChildren(children: OverlayNestedChild[], run: OverlayRun, rows: FlattenedRow[], prefix: string): void {
	for (const child of children) {
		const childLabel = prefix ? `${prefix} → ${child.agent}` : child.agent;
		const childPrefix = childLabel;
		if (!isSoloNestedChildHeaderRedundant(child)) {
			rows.push({
				type: "nested",
				run,
				nestedChild: child,
				target: {
					id: child.id,
					label: childLabel,
					sessionFile: nestedChildSessionFile(child),
					logPath: child.logPath,
					artifactPath: child.artifactPath,
					asyncDir: child.asyncDir,
				},
			});
		}
		if (child.steps) {
			for (const [stepIndex, step] of child.steps.entries()) {
				const stepLabel = `${childPrefix} → ${step.agent} (step ${stepIndex + 1})`;
				rows.push({
					type: "step",
					run,
					stepIndex,
					step,
					target: {
						id: `${child.id}:step:${stepIndex}`,
						label: stepLabel,
						sessionFile: step.sessionFile,
						logPath: step.logPath,
						artifactPath: step.artifactPath,
						asyncDir: step.asyncDir ?? child.asyncDir,
					},
				});
				flattenNestedChildren(step.children, run, rows, `${childPrefix} → ${step.agent}`);
			}
		}
		flattenNestedChildren(child.children, run, rows, childPrefix);
	}
}

export class SubagentDetailPane {
	private run: OverlayRun;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private candidates: DetailPaneTarget[];
	private candidateIndex: number;
	private showThinking = false;
	private showToolResults = false;
	private detailView: "session" | "logs";
	private detailViewExplicit = false;
	private scrollOffset = 0;
	private contentLines: FormattedLine[] = [];
	private lastLineCount = 0;
	private lastRenderWidth = 200;
	private lastRenderHeight = 24;
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	private error?: string;
	private readonly terminalCommand?: ResolvedTerminalCommand;
	private transientError?: string;
	private transientErrorTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(run: OverlayRun, theme: Theme, requestRender: () => void, terminalCommand?: ResolvedTerminalCommand, initialTargetId?: string) {
		this.run = run;
		this.theme = theme;
		this.requestRender = requestRender;
		this.terminalCommand = terminalCommand;
		this.candidates = buildDetailTargets(run);
		// Prefer a candidate with a real session file; fall back to any resolvable path.
		let sessionIndex = -1;
		let anyIndex = -1;
		for (let i = 0; i < this.candidates.length; i++) {
			const c = this.candidates[i]!;
			if (sessionIndex < 0 && resolveSessionPath(c, "session")) {
				sessionIndex = i;
			}
			if (anyIndex < 0 && resolveSessionPath(c)) {
				anyIndex = i;
			}
			if (sessionIndex >= 0 && anyIndex >= 0) break;
		}
		const defaultIndex = sessionIndex >= 0 ? sessionIndex : anyIndex >= 0 ? anyIndex : 0;
		if (initialTargetId) {
			const explicitIndex = this.candidates.findIndex((c) => c.id === initialTargetId);
			this.candidateIndex = explicitIndex >= 0 ? explicitIndex : defaultIndex;
		} else {
			this.candidateIndex = defaultIndex;
		}
		// Default to session view when a session file is available; otherwise logs.
		const initialTarget = this.candidates[this.candidateIndex];
		this.detailView = initialTarget && resolveSessionPath(initialTarget, "session") ? "session" : "logs";
		this.detailViewExplicit = false;
		this.refresh();
	}

	getRunId(): string {
		return this.run.id;
	}

	getCurrentTarget(): DetailPaneTarget {
		return this.currentTarget();
	}

	updateRun(run: OverlayRun): void {
		const oldId = this.candidates[this.candidateIndex]?.id;
		this.run = run;
		this.candidates = buildDetailTargets(run);
		const newIndex = this.candidates.findIndex((c) => c.id === oldId);
		this.candidateIndex = newIndex >= 0 ? newIndex : Math.min(this.candidateIndex, Math.max(0, this.candidates.length - 1));
		if (!this.detailViewExplicit) {
			this.setDefaultDetailView();
		}
		this.invalidate();
	}

	private currentTarget(): DetailPaneTarget {
		return this.candidates[this.candidateIndex] ?? { id: this.run.id, label: this.run.agents.join(", ") || "subagent" };
	}

	private setDefaultDetailView(): void {
		const target = this.currentTarget();
		this.detailView = resolveSessionPath(target, "session") ? "session" : "logs";
	}

	nextCandidate(): void {
		if (this.candidates.length <= 1) return;
		this.candidateIndex = (this.candidateIndex + 1) % this.candidates.length;
		this.scrollOffset = 0;
		this.setDefaultDetailView();
		this.detailViewExplicit = false;
		this.refresh();
	}

	prevCandidate(): void {
		if (this.candidates.length <= 1) return;
		this.candidateIndex = (this.candidateIndex - 1 + this.candidates.length) % this.candidates.length;
		this.scrollOffset = 0;
		this.setDefaultDetailView();
		this.detailViewExplicit = false;
		this.refresh();
	}

	refresh(): void {
		const target = this.currentTarget();
		const sessionPath = resolveSessionPath(target, this.detailView);
		if (!sessionPath) {
			this.error = this.detailView === "session"
				? "No session transcript available for this run yet."
				: "No logs available for this run yet.";
			this.contentLines = [];
			this.invalidate();
			return;
		}

		// Capture whether user was at bottom BEFORE content changes
		const wasAtBottom = this.lastLineCount === 0 || this.scrollOffset >= Math.max(0, this.lastLineCount - this.viewportLines(this.lastRenderHeight));

		const result = readSessionFile(sessionPath, this.theme, this.lastRenderWidth, this.showThinking, this.showToolResults);
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

		// Auto-scroll to bottom on first load or if user was already at bottom;
		// otherwise clamp the offset in case filters shrink the visible content.
		if (wasAtBottom) {
			this.scrollToBottom();
		} else {
			const viewport = this.viewportLines(this.lastRenderHeight);
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.contentLines.length - viewport));
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
		const targetPaths = pathParts(this.currentTarget());
		const needsHeader = height >= 4;
		const needsPathHeader = targetPaths.length > 0 && height >= 5;
		const needsSeparator = height >= (needsPathHeader ? 6 : 5);
		const needsScrollHint = height >= (needsPathHeader ? 7 : 6);
		const overhead = 2 + (needsHeader ? 1 : 0) + (needsPathHeader ? 1 : 0) + (needsSeparator ? 1 : 0) + (needsScrollHint ? 1 : 0);
		return Math.max(0, height - overhead);
	}

	toggleThinking(): void {
		this.showThinking = !this.showThinking;
		this.refresh();
	}

	toggleToolResults(): void {
		this.showToolResults = !this.showToolResults;
		this.refresh();
	}

	toggleDetailView(): void {
		this.detailView = this.detailView === "session" ? "logs" : "session";
		this.detailViewExplicit = true;
		this.scrollOffset = 0;
		this.refresh();
	}

	getDetailView(): "session" | "logs" {
		return this.detailView;
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

	getShowToolResults(): boolean {
		return this.showToolResults;
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

	setTransientError(message: string): void {
		this.transientError = message;
		this.invalidate();
		this.requestRender();
		if (this.transientErrorTimer) {
			clearTimeout(this.transientErrorTimer);
		}
		this.transientErrorTimer = setTimeout(() => {
			this.transientError = undefined;
			this.invalidate();
			this.requestRender();
		}, 3000);
	}

	private doRender(width: number, height: number): string[] {
		const innerW = width - 2;
		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => {
			const truncated = truncateToWidth(content, innerW);
			return this.theme.fg("border", "│") + pad(truncated, innerW) + this.theme.fg("border", "│");
		};

		const lines: string[] = [];
		const target = this.currentTarget();
		const title = `${target.id} · ${target.label}`;
		const titleTrunc = truncateToWidth(title, innerW);
		const titlePad = Math.max(0, innerW - visibleWidth(titleTrunc));
		lines.push(this.theme.fg("border", "╭") + this.theme.fg("accent", titleTrunc) + this.theme.fg("border", "─".repeat(titlePad) + "╮"));

		const targetPaths = pathParts(target);
		const needsHeader = height >= 4;
		const needsPathHeader = targetPaths.length > 0 && height >= 5;
		const needsSeparator = height >= (needsPathHeader ? 6 : 5);
		const needsScrollHint = height >= (needsPathHeader ? 7 : 6);

		if (needsHeader) {
			const viewStatus = this.theme.fg("dim", `view:${this.detailView}`);
			const thinkingStatus = this.showThinking
				? this.theme.fg("dim", "think:shown")
				: this.theme.fg("dim", "think:hidden");
			const toolStatus = this.showToolResults
				? this.theme.fg("dim", "results:shown")
				: this.theme.fg("dim", "results:hidden");
			const hasMultiple = this.candidates.length > 1;
			const navHint = hasMultiple ? ` · ←/→ ${this.candidateIndex + 1}/${this.candidates.length}` : "";
			const terminalHint = this.terminalCommand ? " · o open terminal" : "";
			const errorHint = this.transientError ? ` · ${this.transientError}` : "";
			const headerLine = `${viewStatus} · ${thinkingStatus} · ${toolStatus}${terminalHint} ${this.theme.fg("dim", `· t/r/l · ↑↓${navHint} · Esc`)}${this.theme.fg("error", errorHint)}`;
			lines.push(row(truncateToWidth(headerLine, innerW)));
		}
		if (needsPathHeader) {
			lines.push(row(this.theme.fg("dim", `files · ${targetPaths.join(" · ")}`)));
		}
		if (needsSeparator) {
			lines.push(row(this.theme.fg("border", "─".repeat(innerW))));
		}

		const overhead = 2 + (needsHeader ? 1 : 0) + (needsPathHeader ? 1 : 0) + (needsSeparator ? 1 : 0) + (needsScrollHint ? 1 : 0);
		const contentHeight = Math.max(0, height - overhead);

		if (this.transientError) {
			if (contentHeight > 0) {
				lines.push(row(this.theme.fg("error", ` ${truncateToWidth(this.transientError, innerW - 1)}`)));
				for (let i = 1; i < contentHeight; i++) lines.push(row(""));
			}
		} else if (this.error) {
			if (contentHeight > 0) {
				lines.push(row(this.theme.fg("warning", ` ${this.error}`)));
				for (let i = 1; i < contentHeight; i++) lines.push(row(""));
			}
		} else if (this.contentLines.length === 0) {
			if (contentHeight > 0) {
				lines.push(row(this.theme.fg("dim", " No session content available yet.")));
				for (let i = 1; i < contentHeight; i++) lines.push(row(""));
			}
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

		if (needsScrollHint) {
			const scrollHint = this.buildScrollHint();
			lines.push(row(truncateToWidth(scrollHint, innerW)));
		}
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerW)}╯`));
		// Safety: never exceed requested height, but preserve bottom border when possible
		if (lines.length > height) {
			const bottom = lines.pop()!;
			lines.length = Math.max(0, height - 1);
			if (height > 0) lines.push(bottom);
		}
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
	private selectedRowIndex = 0;
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
	private readonly terminalCommand?: ResolvedTerminalCommand;

	constructor(
		theme: Theme,
		state: SubagentState,
		done: () => void,
		requestRender: () => void,
		keybindings: KeybindingsManager,
		terminalConfig?: ExtensionConfig["externalTerminal"],
	) {
		this.theme = theme;
		this.state = state;
		this.done = done;
		this.requestRender = requestRender;
		this.keybindings = keybindings;
		this.terminalCommand = resolveTerminalCommand(terminalConfig);
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
		const rows = flattenRows(this.visibleRuns());
		if (rows.length === 0) {
			this.selectedRowIndex = 0;
		} else if (this.selectedRowIndex >= rows.length) {
			this.selectedRowIndex = rows.length - 1;
		}
	}

	private setView(view: SubagentsOverlayView): void {
		if (this.view === view) return;
		this.view = view;
		this.selectedRowIndex = 0;
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
			this.selectedRowIndex = Math.max(0, this.selectedRowIndex - 1);
			this.invalidate();
			this.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			const rows = flattenRows(this.visibleRuns());
			this.selectedRowIndex = rows.length === 0 ? 0 : Math.min(rows.length - 1, this.selectedRowIndex + 1);
			this.invalidate();
			this.requestRender();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter") || matchesKey(data, "space")) {
			this.openDetail();
		} else if (data === "o" || data === "O") {
			this.openSelectedInTerminal();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			this.closeDetail();
			return;
		}
		if (matchesKey(data, "left")) {
			this.detailPane?.prevCandidate();
			this.invalidate();
			return;
		}
		if (matchesKey(data, "right")) {
			this.detailPane?.nextCandidate();
			this.invalidate();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.detailPane?.scrollUp();
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.detailPane?.scrollDown();
		} else if (data === "t" || data === "T") {
			this.detailPane?.toggleThinking();
		} else if (data === "r" || data === "R") {
			this.detailPane?.toggleToolResults();
		} else if (data === "l" || data === "L") {
			this.detailPane?.toggleDetailView();
		} else if (data === "o" || data === "O") {
			this.openDetailInTerminal();
		}
		this.invalidate();
	}

	private openDetail(): void {
		const visibleRuns = this.visibleRuns();
		if (visibleRuns.length === 0) return;
		const rows = flattenRows(visibleRuns);
		const row = rows[this.selectedRowIndex];
		if (!row) return;
		this.mode = "detail";
		// Only force an explicit initial target for non-run rows (step/nested).
		// For run rows, let the detail pane auto-select the best resolvable candidate
		// so that a parent/run without its own session/log falls back to a child/step
		// that does have content (issue #30).
		const initialTargetId = row.type === "run" ? undefined : row.target.id;
		this.detailPane = new SubagentDetailPane(row.run, this.theme, this.requestRender, this.terminalCommand, initialTargetId);
		this.invalidate();
		this.requestRender();
	}

	private closeDetail(): void {
		this.mode = "list";
		this.detailPane = undefined;
		this.invalidate();
		this.requestRender();
	}

	private openSelectedInTerminal(): void {
		const visibleRuns = this.visibleRuns();
		if (visibleRuns.length === 0 || !this.terminalCommand) return;
		const rows = flattenRows(visibleRuns);
		const row = rows[this.selectedRowIndex];
		if (!row) return;
		// Terminal handoff requires a real child session file, not log/artifact fallback.
		const sessionFile = row.target.sessionFile;
		const metadata: TerminalLaunchMetadata = {
			sessionFile: sessionFile ?? undefined,
			cwd: this.state.baseCwd || process.cwd(),
		};
		const reason = terminalUnavailableReason(this.terminalCommand, metadata);
		if (reason) {
			this.openDetail();
			this.detailPane?.setTransientError(reason);
			return;
		}
		launchTerminal(this.terminalCommand, metadata).then((result) => {
			if (!result.success) {
				this.openDetail();
				this.detailPane?.setTransientError(result.error ?? "Failed to open terminal.");
			}
		});
	}

	private openDetailInTerminal(): void {
		if (!this.detailPane || !this.terminalCommand) return;
		const target = this.detailPane.getCurrentTarget();
		// Terminal handoff requires a real child session file, not log/artifact fallback.
		const sessionFile = target.sessionFile;
		const metadata: TerminalLaunchMetadata = {
			sessionFile: sessionFile ?? undefined,
			cwd: this.state.baseCwd || process.cwd(),
		};
		const reason = terminalUnavailableReason(this.terminalCommand, metadata);
		if (reason) {
			this.detailPane.setTransientError(reason);
			return;
		}
		launchTerminal(this.terminalCommand, metadata).then((result) => {
			if (!result.success) {
				this.detailPane.setTransientError(result.error ?? "Failed to open terminal.");
			}
		});
	}

	render(width: number): string[] {
		const height = resolveOverlayRenderHeight(process.stdout.rows || 24);
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedHeight = height;

		if (this.mode === "detail" && this.detailPane) {
			this.cachedLines = this.detailPane.render(width, height);
		} else {
			const counts = countRunsByView(this.runs);
			this.cachedLines = renderOverlay(this.visibleRuns(), this.theme, width, this.selectedRowIndex, {
				view: this.view,
				runningCount: counts.running,
				completedCount: counts.completed,
			}, this.terminalCommand, undefined, height);
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

async function openSubagentsOverlay(
	ctx: ExtensionContext,
	state: SubagentState,
	terminalConfig?: ExtensionConfig["externalTerminal"],
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const requestRender = () => { (tui as { requestRender?: () => void }).requestRender?.(); };
		const overlay = new SubagentsOverlay(
			theme,
			state,
			done,
			requestRender,
			keybindings,
			terminalConfig,
		);
		return {
			render: (w: number) => overlay.render(w),
			invalidate: () => overlay.invalidate(),
			handleInput: (data: string) => overlay.handleInput(data),
			dispose: () => overlay.dispose(),
		};
	}, { overlay: true, overlayOptions: SUBAGENTS_OVERLAY_OPTIONS });
}

export function registerSubagentsOverlayCommand(
	pi: ExtensionAPI,
	state: SubagentState,
	terminalConfig?: ExtensionConfig["externalTerminal"],
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
			await openSubagentsOverlay(ctx, state, terminalConfig);
		},
	});
}

export function registerSubagentsOverlayShortcut(
	pi: ExtensionAPI,
	state: SubagentState,
	config?: ExtensionConfig,
): void {
	const shortcut = config?.overlayShortcut;
	if (!shortcut) return;

	pi.registerShortcut(shortcut as KeyId, {
		description: "Open subagents overlay",
		handler: (ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`Subagents overlay shortcut requires TUI mode. For text status, use: subagent({ action: "status" })`,
					"info",
				);
				return;
			}
			return openSubagentsOverlay(ctx, state, config?.externalTerminal);
		},
	});
}
