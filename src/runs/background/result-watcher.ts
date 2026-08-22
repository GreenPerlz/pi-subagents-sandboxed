import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type IntercomEventBus,
	type NestedRunSummary,
	type SubagentResultIntercomChild,
	type SubagentState,
} from "../../shared/types.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "watch">;

type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	timers?: ResultWatcherTimers;
};

type ResultFileChild = {
	flatIndex?: number;
	/** Group diagnostics are intentionally not assigned a child index. */
	groupId?: string;
	unindexed?: boolean;
	agent?: string;
	/** Canonical output; output is retained for legacy result files. */
	finalOutput?: string;
	output?: string;
	error?: string;
	success?: boolean;
	interrupted?: boolean;
	cancelled?: boolean;
	teardownUnproven?: boolean;
	sessionFile?: string;
	artifactPaths?: { outputPath?: string };
	gitBundle?: {
		path: string;
		checksum: string;
		base: string;
		head: string;
		commitSummary: string;
		recovery?: string;
		stagedSnapshot?: string;
		stagedTree?: string;
		recoveryTree?: string;
		terminationState?: string;
		incomplete?: boolean;
		dirtySummary?: string;
		bundleSize?: number;
		payloadChecksum?: string;
		canonicalPayloadChecksum?: string;
		canonicalPayloadSize?: number;
		portableMetadata?: string;
	};
	intercomTarget?: string;
	children?: unknown;
};

type ResultFileData = {
	id?: string;
	runId?: string;
	agent?: string;
	success?: boolean;
	state?: string;
	mode?: string;
	summary?: string;
	finalOutput?: string;
	results?: ResultFileChild[];
	nestedChildren?: unknown;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string;
	asyncDir?: string;
	intercomTarget?: string;
	worktreeSummary?: string;
	worktreeCaptureError?: string;
	worktreeExecutionError?: string;
};

function sanitizeNestedResultChildren(value: unknown, resultPath: string, label: string): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
		return undefined;
	}
	const children = value.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
	}
	return children.length ? children : undefined;
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

function hasDurableTerminalStatus(fsApi: ResultWatcherFs, data: ResultFileData, resultPath: string): boolean {
	// Legacy result-only receipts do not carry an async directory and remain
	// consumable. When they do, the result is not safe to unlink until the
	// sibling status rename has durably published terminal truth.
	if (!data.asyncDir || !fsApi.existsSync(data.asyncDir)) return true;
	const statusPath = path.join(data.asyncDir, "status.json");
	try {
		const status = JSON.parse(fsApi.readFileSync(statusPath, "utf-8")) as { runId?: string; state?: string; teardownUnproven?: boolean };
		if (data.id && status.runId && data.id !== status.runId) return false;
		return status.teardownUnproven !== true
			&& (status.state === "complete" || status.state === "failed" || status.state === "paused" || status.state === "cancelled");
	} catch (error) {
		if (!isNotFoundError(error)) console.error(`Failed to verify durable async status before consuming '${resultPath}':`, error);
		return false;
	}
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}

function resolveResultFileFromWatchEvent(fileName: string): string | undefined {
	if (fileName.endsWith(".json")) return path.basename(fileName) === fileName ? fileName : undefined;
	// writeAtomicJson renames `.result.json.<pid>.<time>.<nonce>.tmp` to
	// `result.json`. Node reports the destination rename, while Bun may report
	// only the temporary source filename. Recover the destination in either case.
	const atomicTempMatch = /^\.(.+\.json)\.\d+\.\d+\.[^.]+\.tmp$/.exec(fileName);
	const resultFile = atomicTempMatch?.[1];
	return resultFile && path.basename(resultFile) === resultFile ? resultFile : undefined;
}

