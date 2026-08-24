import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel, formatParallelOutcome } from "../../shared/status-format.ts";
import { type ActivityState, type AsyncJobStep, type AsyncParallelGroupStatus, type AsyncStatus, type NestedRunSummary, type SubagentRunMode, type TokenUsage, type NestedRouteValidity } from "../../shared/types.ts";
import type { FastModeStatus } from "../../shared/fast-mode.ts";
import { readStatus } from "../../shared/utils.ts";
import { attachRootChildrenToSteps, mergeNestedRunSnapshots, projectNestedEvents, readNestedRegistry, resolveNestedRoute, resolveExactNestedRoute } from "../shared/nested-events.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { isExpectedAsyncRunnerPid } from "./pid-identity.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";

interface AsyncRunStepSummary {
	index: number;
	agent: string;
	label?: string;
	phase?: string;
	outputName?: string;
	structured?: boolean;
	status: AsyncJobStep["status"];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	turnCount?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
	attemptedModels?: string[];
	error?: string;
	success?: boolean;
	finalOutput?: string;
	interrupted?: boolean;
	cancelled?: boolean;
	teardownUnproven?: boolean;
	gitBundle?: AsyncStatus["steps"] extends Array<infer T> ? T extends { gitBundle?: infer B } ? B : never : never;
	children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "cancelled";
	error?: string;
	worktreeExecutionError?: string;
	teardownUnproven?: boolean;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode: SubagentRunMode;
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	groupDiagnostics?: NonNullable<AsyncStatus["groupDiagnostics"]>;
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	nestedWarnings?: string[];
	nestedRouteValidity?: NestedRouteValidity;
	nestedRouteError?: string;
}

interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	cwd?: string;
	limit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	/** Override exact runner identity checks for trusted fixture/test environments. */
	isExpectedAsyncRunnerPid?: typeof isExpectedAsyncRunnerPid;
	reconcile?: boolean;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt: status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt,
	};
}

