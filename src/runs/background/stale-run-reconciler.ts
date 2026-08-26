import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { RESULTS_DIR, type AsyncParallelGroupStatus, type AsyncStatus, type NestedRunSummary, type SubagentRunMode } from "../../shared/types.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, type NestedRoute } from "../shared/nested-events.ts";
import { isExpectedAsyncRunnerPid, readProcessStartToken } from "./pid-identity.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	/** Override exact runner identity checks for trusted fixture/test environments. */
	isExpectedAsyncRunnerPid?: typeof isExpectedAsyncRunnerPid;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
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

function appendJsonl(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function readStatusFile(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

interface ResultChildOutcome {
	agent?: string;
	flatIndex?: number;
	groupId?: string;
	unindexed?: boolean;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	error?: string;
	output?: string;
	finalOutput?: string;
	sessionFile?: string;
	teardownUnproven?: boolean;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
	cancelled?: boolean;
	exitCode?: number | null;
	gitBundle?: NonNullable<AsyncStatus["steps"]>[number]["gitBundle"];
}

interface ResultRepairData {
	state: "complete" | "failed" | "paused" | "cancelled";
	results?: ResultChildOutcome[];
	finalOutput?: string;
	teardownUnproven?: boolean;
}

function readResultRepairData(resultPath: string, fallbackState?: AsyncStatus["state"]): (ResultRepairData & { workflowGraph?: AsyncStatus["workflowGraph"]; groupDiagnostics?: AsyncStatus["groupDiagnostics"]; outputs?: AsyncStatus["outputs"]; sessionFile?: string; finalOutput?: string }) | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			success?: boolean; state?: string; exitCode?: number; results?: ResultChildOutcome[];
			workflowGraph?: AsyncStatus["workflowGraph"];
			groupDiagnostics?: AsyncStatus["groupDiagnostics"];
			teardownUnproven?: boolean;
			outputs?: AsyncStatus["outputs"];
			sessionFile?: string; finalOutput?: string;
		};
		const childFailed = data.results?.some((child) => child.cancelled !== true && child.interrupted !== true
			&& child.state !== "paused" && child.state !== "cancelled"
			&& (child.success === false || child.state === "failed" || (child.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0))) === true;
		const state = childFailed ? "failed" : data.success === true ? "complete" : data.state === "cancelled" ? "cancelled" : data.state === "paused" || data.exitCode === 0 || fallbackState === "paused" ? "paused" : "failed";
		return {
			state,
			...(Array.isArray(data.results) ? { results: data.results } : {}),
			...(data.workflowGraph ? { workflowGraph: data.workflowGraph } : {}),
			...(Array.isArray(data.groupDiagnostics) ? { groupDiagnostics: data.groupDiagnostics } : {}),
			...(data.outputs ? { outputs: data.outputs } : {}),
			...(data.sessionFile ? { sessionFile: data.sessionFile } : {}),
			...(data.finalOutput !== undefined ? { finalOutput: data.finalOutput } : {}),
			...(data.teardownUnproven === true ? { teardownUnproven: true } : {}),
		};
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): "complete" | "failed" | "paused" | "cancelled" {
	// Child truth is canonical. In particular, a paused/cancelled aggregate must
	// not relabel a sibling whose own result explicitly failed.
	if (child?.cancelled === true || child?.state === "cancelled") return "cancelled";
	if (child?.interrupted === true || child?.state === "paused" || child?.state === "interrupted") return "paused";
	if (child?.success === true || child?.exitCode === 0) return "complete";
	if (child?.success === false || (child?.exitCode !== undefined && child.exitCode !== 0) || child?.state === "failed") return "failed";
	return overallState;
}

function repairTeardownResultProjection(resultPath: string): boolean {
	const raw = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown> & { results?: Array<Record<string, unknown>> };
	const cleanupUnproven = raw.teardownUnproven === true || raw.results?.some((child) => child.teardownUnproven === true) === true;
	if (!cleanupUnproven) return false;
	const results = raw.results?.map((child) => {
		const state = typeof child.state === "string" ? child.state : typeof child.status === "string" ? child.status : undefined;
		if (child.teardownUnproven !== true && state !== "running" && state !== "pending" && state !== "paused") return child;
		return { ...child, state: "failed", ...(child.status !== undefined ? { status: "failed" } : {}), success: false, incomplete: true };
	});
	const repaired = { ...raw, state: "failed", success: false, incomplete: true, ...(results ? { results } : {}) };
	if (JSON.stringify(repaired) === JSON.stringify(raw)) return false;
	writeAtomicJson(resultPath, repaired);
	return true;
}

