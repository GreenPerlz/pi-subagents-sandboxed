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
import { mergeNestedRunSnapshots, projectNestedEvents, resolveNestedRoute, updateForegroundNestedProjection } from "../runs/shared/nested-events.ts";
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
import type { FastModeStatus } from "../shared/fast-mode.ts";
import { resolveAggregateState } from "../shared/aggregate-state.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OverlayRunState = "running" | "complete" | "failed" | "paused" | "cancelled" | "queued";

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
	fastMode?: FastModeStatus;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	children: OverlayNestedChild[];
	steps?: OverlayStep[];
	teardownUnproven?: boolean;
}

export interface OverlayStep {
	agent: string;
	state: OverlayRunState;
	/** Set only for non-positional group diagnostics; never a child index. */
	groupId?: string;
	unindexed?: boolean;
	currentTool?: string;
	elapsed?: string;
	startedAt?: number;
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
	error?: string;
	success?: boolean;
	finalOutput?: string;
	interrupted?: boolean;
	cancelled?: boolean;
	gitBundle?: unknown;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	children: OverlayNestedChild[];
	teardownUnproven?: boolean;
}

/** A group-level failure/diagnostic has identity but deliberately no child index. */
export interface OverlayGroupDiagnostic {
	groupId: string;
	unindexed: true;
	agent: string;
	state: OverlayRunState;
	error?: string;
	finalOutput?: string;
	gitBundle?: unknown;
	teardownUnproven?: boolean;
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
	fastMode?: FastModeStatus;
	tokens?: TokenUsage;
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	steps: OverlayStep[];
	groupDiagnostics?: OverlayGroupDiagnostic[];
	nestedWarning?: string;
	teardownUnproven?: boolean;
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
	groupId?: string;
	index?: number;
	agent?: string;
	state: OverlayRunState;
	status?: string;
	error?: string;
	success?: boolean;
	finalOutput?: string;
	/** Legacy result files used output; canonical persisted field is finalOutput. */
	output?: string;
	interrupted?: boolean;
	cancelled?: boolean;
	gitBundle?: unknown;
	sessionFile?: string;
	artifactPath?: string;
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
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

function mapGroupDiagnostic(child: { groupId?: string; agent?: string; state?: string; status?: string; error?: string; finalOutput?: string; gitBundle?: unknown }): OverlayGroupDiagnostic | undefined {
	if (!child.groupId) return undefined;
	return {
		groupId: child.groupId,
		unindexed: true,
		agent: child.agent ?? child.groupId,
		state: mapState(child.state ?? child.status ?? "failed"),
		error: child.error,
		finalOutput: child.finalOutput,
		gitBundle: child.gitBundle,
	};
}

function mapState(state: string): OverlayRunState {
	if (state === "running" || state === "queued") return state as OverlayRunState;
	if (state === "complete" || state === "completed") return "complete";
	if (state === "paused") return "paused";
	if (state === "cancelled") return "cancelled";
	if (state === "failed") return "failed";
	if (state === "pending") return "queued";
	return "complete";
}

function hasExecutingOverlayChild(child: OverlayNestedChild): boolean {
	if (child.teardownUnproven !== true) {
		if (child.state === "running" || child.state === "queued") return true;
		if (child.steps?.some((step) => (step.state === "running" || step.state === "queued") && step.teardownUnproven !== true)) return true;
	}
	// The direct step repeats its teardown-marked owner's stale lifecycle state.
	// Only independently nested descendants can keep that owner active.
	if (child.steps?.some((step) => step.children.some(hasExecutingOverlayChild))) return true;
	return child.children.some(hasExecutingOverlayChild);
}

function hasTeardownOverlayChild(child: OverlayNestedChild): boolean {
	return child.teardownUnproven === true
		|| child.steps?.some((step) => step.teardownUnproven === true || step.children.some(hasTeardownOverlayChild)) === true
		|| child.children.some(hasTeardownOverlayChild);
}

function deriveRunState(topLevel: OverlayRunState, steps: OverlayStep[], nestedChildren: OverlayNestedChild[] = [], teardownUnproven = false): OverlayRunState {
	const descendants = [
		...steps.map((step) => ({ state: step.state, teardownUnproven: step.teardownUnproven })),
		...steps.flatMap((s) => s.children).map((child) => ({ state: child.state, teardownUnproven: child.teardownUnproven })),
		...nestedChildren.map((child) => ({ state: child.state, teardownUnproven: child.teardownUnproven })),
	];
	// Cleanup evidence controls retention, not process lifecycle. A durable
	// failed/incomplete projection must not return to the active bucket merely
	// because its recovery fence remains actionable. A separately running child
	// without a teardown marker is still live work and keeps the parent active.
	const hasLiveDescendant = steps.some((step) => ((step.state === "running" || step.state === "queued") && step.teardownUnproven !== true)
		|| step.children.some(hasExecutingOverlayChild))
		|| nestedChildren.some(hasExecutingOverlayChild);
	const hasRecoveryDescendant = teardownUnproven
		|| steps.some((step) => step.teardownUnproven === true || step.children.some(hasTeardownOverlayChild))
		|| nestedChildren.some(hasTeardownOverlayChild);
	if (hasRecoveryDescendant && !hasLiveDescendant && (topLevel === "failed" || topLevel === "complete" || topLevel === "paused" || topLevel === "cancelled")) return topLevel;
	const values = [{ state: topLevel, teardownUnproven }, ...descendants];
	const state = resolveAggregateState(values);
	if (state === "failed" || state === "cancelled" || state === "paused") return state;
	if (values.some((value) => value.state === "running")) return "running";
	if (values.some((value) => value.state === "queued" || value.state === "pending")) return "queued";
	return state === "completed" ? "complete" : state;
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
			fastMode: step.fastMode,
			tokens: step.totalTokens,
			sessionFile: step.sessionFile,
			children: mapNestedStepChildrenWithStaleState(step.children, fallbackState, freezeAt),
			...(step.teardownUnproven ? { teardownUnproven: true } : {}),
		};
	});
	const directChildren: OverlayNestedChild[] = (run.children ?? []).map((child) => mapNestedRunWithStaleState(child, fallbackState, freezeAt));
	const derivedState = deriveRunState(runMappedState, steps, directChildren, run.teardownUnproven === true);
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
		fastMode: run.fastMode,
		tokens: run.totalTokens,
		sessionFile: inferNestedSessionFile(run, steps, directChildren),
		asyncDir: run.asyncDir,
		children: directChildren,
		steps: steps.length ? steps : undefined,
		...(run.teardownUnproven ? { teardownUnproven: true } : {}),
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

