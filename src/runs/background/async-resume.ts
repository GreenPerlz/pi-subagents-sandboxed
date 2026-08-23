import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, type AsyncStatus, type NestedRouteInfo } from "../../shared/types.ts";
import { validateNestedRouteForRevival } from "../shared/nested-events.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export type AsyncResumeTarget = {
	kind: "live" | "revive";
	runId: string;
	asyncDir?: string;
	state: AsyncStatus["state"];
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile?: string;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: AsyncStatus["nestedSelf"];
};

interface AsyncResultChild {
	agent?: string;
	success?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	flatIndex?: number;
	groupId?: string;
	unindexed?: boolean;
	teardownUnproven?: boolean;
}

interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	teardownUnproven?: boolean;
	worktreeExecutionError?: string;
	cwd?: string;
	sessionFile?: string;
	asyncDir?: string;
	nestedRoute?: NestedRouteInfo;
	nestedRouteRequired?: true;
	nestedSelf?: AsyncStatus["nestedSelf"];
	results?: AsyncResultChild[];
}

export interface AsyncRunLocation {
	asyncDir: string | null;
	resultPath: string | null;
	resolvedId?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Async result file '${source}' must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function validateOptionalString(value: Record<string, unknown>, field: string, source: string, displayField = field): string | undefined {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string") throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
	return fieldValue;
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
	const data = ensureObject(value, resultPath);
	const resultsValue = data.results;
	let results: AsyncResultFile["results"];
	if (resultsValue !== undefined) {
		if (!Array.isArray(resultsValue)) throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
		results = resultsValue.map((entry, index) => {
			const child = ensureObject(entry, `${resultPath} results[${index}]`);
			const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
			const sessionFile = validateOptionalString(child, "sessionFile", resultPath, `results[${index}].sessionFile`);
			const intercomTarget = validateOptionalString(child, "intercomTarget", resultPath, `results[${index}].intercomTarget`);
			const success = child.success;
			if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
			for (const field of ["flatIndex", "groupId", "unindexed", "teardownUnproven"] as const) {
				if (child[field] !== undefined && typeof child[field] !== (field === "flatIndex" ? "number" : "boolean")) {
					if (field !== "groupId" || typeof child[field] !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].${field} has an invalid type.`);
				}
			}
			if (child.flatIndex !== undefined && (!Number.isInteger(child.flatIndex) || child.flatIndex < 0)) throw new Error(`Invalid async result file '${resultPath}': results[${index}].flatIndex must be a non-negative integer.`);
			return {
				agent, sessionFile, intercomTarget,
				...(typeof success === "boolean" ? { success } : {}),
				...(typeof child.flatIndex === "number" ? { flatIndex: child.flatIndex } : {}),
				...(typeof child.groupId === "string" ? { groupId: child.groupId } : {}),
				...(child.unindexed === true ? { unindexed: true } : {}),
				...(child.teardownUnproven === true ? { teardownUnproven: true } : {}),
			};
		});
	}
	const success = data.success;
	if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
	const worktreeExecutionError = validateOptionalString(data, "worktreeExecutionError", resultPath);
	const nestedRoute = data.nestedRoute === undefined ? undefined : validateNestedRouteForRevival(data.nestedRoute);
	if (data.nestedRouteRequired !== undefined && data.nestedRouteRequired !== true) throw new Error(`Invalid async result file '${resultPath}': nestedRouteRequired must be true.`);
	const nestedSelf = data.nestedSelf === undefined ? undefined : validateNestedSelf(data.nestedSelf, resultPath);
	return {
		id: validateOptionalString(data, "id", resultPath),
		runId: validateOptionalString(data, "runId", resultPath),
		agent: validateOptionalString(data, "agent", resultPath),
		mode: validateOptionalString(data, "mode", resultPath),
		state: validateOptionalString(data, "state", resultPath),
		cwd: validateOptionalString(data, "cwd", resultPath),
		sessionFile: validateOptionalString(data, "sessionFile", resultPath),
		asyncDir: validateOptionalString(data, "asyncDir", resultPath),
		...(nestedRoute ? { nestedRoute } : {}),
		...(data.nestedRouteRequired === true ? { nestedRouteRequired: true as const } : {}),
		...(nestedSelf ? { nestedSelf } : {}),
		...(typeof success === "boolean" ? { success } : {}),
		...(data.teardownUnproven === true ? { teardownUnproven: true } : {}),
		...(worktreeExecutionError ? { worktreeExecutionError } : {}),
		...(results ? { results } : {}),
	};
}

function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return validateResultFile(JSON.parse(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new Error(`${field} must not be empty.`);
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
		throw new Error(`${field} must be an async run id or prefix, not a path.`);
	}
	return value;
}

function assertInsideRoot(root: string, target: string, label: string): void {
	const rootPath = path.resolve(root);
	const targetPath = path.resolve(target);
	const relative = path.relative(rootPath, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error(`${label} must be inside ${rootPath}.`);
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
		.map((entry) => suffix ? entry.slice(0, -suffix.length) : entry)
		.sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	assertInsideRoot(resultsDir, resultPath, "Async result file");
	return fs.existsSync(resultPath) ? resultPath : null;
}

export function findAsyncRunPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	const requestedId = assertRunId(prefix, "id");
	if (!requestedId) return [];
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const matchingIds = [...new Set([
		...prefixedRunIds(asyncRoot, requestedId),
		...prefixedRunIds(resultRoot, requestedId, ".json"),
	])].sort();
	return matchingIds.map((id) => {
		const asyncDir = path.join(asyncRoot, id);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		return {
			id,
			location: {
				asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
				resultPath: exactResultPath(resultRoot, id),
				resolvedId: id,
			},
		};
	});
}

export function resolveAsyncRunLocation(params: AsyncResumeParams, asyncDirRoot: string, resultsDir: string): AsyncRunLocation {
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		const resolvedId = requestedId ?? path.basename(asyncDir);
		if (requestedId && requestedId !== path.basename(asyncDir)) {
			throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
		}
		return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
	}
	if (!requestedId) return { asyncDir: null, resultPath: null };

	const directAsyncDir = path.join(asyncRoot, requestedId);
	assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
	const directResultPath = exactResultPath(resultRoot, requestedId);
	if (fs.existsSync(directAsyncDir) || directResultPath) {
		return {
			asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
			resultPath: directResultPath,
			resolvedId: requestedId,
		};
	}

	const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
	if (matching.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	if (matching.length > 1) {
		throw new Error(`Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`);
	}
	return matching[0]!.location;
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "cancelled" || result.state === "running" || result.state === "queued") {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}

function validateNestedSelf(value: unknown, source: string): NonNullable<AsyncStatus["nestedSelf"]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid nested ancestry '${source}': nestedSelf must be an object.`);
	const raw = value as Record<string, unknown>;
	const safeId = (candidate: unknown, field: string): string => {
		if (typeof candidate !== "string" || !/^[A-Za-z0-9._-]+$/u.test(candidate)) throw new Error(`Invalid nested ancestry '${source}': ${field} must be a safe id.`);
		return candidate;
	};
	const parentRunId = safeId(raw.parentRunId, "parentRunId");
	if (raw.parentStepIndex !== undefined && (!Number.isInteger(raw.parentStepIndex) || (raw.parentStepIndex as number) < 0)) throw new Error(`Invalid nested ancestry '${source}': parentStepIndex must be a non-negative integer.`);
	if (typeof raw.depth !== "number" || !Number.isInteger(raw.depth) || raw.depth < 1) throw new Error(`Invalid nested ancestry '${source}': depth must be a positive integer.`);
	if (!Array.isArray(raw.path) || raw.path.length === 0) throw new Error(`Invalid nested ancestry '${source}': path must be a non-empty array.`);
	const nestedPath = raw.path.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid nested ancestry '${source}': path[${index}] must be an object.`);
		const item = entry as Record<string, unknown>;
		const runId = safeId(item.runId, `path[${index}].runId`);
		if (item.stepIndex !== undefined && (!Number.isInteger(item.stepIndex) || (item.stepIndex as number) < 0)) throw new Error(`Invalid nested ancestry '${source}': path[${index}].stepIndex must be a non-negative integer.`);
		if (item.agent !== undefined && (typeof item.agent !== "string" || item.agent.length === 0 || item.agent.length > 256)) throw new Error(`Invalid nested ancestry '${source}': path[${index}].agent must be a bounded string.`);
		return { runId, ...(item.stepIndex !== undefined ? { stepIndex: item.stepIndex as number } : {}), ...(typeof item.agent === "string" ? { agent: item.agent } : {}) };
	});
	return { parentRunId, ...(raw.parentStepIndex !== undefined ? { parentStepIndex: raw.parentStepIndex as number } : {}), depth: raw.depth, path: nestedPath };
}

function sameNestedRoute(left: NestedRouteInfo, right: NestedRouteInfo): boolean {
	return left.rootRunId === right.rootRunId && left.eventSink === right.eventSink && left.controlInbox === right.controlInbox && left.capabilityToken === right.capabilityToken;
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (typeof status.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && typeof status.cwd !== "string") throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && typeof status.sessionFile !== "string") throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.nestedRoute !== undefined) validateNestedRouteForRevival(status.nestedRoute);
	if (status.nestedRouteRequired !== undefined && status.nestedRouteRequired !== true) throw new Error(`Invalid async status '${source}': nestedRouteRequired must be true.`);
	if (status.nestedSelf !== undefined) validateNestedSelf(status.nestedSelf, source);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		const canonicalIndexes = new Set<number>();
		status.steps.forEach((step, index) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			if (typeof step.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
			if (step.sessionFile !== undefined && typeof step.sessionFile !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
			if (step.groupId !== undefined && typeof step.groupId !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].groupId must be a string.`);
			if ((step as { unindexed?: unknown }).unindexed !== undefined && typeof (step as { unindexed?: unknown }).unindexed !== "boolean") throw new Error(`Invalid async status '${source}': steps[${index}].unindexed must be a boolean.`);
			if (step.flatIndex !== undefined && (!Number.isInteger(step.flatIndex) || step.flatIndex < 0)) throw new Error(`Invalid async status '${source}': steps[${index}].flatIndex must be a non-negative integer.`);
			if (!step.groupId && !(step as { unindexed?: boolean }).unindexed) {
				const flatIndex = step.flatIndex ?? index;
				if (canonicalIndexes.has(flatIndex)) throw new Error(`Invalid async status '${source}': duplicate canonical flatIndex ${flatIndex}.`);
				canonicalIndexes.add(flatIndex);
			}
		});
	}
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!fs.existsSync(resolved)) throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
	return resolved;
}