function terminalStatusFromResult(status: AsyncStatus, resultPath: string, now: number): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath, status.state);
	if (!repair) return undefined;
	const cleanupUnproven = status.teardownUnproven === true || repair.teardownUnproven === true || repair.results?.some((child) => child.teardownUnproven === true);
	// Result diagnostics for parallel groups are intentionally unindexed. Build
	// the repair lookup from canonical flat indexes rather than raw result-array
	// positions, otherwise one diagnostic shifts every later child outcome.
	const indexedResults = new Map<number, ResultChildOutcome>();
	let nextIndex = 0;
	for (const candidate of repair.results ?? []) {
		const diagnostic = candidate as ResultChildOutcome & { groupId?: string; unindexed?: boolean; flatIndex?: number };
		if (diagnostic.groupId || diagnostic.unindexed) continue;
		const explicit = (candidate as ResultChildOutcome & { flatIndex?: number }).flatIndex;
		const index = explicit ?? nextIndex++;
		if (explicit !== undefined) nextIndex = Math.max(nextIndex, explicit + 1);
		indexedResults.set(index, candidate);
	}
	const steps = (status.steps ?? []).map((step, index) => {
		const child = indexedResults.get(index);
		const state = childState(repair.state, child);
		const terminalStep = step.status !== "running" && step.status !== "pending";
		return {
			...step,
			// The canonical result is newer truth even when status.json already says
			// terminal. A crash can publish the result first and leave a stale step
			// projection behind, so never preserve that stale terminal state.
			status: child ? (state === "complete" ? "complete" as const : state) : terminalStep ? step.status : state === "complete" ? "complete" as const : state,
			endedAt: child ? step.endedAt ?? now : terminalStep ? step.endedAt : step.endedAt ?? now,
			durationMs: terminalStep ? step.durationMs : step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" || state === "cancelled" ? 0 : 1),
			error: state === "failed" ? step.error ?? child?.error : step.error,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model: step.model ?? child?.model,
			attemptedModels: step.attemptedModels ?? child?.attemptedModels,
			modelAttempts: step.modelAttempts ?? child?.modelAttempts,
			finalOutput: child?.finalOutput ?? child?.output ?? step.finalOutput,
			gitBundle: child?.gitBundle ?? step.gitBundle,
		};
	});
	if (cleanupUnproven) {
		return {
			...status,
			state: "failed",
			incomplete: true,
			teardownUnproven: true,
			activityState: undefined,
			endedAt: status.endedAt ?? now,
			lastUpdate: now,
			steps: steps.map((step) => step.status === "running" || step.status === "pending" || step.status === "paused"
				? { ...step, status: "failed" as const, success: false, exitCode: step.exitCode ?? 1, endedAt: step.endedAt ?? now, error: step.error ?? "Scoped cleanup proof was not established; recovery evidence is retained." }
				: step),
		};
	}
	const resultDiagnostics = (repair.results ?? [])
		.filter((child) => Boolean(child.groupId || child.unindexed))
		.map((child) => ({
			groupId: child.groupId ?? `group-${child.agent ?? "unknown"}`,
			unindexed: true as const,
			agent: child.agent ?? "group",
			status: childState(repair.state, child),
			...(child.error ? { error: child.error } : {}),
			...(child.finalOutput ?? child.output) !== undefined ? { finalOutput: child.finalOutput ?? child.output } : {},
		}));
	const repaired: AsyncStatus = {
		...status,
		state: repair.state,
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
		...(repair.workflowGraph ? { workflowGraph: repair.workflowGraph } : {}),
		...((repair.groupDiagnostics ?? resultDiagnostics).length ? { groupDiagnostics: repair.groupDiagnostics ?? resultDiagnostics } : {}),
		...(repair.outputs ? { outputs: repair.outputs } : {}),
		...(repair.sessionFile ? { sessionFile: repair.sessionFile } : {}),
		...(repair.finalOutput !== undefined ? { finalOutput: repair.finalOutput } : {}),
	};
	return repaired;
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return {
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	};
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string): { status: AsyncStatus; result: object; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const message = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const paused = step.interrupted === true || status.state === "paused";
		return {
			...step,
			status: paused ? "paused" as const : "failed" as const,
			activityState: undefined,
			interrupted: paused ? true : step.interrupted,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (paused ? 0 : 1),
			error: step.error ?? message,
		};
	});
	const preservedPause = status.state === "paused" || repairedSteps.some((step) => step.status === "paused");
	const repairedStatus: AsyncStatus = {
		...status,
		state: preservedPause ? "paused" : "failed",
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			success: false,
			state: preservedPause ? "paused" : "failed",
			summary: message,
			results: repairedSteps.map((step) => ({
				agent: step.agent,
				output: step.status === "complete" || step.status === "completed" ? "" : message,
				error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
				success: step.status === "complete" || step.status === "completed",
				state: step.status === "paused" ? "paused" : step.status,
				...(step.status === "paused" ? { interrupted: true } : {}),
				model: step.model,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				sessionFile: step.sessionFile,
			})),
			exitCode: preservedPause ? 0 : 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

export function hasActionableIsolatedEvidence(status: AsyncStatus): boolean {
	if (status.steps?.some((step) => Boolean((step.gitBundle?.path && fs.existsSync(step.gitBundle.path)) || (step.gitBundle?.recovery && fs.existsSync(step.gitBundle.recovery)))) ) return true;
	const texts = [status.error ?? "", ...(status.steps ?? []).map((step) => step.error ?? "")];
	const evidencePattern = /(?:runtime\s+retained|recover\s+(?:isolated\s+)?(?:runtime|worktrees?|runtime\/worktrees?))\s+at\s+([^\n;]+)/giu;
	for (const text of texts) for (const match of text.matchAll(evidencePattern)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		// Generated diagnostics use comma-separated worktrees and append a
		// punctuation/error clause. Preserve spaces in paths while removing only
		// delimiters that cannot belong to the referenced filesystem entry.
		for (const part of raw.split(/,\s*/u)) {
			const candidate = part
				.split(/\s+(?:because|after)\b|:\s*/u, 1)[0]
				.trim()
				.replace(/[.,)]+$/u, "");
			if (candidate && fs.existsSync(candidate)) return true;
		}
	}
	return false;
}