function fastModeValue(value: unknown): FastModeStatus | undefined {
	const raw = objectValue(value);
	if (!raw || raw.requested !== true) return undefined;
	const eligible = raw.eligible === true || raw.eligible === false || raw.eligible === "unknown" ? raw.eligible : "unknown";
	const active = raw.active === true || raw.active === false || raw.active === "unknown" ? raw.active : "unknown";
	const model = stringValue(raw.model);
	return { requested: true, eligible, active, ...(model ? { model } : {}) };
}

function modeValue(value: unknown, childCount: number): SubagentRunMode {
	return value === "single" || value === "parallel" || value === "chain"
		? value
		: childCount > 1 ? "chain" : "single";
}

function resultStateValue(state: unknown, success: unknown): OverlayRunState {
	if (state === "queued" || state === "running" || state === "paused" || state === "cancelled" || state === "failed" || state === "complete" || state === "completed") {
		return mapState(state);
	}
	if (typeof success === "boolean") return success ? "complete" : "failed";
	return "complete";
}

function childResultStateValue(parentState: unknown, success: unknown, cancelled: unknown): OverlayRunState {
	// Child-local terminal truth wins over a cancelled aggregate parent; a
	// completed sibling must remain completed in a mixed group.
	if (cancelled === true) return "cancelled";
	if (typeof success === "boolean") return success ? "complete" : "failed";
	return resultStateValue(parentState, success);
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
			const childCancelled = child.cancelled === true || child.status === "cancelled";
			const childInterrupted = child.interrupted === true || child.status === "paused" || child.status === "interrupted";
			return {
				groupId: stringValue(child.groupId),
				index: typeof child.flatIndex === "number" ? child.flatIndex : typeof child.index === "number" ? child.index : undefined,
				agent: stringValue(child.agent),
				state: childInterrupted ? "paused" : childResultStateValue(raw.state, childSuccess, childCancelled),
				success: childSuccess,
				status: stringValue(child.status),
				error: stringValue(child.error),
				finalOutput: stringValue(child.finalOutput ?? child.output),
				interrupted: childInterrupted,
				cancelled: childCancelled,
				gitBundle: child.gitBundle,
				sessionFile: stringValue(child.sessionFile),
				artifactPath: stringValue(artifactPaths?.outputPath),
				model: stringValue(child.model),
				thinking: stringValue(child.thinking),
				fastMode: fastModeValue(child.fastMode),
			};
		});
		const id = stringValue(raw.runId) ?? stringValue(raw.id) ?? path.basename(resultPath, ".json");
		return {
			id,
			sessionId: stringValue(raw.sessionId),
			cwd: stringValue(raw.cwd),
			mode: modeValue(raw.mode, children.length),
			state: raw.cancelled === true ? "cancelled" : resultStateValue(raw.state, raw.success),
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

function deriveRunModelThinking(steps: Array<{ model?: string; thinking?: string }>, currentStep?: number): { model?: string; thinking?: string } {
	const active = currentStep !== undefined ? steps[currentStep] : undefined;
	const modelStep = active?.model ? active : steps.find((step) => step.model);
	return {
		model: modelStep?.model,
		thinking: modelStep?.thinking,
	};
}

function overlayRunFromPersistedStatus(run: AsyncRunSummary, result: PersistedResultRecord | undefined, now: number): OverlayRun {
	const groupDiagnosticsById = new Map<string, OverlayGroupDiagnostic>();
	for (const source of [...(result?.children ?? []), ...(run.groupDiagnostics ?? [])]) {
		const diagnostic = mapGroupDiagnostic(source);
		if (diagnostic) groupDiagnosticsById.set(diagnostic.groupId, diagnostic);
	}
	const groupDiagnostics = [...groupDiagnosticsById.values()];
	const agents = agentsLabel(run.steps.map((step) => step.agent));
	if (!agents.length) {
		const fallbackAgents = result?.children.map((child) => child.agent).filter((agent): agent is string => Boolean(agent))
			?? (result?.agent ? [result.agent] : []);
		agents.push(...fallbackAgents);
	}
	const elapsed = elapsedFromRange(run.startedAt, run.endedAt ?? run.lastUpdate, now);
	const persistedState = mapState(run.state);
	const terminalCleanupState = run.teardownUnproven === true
		&& (persistedState === "failed" || persistedState === "complete" || persistedState === "paused" || persistedState === "cancelled");
	const mapPersistedNested = terminalCleanupState
		? (child: NestedRunSummary) => mapNestedRunWithStaleState(child, "failed", run.endedAt ?? run.lastUpdate)
		: mapNestedRun;
	const mappedNestedChildren = (run.nestedChildren ?? []).map(mapPersistedNested);
	const steps: OverlayStep[] = run.steps.map((step) => {
		const resultChild = result?.children.find((child) => child.index === step.index)
			?? (result?.children.some((child) => child.index !== undefined) ? undefined : result?.children[step.index]);
		const stepState = terminalCleanupState ? staleNestedState(mapState(step.status), "failed") : mapState(step.status);
		return {
			agent: step.agent,
			state: stepState,
			groupId: step.groupId,
			currentTool: stepState === "running" ? step.currentTool : undefined,
			elapsed: elapsedFromMs(step.durationMs),
			startedAt: step.startedAt,
			model: step.model,
			thinking: step.thinking,
			fastMode: step.fastMode,
			tokens: step.tokens,
			error: step.error ?? resultChild?.error,
			success: step.success ?? resultChild?.success,
			finalOutput: step.finalOutput ?? resultChild?.finalOutput,
			interrupted: step.interrupted ?? resultChild?.interrupted,
			cancelled: step.cancelled ?? resultChild?.cancelled,
			gitBundle: step.gitBundle ?? resultChild?.gitBundle,
			sessionFile: step.sessionFile ?? resultChild?.sessionFile,
			logPath: logPathForStep(run.asyncDir, step.index),
			artifactPath: resultChild?.artifactPath,
			children: (step.children ?? []).map(mapPersistedNested),
			...(step.teardownUnproven ? { teardownUnproven: true } : {}),
		};
	});
	const attachedIds = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = mappedNestedChildren.filter((child) => !attachedIds.has(child.id));
	if (unattached.length && steps.length) steps[steps.length - 1]!.children.push(...unattached);
	const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps, run.currentStep);
	return {
		id: run.id,
		label: `${modeLabel(run.mode)}: ${agents.join(", ")}`,
		// Persisted terminal cleanup state is canonical lifecycle truth. Its nested
		// snapshots may predate teardown markers and are retained as recovery
		// evidence, but cannot prove that a process is currently executing.
		state: terminalCleanupState ? persistedState : deriveRunState(persistedState, steps, mappedNestedChildren, run.teardownUnproven === true),
		...(run.teardownUnproven ? { teardownUnproven: true } : {}),
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
		...(groupDiagnostics.length ? { groupDiagnostics } : {}),
	};
}