export function resolveAsyncResumeTarget(params: AsyncResumeParams, deps: AsyncResumeDeps = {}): AsyncResumeTarget {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	const reconciliation = location.asyncDir
		? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
		: undefined;
	const status = reconciliation?.status ?? null;
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	if (status?.cwd && result?.cwd && path.resolve(status.cwd) !== path.resolve(result.cwd)) throw new Error("Persisted async cwd differs between status and result files.");
	if (status?.sessionFile && result?.sessionFile && path.resolve(status.sessionFile) !== path.resolve(result.sessionFile)) throw new Error("Persisted async session differs between status and result files.");
	const persistedRoute = status?.nestedRoute ?? result?.nestedRoute;
	const routeRequired = status?.nestedRouteRequired === true || result?.nestedRouteRequired === true;
	if (routeRequired && !persistedRoute) throw new Error("Async revival requires persisted nested route metadata, but the authenticated route is missing.");
	if (status?.nestedRoute && result?.nestedRoute && !sameNestedRoute(status.nestedRoute, result.nestedRoute)) throw new Error("Persisted nested route metadata differs between async status and result files.");
	const statusNestedSelf = status?.nestedSelf ? validateNestedSelf(status.nestedSelf, "status.json") : undefined;
	const persistedNestedSelf = statusNestedSelf ?? result?.nestedSelf;
	if (statusNestedSelf && result?.nestedSelf && JSON.stringify(statusNestedSelf) !== JSON.stringify(result.nestedSelf)) throw new Error("Persisted nested ancestry differs between async status and result files.");
	const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs");
	const nestedLocation = location.asyncDir ? path.resolve(location.asyncDir).startsWith(`${nestedRoot}${path.sep}`) : Boolean(result?.asyncDir && path.resolve(result.asyncDir).startsWith(`${nestedRoot}${path.sep}`));
	if (nestedLocation && !persistedRoute) throw new Error("Nested async revival requires persisted nested route metadata.");
	const runId = status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);
	if (status?.teardownUnproven === true || result?.teardownUnproven === true) {
		throw new Error(`Async run '${runId}' has unproven teardown and cannot be resumed safely.`);
	}
	if (status?.steps?.some((step) => step.teardownUnproven === true) || result?.results?.some((step) => step.teardownUnproven === true)) {
		throw new Error(`Async run '${runId}' has a child with unproven teardown and cannot be resumed safely.`);
	}

	// Diagnostics are deliberately unindexed. Resolve resume targets from the
	// canonical flat indexes, never from raw array positions.
	const statusSteps = (status?.steps ?? []).filter((step) => !step.groupId && !(step as { unindexed?: boolean }).unindexed).map((step, position) => ({ step, index: step.flatIndex ?? position }));
	const resultSteps = (result?.results ?? []).filter((step) => !(step as { groupId?: string; unindexed?: boolean }).groupId && !(step as { unindexed?: boolean }).unindexed).map((step, position) => ({ step, index: (step as { flatIndex?: number }).flatIndex ?? position }));
	const resultIndexes = new Set<number>();
	for (const entry of resultSteps) {
		if (resultIndexes.has(entry.index)) throw new Error(`Invalid async result: duplicate canonical flatIndex ${entry.index}.`);
		resultIndexes.add(entry.index);
		const persistedStatus = statusSteps.find((candidate) => candidate.index === entry.index)?.step;
		if (persistedStatus && entry.step.agent && persistedStatus.agent !== entry.step.agent) throw new Error(`Persisted async child ${entry.index} differs between status and result files.`);
		if (persistedStatus?.sessionFile && entry.step.sessionFile && path.resolve(persistedStatus.sessionFile) !== path.resolve(entry.step.sessionFile)) throw new Error(`Persisted async child ${entry.index} session differs between status and result files.`);
	}
	if (status?.steps !== undefined && result?.results !== undefined) {
		const statusIndexes = new Set(statusSteps.map((entry) => entry.index));
		if (statusIndexes.size !== resultIndexes.size || [...statusIndexes].some((index) => !resultIndexes.has(index))) throw new Error("Persisted canonical child indexes differ between async status and result files.");
	}
	const stepCount = Math.max(statusSteps.length ? Math.max(...statusSteps.map(({ index }) => index + 1)) : 0, resultSteps.length ? Math.max(...resultSteps.map(({ index }) => index + 1)) : 0, result?.agent ? 1 : 0);
	const requestedIndex = params.index;
	if (requestedIndex !== undefined && !Number.isInteger(requestedIndex)) throw new Error(`Async run '${runId}' index must be an integer.`);
	const terminalStepStatuses = new Set(["complete", "completed", "failed", "paused", "cancelled"]);

	if (state === "running") {
		if (requestedIndex !== undefined) {
			if (requestedIndex < 0 || requestedIndex >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
			const selectedEntry = statusSteps.find(({ index }) => index === requestedIndex);
			const selectedStep = selectedEntry?.step;
			if (selectedStep?.status === "running") {
				return {
					kind: "live",
					runId,
					asyncDir: location.asyncDir ?? undefined,
					state,
					agent: selectedStep.agent,
					index: requestedIndex,
					intercomTarget: resolveSubagentIntercomTarget(runId, selectedStep.agent, requestedIndex),
					cwd: status?.cwd ?? result?.cwd,
					sessionFile: selectedStep.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
					...(persistedRoute ? { nestedRoute: persistedRoute } : {}),
					...(persistedNestedSelf ? { nestedSelf: persistedNestedSelf } : {}),
				};
			}
			if (selectedStep?.status === "pending") throw new Error(`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`);
			if (selectedStep && !terminalStepStatuses.has(selectedStep.status)) throw new Error(`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`);
		} else {
			const running = statusSteps.filter(({ step }) => step.status === "running");
			const selected = running.length === 1 ? running[0] : undefined;
			if (!selected) {
				throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
			}
			return {
				kind: "live",
				runId,
				asyncDir: location.asyncDir ?? undefined,
				state,
				agent: selected.step.agent,
				index: selected.index,
				intercomTarget: resolveSubagentIntercomTarget(runId, selected.step.agent, selected.index),
				cwd: status?.cwd ?? result?.cwd,
				sessionFile: selected.step.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
				...(persistedRoute ? { nestedRoute: persistedRoute } : {}),
				...(persistedNestedSelf ? { nestedSelf: persistedNestedSelf } : {}),
			};
		}
	}

	if (stepCount > 1 && requestedIndex === undefined) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
	}
	const index = requestedIndex ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Async run '${runId}' index must be an integer.`);
	if (index < 0 || index >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
	const statusStep = statusSteps.find(({ index: flatIndex }) => flatIndex === index)?.step;
	const resultStep = resultSteps.find(({ index: flatIndex }) => flatIndex === index)?.step;
	const agent = statusStep?.agent ?? resultStep?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	const sessionFile = statusStep?.sessionFile
		?? resultStep?.sessionFile
		?? (stepCount === 1 ? status?.sessionFile ?? result?.sessionFile : undefined);
	if (!sessionFile) throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
	const resolvedSessionFile = validateResumeSessionFile(runId, sessionFile);

	return {
		kind: "revive",
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		index,
		intercomTarget: resolveSubagentIntercomTarget(runId, agent, index),
		cwd: status?.cwd ?? result?.cwd,
		sessionFile: resolvedSessionFile,
		...(persistedRoute ? { nestedRoute: persistedRoute } : {}),
		...(persistedNestedSelf ? { nestedSelf: persistedNestedSelf } : {}),
	};
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		`Original run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	].filter((line): line is string => line !== undefined).join("\n");
}