function isIsolatedStatus(status: AsyncStatus): boolean {
	return Boolean(status.steps?.some((step) => step.sandbox?.gitMode === "isolated"));
}

function writeIncompleteRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number): ReconcileAsyncRunResult {
	const message = `Async isolated run ${status.runId || path.basename(asyncDir)} ended without a verified recovery bundle or retained runtime; marked failed with incomplete recovery evidence.`;
	const repair = buildFailedRepair(status, asyncDir, now, message);
	const incompleteStatus: AsyncStatus = { ...repair.status, incomplete: true };
	const incompleteResult = { ...repair.result, incomplete: true };
	writeAtomicJson(resultPath, incompleteResult);
	writeAtomicJson(path.join(asyncDir, "status.json"), incompleteStatus);
	appendJsonl(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_incomplete",
		ts: now,
		runId: incompleteStatus.runId,
		pid: status.pid,
		message,
	});
	return { status: incompleteStatus, repaired: true, resultPath, message };
}

function writeFailedRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number, reason?: string): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendJsonl(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

function terminal(state: AsyncStatus["state"], teardownUnproven = false): boolean {
	return !teardownUnproven && (state === "complete" || state === "failed" || state === "paused" || state === "cancelled");
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state, status.teardownUnproven) && !status.teardownUnproven) continue;
		const ts = options.now?.() ?? Date.now();
		writeNestedEvent(route, {
			type: terminal(status.state, status.teardownUnproven) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			parentStepIndex: run.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(status, asyncDir, {
				id: run.id,
				parentRunId: run.parentRunId,
				parentStepIndex: run.parentStepIndex,
				depth: run.depth,
				path: run.path,
				mode: run.mode,
				ts,
			}),
		});
	}
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill): PidLiveness {
	if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) return "unknown";
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