function overlayRunFromPersistedResult(result: PersistedResultRecord): OverlayRun {
	const groupDiagnostics = result.children.map(mapGroupDiagnostic).filter((diagnostic): diagnostic is OverlayGroupDiagnostic => Boolean(diagnostic));
	const indexedChildren = result.children.filter((child) => !child.groupId && !child.unindexed).slice().sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
	const steps: OverlayStep[] = (indexedChildren.length ? indexedChildren : [{ agent: result.agent, state: result.state }]).map((child, index) => ({
		agent: child.agent ?? `step-${index + 1}`,
		state: child.state,
		success: child.success,
		sessionFile: child.sessionFile,
		artifactPath: child.artifactPath,
		model: child.model,
		thinking: child.thinking,
		fastMode: child.fastMode,
		error: child.error,
		finalOutput: child.finalOutput,
		interrupted: child.interrupted,
		cancelled: child.cancelled,
		gitBundle: child.gitBundle,
		children: [],
	}));
	const agents = agentsLabel(steps.map((step) => step.agent));
	const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps);
	const runFastMode = result.mode === "single" ? steps[0]?.fastMode : undefined;
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
		fastMode: runFastMode,
		sessionFile: result.sessionFile ?? sessionFileFromResult(result),
		logPath: logPathForRun(result.asyncDir),
		artifactPath: artifactPathFromResult(result),
		asyncDir: result.asyncDir,
		steps,
		...(groupDiagnostics.length ? { groupDiagnostics } : {}),
	};
}