export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: () => void;
} {
	const fsApi = deps.fs ?? fs;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };

	const handleResult = async (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsApi.existsSync(resultPath)) return;
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as ResultFileData;
			if (data.sessionId && data.sessionId !== state.currentSessionId) return;
			if (!data.sessionId && data.cwd && (!state.baseCwd || data.cwd !== state.baseCwd)) return;

			const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
			const hasExplicitNestedChildren = data.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				try {
					nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
				} catch (error) {
					console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
					return;
				}
			}
			if (!hasDurableTerminalStatus(fsApi, data, resultPath)) {
				// The result may have won the crash race with status publication. Keep
				// it as the recovery source and retry after the status rename rather than
				// dropping it or requiring a new result-directory watch event.
				timers.setTimeout(() => state.resultFileCoalescer.schedule(file, 0), 250);
				return;
			}
			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				fsApi.unlinkSync(resultPath);
				return;
			}

			const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
			const resultChildren = hasResultChildren
				? data.results!
				: [{
					agent: data.agent,
					output: data.summary,
					success: data.success,
				}];
			const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
				const baseOutput = result.finalOutput ?? result.output ?? data.finalOutput ?? data.summary;
				const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
				const output = hasRealOutput ? baseOutput : "(no output)";
				const summary = result.success === false && result.error
					? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
					: output;
				const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
				const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
				return {
					agent: result.agent ?? data.agent ?? `step-${index + 1}`,
					// Child execution truth takes precedence over the top-level paused
					// state; a completed sibling must remain completed after another
					// child is interrupted.
					status: resolveSubagentResultStatus({
						success: result.success,
						interrupted: result.interrupted,
						cancelled: result.cancelled,
						teardownUnproven: result.teardownUnproven,
						state: result.interrupted ? "paused" : typeof result.success === "boolean" ? undefined : data.state,
					}),
					summary,
					...(result.groupId ? { groupId: result.groupId } : result.unindexed ? { unindexed: true } : result.flatIndex !== undefined ? { index: result.flatIndex } : resultChildren.length === 1 && !hasResultChildren ? {} : { index }),
					artifactPath: result.artifactPaths?.outputPath,
					...(result.gitBundle ? { gitBundle: result.gitBundle } : {}),
					...(result.teardownUnproven ? { teardownUnproven: true } : {}),
					...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
					...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
					...(childNestedChildren ? { children: childNestedChildren } : {}),
				};
			}), nestedChildren);

			const childFailure = normalizedChildren.some((child) => child.status === "failed");
			const aggregateState = resolveAggregateState([
				{ state: data.state ?? (data.success === true ? "complete" : data.success === false ? "failed" : "pending"), teardownUnproven: data.teardownUnproven },
				...(data.worktreeCaptureError || data.worktreeExecutionError ? [{ state: "failed" }] : []),
				...normalizedChildren.map((child) => ({ state: child.status, teardownUnproven: child.teardownUnproven })),
			]);
			const topLevelFailure = aggregateState === "failed";
			if (topLevelFailure && normalizedChildren.length > 0 && !childFailure) {
				// Group diagnostics are unindexed aggregate records; project a
				// top-level lifecycle failure onto the first canonical child instead.
				const canonical = normalizedChildren.find((child) => !child.groupId && !child.unindexed);
				if (canonical) canonical.status = "failed";
			}
			const observedFailure = aggregateState === "failed";
			const observedState = aggregateState === "running" ? "running" : aggregateState === "failed" ? "failed" : aggregateState === "cancelled" ? "cancelled" : aggregateState === "paused" ? "paused" : "complete";
			const observedSuccess = observedState === "complete";
			const intercomTarget = data.intercomTarget?.trim();
			if (intercomTarget) {
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: resultChildren.length > 1 ? "chain" : "single";
				const payload = buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: normalizedChildren,
					asyncId: data.id,
					asyncDir: data.asyncDir,
					...(data.worktreeExecutionError ? { worktreeExecutionError: data.worktreeExecutionError } : {}),
				});
				for (const worktreeNotice of [data.worktreeExecutionError, data.worktreeCaptureError, data.worktreeSummary]) {
					if (worktreeNotice && !payload.message.includes(worktreeNotice)) payload.message = `${payload.message}\n\n${worktreeNotice}`;
				}
				const delivered = await deliverSubagentResultIntercomEvent(pi.events, payload);
				if (!delivered) {
					console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
				}
			}

			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				...data,
				runId,
				success: observedSuccess,
				state: observedState,
				finalOutput: data.finalOutput ?? data.summary,

				...(nestedChildren?.length ? { nestedChildren } : {}),
				...(Array.isArray(data.results) ? {
					results: hasResultChildren
						? normalizedChildren.map((child, index) => ({
							...data.results![index],
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							// Keep the canonical child output raw; `summary` may be decorated
							// with an execution error for intercom/UI display.
							finalOutput: data.results![index]?.finalOutput ?? data.results![index]?.output ?? data.finalOutput ?? data.summary,
							...(child.groupId ? { groupId: child.groupId } : child.index !== undefined ? { index: child.index } : {}),
							artifactPath: child.artifactPath,
							...(child.gitBundle ? { gitBundle: child.gitBundle } : {}),
							sessionPath: child.sessionPath,
							children: child.children,
						}))
						: [],
				} : {}),
			});
			fsApi.unlinkSync(resultPath);
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		}
	};

	state.resultFileCoalescer = createFileCoalescer((file) => {
		void handleResult(file);
	}, 50);

	const primeExistingResults = () => {
		try {
			fsApi.readdirSync(resultsDir)
				.filter((f) => f.endsWith(".json"))
				.forEach((file) => state.resultFileCoalescer.schedule(file, 0));
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};

	const startPollingFallback = (reason: unknown) => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) return;

		console.error(
			`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
		);
		primeExistingResults();
		state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	const scheduleRestart = () => {
		if (state.watcherRestartTimer) return;
		state.watcherRestartTimer = timers.setTimeout(() => {
			state.watcherRestartTimer = null;
			try {
				fsApi.mkdirSync(resultsDir, { recursive: true });
				startResultWatcher();
			} catch (error) {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart();
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer.unref?.();
	};

	const startResultWatcher = () => {
		if (state.watcher) return;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		try {
			// Async launch and watcher startup race: the detached runner may create
			// the result root only after this call. Ensure the watch target exists
			// before fs.watch so the first result cannot be missed or leave a noisy
			// ENOENT handle behind.
			fsApi.mkdirSync(resultsDir, { recursive: true });
			state.watcher = fsApi.watch(resultsDir, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const resultFile = resolveResultFileFromWatchEvent(file.toString());
				if (!resultFile) return;
				state.resultFileCoalescer.schedule(resultFile);
			});
			state.watcher.on("error", (error) => {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart();
			});
			state.watcher.unref?.();
		} catch (error) {
			if (shouldFallBackToPolling(error)) {
				startPollingFallback(error);
				return;
			}
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart();
		}
	};

	const stopResultWatcher = () => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