/** Read the direct parent from Linux proc stat without trusting a PID alone. */
function readDirectParentPid(pid: number): number | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
		const parent = Number(fields[1]);
		return Number.isInteger(parent) && parent > 0 ? parent : undefined;
	} catch { return undefined; }
}

/**
 * Owner liveness is identity-qualified. Old status files have no start token,
 * so an owner PID is trusted only when proc proves it is still the runner's
 * direct parent; an arbitrary live/reused PID is deliberately unknown.
 */
function ownerLiveness(status: AsyncStatus, kill: KillFn): PidLiveness {
	const ownerPid = status.ownerPid;
	if (!Number.isInteger(ownerPid) || !Number.isFinite(ownerPid) || ownerPid <= 0) return "unknown";
	const liveness = checkPidLiveness(ownerPid, kill);
	if (liveness !== "alive") return liveness;
	if (process.platform === "linux" && status.ownerStartToken) {
		return readProcessStartToken(ownerPid) === status.ownerStartToken ? "alive" : "dead";
	}
	return readDirectParentPid(status.pid ?? -1) === ownerPid ? "alive" : "unknown";
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatusFile(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };

	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
	if (fs.existsSync(resultPath)) {
		const resultRepaired = repairTeardownResultProjection(resultPath);
		const staleProjection = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
			|| effectiveStatus.teardownUnproven === true
			|| effectiveStatus.steps?.some((step) => step.status === "running" || step.status === "pending" || step.status === "paused") === true;
		const projectedStatus = staleProjection ? terminalStatusFromResult(effectiveStatus, resultPath, now) : undefined;
		if (projectedStatus) {
			// Ignore the reconciliation timestamp when deciding whether durable state
			// already matches. This keeps polling idempotent and prevents perpetual
			// status rewrites/UI rerenders for retained cleanup evidence.
			const comparable = { ...projectedStatus, lastUpdate: effectiveStatus.lastUpdate };
			const statusRepaired = JSON.stringify(comparable) !== JSON.stringify(effectiveStatus);
			const terminalStatus = statusRepaired ? projectedStatus : effectiveStatus;
			if (statusRepaired) writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
			const repaired = statusRepaired || resultRepaired;
			return { status: terminalStatus, repaired, resultPath, ...(repaired ? { message: "Existing async result file was used to reconcile terminal status/result projections." } : {}) };
		}
		return { status: effectiveStatus, repaired: resultRepaired, resultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number" || !Number.isFinite(effectiveStatus.pid) || !Number.isInteger(effectiveStatus.pid) || effectiveStatus.pid <= 0) {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	// A persisted PID without its exact runner identity is untrusted. Treating it
	// as live would allow PID reuse to block fail-closed recovery indefinitely.
	const verifyRunnerPid = options.isExpectedAsyncRunnerPid ?? isExpectedAsyncRunnerPid;
	const identityValid = verifyRunnerPid(effectiveStatus.pid, runId, effectiveStatus.runnerIdentity);
	const repairStale = (reason?: string): ReconcileAsyncRunResult =>
		isIsolatedStatus(effectiveStatus) && !hasActionableIsolatedEvidence(effectiveStatus)
			? writeIncompleteRepair(asyncDir, effectiveStatus, resultPath, now)
			: writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, reason);
	const liveness = identityValid ? checkPidLiveness(effectiveStatus.pid, options.kill) : "dead";
	if (liveness !== "dead") {
		// Check whether the owner (parent session) process is gone.
		// If so, the runner is orphaned even though its PID is still alive.
		if (typeof effectiveStatus.ownerPid === "number") {
			const ownerState = ownerLiveness(effectiveStatus, options.kill ?? process.kill);
			if (ownerState === "dead") {
				const message = `Owner process ${effectiveStatus.ownerPid} exited or its start identity was reused while async runner ${effectiveStatus.pid} was still running. Marked run failed as orphaned by stale-run reconciliation.`;
				return repairStale(message);
			}
		}
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
		return repairStale(message);
	}

	return repairStale();
}