/** Narrow serial seam for persisted group-diagnostic projection tests. */
export function projectPersistedResultForTests(result: { id: string; mode: SubagentRunMode; state: OverlayRunState; children: Array<{ groupId?: string; unindexed?: boolean; index?: number; agent?: string; state: OverlayRunState; sessionFile?: string; artifactPath?: string; model?: string; thinking?: string; fastMode?: FastModeStatus }>; sessionFile?: string; asyncDir?: string; updatedAt?: number; agent?: string }): OverlayRun {
	return overlayRunFromPersistedResult(result);
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
		const groupDiagnostics = childInfo.map((child) => mapGroupDiagnostic(child as { groupId?: string; agent?: string; status?: string; error?: string; finalOutput?: string })).filter((diagnostic): diagnostic is OverlayGroupDiagnostic => Boolean(diagnostic));
		const indexedChildInfo = childInfo.filter((child) => !("groupId" in child && child.groupId) && !("unindexed" in child && child.unindexed)).slice().sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
		const agents = indexedChildInfo.map((c) => c.agent);
		if (!agents.length && ctrl.currentAgent) agents.push(ctrl.currentAgent);

		const elapsed = elapsedFromRange(ctrl.startedAt, ctrl.updatedAt, now);
		const rememberedState = childInfo.length > 0 ? resolveForegroundRunState(childInfo) : undefined;
		const finalizedNestedState = rememberedState === "complete" || rememberedState === "failed" || rememberedState === "paused" || rememberedState === "cancelled" ? rememberedState : undefined;
		const finalizedNestedFreezeAt = finalizedNestedState ? fgRuns?.updatedAt ?? ctrl.updatedAt : undefined;

		const steps: OverlayStep[] = indexedChildInfo.map((child, index) => {
			const stepElapsed = elapsedFromRange(ctrl.startedAt, ctrl.updatedAt, now);
			const nestedChildren = ctrl.nestedChildren ?? [];
			const stepNested = nestedChildren.filter((nc) => nc.parentStepIndex === index);
			const stepState = mapState(child.status === "running" || child.status === "completed" || child.status === "failed" || child.status === "paused" || child.status === "cancelled" ? child.status : "running");
			return {
				agent: child.agent,
				state: stepState,
				currentTool: stepState === "running" && ctrl.currentIndex === index ? ctrl.currentTool : undefined,
				elapsed: stepElapsed,
				startedAt: ctrl.startedAt,
				model: ctrl.currentIndex === index ? ctrl.currentModel ?? child.model : child.model,
				thinking: ctrl.currentIndex === index ? (ctrl.currentThinking ?? child.thinking) : child.thinking,
				fastMode: ctrl.currentIndex === index ? (ctrl.currentFastMode ?? child.fastMode) : child.fastMode,
				tokens: ctrl.currentIndex === index ? approximateTokenUsage(ctrl.tokens) ?? child.totalTokens : child.totalTokens,
				error: child.error,
				finalOutput: child.finalOutput,
				interrupted: child.interrupted,
				cancelled: child.cancelled,
				gitBundle: child.gitBundle,
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
				fastMode: ctrl.currentFastMode,
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
		const runFastMode = ctrl.mode === "single" && steps.length === 1 ? (steps[0]?.fastMode ?? ctrl.currentFastMode) : undefined;

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
			fastMode: runFastMode,
			tokens: approximateTokenUsage(ctrl.tokens) ?? sumTokenUsage(childInfo.map((child) => child.totalTokens)),
			sessionFile: childInfo.find((child) => child.sessionFile)?.sessionFile ?? ctrl.sessionFile ?? nestedSessionFile,
			artifactPath: childInfo.find((child) => child.artifactPath)?.artifactPath,
			asyncDir: nestedAsyncDir,
			steps,
			...(groupDiagnostics.length ? { groupDiagnostics } : {}),
		});
	}
	return runs;
}

