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

/**
 * Async interrupt signal used to pause a detached subagent-runner.
 * Matches the constant in subagent-runner.ts / subagent-executor.ts.
 */
export const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

/** Check whether a nested run state is terminal (no longer active). */
export function isTerminalNestedState(state: string): boolean {
	return state === "complete" || state === "failed" || state === "paused";
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
		if (!isTerminalNestedState(child.state)) output.push(child);
	}
	return output;
}

/**
 * Mark a nested run as paused via the nested event store.
 */
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
}

/**
 * During session shutdown, interrupt all owned async runs and cascade to nested
 * descendants so that orphaned runs do not continue running indefinitely.
 */
export function shutdownOwnedAsyncJobs(state: SubagentState, deps: ShutdownCascadeDeps = {}): void {
	const kill = deps.kill ?? process.kill;
	const statusReader = deps.readStatus ?? readStatus;
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
				// Send nested control request so foreground descendants (managed via
				// control-request protocol, not PID signaling) are also interrupted.
				try {
					writeNestedControlRequest(job.nestedRoute, {
						ts: Date.now(),
						requestId: randomUUID(),
						targetRunId: run.id,
						action: "interrupt",
					});
				} catch {
					// Best-effort during shutdown.
				}
				// Also signal the async runner PID directly when available.
				const asyncDir = resolveNestedAsyncDir(job.nestedRoute.rootRunId, run);
				if (asyncDir) {
					try {
						const status = statusReader(asyncDir);
						const pid = status?.state === "running" || status?.state === "queued"
							? (typeof status.pid === "number" && status.pid > 0 ? status.pid : undefined)
							: undefined;
						if (typeof pid === "number") kill(pid, ASYNC_INTERRUPT_SIGNAL);
					} catch {
						// Best-effort during shutdown.
					}
				}
				try {
					markNestedRunPaused(job.nestedRoute, run, "Interrupted because parent session was shut down.");
				} catch {
					// Best-effort during shutdown.
				}
			}
		}
		// Interrupt the direct child runner process. Skip for terminal jobs —
		// their processes have already exited.
		if (!isTerminalNestedState(job.status) && typeof job.pid === "number" && job.pid > 0) {
			try {
				kill(job.pid, ASYNC_INTERRUPT_SIGNAL);
			} catch {
				// Best-effort: process may already be dead.
			}
		}
	}
}
