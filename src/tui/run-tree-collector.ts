/**
 * Run tree collection and flattening for the /subagents overlay.
 *
 * Collects live run data from foreground controls and async background jobs,
 * building a nested tree where nested subagent runs appear as children under
 * the parent step that launched them.
 */

import { updateForegroundNestedProjection } from "../runs/shared/nested-events.ts";
import type {
	AsyncJobState,
	AsyncJobStep,
	NestedRunSummary,
	NestedStepSummary,
	SubagentRunMode,
	SubagentState,
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
	artifactPath?: string;
	children: OverlayNestedChild[];
}

export interface OverlayStep {
	agent: string;
	state: OverlayRunState;
	currentTool?: string;
	elapsed?: string;
	sessionFile?: string;
	artifactPath?: string;
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
	sessionFile?: string;
	artifactPath?: string;
	steps: OverlayStep[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	const steps: OverlayNestedChild[] = (run.steps ?? []).flatMap((step: NestedStepSummary) => {
		const stepChild: OverlayNestedChild = {
			id: `${run.id}:step:${step.agent}`,
			agent: step.agent,
			state: mapState(step.status),
			currentTool: step.currentTool,
			elapsed: elapsedFromRange(step.startedAt, step.endedAt),
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
		artifactPath: run.asyncDir,
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
			// Find nested children belonging to this step index
			const stepNested = nestedChildren.filter(
				(nc) => nc.parentStepIndex === index,
			);
			return {
				agent: child.agent,
				state: mapState(child.status === "running" || child.status === "completed" || child.status === "failed" || child.status === "paused" ? child.status : "running"),
				currentTool: ctrl.currentIndex === index ? ctrl.currentTool : undefined,
				elapsed: stepElapsed,
				sessionFile: child.sessionFile,
				children: stepNested.map(mapNestedRun),
			};
		});

		// If no explicit children, synthesize one step from control data
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
				children: currentStepNested.map(mapNestedRun),
			});
		}

		runs.push({
			id,
			label: `${modeLabel(ctrl.mode)}: ${agents.join(", ")}`,
			state: "running",
			mode: ctrl.mode,
			source: "foreground",
			agents,
			elapsed,
			sessionFile: childInfo.find((child) => child.sessionFile)?.sessionFile,
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
				children: (step.children ?? []).map(mapNestedRun),
			};
		});

		// Attach unattached nested children
		const attachedIds = new Set(
			(job.steps ?? []).flatMap((s: AsyncJobStep) => (s.children ?? []).map((c) => c.id)),
		);
		const unattached = (job.nestedChildren ?? []).filter(
			(nc) => !attachedIds.has(nc.id),
		);
		if (unattached.length && steps.length) {
			// Append to a synthetic step or last step
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
			sessionFile: job.sessionFile,
			artifactPath: job.outputFile ?? job.asyncDir,
			steps,
		});
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
export function collectRunTree(state: SubagentState, now = Date.now()): OverlayRun[] {
	const runs: OverlayRun[] = [
		...collectForegroundRuns(state, now),
		...collectAsyncRuns(state, now),
	];
	// Sort: running first, then by most recent start time
	const rank = (r: OverlayRun): number => {
		if (r.state === "running") return 0;
		if (r.state === "queued") return 1;
		if (r.state === "failed") return 2;
		if (r.state === "paused") return 2;
		return 3;
	};
	runs.sort((a, b) => rank(a) - rank(b));
	return runs;
}