// ---------------------------------------------------------------------------
// Finished foreground run collection
// ---------------------------------------------------------------------------

function resolveForegroundRunState(children: { status: string; teardownUnproven?: boolean }[]): OverlayRunState {
	// Foreground display lifecycle ignores recovery-retention metadata. The
	// teardown marker remains on the child for diagnostics and cleanup fencing.
	const state = resolveAggregateState(children.map((child) => ({ state: child.status })));
	if (state === "running") return "running";
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	if (state === "paused") return "paused";
	if (state === "pending") return "queued";
	return "complete";
}

function collectFinishedForegroundRuns(state: SubagentState, now: number): OverlayRun[] {
	const runs: OverlayRun[] = [];
	if (!state.foregroundRuns?.size) return runs;

	const liveIds = new Set(state.foregroundControls?.keys() ?? []);

	for (const [id, run] of state.foregroundRuns) {
		if (liveIds.has(id)) continue;

		const groupDiagnostics = run.children.map((child) => mapGroupDiagnostic(child as { groupId?: string; agent?: string; status?: string; error?: string; finalOutput?: string })).filter((diagnostic): diagnostic is OverlayGroupDiagnostic => Boolean(diagnostic));
		const indexedChildren = run.children.filter((child) => !("groupId" in child && child.groupId) && !("unindexed" in child && child.unindexed)).slice().sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
		const agents = indexedChildren.map((c) => c.agent);
		const elapsed = elapsedFromRange(run.startedAt, run.updatedAt, now);
		const runState = resolveForegroundRunState(run.children);

		const nestedChildren = (run.nestedChildren ?? []).map((nested) => mapNestedRunWithStaleState(nested, runState, run.updatedAt));
		const sourceChild = indexedChildren.find((child) => child.model);
		const runModel = sourceChild?.model;
		const runThinking = sourceChild?.thinking;
		const runFastMode = run.mode === "single" && indexedChildren.length === 1 ? indexedChildren[0]?.fastMode : undefined;
		const steps: OverlayStep[] = indexedChildren.map((child, index) => ({
			agent: child.agent,
			state: mapState(child.status),
			model: child.model,
			thinking: child.thinking,
			fastMode: child.fastMode,
			tokens: child.totalTokens,
			error: child.error,
			finalOutput: child.finalOutput,
			interrupted: child.interrupted,
			cancelled: child.cancelled,
			gitBundle: child.gitBundle,
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
			fastMode: runFastMode,
			tokens: sumTokenUsage(indexedChildren.map((child) => child.totalTokens)),
			sessionFile: indexedChildren.find((c) => c.sessionFile)?.sessionFile,
			artifactPath: indexedChildren.find((c) => c.artifactPath)?.artifactPath,
			steps,
			...(groupDiagnostics.length ? { groupDiagnostics } : {}),
		});
	}
	return runs;
}

function staleForegroundState(state: OverlayRunState): OverlayRunState {
	return state === "running" || state === "queued" ? "paused" : state;
}

function overlayRunFromPersistedForeground(status: PersistedForegroundStatus, now: number): OverlayRun {
	const staleState = staleForegroundState(mapState(status.state));
	const children: PersistedForegroundStatus["children"] = status.children.length
		? status.children
		: status.currentAgent
			? [{ agent: status.currentAgent, index: status.currentIndex ?? 0, status: status.state, sessionFile: status.sessionFile }]
			: [];
	const groupDiagnostics = children.map((child) => mapGroupDiagnostic(child as { groupId?: string; agent?: string; status?: string; error?: string; finalOutput?: string })).filter((diagnostic): diagnostic is OverlayGroupDiagnostic => Boolean(diagnostic));
	const indexedChildren = children.filter((child) => !("groupId" in child && child.groupId) && !("unindexed" in child && child.unindexed)).slice().sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
	let persistedNestedChildren = status.nestedChildren ?? [];
	let nestedWarning: string | undefined;
	const resolution = resolveNestedRoute(status.runId, status.nestedRoute);
	if (resolution.error) nestedWarning = resolution.error;
	try {
		if (resolution.route) persistedNestedChildren = mergeNestedRunSnapshots(persistedNestedChildren, projectNestedEvents(resolution.route).children);
	} catch (error) {
		nestedWarning = error instanceof Error ? error.message : String(error);
	}
	const nestedChildren = persistedNestedChildren.map((nested) => mapNestedRunWithStaleState(nested, staleState, status.updatedAt));
	const sourceChild = indexedChildren.find((child) => child.model);
	const runModel = sourceChild?.model;
	const runThinking = sourceChild?.thinking;
	const runFastMode = status.mode === "single" && indexedChildren.length === 1 ? indexedChildren[0]?.fastMode : undefined;
	const steps: OverlayStep[] = indexedChildren.map((child, index) => ({
		agent: child.agent,
		state: staleForegroundState(mapState(child.status)),
		groupId: child.groupId,
		model: child.model,
		thinking: child.thinking,
		fastMode: child.fastMode,
		tokens: child.totalTokens,
		error: child.error,
		finalOutput: child.finalOutput,
		interrupted: child.interrupted,
		cancelled: child.cancelled,
		gitBundle: child.gitBundle,
		sessionFile: child.sessionFile,
		artifactPath: child.artifactPath,
		children: nestedChildren.filter((nested) => persistedNestedChildren.find((raw) => raw.id === nested.id)?.parentStepIndex === index),
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
		fastMode: runFastMode,
		tokens: sumTokenUsage(indexedChildren.map((child) => child.totalTokens)),
		sessionFile: status.sessionFile ?? indexedChildren.find((child) => child.sessionFile)?.sessionFile,
		artifactPath: indexedChildren.find((child) => child.artifactPath)?.artifactPath,
		steps,
		...(groupDiagnostics.length ? { groupDiagnostics } : {}),
		...(nestedWarning ? { nestedWarning } : {}),
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
				fastMode: step.fastMode,
				tokens: step.tokens,
				error: step.error,
				success: step.success,
				finalOutput: step.finalOutput,
				interrupted: step.interrupted,
				cancelled: step.cancelled,
				gitBundle: step.gitBundle,
				sessionFile: step.sessionFile,
				logPath: logPathForStep(job.asyncDir, step.index),
				children: (step.children ?? []).map(mapNestedRun),
				...(step.teardownUnproven ? { teardownUnproven: true } : {}),
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

		const { model: runModel, thinking: runThinking } = deriveRunModelThinking(steps, job.currentStep);
		runs.push({
			id: job.asyncId,
			label: `${modeLabel(job.mode)}: ${agents.join(", ")}`,
			state: deriveRunState(mapState(job.status ?? "running"), steps, mappedNestedChildren, job.teardownUnproven === true),
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
			...(job.groupDiagnostics?.length ? { groupDiagnostics: job.groupDiagnostics.map(mapGroupDiagnostic).filter((diagnostic): diagnostic is OverlayGroupDiagnostic => Boolean(diagnostic)) } : {}),
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
	const persistedStates: Array<AsyncRunSummary["state"]> = ["complete", "failed", "paused", "cancelled", "running", "queued"];
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
		if (seenIds.has(run.id)) continue;
		const live = state.asyncJobs.get(run.id);
		// A detached in-memory record can lag the durable status file. Prefer
		// the fresher persisted projection so newly observed children are not
		// hidden by an old process-local snapshot.
		if (liveIds.has(run.id) && (run.lastUpdate ?? run.endedAt ?? run.startedAt) <= (live?.updatedAt ?? live?.startedAt ?? 0)) continue;
		runs.push(overlayRunFromPersistedStatus(run, resultById.get(run.id), now));
		seenIds.add(run.id);
		if (runs.length >= limit) return runs;
	}

	for (const result of resultRecords) {
		if (seenIds.has(result.id)) continue;
		const live = state.asyncJobs.get(result.id);
		if (liveIds.has(result.id) && (result.updatedAt ?? 0) <= (live?.updatedAt ?? live?.startedAt ?? 0)) continue;
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
	const persistedAsyncRuns = collectPersistedAsyncRuns(state, now, options);
	const persistedAsyncIds = new Set(persistedAsyncRuns.map((run) => run.id));
	const runs: OverlayRun[] = [
		...collectForegroundRuns(state, now),
		...collectFinishedForegroundRuns(state, now),
		...collectPersistedForegroundRuns(state, now, options),
		...collectAsyncRuns(state, now).filter((run) => !persistedAsyncIds.has(run.id)),
		...persistedAsyncRuns,
	];
	runs.sort((a, b) => {
		const startDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
		if (startDiff !== 0) return startDiff;
		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
	return runs;
}