function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }, nestedWarnings: string[] = [], options?: { readOnly?: boolean }): AsyncRunSummary {
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") {
		throw new Error(`Invalid async status '${path.join(asyncDir, "status.json")}': sessionId must be a string.`);
	}
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const steps = status.steps ?? [];
	const chainStepCount = status.chainStepCount ?? steps.length;
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
	let nestedChildren: NestedRunSummary[] = status.nestedChildren ?? [];
	let nestedRouteValidity: NestedRouteValidity = "legacy";
	const rootRunId = status.runId || path.basename(asyncDir);
	const resolution = resolveNestedRoute(rootRunId, status.nestedRoute, { routeRequired: status.nestedRouteRequired === true });
	nestedRouteValidity = resolution.validity;
	if (resolution.error) nestedWarnings.push(`Nested status unavailable: ${resolution.error}`);
	if (resolution.route) {
		try {
			const routeChildren = options?.readOnly ? readNestedRegistry(resolution.route).children : projectNestedEvents(resolution.route).children;
			nestedChildren = mergeNestedRunSnapshots(nestedChildren, routeChildren);
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			nestedRouteValidity = "unavailable";
		}
	}
	const summarizedSteps = steps.map((step, index) => {
		const stepActivityState = step.activityState;
		const stepLastActivityAt = step.lastActivityAt;
		return {
			index,
			...(step.flatIndex !== undefined ? { flatIndex: step.flatIndex } : { flatIndex: index }),
			...(step.groupId ? { groupId: step.groupId } : {}),
			agent: step.agent,
			...(step.label ? { label: step.label } : {}),
			...(step.phase ? { phase: step.phase } : {}),
			...(step.outputName ? { outputName: step.outputName } : {}),
			...(step.structured ? { structured: step.structured } : {}),
			status: step.status,
			...(stepActivityState ? { activityState: stepActivityState } : {}),
			...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
			...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
			...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.tokens ? { tokens: step.tokens } : {}),
			...(step.skills ? { skills: step.skills } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.fastMode ? { fastMode: step.fastMode } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
			...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
			...(step.error ? { error: step.error } : {}),
			...(step.success !== undefined ? { success: step.success } : {}),
			...(step.finalOutput !== undefined ? { finalOutput: step.finalOutput } : {}),
			...(step.interrupted ? { interrupted: true } : {}),
			...(step.cancelled ? { cancelled: true } : {}),
			...(step.teardownUnproven ? { teardownUnproven: true } : {}),
			...(step.acceptance ? { acceptance: step.acceptance } : {}),
			...(step.sandbox !== undefined ? { sandbox: step.sandbox } : {}),
			...(step.sandboxDisabled ? { sandboxDisabled: true } : {}),
			...(step.gitBundle ? { gitBundle: step.gitBundle } : {}),
			...(step.children?.length ? { children: step.children } : {}),
		};
	});
	attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		state: status.state,
		...(status.error ? { error: status.error } : {}),
		...(status.worktreeExecutionError ? { worktreeExecutionError: status.worktreeExecutionError } : {}),
		...(status.teardownUnproven ? { teardownUnproven: true } : {}),
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		currentPath: status.currentPath,
		turnCount: status.turnCount,
		toolCount: status.toolCount,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		currentStep: status.currentStep,
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		...(status.groupDiagnostics?.length ? { groupDiagnostics: status.groupDiagnostics } : {}),
		steps: summarizedSteps,
		...(nestedChildren.length ? { nestedChildren } : {}),
		...(nestedWarnings.length ? { nestedWarnings } : {}),
		nestedRouteValidity,
		...(nestedWarnings.length ? { nestedRouteError: nestedWarnings[0] } : {}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

function matchesRunScope(summary: Pick<AsyncRunSummary, "sessionId" | "cwd">, options: Pick<AsyncRunListOptions, "sessionId" | "cwd">): boolean {
	if (options.sessionId) {
		if (summary.sessionId) return summary.sessionId === options.sessionId;
		if (options.cwd && summary.cwd) return summary.cwd === options.cwd;
		return false;
	}
	if (options.cwd) {
		if (summary.cwd) return summary.cwd === options.cwd;
		if (summary.sessionId) return false;
		return false;
	}
	return true;
}

function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
			case "failed": return 2;
			case "paused": return 2;
			case "cancelled": return 2;
			case "complete": return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		const byTime = bTime - aTime;
		return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
	});
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot).filter((entry) => isAsyncRunDir(asyncDirRoot, entry));
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		const reconciliation = options.reconcile === false
			? undefined
			: reconcileAsyncRun(asyncDir, {
				resultsDir: options.resultsDir,
				kill: options.kill,
				now: options.now,
				isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid,
			});
		const status = (reconciliation?.status ?? readStatus(asyncDir)) as (AsyncStatus & { cwd?: string }) | null;
		if (!status) continue;
		if (!matchesRunScope({ sessionId: status.sessionId, cwd: status.cwd }, options)) continue;
		const nestedWarnings: string[] = [];
		// When reconciliation repaired a run (e.g. owner dead → failed),
		// reconcile nested descendants before the state filter so that the
		// nested registry is materialized. The later read-only orphaned pass
		// relies on registry.json existing; it cannot call projectNestedEvents()
		// itself because tests require orphan listing to stay side-effect-free.
		if (reconciliation?.repaired) {
			try {
				const nestedRoute = resolveExactNestedRoute(status.runId || path.basename(asyncDir), status.nestedRoute, { routeRequired: status.nestedRouteRequired === true });
				if (nestedRoute) {
					reconcileNestedAsyncDescendants(nestedRoute, {
						resultsDir: options.resultsDir,
						kill: options.kill,
						now: options.now,
						isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid,
					});
					projectNestedEvents(nestedRoute);
				}
			} catch (error) {
				nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			}
		}
		if (allowedStates && !allowedStates.has(status.state)) continue;
		if (options.reconcile !== false && !reconciliation?.repaired) {
			try {
				const nestedRoute = resolveExactNestedRoute(status.runId || path.basename(asyncDir), status.nestedRoute, { routeRequired: status.nestedRouteRequired === true });
				if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, {
					resultsDir: options.resultsDir,
					kill: options.kill,
					now: options.now,
					isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid,
				});
			} catch (error) {
				nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			}
		}
		const summary = statusToSummary(asyncDir, status, nestedWarnings, { readOnly: options.reconcile === false });
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number; currentPath?: string; turnCount?: number; toolCount?: number }): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const display = step.label ? `${step.label} (${step.agent})` : step.agent;
	const phase = step.phase ? `[${step.phase}] ` : "";
	const parts = [`${step.index + 1}. ${phase}${display}`, step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	const modelThinking = formatModelThinking(step.model, step.thinking);
	if (modelThinking) parts.push(modelThinking);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

export function formatAsyncRunOutputPath(run: Pick<AsyncRunSummary, "asyncDir" | "outputFile">): string | undefined {
	if (!run.outputFile) return undefined;
	return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}

export function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps">): string {
	const stepCount = run.steps.length || 1;
	const chainStepCount = run.chainStepCount ?? stepCount;
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	if (activeGroup) {
		const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
		const groupLabel = formatParallelOutcome(groupSteps, activeGroup.count, { showRunning: run.state === "running" });
		if (run.mode === "parallel") return groupLabel;
		return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
	}
	if (run.mode === "parallel") return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
	if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
		const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
		return `step ${logicalStep + 1}/${chainStepCount}`;
	}
	return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	const activeStep = run.currentStep !== undefined ? run.steps[run.currentStep] : undefined;
	const modelStep = activeStep?.model ? activeStep : run.steps.find((step) => step.model);
	const modelThinking = formatModelThinking(modelStep?.model, modelStep?.thinking);
	return `${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel}${modelThinking ? ` | ${modelThinking}` : ""} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		if (run.error) lines.push(`  Error: ${run.error}`);
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12 }));
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12 }));
		for (const warning of run.nestedWarnings ?? []) lines.push(`  Warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
