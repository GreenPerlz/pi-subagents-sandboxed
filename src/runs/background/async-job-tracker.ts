import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { listAsyncRuns } from "./async-status.ts";
import { isExpectedAsyncRunnerPid } from "./pid-identity.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	/** Override exact runner identity checks only for trusted test fixtures. */
	isExpectedAsyncRunnerPid?: typeof isExpectedAsyncRunnerPid;
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	/** Rehydrate only live, identity-verified runs owned by this session. */
	adoptPersistedActiveRuns: (ctx?: ExtensionContext) => number;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const nestedRefreshErrorSignatures = new Map<string, Set<string>>();
	const logNestedRefreshError = (job: Pick<AsyncJobState, "asyncId" | "asyncDir">, error: unknown): void => {
		const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
		let seen = nestedRefreshErrorSignatures.get(job.asyncId);
		if (!seen) { seen = new Set(); nestedRefreshErrorSignatures.set(job.asyncId, seen); }
		if (seen.has(detail)) {
			// Refresh recency so a repeatedly observed signature remains suppressed
			// while genuinely changed failures displace only the least-recent one.
			seen.delete(detail);
			seen.add(detail);
			return;
		}
		// Bound memory without permanently silencing a genuinely changed failure.
		if (seen.size >= 8) seen.delete(seen.values().next().value!);
		seen.add(detail);
		console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
	};
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		ctx.ui.requestRender?.();
	};
	const aggregateStatus = (status: Pick<AsyncJobState, "status" | "teardownUnproven" | "steps">): AsyncJobState["status"] => {
		const state = resolveAggregateState([
			{ state: status.status, teardownUnproven: status.teardownUnproven },
			...(status.steps ?? []).map((step) => ({ state: step.status, teardownUnproven: step.teardownUnproven })),
		]);
		return state === "completed" ? "complete" : state === "pending" ? "queued" : state as AsyncJobState["status"];
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			const job = state.asyncJobs.get(asyncId);
			if (!job) return;
			// A descendant can publish after the parent's terminal event (or after
			// handleComplete scheduled this timer). Re-read both durable status and
			// the nested event projection at fire time; never evict a job while a
			// descendant is still actionable.
			let nestedProjectionFailed = false;
			try {
				if (job.nestedRoute) {
					try {
						reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now, isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid });
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedProjectionFailed = true;
						throw error;
					}
				}
				const current = readStatus(job.asyncDir);
				if (current) {
					job.teardownUnproven = current.teardownUnproven;
					job.steps = current.steps;
					job.status = aggregateStatus({ status: current.state, teardownUnproven: current.teardownUnproven, steps: current.steps });
					job.updatedAt = current.lastUpdate ?? job.updatedAt;
				}
			} catch (error) {
				if (nestedProjectionFailed) {
					logNestedRefreshError(job, error);
					// Projection failure means descendant absence is unproven. Retain the
					// job and retry even when cached projection has no live child.
					scheduleCleanup(asyncId);
				} else {
					console.error(`Failed to recheck async cleanup fence for '${asyncId}':`, error);
					if (hasLiveNestedDescendants(job.nestedChildren)) scheduleCleanup(asyncId);
					else {
						state.asyncJobs.delete(asyncId);
						nestedRefreshErrorSignatures.delete(asyncId);
						if (state.lastUiContext) rerenderWidget(state.lastUiContext);
					}
				}
				return;
			}
			nestedRefreshErrorSignatures.delete(asyncId);
			if (job.teardownUnproven === true || (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "cancelled") || hasLiveNestedDescendants(job.nestedChildren)) {
				// Keep the tracker entry and let the poller observe the eventual
				// terminal descendant event before trying cleanup again.
				scheduleCleanup(asyncId);
				if (state.lastUiContext) rerenderWidget(state.lastUiContext);
				return;
			}
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			let widgetChanged = false;
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						logNestedRefreshError(job, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now, isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid });
					} catch (error) {
						nestedRefreshFailed = true;
						logNestedRefreshError(job, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.teardownUnproven = status.teardownUnproven;
						job.status = aggregateStatus({ status: status.state, teardownUnproven: status.teardownUnproven, steps: status.steps });
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "cancelled") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.groupDiagnostics = status.groupDiagnostics ?? job.groupDiagnostics;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							const logicalGroupDiagnostics = job.groupDiagnostics ?? [];
							const completedLogicalGroups = logicalGroupDiagnostics.filter((diagnostic) => diagnostic.status === "complete").length;
							job.stepsTotal = visibleSteps.length + logicalGroupDiagnostics.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length + completedLogicalGroups;
							if (status.state === "complete") job.completedSteps = job.stepsTotal;
						}
						if (!status.steps?.length && job.groupDiagnostics?.length) {
							job.stepsTotal = job.groupDiagnostics.length;
							job.runningSteps = 0;
							job.completedSteps = job.groupDiagnostics.filter((diagnostic) => diagnostic.status === "complete").length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						job.teardownUnproven = status.teardownUnproven;
						if (job.teardownUnproven !== true && (job.status === "complete" || job.status === "failed" || job.status === "paused" || job.status === "cancelled") && !nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
							scheduleCleanup(job.asyncId);
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						if (!nestedRefreshFailed) nestedRefreshErrorSignatures.delete(job.asyncId);
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (!nestedRefreshFailed) nestedRefreshErrorSignatures.delete(job.asyncId);
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
			}

			if (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const adoptPersistedActiveRuns = (ctx?: ExtensionContext): number => {
		// Reload adoption is an ownership transfer, so a verified process identity
		// is necessary but not sufficient: require exact current-session authority.
		if (!state.currentSessionId) return 0;
		let adopted = 0;
		let runs;
		try {
			// listAsyncRuns is the trusted status/list seam. Reconciliation is
			// deliberately disabled here: adoption must not mutate stale or terminal
			// records while the new extension instance is coming up.
			runs = listAsyncRuns(asyncDirRoot, {
				states: ["queued", "running"],
				sessionId: state.currentSessionId ?? undefined,
				reconcile: false,
				isExpectedAsyncRunnerPid: options.isExpectedAsyncRunnerPid,
			});
		} catch (error) {
			console.error(`Failed to inspect persisted async runs in '${asyncDirRoot}':`, error);
			return 0;
		}
		for (const summary of runs) {
			// listAsyncRuns is rooted, but retain explicit exact-root and directory
			// checks so malformed status or symlinked entries cannot escape adoption.
			if (path.resolve(path.dirname(summary.asyncDir)) !== path.resolve(asyncDirRoot) || path.basename(summary.asyncDir) !== summary.id) continue;
			try { if (!fs.lstatSync(summary.asyncDir).isDirectory()) continue; } catch { continue; }
			if (state.asyncJobs.has(summary.id)) continue;
			let status;
			try { status = readStatus(summary.asyncDir); } catch { continue; }
			if (!status || status.runId !== summary.id || (status.state !== "queued" && status.state !== "running")) continue;
			if (status.sessionId !== state.currentSessionId) continue;
			if (!Number.isInteger(status.pid) || (status.pid ?? 0) <= 0) continue;
			const verifyRunnerPid = options.isExpectedAsyncRunnerPid ?? isExpectedAsyncRunnerPid;
			if (!verifyRunnerPid(status.pid, summary.id, status.runnerIdentity)) continue;
			const now = options.now?.() ?? Date.now();
			const steps = summary.steps as AsyncJobState["steps"];
			const groups = normalizeParallelGroups(status.parallelGroups, steps.length, status.chainStepCount ?? steps.length);
			state.asyncJobs.set(summary.id, {
				asyncId: summary.id,
				asyncDir: summary.asyncDir,
				status: aggregateStatus(status),
				pid: status.pid,
				...(status.sessionId ? { sessionId: status.sessionId } : {}),
				mode: status.mode,
				agents: steps.map((step) => step.agent),
				steps,
				stepsTotal: steps.length + (status.groupDiagnostics?.length ?? 0),
				runningSteps: steps.filter((step) => step.status === "running").length,
				completedSteps: steps.filter((step) => step.status === "complete" || step.status === "completed").length,
				currentStep: status.currentStep,
				chainStepCount: status.chainStepCount,
				parallelGroups: groups,
				groupDiagnostics: status.groupDiagnostics,
				hasParallelGroups: groups.length > 0,
				activeParallelGroup: status.currentStep !== undefined && groups.some((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count),
				startedAt: status.startedAt,
				updatedAt: status.lastUpdate ?? now,
				activityState: status.activityState,
				lastActivityAt: status.lastActivityAt,
				currentTool: status.currentTool,
				currentToolStartedAt: status.currentToolStartedAt,
				currentPath: status.currentPath,
				turnCount: status.turnCount,
				toolCount: status.toolCount,
				sessionDir: status.sessionDir,
				outputFile: status.outputFile,
				totalTokens: status.totalTokens,
				sessionFile: status.sessionFile,
				nestedRoute: status.nestedRoute,
				nestedChildren: status.nestedChildren,
			});
			adopted += 1;
		}
		if (adopted > 0) {
			ensurePoller();
			if (ctx) rerenderWidget(ctx);
		}
		return adopted;
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		nestedRefreshErrorSignatures.delete(info.id);
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			groupDiagnostics: info.groupDiagnostics,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; state?: string; cancelled?: boolean; teardownUnproven?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			const completionState = resolveAggregateState([
				{ state: result.state ?? (result.success ? "complete" : "failed"), teardownUnproven: result.teardownUnproven },
				...(result.cancelled ? [{ state: "cancelled" }] : []),
			]);
			job.status = completionState === "running" ? "running" : completionState === "completed" ? "complete" : completionState === "cancelled" ? "cancelled" : completionState === "paused" ? "paused" : "failed";
			job.teardownUnproven = result.teardownUnproven;
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				logNestedRefreshError(job, error);
			}
			if (!nestedRefreshFailed) nestedRefreshErrorSignatures.delete(job.asyncId);
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		nestedRefreshErrorSignatures.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, adoptPersistedActiveRuns, resetJobs };
}
