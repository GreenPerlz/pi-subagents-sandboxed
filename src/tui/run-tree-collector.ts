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
import { updateForegroundNestedProjection } from "../runs/shared/nested-events.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	type AsyncJobState,
	type AsyncJobStep,
	type NestedRunSummary,
	type NestedStepSummary,
	type SubagentRunMode,
	type SubagentState,
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
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	children: OverlayNestedChild[];
}

export interface OverlayStep {
	agent: string;
	state: OverlayRunState;
	currentTool?: string;
	elapsed?: string;
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
	sessionFile?: string;
	logPath?: string;
	artifactPath?: string;
	asyncDir?: string;
	steps: OverlayStep[];
}

export interface CollectRunTreeOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	persistedAsyncLimit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PERSISTED_ASYNC_LIMIT = 25;

interface PersistedResultChild {
	agent?: string;
	state: OverlayRunState;
	sessionFile?: string;
	artifactPath?: string;
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
	return "complete";
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

function mapNestedStepChildren(children: NestedRunSummary[] | undefined): OverlayNestedChild[] {
	if (!children?.length) return [];
	return children.map(mapNestedRun);
}

function mapNestedRun(run: NestedRunSummary): OverlayNestedChild {
	const steps: OverlayNestedChild[] = (run.steps ?? []).flatMap((step: NestedStepSummary, index) => {
		const stepChild: OverlayNestedChild = {
			id: `${run.id}:step:${step.agent}:${index}`,
			agent: step.agent,
			state: mapState(step.status),
			currentTool: step.currentTool,
			elapsed: elapsedFromRange(step.startedAt, step.endedAt),
			sessionFile: step.sessionFile,
			children: mapNestedStepChildren(step.children),
		};
		return stepChild;
	});
	const directChildren: OverlayNestedChild[] = (run.children ?? []).map(mapNestedRun);
	return {
		id: run.id,
		agent: run.agent ?? run.agents?.join(", ") ?? run.id,
		state: mapState(run.state),
		mode: run.mode,
		currentTool: run.currentTool,
		elapsed: elapsedFromRange(run.startedAt, run.endedAt),
		sessionFile: run.sessionFile,
		asyncDir: run.asyncDir,
		children: [...steps, ...directChildren],
	};
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

function overlayRunFromPersistedStatus(run: AsyncRunSummary, result: PersistedResultRecord | undefined, now: number): OverlayRun {
	const agents = agentsLabel(run.steps.map((step) => step.agent));
	if (!agents.length) {
		const fallbackAgents = result?.children.map((child) => child.agent).filter((agent): agent is string => Boolean(agent))
			?? (result?.agent ? [result.agent] : []);
		agents.push(...fallbackAgents);
	}
	const elapsed = elapsedFromRange(run.startedAt, run.endedAt ?? run.lastUpdate, now);
	const steps: OverlayStep[] = run.steps.map((step) => {
		const resultChild = result?.children[step.index];
		return {
			agent: step.agent,
			state: mapState(step.status),
			currentTool: step.currentTool,
			elapsed: elapsedFromMs(step.durationMs),
			sessionFile: step.sessionFile ?? resultChild?.sessionFile,
			logPath: logPathForStep(run.asyncDir, step.index),
			artifactPath: resultChild?.artifactPath,
			children: (step.children ?? []).map(mapNestedRun),
		};
	});
	const attachedIds = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = (run.nestedChildren ?? []).filter((child) => !attachedIds.has(child.id));
	if (unattached.length && steps.length) steps[steps.length - 1]!.children.push(...unattached.map(mapNestedRun));
	return {
		id: run.id,
		label: `${modeLabel(run.mode)}: ${agents.join(", ")}`,
		state: mapState(run.state),
		mode: run.mode,
		source: "async",
		agents,
		elapsed,
		startedAt: run.startedAt,
		updatedAt: run.lastUpdate ?? run.endedAt ?? run.startedAt,
		sessionFile: run.sessionFile ?? sessionFileFromResult(result),
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
		children: [],
	}));
	const agents = agentsLabel(steps.map((step) => step.agent));
	return {
		id: result.id,
		label: `${modeLabel(result.mode)}: ${agents.join(", ")}`,
		state: result.state,
		mode: result.mode,
		source: "async",
		agents,
		updatedAt: result.updatedAt,
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

		const steps: OverlayStep[] = childInfo.map((child, index) => {
			const stepElapsed = elapsedFromRange(ctrl.startedAt, ctrl.updatedAt, now);
			const nestedChildren = ctrl.nestedChildren ?? [];
			const stepNested = nestedChildren.filter((nc) => nc.parentStepIndex === index);
			return {
				agent: child.agent,
				state: mapState(child.status === "running" || child.status === "completed" || child.status === "failed" || child.status === "paused" ? child.status : "running"),
				currentTool: ctrl.currentIndex === index ? ctrl.currentTool : undefined,
				elapsed: stepElapsed,
				sessionFile: child.sessionFile,
				artifactPath: child.artifactPath,
				children: stepNested.map(mapNestedRun),
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
				sessionFile: ctrl.sessionFile,
				children: currentStepNested.map(mapNestedRun),
			});
		}

		const nestedSessionFile = ctrl.nestedChildren?.find((nc) => nc.sessionFile)?.sessionFile;
		const nestedAsyncDir = ctrl.nestedChildren?.find((nc) => nc.asyncDir)?.asyncDir;

		runs.push({
			id,
			label: `${modeLabel(ctrl.mode)}: ${agents.join(", ")}`,
			state: "running",
			mode: ctrl.mode,
			source: "foreground",
			agents,
			elapsed,
			startedAt: ctrl.startedAt,
			updatedAt: ctrl.updatedAt,
			currentTool: ctrl.currentTool,
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

		const steps: OverlayStep[] = run.children.map((child) => ({
			agent: child.agent,
			state: mapState(child.status),
			sessionFile: child.sessionFile,
			artifactPath: child.artifactPath,
			children: [],
		}));

		runs.push({
			id,
			label: `${modeLabel(run.mode)}: ${agents.join(", ")}`,
			state: resolveForegroundRunState(run.children),
			mode: run.mode,
			source: "foreground",
			agents,
			elapsed,
			startedAt: run.startedAt,
			updatedAt: run.updatedAt,
			sessionFile: run.children.find((c) => c.sessionFile)?.sessionFile,
			artifactPath: run.children.find((c) => c.artifactPath)?.artifactPath,
			steps,
		});
	}
	return runs;
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

		const steps: OverlayStep[] = (job.steps ?? []).map((step: AsyncJobStep) => {
			return {
				agent: step.agent,
				state: mapState(step.status),
				currentTool: step.currentTool,
				elapsed: elapsedFromMs(step.durationMs),
				sessionFile: step.sessionFile,
				logPath: logPathForStep(job.asyncDir, step.index),
				children: (step.children ?? []).map(mapNestedRun),
			};
		});

		const attachedIds = new Set(
			(job.steps ?? []).flatMap((s: AsyncJobStep) => (s.children ?? []).map((c) => c.id)),
		);
		const unattached = (job.nestedChildren ?? []).filter(
			(nc) => !attachedIds.has(nc.id),
		);
		if (unattached.length && steps.length) {
			const lastStep = steps[steps.length - 1]!;
			lastStep.children.push(...unattached.map(mapNestedRun));
		}

		runs.push({
			id: job.asyncId,
			label: `${modeLabel(job.mode)}: ${agents.join(", ")}`,
			state: mapState(job.status ?? "running"),
			mode: job.mode ?? "single",
			source: "async",
			agents,
			elapsed,
			startedAt: job.startedAt,
			updatedAt: job.updatedAt,
			sessionFile: job.sessionFile,
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
	const terminalStates: Array<AsyncRunSummary["state"]> = ["complete", "failed", "paused"];
	const liveIds = new Set(state.asyncJobs.keys());
	const runs: OverlayRun[] = [];
	const seenIds = new Set<string>();
	let resultRecords: PersistedResultRecord[] = [];
	let persistedStatusRuns: AsyncRunSummary[] = [];

	try {
		resultRecords = listPersistedResultRecords(resultsDir, state, limit * 2);
		persistedStatusRuns = listAsyncRuns(asyncDirRoot, {
			states: terminalStates,
			sessionId: state.currentSessionId ?? undefined,
			cwd: state.baseCwd,
			limit: limit + liveIds.size,
			resultsDir,
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
		...collectAsyncRuns(state, now),
		...collectPersistedAsyncRuns(state, now, options),
	];
	const rank = (r: OverlayRun): number => {
		if (r.state === "running") return 0;
		if (r.state === "queued") return 1;
		if (r.state === "failed") return 2;
		if (r.state === "paused") return 2;
		return 3;
	};
	runs.sort((a, b) => {
		const rankDiff = rank(a) - rank(b);
		if (rankDiff !== 0) return rankDiff;
		const aTs = a.updatedAt ?? a.startedAt ?? 0;
		const bTs = b.updatedAt ?? b.startedAt ?? 0;
		return bTs - aTs;
	});
	return runs;
}
