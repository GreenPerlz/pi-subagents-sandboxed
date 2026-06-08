/**
 * Run tree collection and flattening for the /subagents overlay.
 *
 * Collects live run data from foreground controls and async background jobs,
 * building a nested tree where nested subagent runs appear as children under
 * the parent step that launched them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listAsyncRuns, formatAsyncRunOutputPath, type AsyncRunSummary } from "../runs/background/async-status.ts";
import { listPersistedForegroundRuns, type PersistedForegroundStatus } from "../runs/foreground/foreground-status.ts";
import { updateForegroundNestedProjection } from "../runs/shared/nested-events.ts";
import {
	ASYNC_DIR,
	FOREGROUND_DIR,
	RESULTS_DIR,
	type AsyncJobState,
	type AsyncJobStep,
	type NestedRunSummary,
	type NestedStepSummary,
	type SubagentRunMode,
	type SubagentState,
	type TokenUsage,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OverlayRunState = "running" | "complete" | "failed" | "paused" | "queued";

export interface OverlayNestedChild {
	id: string;
	agent: string;
	state: OverlayRunState;
	mode?: SubagentRunMode;
	currentTool?: string;
	elapsed?: string;
	startedAt?: number;
	model?: string;
	thinking?: string;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	children: OverlayNestedChild[];
	steps?: OverlayStep[];
}

export interface OverlayStep {
	agent: string;
	state: OverlayRunState;
	currentTool?: string;
	elapsed?: string;
	startedAt?: number;
	model?: string;
	thinking?: string;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	children: OverlayNestedChild[];
}

export interface OverlayRun {
	id: string;
	label: string;
	state: OverlayRunState;
	mode: SubagentRunMode;
	source: "foreground" | "async";
	agents: string[];
	elapsed?: string;
	startedAt?: number;
	updatedAt?: number;
	currentTool?: string;
	model?: string;
	thinking?: string;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	steps: OverlayStep[];
}

export interface CollectRunTreeOptions {
	asyncDirRoot?: string;
	foregroundDirRoot?: string;
	resultsDir?: string;
	persistedAsyncLimit?: number;
	persistedForegroundLimit?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PERSISTED_ASYNC_LIMIT = 25;
const DEFAULT_PERSISTED_FOREGROUND_LIMIT = 25;

interface PersistedResultChild {
	agent?: string;
	state: OverlayRunState;
	sessionFile?: string;
	artifactPath?: string;
	model?: string;
	thinking?: string;
}

interface PersistedResultRecord {
	id: string;
	sessionId?: string;
	cwd?: string;
	mode: SubagentRunMode;
	state: OverlayRunState;
	sessionFile?: string;
	asyncDir?: string;
	updatedAt?: number;
	agent?: string;
	children: PersistedResultChild[];
}

function mapState(state: string): OverlayRunState {
	if (state === "running" || state === "queued") return state as OverlayRunState;
	if (state === "complete" || state === "completed") return "complete";
	if (state === "paused") return "paused";
	if (state === "failed") return "failed";
	if (state === "pending") return "queued";
	return "complete";
}

function deriveRunState(topLevel: OverlayRunState, steps: OverlayStep[], nestedChildren: OverlayNestedChild[] = []): OverlayRunState {
	const allStates = new Set<OverlayRunState>([
		topLevel,
		...steps.map((s) => s.state),
		...steps.flatMap((s) => s.children).map((c) => c.state),
		...nestedChildren.map((c) => c.state),
	]);
	if (allStates.has("running")) return "running";
	if (allStates.has("failed")) return "failed";
	if (allStates.has("paused")) return "paused";
	if (allStates.has("queued")) return "queued";
	return topLevel;
}

function elapsedFromMs(ms: number | undefined): string | undefined {
	if (ms === undefined || ms < 0) return undefined;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

function elapsedFromRange(start: number | undefined, end: number | undefined, now = Date.now()): string | undefined {
	if (start === undefined) return undefined;
	return elapsedFromMs((end ?? now) - start);
}

function approximateTokenUsage(total: number | undefined): TokenUsage | undefined {
	return typeof total === "number" && Number.isFinite(total) && total > 0
		? { input: 0, output: total, total }
		: undefined;
}

function sumTokenUsage(values: Array<TokenUsage | undefined>): TokenUsage | undefined {
	let input = 0;
	let output = 0;
	let total = 0;
	let seen = false;
	for (const value of values) {
		if (!value) continue;
		input += value.input;
		output += value.output;
		total += value.total;
		seen = true;
	}
	return seen ? { input, output, total } : undefined;
}

function inferSessionFileFromAsyncDir(asyncDir: string | undefined): string | undefined {
	return fileIfExists(asyncDir ? path.join(asyncDir, "session.jsonl") : undefined);
}

function inferNestedSessionFile(run: NestedRunSummary, steps: OverlayStep[], directChildren: OverlayNestedChild[]): string | undefined {
	return run.sessionFile
		?? (steps.length === 1 ? steps[0]?.sessionFile : undefined)
		?? inferSessionFileFromAsyncDir(run.asyncDir)
		?? (directChildren.length === 1 ? directChildren[0]?.sessionFile : undefined);
}

function mapNestedRun(run: NestedRunSummary): OverlayNestedChild {
	return mapNestedRunWithStaleState(run);
}

function staleNestedState(state: OverlayRunState, fallback: OverlayRunState | undefined): OverlayRunState {
	if ((state === "running" || state === "queued") && fallback) return fallback;
	return state;
}

function mapNestedRunWithStaleState(run: NestedRunSummary, fallbackState?: OverlayRunState, fallbackFreezeAt?: number): OverlayNestedChild {
	const runMappedState = staleNestedState(mapState(run.state), fallbackState);
	const freezeAt = fallbackState ? run.endedAt ?? run.lastUpdate ?? fallbackFreezeAt : run.endedAt;
	const steps: OverlayStep[] = (run.steps ?? []).map((step) => {
		const stepState = staleNestedState(mapState(step.status), fallbackState);
		return {
			agent: step.agent,
			state: stepState,
			currentTool: stepState === "running" ? step.currentTool : undefined,
			elapsed: elapsedFromRange(step.startedAt, step.endedAt ?? freezeAt),
			startedAt: step.startedAt,
			model: step.model,
			thinking: step.thinking,
			tokens: step.totalTokens,
			sessionFile: step.sessionFile,
			children: mapNestedStepChildrenWithStaleState(step.children, fallbackState, freezeAt),
		};
	});
	const directChildren: OverlayNestedChild[] = (run.children ?? []).map((child) => mapNestedRunWithStaleState(child, fallbackState, freezeAt));
	const derivedState = deriveRunState(runMappedState, steps, directChildren);
	return {
		id: run.id,
		agent: run.agent ?? run.agents?.join(", ") ?? run.id,
		state: derivedState,
		mode: run.mode,
		currentTool: derivedState === "running" ? run.currentTool : undefined,
		elapsed: elapsedFromRange(run.startedAt, freezeAt),
		startedAt: run.startedAt,
		model: run.model,
		thinking: run.thinking,
		tokens: run.totalTokens,
		sessionFile: inferNestedSessionFile(run, steps, directChildren),
		asyncDir: run.asyncDir,
		children: directChildren,
		steps: steps.length ? steps : undefined,
	};
}

function mapNestedStepChildrenWithStaleState(children: NestedRunSummary[] | undefined, fallbackState?: OverlayRunState, fallbackFreezeAt?: number): OverlayNestedChild[] {
	if (!children?.length) return [];
	return children.map((child) => mapNestedRunWithStaleState(child, fallbackState, fallbackFreezeAt));
}

function modeLabel(mode: SubagentRunMode | undefined): string {
	if (mode === "parallel") return "parallel";
	if (mode === "chain") return "chain";
	return "single";
}

function agentsLabel(agents: string[] | undefined): string[] {
	if (!agents?.length) return [];
	return agents;
}

function fileIfExists(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : undefined;
	} catch {
		return undefined;
	}
}

function logPathForStep(asyncDir: string | undefined, index: number | undefined): string | undefined {
	if (!asyncDir || index === undefined) return undefined;
	return fileIfExists(path.join(asyncDir, `output-${index}.log`));
}

function logPathForRun(asyncDir: string | undefined, explicit?: string): string | undefined {
	return fileIfExists(explicit)
		?? fileIfExists(asyncDir ? path.join(asyncDir, "output.log") : undefined)
		?? fileIfExists(asyncDir ? path.join(asyncDir, "output-0.log") : undefined);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modeValue(value: unknown, childCount: number): SubagentRunMode {
	return value === "single" || value === "parallel" || value === "chain"
		? value
		: childCount > 1 ? "chain" : "single";
}

function resultStateValue(state: unknown, success: unknown): OverlayRunState {
	if (state === "queued" || state === "running" || state === "paused" || state === "failed" || state === "complete" || state === "completed") {
		return mapState(state);
	}
	if (typeof success === "boolean") return success ? "complete" : "failed";
	return "complete";
}

function childResultStateValue(parentState: unknown, success: unknown): OverlayRunState {
	if (parentState === "paused" || typeof success !== "boolean") return resultStateValue(parentState, success);
	return success ? "complete" : "failed";
}

function matchesPersistedScope(entry: { sessionId?: string; cwd?: string }, state: Pick<SubagentState, "currentSessionId" | "baseCwd">): boolean {
	if (state.currentSessionId) {
		if (entry.sessionId) return entry.sessionId === state.currentSessionId;
		if (entry.cwd) return entry.cwd === state.baseCwd;
		return false;
	}
	if (entry.cwd) return entry.cwd === state.baseCwd;
	if (entry.sessionId) return false;
	return false;
}

function readPersistedResultRecord(resultPath: string): PersistedResultRecord | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as Record<string, unknown>;
		const results = Array.isArray(raw.results) ? raw.results : [];
		const children = results.map((entry) => {
			const child = objectValue(entry) ?? {};
			const artifactPaths = objectValue(child.artifactPaths);
			const childSuccess = booleanValue(child.success);
			return {
				agent: stringValue(child.agent),
				state: childResultStateValue(raw.state, childSuccess),
				sessionFile: stringValue(child.sessionFile),
				artifactPath: stringValue(artifactPaths?.outputPath),
				model: stringValue(child.model),
				thinking: stringValue(child.thinking),
			};
		});
		const id = stringValue(raw.runId) ?? stringValue(raw.id) ?? path.basename(resultPath, ".json");
		return {
			id,
			sessionId: stringValue(raw.sessionId),
			cwd: stringValue(raw.cwd),
			mode: modeValue(raw.mode, children.length),
			state: resultStateValue(raw.state, raw.success),
			sessionFile: stringValue(raw.sessionFile),
			asyncDir: stringValue(raw.asyncDir),
			agent: stringValue(raw.agent),
			children,
		};
	} catch {
		return undefined;
	}
}

function listPersistedResultRecords(resultsDir: string, state: Pick<SubagentState, "currentSessionId" | "baseCwd">, limit: number): PersistedResultRecord[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(resultsDir).filter((entry) => entry.endsWith(".json"));
	} catch {
		return [];
	}
	return entries
		.map((entry) => {
			const resultPath = path.join(resultsDir, entry);
			const record = readPersistedResultRecord(resultPath);
			if (!record || !matchesPersistedScope(record, state)) return undefined;
			try {
				record.updatedAt = fs.statSync(resultPath).mtimeMs;
			} catch {
				record.updatedAt = undefined;
			}
			return record;
		})
		.filter((record): record is PersistedResultRecord => Boolean(record))
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
		.slice(0, limit);
}

function artifactPathFromResult(result: PersistedResultRecord | undefined): string | undefined {
	return result?.children.find((child) => child.artifactPath)?.artifactPath;
}

function sessionFileFromResult(result: PersistedResultRecord | undefined): string | undefined {
	return result?.sessionFile ?? result?.children.find((child) => child.sessionFile)?.sessionFile;
}

function sessionFileFromSoloStep(steps: OverlayStep[]): string | undefined {
	return steps.length === 1 ? steps[0]?.sessionFile : undefined;
}

function deriveRunModelThinking(steps: Array<{ model?: string; thinking?: string }>): { model?: string; thinking?: string } {
	const activeStep = steps.find((step) => step.model);
	return {
		model: activeStep?.model,
		thinking: activeStep?.thinking,
	};
}

function overlayRunFromPersistedStatus(run: AsyncRunSummary, result: PersistedResultRecord | undefined, now: number): OverlayRun {
	const agents = agentsLabel(run.steps.map((step) => step.agent));
	if (!agents.length) {
		const fallbackAgents = result?.children.map((child) => child.agent).filter((agent): agent is string => Boolean(agent))
			?? (result?.agent ? [result.agent] : []);
		agents.push(...fallbackAgents);
	}
	const elapsed = elapsedFromRange(run.startedAt, run.endedAt ?? run.lastUpdate, now);
	const mappedNestedChildren = (run.nestedChildren ?? []).map(mapNestedRun);
	const steps: OverlayStep[] = run.steps.map((step) => {
		const resultChild = result?.children[step.index];
		return {
			agent: step.agent,
			state: mapState(step.status),
			currentTool: step.currentTool,
			elapsed: elapsedFromMs(step.durationMs),
			startedAt: step.startedAt,
			model: step.model,
			thinking: step.thinking,
			tokens: step.tokens,
			sessionFile: step.sessionFile ?? resultChild?.sessionFile,
			logPath: logPathForStep(run.asyncDir, step.index),
			artifactPath: resultChild?.artifactPath,
			children: (step.children ?? []).map(mapNestedRun),
		};
	});
	const attachedIds = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = mappedNestedChildren.filter((child) => !attachedIds.has(child.id));
	if (unattached.length && steps.length) steps[steps.length - 1]!.children.push(...unattached);
	const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps);
	return {
		id: run.id,
		label: `${modeLabel(run.mode)}: ${agents.join(", ")}`,
		state: deriveRunState(mapState(run.state), steps, mappedNestedChildren),
		mode: run.mode,
		source: "async",
		agents,
		elapsed,
		startedAt: run.startedAt,
		updatedAt: run.lastUpdate ?? run.endedAt ?? run.startedAt,
		model: runModel,
		thinking: runThinking,
		tokens: run.totalTokens,
		sessionFile: run.sessionFile ?? sessionFileFromSoloStep(steps) ?? sessionFileFromResult(result),
		logPath: logPathForRun(run.asyncDir, formatAsyncRunOutputPath(run)),
		artifactPath: artifactPathFromResult(result),
		asyncDir: run.asyncDir,
		steps,
	};
}

function overlayRunFromPersistedResult(result: PersistedResultRecord): OverlayRun {
	const steps: OverlayStep[] = (result.children.length ? result.children : [{ agent: result.agent, state: result.state }]).map((child, index) => ({
		agent: child.agent ?? `step-${index + 1}`,
		state: child.state,
		sessionFile: child.sessionFile,
		artifactPath: child.artifactPath,
		model: child.model,
		thinking: child.thinking,
		children: [],
	}));
	const agents = agentsLabel(steps.map((step) => step.agent));
	const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps);
	return {
		id: result.id,
		label: `${modeLabel(result.mode)}: ${agents.join(", ")}`,
		state: result.state,
		mode: result.mode,
		source: "async",
		agents,
		updatedAt: result.updatedAt,
		model: runModel,
		thinking: runThinking,
		sessionFile: result.sessionFile ?? sessionFileFromResult(result),
		logPath: logPathForRun(result.asyncDir),
		artifactPath: artifactPathFromResult(result),
		asyncDir: result.asyncDir,
		steps,
	};
}

// ---------------------------------------------------------------------------
// Foreground run collection
// ---------------------------------------------------------------------------

function collectForegroundRuns(state: SubagentState, now: number): OverlayRun[] {
	const runs: OverlayRun[] = [];
	if (!state.foregroundControls?.size) return runs;

	for (const [id, ctrl] of state.foregroundControls) {
		updateForegroundNestedProjection(ctrl);
		const fgRuns = state.foregroundRuns?.get(id);
		const childInfo = fgRuns?.children ?? [];
		const agents = childInfo.map((c) => c.agent);
		if (!agents.length && ctrl.currentAgent) agents.push(ctrl.currentAgent);

		const elapsed = elapsedFromRange(ctrl.startedAt, ctrl.updatedAt, now);
		const rememberedState = childInfo.length > 0 ? resolveForegroundRunState(childInfo) : undefined;
		const finalizedNestedState = rememberedState === "complete" || rememberedState === "failed" || rememberedState === "paused" ? rememberedState : undefined;
		const finalizedNestedFreezeAt = finalizedNestedState ? fgRuns?.updatedAt ?? ctrl.updatedAt : undefined;

		const steps: OverlayStep[] = childInfo.map((child, index) => {
			const stepElapsed = elapsedFromRange(ctrl.startedAt, ctrl.updatedAt, now);
			const nestedChildren = ctrl.nestedChildren ?? [];
			const stepNested = nestedChildren.filter((nc) => nc.parentStepIndex === index);
			const stepState = mapState(child.status === "running" || child.status === "completed" || child.status === "failed" || child.status === "paused" ? child.status : "running");
			return {
				agent: child.agent,
				state: stepState,
				currentTool: stepState === "running" && ctrl.currentIndex === index ? ctrl.currentTool : undefined,
				elapsed: stepElapsed,
				startedAt: ctrl.startedAt,
				model: ctrl.currentIndex === index ? ctrl.currentModel ?? child.model : child.model,
				thinking: ctrl.currentIndex === index ? (ctrl.currentThinking ?? child.thinking) : child.thinking,
				tokens: ctrl.currentIndex === index ? approximateTokenUsage(ctrl.tokens) ?? child.totalTokens : child.totalTokens,
				sessionFile: child.sessionFile,
				artifactPath: child.artifactPath,
				children: stepNested.map((nested) => mapNestedRunWithStaleState(nested, finalizedNestedState, finalizedNestedFreezeAt)),
			};
		});

		if (steps.length === 0 && ctrl.currentAgent) {
			const currentIndex = ctrl.currentIndex ?? 0;
			const currentStepNested = (ctrl.nestedChildren ?? []).filter(
				(nc) => nc.parentStepIndex === undefined || nc.parentStepIndex === currentIndex,
			);
			steps.push({
				agent: ctrl.currentAgent,
				state: "running",
				currentTool: ctrl.currentTool,
				elapsed,
				startedAt: ctrl.startedAt,
				model: ctrl.currentModel,
				thinking: ctrl.currentThinking,
				tokens: approximateTokenUsage(ctrl.tokens),
				sessionFile: ctrl.sessionFile,
				children: currentStepNested.map(mapNestedRun),
			});
		}

		const nestedSessionFile = ctrl.nestedChildren?.find((nc) => nc.sessionFile)?.sessionFile;
		const nestedAsyncDir = ctrl.nestedChildren?.find((nc) => nc.asyncDir)?.asyncDir;
		const currentChild = ctrl.currentIndex !== undefined ? childInfo[ctrl.currentIndex] : undefined;
		const displayedSourceChild = ctrl.currentModel !== undefined ? currentChild : childInfo.find((child) => child.model);
		const runModel = ctrl.currentModel ?? displayedSourceChild?.model;
		const runThinking = ctrl.currentModel !== undefined ? (ctrl.currentThinking ?? displayedSourceChild?.thinking) : displayedSourceChild?.thinking;

		const runState = deriveRunState(rememberedState ?? "running", steps, (ctrl.nestedChildren ?? []).map((nested) => mapNestedRunWithStaleState(nested, finalizedNestedState, finalizedNestedFreezeAt)));

		runs.push({
			id,
			label: `${modeLabel(ctrl.mode)}: ${agents.join(", ")}`,
			state: runState,
			mode: ctrl.mode,
			source: "foreground",
			agents,
			elapsed,
			startedAt: ctrl.startedAt,
			updatedAt: ctrl.updatedAt,
			currentTool: runState === "running" ? ctrl.currentTool : undefined,
			model: runModel,
			thinking: runThinking,
			tokens: approximateTokenUsage(ctrl.tokens) ?? sumTokenUsage(childInfo.map((child) => child.totalTokens)),
			sessionFile: childInfo.find((child) => child.sessionFile)?.sessionFile ?? ctrl.sessionFile ?? nestedSessionFile,
			artifactPath: childInfo.find((child) => child.artifactPath)?.artifactPath,
			asyncDir: nestedAsyncDir,
			steps,
		});
	}
	return runs;
}

// ---------------------------------------------------------------------------
// Finished foreground run collection
// ---------------------------------------------------------------------------

function resolveForegroundRunState(children: { status: string }[]): OverlayRunState {
	const statuses = children.map((c) => c.status);
	if (statuses.some((s) => s === "failed")) return "failed";
	if (statuses.some((s) => s === "paused")) return "paused";
	if (statuses.some((s) => s === "pending")) return "queued";
	return "complete";
}

function collectFinishedForegroundRuns(state: SubagentState, now: number): OverlayRun[] {
	const runs: OverlayRun[] = [];
	if (!state.foregroundRuns?.size) return runs;

	const liveIds = new Set(state.foregroundControls?.keys() ?? []);

	for (const [id, run] of state.foregroundRuns) {
		if (liveIds.has(id)) continue;

		const agents = run.children.map((c) => c.agent);
		const elapsed = elapsedFromRange(run.startedAt, run.updatedAt, now);
		const runState = resolveForegroundRunState(run.children);

		const nestedChildren = (run.nestedChildren ?? []).map((nested) => mapNestedRunWithStaleState(nested, runState, run.updatedAt));
		const sourceChild = run.children.find((child) => child.model);
		const runModel = sourceChild?.model;
		const runThinking = sourceChild?.thinking;
		const steps: OverlayStep[] = run.children.map((child, index) => ({
			agent: child.agent,
			state: mapState(child.status),
			model: child.model,
			thinking: child.thinking,
			tokens: child.totalTokens,
			sessionFile: child.sessionFile,
			artifactPath: child.artifactPath,
			children: nestedChildren.filter((nested) => run.nestedChildren?.find((raw) => raw.id === nested.id)?.parentStepIndex === index),
		}));
		const attachedIds = new Set(steps.flatMap((step) => step.children.map((child) => child.id)));
		const unattached = nestedChildren.filter((child) => !attachedIds.has(child.id));
		if (unattached.length && steps.length) steps[steps.length - 1]!.children.push(...unattached);

		runs.push({
			id,
			label: `${modeLabel(run.mode)}: ${agents.join(", ")}`,
			state: deriveRunState(runState, steps, nestedChildren),
			mode: run.mode,
			source: "foreground",
			agents,
			elapsed,
			startedAt: run.startedAt,
			updatedAt: run.updatedAt,
			model: runModel,
			thinking: runThinking,
			tokens: sumTokenUsage(run.children.map((child) => child.totalTokens)),
			sessionFile: run.children.find((c) => c.sessionFile)?.sessionFile,
			artifactPath: run.children.find((c) => c.artifactPath)?.artifactPath,
			steps,
		});
	}
	return runs;
}

function staleForegroundState(state: OverlayRunState): OverlayRunState {
	return state === "running" || state === "queued" ? "paused" : state;
}

function overlayRunFromPersistedForeground(status: PersistedForegroundStatus, now: number): OverlayRun {
	const staleState = staleForegroundState(mapState(status.state));
	const children = status.children.length
		? status.children
		: status.currentAgent
			? [{ agent: status.currentAgent, index: status.currentIndex ?? 0, status: status.state, sessionFile: status.sessionFile }]
			: [];
	const nestedChildren = (status.nestedChildren ?? []).map((nested) => mapNestedRunWithStaleState(nested, staleState, status.updatedAt));
	const sourceChild = children.find((child) => child.model);
	const runModel = sourceChild?.model;
	const runThinking = sourceChild?.thinking;
	const steps: OverlayStep[] = children.map((child, index) => ({
		agent: child.agent,
		state: staleForegroundState(mapState(child.status)),
		model: child.model,
		thinking: child.thinking,
		tokens: child.totalTokens,
		sessionFile: child.sessionFile,
		artifactPath: child.artifactPath,
		children: nestedChildren.filter((nested) => status.nestedChildren?.find((raw) => raw.id === nested.id)?.parentStepIndex === index),
	}));
	const attachedIds = new Set(steps.flatMap((step) => step.children.map((child) => child.id)));
	const unattached = nestedChildren.filter((child) => !attachedIds.has(child.id));
	if (unattached.length && steps.length) steps[steps.length - 1]!.children.push(...unattached);
	const agents = agentsLabel(steps.map((step) => step.agent));
	const elapsed = elapsedFromRange(status.startedAt, status.updatedAt, now);
	return {
		id: status.runId,
		label: `${modeLabel(status.mode)}: ${agents.join(", ")}`,
		state: deriveRunState(staleState, steps, nestedChildren),
		mode: status.mode,
		source: "foreground",
		agents,
		elapsed,
		startedAt: status.startedAt,
		updatedAt: status.updatedAt,
		currentTool: staleState === "running" ? status.currentTool : undefined,
		model: runModel,
		thinking: runThinking,
		tokens: sumTokenUsage(children.map((child) => child.totalTokens)),
		sessionFile: status.sessionFile ?? children.find((child) => child.sessionFile)?.sessionFile,
		artifactPath: children.find((child) => child.artifactPath)?.artifactPath,
		steps,
	};
}

function collectPersistedForegroundRuns(state: SubagentState, now: number, options: CollectRunTreeOptions): OverlayRun[] {
	const foregroundDirRoot = options.foregroundDirRoot ?? FOREGROUND_DIR;
	const limit = options.persistedForegroundLimit ?? DEFAULT_PERSISTED_FOREGROUND_LIMIT;
	const liveIds = new Set(state.foregroundControls?.keys() ?? []);
	const rememberedIds = new Set(state.foregroundRuns?.keys() ?? []);
	try {
		return listPersistedForegroundRuns(foregroundDirRoot, {
			sessionId: state.currentSessionId ?? undefined,
			cwd: state.baseCwd,
			limit: limit + liveIds.size + rememberedIds.size,
		})
			.filter((run) => !liveIds.has(run.runId) && !rememberedIds.has(run.runId))
			.slice(0, limit)
			.map((run) => overlayRunFromPersistedForeground(run, now));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Async run collection
// ---------------------------------------------------------------------------

function collectAsyncRuns(state: SubagentState, now: number): OverlayRun[] {
	const runs: OverlayRun[] = [];
	if (!state.asyncJobs.size) return runs;

	for (const [, job] of state.asyncJobs) {
		const agents = agentsLabel(job.agents);
		const elapsed = elapsedFromRange(job.startedAt, job.updatedAt, now);

		const mappedNestedChildren = (job.nestedChildren ?? []).map(mapNestedRun);
		const steps: OverlayStep[] = (job.steps ?? []).map((step: AsyncJobStep) => {
			return {
				agent: step.agent,
				state: mapState(step.status),
				currentTool: step.currentTool,
				elapsed: elapsedFromMs(step.durationMs),
				startedAt: step.startedAt,
				model: step.model,
				thinking: step.thinking,
				tokens: step.tokens,
				sessionFile: step.sessionFile,
				logPath: logPathForStep(job.asyncDir, step.index),
				children: (step.children ?? []).map(mapNestedRun),
			};
		});

		const attachedIds = new Set(
			(job.steps ?? []).flatMap((s: AsyncJobStep) => (s.children ?? []).map((c) => c.id)),
		);
		const unattached = mappedNestedChildren.filter(
			(nc) => !attachedIds.has(nc.id),
		);
		if (unattached.length && steps.length) {
			const lastStep = steps[steps.length - 1]!;
			lastStep.children.push(...unattached);
		}

		const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps);
		runs.push({
			id: job.asyncId,
			label: `${modeLabel(job.mode)}: ${agents.join(", ")}`,
			state: deriveRunState(mapState(job.status ?? "running"), steps, mappedNestedChildren),
			mode: job.mode ?? "single",
			source: "async",
			agents,
			elapsed,
			startedAt: job.startedAt,
			updatedAt: job.updatedAt,
			model: runModel,
			thinking: runThinking,
			tokens: job.totalTokens,
			sessionFile: job.sessionFile ?? sessionFileFromSoloStep(steps),
			logPath: logPathForRun(job.asyncDir, job.outputFile),
			asyncDir: job.asyncDir,
			steps,
		});
	}
	return runs;
}

function collectPersistedAsyncRuns(state: SubagentState, now: number, options: CollectRunTreeOptions): OverlayRun[] {
	const asyncDirRoot = options.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const limit = options.persistedAsyncLimit ?? DEFAULT_PERSISTED_ASYNC_LIMIT;
	// Include non-terminal states so that runs interrupted by a parent Ctrl-C
	// (still "running" or "queued" on disk) are recovered on resume.
	const persistedStates: Array<AsyncRunSummary["state"]> = ["complete", "failed", "paused", "running", "queued"];
	const liveIds = new Set(state.asyncJobs.keys());
	const runs: OverlayRun[] = [];
	const seenIds = new Set<string>();
	let resultRecords: PersistedResultRecord[] = [];
	let persistedStatusRuns: AsyncRunSummary[] = [];

	try {
		resultRecords = listPersistedResultRecords(resultsDir, state, limit * 2);
		persistedStatusRuns = listAsyncRuns(asyncDirRoot, {
			states: persistedStates,
			sessionId: state.currentSessionId ?? undefined,
			cwd: state.baseCwd,
			limit: limit + liveIds.size,
			resultsDir,
			kill: options.kill,
		});
	} catch {
		return runs;
	}
	const resultById = new Map(resultRecords.map((record) => [record.id, record]));

	for (const run of persistedStatusRuns) {
		if (liveIds.has(run.id) || seenIds.has(run.id)) continue;
		runs.push(overlayRunFromPersistedStatus(run, resultById.get(run.id), now));
		seenIds.add(run.id);
		if (runs.length >= limit) return runs;
	}

	for (const result of resultRecords) {
		if (liveIds.has(result.id) || seenIds.has(result.id)) continue;
		runs.push(overlayRunFromPersistedResult(result));
		seenIds.add(result.id);
		if (runs.length >= limit) break;
	}

	return runs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all known runs from the current Pi session state, returning a flat
 * list of top-level runs with nested children represented in a tree.
 */
export function collectRunTree(state: SubagentState, now = Date.now(), options: CollectRunTreeOptions = {}): OverlayRun[] {
	const runs: OverlayRun[] = [
		...collectForegroundRuns(state, now),
		...collectFinishedForegroundRuns(state, now),
		...collectPersistedForegroundRuns(state, now, options),
		...collectAsyncRuns(state, now),
		...collectPersistedAsyncRuns(state, now, options),
	];
	runs.sort((a, b) => {
		const startDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
		if (startDiff !== 0) return startDiff;
		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
	return runs;
}
