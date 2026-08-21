/**
 * Cascade interrupt to all owned async runs when the parent session shuts down.
 *
 * This module is separated from extension/index.ts for testability. It owns the
 * logic that, on session_shutdown, iterates over tracked async jobs and interrupts
 * their runner PIDs (plus any nested descendants) so orphaned runs do not continue
 * after the parent Pi session exits.
 */

import { randomUUID } from "node:crypto";
import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import type { NestedRunSummary } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { projectNestedEvents, resolveNestedAsyncDir, writeNestedControlRequest, writeNestedEvent } from "../shared/nested-events.ts";
import type { NestedRouteInfo } from "../../shared/types.ts";
import { isExpectedAsyncRunnerPid } from "./pid-identity.ts";

/**
 * Async interrupt signal used to pause a detached subagent-runner.
 * Matches the constant in subagent-runner.ts / subagent-executor.ts.
 */
export const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

/** Check whether a nested run state is terminal (no longer active). */
export function isTerminalNestedState(state: string, teardownUnproven = false): boolean {
	return !teardownUnproven && (state === "complete" || state === "failed" || state === "paused" || state === "cancelled");
}

/**
 * Collect live (non-terminal) nested runs recursively.
 */
export function collectLiveNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = [], visited = new Set<string>()): NestedRunSummary[] {
	for (const child of children ?? []) {
		if (visited.has(child.id)) continue;
		visited.add(child.id);
		collectLiveNestedRuns(child.children, output, visited);
		collectLiveNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output, visited);
		if (!isTerminalNestedState(child.state, child.teardownUnproven)) output.push(child);
	}
	return output;
}

/**
 * Mark a nested run as paused via the nested event store.
 */
function nestedRunTerminalAcknowledged(route: NestedRouteInfo, runId: string): boolean {
	try {
		const walk = (children: NestedRunSummary[] | undefined): NestedRunSummary | undefined => {
			for (const child of children ?? []) {
				if (child.id === runId) return child;
				const nested = walk(child.children) ?? walk(child.steps?.flatMap((step) => step.children ?? []));
				if (nested) return nested;
			}
			return undefined;
		};
		const acknowledged = walk(projectNestedEvents(route).children);
		return Boolean(acknowledged && isTerminalNestedState(acknowledged.state, acknowledged.teardownUnproven));
	} catch {
		return false;
	}
}

export function markNestedRunPaused(route: NestedRouteInfo, run: NestedRunSummary, message: string): void {
	writeNestedEvent(route, {
		type: "subagent.nested.completed",
		ts: Date.now(),
		parentRunId: run.parentRunId,
		parentStepIndex: run.parentStepIndex,
		child: {
			...run,
			state: "paused",
			activityState: undefined,
			endedAt: Date.now(),
			lastUpdate: Date.now(),
			error: run.error ?? message,
		},
	});
}

export interface ShutdownCascadeDeps {
	kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
	readStatus?: (asyncDir: string) => ReturnType<typeof readStatus>;
	now?: () => number;
	/** Internal test seam; production defaults to exact /proc runner identity verification. */
	isExpectedAsyncRunnerPid?: typeof isExpectedAsyncRunnerPid;
}

/**
 * During session shutdown, interrupt all owned async runs and cascade to nested
 * descendants so that orphaned runs do not continue running indefinitely.
 */
export function shutdownOwnedAsyncJobs(state: SubagentState, deps: ShutdownCascadeDeps = {}): void {
	const kill = deps.kill ?? process.kill;
	const statusReader = deps.readStatus ?? readStatus;
	const verifyRunnerPid = deps.isExpectedAsyncRunnerPid ?? isExpectedAsyncRunnerPid;
	for (const job of state.asyncJobs.values()) {
		// Cascade to nested descendants first (best-effort). This must happen even
		// when the direct parent job is terminal, because terminal async jobs may
		// intentionally remain in state.asyncJobs while they still own live nested
		// descendants that need to be interrupted on session shutdown.
		if (job.nestedRoute) {
			let children: NestedRunSummary[] | undefined;
			try {
				children = projectNestedEvents(job.nestedRoute).children;
			} catch {
				// Best-effort: use cached children from the job.
				children = job.nestedChildren;
			}
			for (const run of collectLiveNestedRuns(children)) {
				// A nested run is paused only after the shutdown request has a proven
				// delivery path. Marking it first would let the terminal fence pass
				// despite a refused PID identity/signal or failed control write.
				let teardownProven = false;
				let controlRequestWritten = false;
				try {
					writeNestedControlRequest(job.nestedRoute, {
						ts: Date.now(),
						requestId: randomUUID(),
						targetRunId: run.id,
						action: "interrupt",
					});
					controlRequestWritten = true;
				} catch {
					// Refused control writes remain running/actionable.
				}
				const asyncDir = resolveNestedAsyncDir(job.nestedRoute.rootRunId, run);
			if (asyncDir) {
				try {
					const status = statusReader(asyncDir);
					const pid = status?.state === "running" || status?.state === "queued"
						? (typeof status.pid === "number" && Number.isFinite(status.pid) && Number.isInteger(status.pid) && status.pid > 0 ? status.pid : undefined)
						: undefined;
					if (typeof pid === "number" && verifyRunnerPid(pid, run.id, status?.runnerIdentity)) teardownProven = kill(pid, ASYNC_INTERRUPT_SIGNAL) !== false;
				} catch {
					teardownProven = false;
				}
			} else {
				// Foreground descendants have no runner PID; the durable control
				// request is their exact teardown mechanism.
				teardownProven = controlRequestWritten;
			}
			// A terminal event is an acknowledgement of the descendant's actual
			// observed outcome. Never rewrite that truth as paused merely because the
			// parent shutdown requested an interrupt.
			if (teardownProven && !nestedRunTerminalAcknowledged(job.nestedRoute, run.id)) {
				// Delivery alone is not a terminal acknowledgement; leave the live
				// projection in place so the descendant fence cannot pass falsely.
				// The descendant will publish its own completed/failed/paused state.
			}
			}
		}
		// Interrupt the direct child runner process. Skip for terminal jobs —
		// their processes have already exited.
		let directRunnerIdentity: string | undefined;
		try { directRunnerIdentity = statusReader(job.asyncDir)?.runnerIdentity; } catch { /* fail closed below */ }
		if (!isTerminalNestedState(job.status, job.teardownUnproven) && typeof job.pid === "number" && verifyRunnerPid(job.pid, job.asyncId, directRunnerIdentity)) {
			try {
				kill(job.pid, ASYNC_INTERRUPT_SIGNAL);
			} catch {
				// Best-effort: process may already be dead.
			}
		}
	}
}
