import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSandboxSettings, type AgentConfig, type AgentScope } from "../../agents/agents.ts";
import { hasExplicitSandboxOptOut, resolveSandboxConfig, worktreeOptOutIsAuthorized } from "../../sandbox/config.ts";
import { createIsolatedGitRuntime, createIsolatedGitWorktree, exportIsolatedGitBundle, cleanupIsolatedGitRuntime, stripIsolatedGitExportDiagnostics, type IsolatedGitRuntime, type IsolatedGitWorktree } from "../../sandbox/isolated-git.ts";
import { hasSandboxWritableAgent, inferSandboxCwdWritable, sandboxParallelWorktreeRequiredMessage } from "../../sandbox/write-inference.ts";
import { packagedAgentIsReadOnly, resolvePackagedAgentRole } from "../shared/agent-role.ts";
import { resolveCapabilityRights } from "../shared/capability-rights.ts";
import type { ResolvedSandboxConfig, SandboxRunConfig, SandboxSettingsDefaults } from "../../sandbox/types.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type ChainClarifyPolicy } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveFastModeStatus } from "../../shared/fast-mode.ts";
import { executeChain } from "./chain-execution.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { runSync } from "./execution.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { runSandboxPreflight } from "../../sandbox/preflight.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import { writePersistedForegroundStatus, type PersistedForegroundStep } from "./foreground-status.ts";
import { createForkContextResolver } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, stripContactSupervisorFromAgent, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { resolveSavedOutputPath, shouldPersistSavedOutput } from "../../shared/output-paths.ts";
import { compactForegroundDetails, getAgentDir, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd } from "../../shared/utils.ts";
import { MapConcurrentError } from "../shared/parallel-utils.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentIntercomMessageEvent,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { createNestedRoute, projectNestedEvents, readNestedControlResults, resolveInheritedNestedRouteFromEnv, resolveRequiredInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, updateAsyncJobNestedProjection, updateForegroundNestedProjection, validateNestedRouteForRevival, waitForNestedDescendantsToStop, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { registerForegroundInterrupt } from "../shared/foreground-control.ts";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_INTERCOM_EXTENSION_DIR_ENV, SUBAGENT_INTERCOM_STATE_DIR_ENV, SUBAGENT_SCOPED_GIT_ENDPOINT_ENV } from "../shared/pi-args.ts";
import { delegateScopedGitWriterDescriptor, readScopedGitProcessIdentity, reserveScopedGitChildDescriptor, validateScopedGitChildDescriptor, type IsolatedGitCapability, type ScopedGitEndpointDescriptor } from "../../sandbox/isolated-git.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { isExpectedAsyncRunnerPid } from "../background/pid-identity.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";

function exportBundleWithRetries(runtime: IsolatedGitRuntime, options: Parameters<typeof exportIsolatedGitBundle>[1]): ReturnType<typeof exportIsolatedGitBundle> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try { return exportIsolatedGitBundle(runtime, options); }
		catch (error) { lastError = error; }
	}
	throw lastError;
}
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { validateAndFormatAgentOverridePolicy } from "../shared/agent-override-policy.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	formatRecoverableWorktreePaths,
	WorktreeDiffCaptureError,
	WorktreeSetupHookTeardownError,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AcceptanceInput,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncStatus,
	type ControlConfig,
	type ControlEvent,
	type AgentProgress,
	type Details,
	type ExtensionConfig,
	type IntercomEventBus,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunAddress,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type SandboxIntercomBridge,
	type SingleResult,
	type SubagentRunMode,
	type SubagentState,
	type TokenUsage,
	DEFAULT_ARTIFACT_CONFIG,
	FOREGROUND_DIR,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	SUBAGENT_ACTIONS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	resolveRunMaxSubagentDepth,
	wrapForkTask,
} from "../../shared/types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);

interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	fastMode?: boolean;
	skill?: string | string[] | boolean;
	acceptance?: AcceptanceInput;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	maxSubagentDepth?: number;
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sandbox?: SandboxRunConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	fastMode?: boolean;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	agentScope?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
	/** Foreground scoped Git endpoint supplied by the owner process. */
	isolatedGitEndpoint?: ScopedGitEndpointDescriptor;
	isolatedGitRights?: "read-only" | "writer";
}

function resolveChildSandboxConfig(input: {
	settings?: SandboxSettingsDefaults;
	agent?: AgentConfig;
	run?: SandboxRunConfig;
}): ResolvedSandboxConfig | undefined {
	return resolveSandboxConfig(input);
}

interface TeardownHooks {
	waitForNestedDescendantsToStop?: typeof waitForNestedDescendantsToStop;
	releaseInheritedContext?: (runtime: IsolatedGitRuntime, capability: IsolatedGitCapability) => void;
}

interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	allowMutatingManagementActions?: boolean;
	/** Internal lifecycle test seam; production defaults to the bounded fence timeout. */
	nestedFenceTimeoutMs?: number;
	/** Internal test seam; production defaults to exact /proc runner identity verification. */
	isExpectedAsyncRunnerPid?: typeof isExpectedAsyncRunnerPid;
	/** Internal lifecycle test seam; production uses the shared fence/release implementations. */
	teardownHooks?: TeardownHooks;
}

interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	asyncAgents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	inheritedNestedRoute?: NestedRouteInfo;
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running") return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

function nestedFenceTimeoutForExecutor(deps: Pick<ExecutorDeps, "nestedFenceTimeoutMs">): number | undefined {
	return Number.isFinite(deps.nestedFenceTimeoutMs) && deps.nestedFenceTimeoutMs !== undefined && deps.nestedFenceTimeoutMs >= 0
		? deps.nestedFenceTimeoutMs
		: undefined;
}

function nestedResolutionScopeForExecutor(deps: ExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}

function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

function foregroundResultState(results: SingleResult[]): "complete" | "failed" | "paused" | "cancelled" | "running" {
	const statuses = results.map((result) => result.teardownUnproven
		? { state: "running", teardownUnproven: true }
		: { state: result.progress?.status === "pending" || result.progress?.status === "running"
			? "running"
			: resolveSubagentResultStatus({ exitCode: result.exitCode, interrupted: result.interrupted, cancelled: result.cancelled, detached: result.detached }) });
	const state = resolveAggregateState(statuses);
	return state === "running" ? "running" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : state === "paused" ? "paused" : "complete";
}

/** Resolve the terminal state published for a nested foreground run. */
export function resolveNestedTerminalState(results: SingleResult[], isError = false): "complete" | "failed" | "paused" | "cancelled" | "running" {
	return results.length > 0 ? foregroundResultState(results) : isError ? "failed" : "complete";
}

function resolveNestedStepState(result: SingleResult): "complete" | "failed" | "paused" | "cancelled" | "running" {
	const status = resolveSubagentResultStatus({
		exitCode: result.exitCode,
		interrupted: result.interrupted,
		cancelled: result.cancelled,
		detached: result.detached,
		teardownUnproven: result.teardownUnproven,
	});
	return status === "detached" ? "running" : status === "cancelled" ? "cancelled" : status === "paused" ? "paused" : status === "failed" ? "failed" : "complete";
}

function isolatedGitCommitRequired(task: string | undefined, agent: AgentConfig | undefined, sandbox: ResolvedSandboxConfig | undefined, parentRights?: "writer" | "read-only"): boolean {
	return resolveCapabilityRights({
		packagedRole: resolvePackagedAgentRole(agent?.name, agent?.source),
		agentTools: agent?.tools,
		sandbox,
		taskMutationProhibited: taskDisallowsFileUpdates(task),
		parentRights,
		writableCwd: inferSandboxCwdWritable({ agentName: agent?.name, tools: agent?.tools, sandbox }),
		exclusiveLease: true,
	}) === "writer";
}

function tokenUsageFromSingleResult(result: SingleResult): TokenUsage | undefined {
	const input = result.usage?.input ?? result.usage?.inputTokens;
	const output = result.usage?.output ?? result.usage?.outputTokens;
	if (typeof input !== "number" || typeof output !== "number") return undefined;
	return { input, output, total: input + output };
}

function approximateTokenUsage(total: number | undefined): TokenUsage | undefined {
	return typeof total === "number" && Number.isFinite(total) && total > 0
		? { input: 0, output: total, total }
		: undefined;
}

export function foregroundChildrenFromResults(results: SingleResult[]): PersistedForegroundStep[] {
	return results.map((result, index) => ({
		agent: result.agent,
		...(result.groupId ? { groupId: result.groupId, unindexed: true as const } : result.flatIndex !== undefined ? { index: result.flatIndex } : { index }),
		status: result.progress?.status === "pending" || result.progress?.status === "running"
			? result.progress.status
			: resolveSubagentResultStatus({ exitCode: result.exitCode, interrupted: result.interrupted, cancelled: result.cancelled, detached: result.detached }),
		...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
		...(result.artifactPaths?.outputPath ? { artifactPath: result.artifactPaths.outputPath } : {}),
		...(result.model ? { model: result.model } : {}),
		...(result.thinking ? { thinking: result.thinking } : {}),
		...(result.fastMode ? { fastMode: result.fastMode } : {}),
		...(tokenUsageFromSingleResult(result) ? { totalTokens: tokenUsageFromSingleResult(result) } : {}),
		...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
		...(result.detached ? { detached: true } : {}),
		...(result.interrupted ? { interrupted: true } : {}),
		...(result.cancelled ? { cancelled: true } : {}),
		...(result.teardownUnproven ? { teardownUnproven: true } : {}),
		...(result.error ? { error: result.error } : {}),
		...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
		...(result.gitBundle ? { gitBundle: result.gitBundle } : {}),
	}));
}

function initialForegroundChildren(
	params: SubagentParamsLike,
	sessionFileForIndex: (idx?: number) => string | undefined,
	agents: AgentConfig[],
	availableModels: ModelInfo[],
	preferredProvider?: string,
): PersistedForegroundStep[] {
	const children: Array<{ agent: string; model?: string; fastMode?: boolean }> = [];
	const addChild = (agent: string, model?: string, fastMode?: boolean): void => {
		children.push({ agent, model, fastMode });
	};
	if (params.tasks?.length) {
		for (const task of params.tasks) addChild(task.agent, task.model, task.fastMode);
	} else if (params.chain?.length) {
		for (const step of params.chain) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) addChild(task.agent, task.model, task.fastMode);
			} else if (isDynamicParallelStep(step)) {
				addChild(step.parallel.agent, step.parallel.model, step.parallel.fastMode);
			} else if ("agent" in step && typeof step.agent === "string") {
				addChild(step.agent, step.model, step.fastMode);
			}
		}
	} else if (params.agent) {
		addChild(params.agent, params.model, params.fastMode);
	}
	return children.map((child, index) => {
		const config = agents.find((agent) => agent.name === child.agent);
		const configuredModel = child.model ?? config?.model;
		const model = configuredModel ? resolveModelCandidate(configuredModel, availableModels, preferredProvider) ?? configuredModel : undefined;
		const fastMode = resolveFastModeStatus(child.fastMode ?? config?.fastMode, model, availableModels, preferredProvider);
		return {
			agent: child.agent,
			index,
			status: index === 0 ? "running" : "pending",
			...(sessionFileForIndex(index) ? { sessionFile: sessionFileForIndex(index) } : {}),
			...(model ? { model } : {}),
			...(fastMode ? { fastMode } : {}),
		};
	});
}

function persistForegroundStatus(input: {
	runId: string;
	mode: "single" | "parallel" | "chain";
	cwd: string;
	sessionId?: string | null;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "cancelled";
	startedAt?: number;
	updatedAt?: number;
	children: PersistedForegroundStep[];
	currentAgent?: string;
	currentIndex?: number;
	currentTool?: string;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	groupDiagnostics?: Details["groupDiagnostics"];
	teardownUnproven?: boolean;
	foregroundDirRoot?: string;
}): void {
	try {
		writePersistedForegroundStatus(input.foregroundDirRoot ?? FOREGROUND_DIR, {
			runId: input.runId,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			cwd: input.cwd,
			mode: input.mode,
			state: input.state,
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			updatedAt: input.updatedAt ?? Date.now(),
			...(input.currentAgent ? { currentAgent: input.currentAgent } : {}),
			...(input.currentIndex !== undefined ? { currentIndex: input.currentIndex } : {}),
			...(input.currentTool ? { currentTool: input.currentTool } : {}),
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
			children: input.children,
			...(input.groupDiagnostics?.length ? { groupDiagnostics: input.groupDiagnostics } : {}),
			...(input.teardownUnproven ? { teardownUnproven: true } : {}),
			...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
		});
	} catch {
		// Foreground persistence should never fail the user-visible subagent run.
	}
}

function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId?: string | null; startedAt?: number; results: SingleResult[]; nestedChildren?: NestedRunSummary[]; groupDiagnostics?: Details["groupDiagnostics"] }): void {
	const updatedAt = Date.now();
	const diagnosticResults: SingleResult[] = (input.groupDiagnostics ?? []).map((diagnostic) => ({
		groupId: diagnostic.groupId,
		agent: diagnostic.agent,
		task: "dynamic aggregate diagnostic",
		exitCode: diagnostic.status === "failed" ? 1 : 0,
		success: diagnostic.status === "complete",
		...(diagnostic.status === "paused" ? { interrupted: true } : {}),
		...(diagnostic.status === "cancelled" ? { cancelled: true } : {}),
		...(diagnostic.error ? { error: diagnostic.error } : {}),
		...(diagnostic.finalOutput ?? diagnostic.output ? { finalOutput: diagnostic.finalOutput ?? diagnostic.output } : {}),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 },
	}));
	const children = foregroundChildrenFromResults([...input.results, ...diagnosticResults]);
	const teardownUnproven = input.results.some((result) => result.teardownUnproven === true);
	state.foregroundRuns ??= new Map();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
		updatedAt,
		children,
		...(teardownUnproven ? { teardownUnproven: true } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
	});
	persistForegroundStatus({
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		sessionId: input.sessionId,
		state: teardownUnproven ? "running" : foregroundResultState([...input.results, ...diagnosticResults]),
		teardownUnproven,
		startedAt: input.startedAt,
		updatedAt,
		children,
		...(input.groupDiagnostics?.length ? { groupDiagnostics: input.groupDiagnostics } : {}),
		sessionFile: children.find((child) => child.sessionFile)?.sessionFile,
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
	});
	while (state.foregroundRuns.size > 50) {
		const oldest = [...state.foregroundRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldest) break;
		state.foregroundRuns.delete(oldest.runId);
	}
}

function resolveForegroundResumeTarget(params: SubagentParamsLike, state: SubagentState): { runId: string; mode: "single" | "parallel" | "chain"; state: "complete"; agent: string; index: number; intercomTarget: string; cwd: string; sessionFile: string } | undefined {
	const requested = (params.id ?? params.runId)?.trim();
	if (!requested || !state.foregroundRuns?.size) return undefined;
	const direct = state.foregroundRuns.get(requested);
	const matches = direct ? [direct] : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	const run = matches[0]!;
	if (run.teardownUnproven === true || run.children.some((child) => child.teardownUnproven === true)) {
		throw new Error(`Foreground run '${run.runId}' has unproven teardown and cannot be resumed safely.`);
	}
	const canonicalChildren = run.children.filter((child) => !child.groupId && !(child as { unindexed?: boolean }).unindexed);
	if (canonicalChildren.length > 1 && params.index === undefined) throw new Error(`Foreground run '${run.runId}' has ${canonicalChildren.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= canonicalChildren.length) throw new Error(`Foreground run '${run.runId}' has ${canonicalChildren.length} children. Index ${index} is out of range.`);
	const child = canonicalChildren.find((candidate) => candidate.index === index) ?? canonicalChildren[index]!;
	if (child.status === "detached") throw new Error(`Foreground run '${run.runId}' child ${index} is detached for intercom coordination and cannot be revived safely from the remembered foreground state. Reply to the supervisor request first; after the child exits, start a fresh follow-up if needed.`);
	if (!child.sessionFile) throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
	if (path.extname(child.sessionFile) !== ".jsonl") throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile)) throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
	return { runId: run.runId, mode: run.mode, state: "complete", agent: child.agent, index, intercomTarget: resolveSubagentIntercomTarget(run.runId, child.agent, index), cwd: run.cwd, sessionFile };
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused" | "cancelled";
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile: string;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: AsyncStatus["nestedSelf"];
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(params: SubagentParamsLike, state: SubagentState): ResumeSourceTarget {
	const requested = (params.id ?? params.runId)?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = { source: "async", ...resolveAsyncResumeTarget(params) };
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested)) throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id or runId.");
}

function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

function resolveSandboxIntercomBridge(intercomBridge: IntercomBridgeState): SandboxIntercomBridge | undefined {
	if (!intercomBridge.active) return undefined;
	return {
		extensionDir: intercomBridge.extensionDir,
		stateDir: process.env[SUBAGENT_INTERCOM_STATE_DIR_ENV] || path.join(getAgentDir(), "intercom"),
	};
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

function interruptAsyncRun(state: SubagentState, runId: string | undefined, verifyRunnerPid: typeof isExpectedAsyncRunnerPid): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const status = readStatus(target.asyncDir);
	if (!status || status.state !== "running" || !verifyRunnerPid(status.pid, target.asyncId, status.runnerIdentity)) {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		const tracked = state.asyncJobs.get(target.asyncId);
		const cascade = cascadeStopNestedDescendants({ route: tracked?.nestedRoute, children: tracked?.nestedChildren, sourceRunId: target.asyncId, verifyRunnerPid });
		process.kill(status.pid, ASYNC_INTERRUPT_SIGNAL);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
			try {
				updateAsyncJobNestedProjection(tracked);
			} catch {
				// Non-fatal: cascadeStopNestedDescendants already made a best-effort status update.
			}
		}
		return {
			content: [{ type: "text", text: appendNestedCleanupSummary(`Interrupt requested for async run ${target.asyncId}.`, cascade) }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function nestedRunSessionFile(run: NestedRunSummary, index: number): string | undefined {
	const indexedStep = run.steps?.find((step, position) => (step.flatIndex ?? position) === index);
	if (indexedStep) return indexedStep.sessionFile;
	const isSingleChild = (run.steps?.length ?? run.agents?.length ?? run.chainStepCount ?? 1) === 1;
	return index === 0 && isSingleChild ? run.sessionFile : undefined;
}

function nestedRunAgent(run: NestedRunSummary, index: number): string | undefined {
	return run.steps?.find((step, position) => (step.flatIndex ?? position) === index)?.agent
		?? run.agents?.[index]
		?? (index === 0 ? run.agent : undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateNestedSessionFile(run: NestedRunSummary, index: number, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run, index);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	const authorizedSessionRunIds = new Set([run.id, ...run.path.map((entry) => entry.runId)]);
	if (!realSessionFile.split(path.sep).some((segment) => authorizedSessionRunIds.has(segment))) {
		throw new Error(`Nested run '${run.id}' session file is not under its authenticated run lineage: ${sessionFile}`);
	}
	return realSessionFile;
}

function sameNestedRoute(left: NestedRouteInfo, right: NestedRouteInfo): boolean {
	return left.rootRunId === right.rootRunId && left.eventSink === right.eventSink && left.controlInbox === right.controlInbox && left.capabilityToken === right.capabilityToken;
}

function resolveNestedResumeTarget(match: ResolvedSubagentRunId & { kind: "nested" }, trustedSessionRoots: string[], requestedIndex?: number): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued") throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	const registryChildCount = run.steps?.length ?? run.agents?.length ?? run.chainStepCount ?? 1;
	const singleChildSession = registryChildCount === 1 ? validateNestedSessionFile(run, 0, trustedSessionRoots) : undefined;
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	if (!asyncDir) throw new Error(`Nested run '${run.id}' has no trusted persisted async directory.`);
	const nestedRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", match.match.rootRunId);
	const persisted = resolveAsyncResumeTarget(
		{ id: run.id, dir: asyncDir, ...(requestedIndex !== undefined ? { index: requestedIndex } : {}) },
		{ asyncDirRoot: nestedRoot, resultsDir: path.join(RESULTS_DIR, "nested", match.match.rootRunId) },
	);
	if (persisted.kind !== "revive") throw new Error(`Nested run '${run.id}' is still live; route the follow-up to the owner process instead.`);
	const route = validateNestedRouteForRevival(match.match.route);
	if (!persisted.nestedRoute || !sameNestedRoute(route, persisted.nestedRoute)) throw new Error(`Nested run '${run.id}' persisted route does not match its authenticated registry route.`);
	const authenticatedAgent = nestedRunAgent(run, persisted.index);
	if (!authenticatedAgent || persisted.agent !== authenticatedAgent) throw new Error(`Nested run '${run.id}' persisted agent does not match its authenticated registry entry.`);
	if (!run.cwd || !persisted.cwd || path.resolve(run.cwd) !== path.resolve(persisted.cwd)) throw new Error(`Nested run '${run.id}' persisted cwd does not match its authenticated registry entry.`);
	const sessionFile = persisted.index === 0 && singleChildSession
		? singleChildSession
		: validateNestedSessionFile(run, persisted.index, trustedSessionRoots);
	if (persisted.sessionFile && path.resolve(persisted.sessionFile) !== path.resolve(sessionFile)) throw new Error(`Nested run '${run.id}' persisted session does not match its authenticated registry entry.`);
	const lineage = run.path.at(-1)?.runId === run.id ? run.path : [...run.path, { runId: run.id, ...(run.parentStepIndex !== undefined ? { stepIndex: run.parentStepIndex } : {}), ...(persisted.agent ? { agent: persisted.agent } : {}) }];
	return {
		...persisted,
		source: "nested",
		sessionFile,
		nestedRoute: route,
		nestedSelf: {
			parentRunId: run.parentRunId,
			...(run.parentStepIndex !== undefined ? { parentStepIndex: run.parentStepIndex } : {}),
			depth: run.depth,
			path: lineage,
		},
	};
}

async function waitForNestedControlResult(target: ResolvedSubagentRunId & { kind: "nested" }, requestId: string, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = readNestedControlResults(target.match.route).find((candidate) => candidate.requestId === requestId && candidate.targetRunId === target.match.run.id);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function sendNestedControlRequest(target: ResolvedSubagentRunId & { kind: "nested" }, action: "interrupt" | "resume", message?: string) {
	const requestId = randomUUID();
	writeNestedControlRequest(target.match.route, {
		ts: Date.now(),
		requestId,
		targetRunId: target.match.run.id,
		action,
		...(message ? { message } : {}),
	});
	return waitForNestedControlResult(target, requestId);
}

function isTerminalNestedState(state: NestedRunSummary["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "cancelled";
}

function collectLiveNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = [], visited = new Set<string>()): NestedRunSummary[] {
	for (const child of children ?? []) {
		if (visited.has(child.id)) continue;
		visited.add(child.id);
		collectLiveNestedRuns(child.children, output, visited);
		collectLiveNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output, visited);
		if (!isTerminalNestedState(child.state)) output.push(child);
	}
	return output;
}

function trustedRunningAsyncPid(status: AsyncStatus | null): number | undefined {
	if (!status || (status.state !== "running" && status.state !== "queued")) return undefined;
	return typeof status.pid === "number" && Number.isFinite(status.pid) && Number.isInteger(status.pid) && status.pid > 0 ? status.pid : undefined;
}

function nestedRunTerminalAcknowledged(route: NestedRouteInfo, runId: string): boolean {
	try {
		// collectLiveNestedRuns intentionally excludes terminal records, so a
		// matching descendant that is absent from the live set is acknowledged
		// only when the projection contains an explicit terminal state.
		const walk = (children: NestedRunSummary[] | undefined): NestedRunSummary | undefined => {
			for (const child of children ?? []) {
				if (child.id === runId) return child;
				const nested = walk(child.children) ?? walk(child.steps?.flatMap((step) => step.children ?? []));
				if (nested) return nested;
			}
			return undefined;
		};
		const acknowledged = walk(projectNestedEvents(route).children);
		return Boolean(acknowledged && isTerminalNestedState(acknowledged.state));
	} catch {
		return false;
	}
}

function markNestedRunPaused(route: NestedRouteInfo, run: NestedRunSummary, message: string): void {
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

function cascadeStopNestedDescendants(input: { route?: NestedRouteInfo; children?: NestedRunSummary[]; sourceRunId: string; kill?: typeof process.kill; verifyRunnerPid: typeof isExpectedAsyncRunnerPid }): { stopped: number; warnings: string[] } {
	const route = input.route;
	if (!route) return { stopped: 0, warnings: [] };
	let children = input.children;
	const warnings: string[] = [];
	try {
		if (!children) children = projectNestedEvents(route).children;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { stopped: 0, warnings: [`Nested cleanup warning for ${input.sourceRunId}: status projection failed: ${message}`] };
	}
	let stopped = 0;
	for (const run of collectLiveNestedRuns(children)) {
		let acted = false;
		try {
			writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: randomUUID(),
				targetRunId: run.id,
				action: "interrupt",
			});
			acted = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`Nested cleanup warning for ${run.id}: control request failed: ${message}`);
		}
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (asyncDir) {
			try {
				const nestedStatus = readStatus(asyncDir);
				const pid = trustedRunningAsyncPid(nestedStatus);
				if (typeof pid === "number" && input.verifyRunnerPid(pid, run.id, nestedStatus?.runnerIdentity)) {
					acted = (input.kill ?? process.kill)(pid, ASYNC_INTERRUPT_SIGNAL) !== false || acted;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`Nested cleanup warning for ${run.id}: async pid interrupt failed: ${message}`);
			}
		}
		try {
			// A terminal projection is the descendant's actual acknowledgement. Do
			// not rewrite completed/failed/cancelled state as paused; if no terminal
			// projection exists, leave the child live/actionable for the fence.
			nestedRunTerminalAcknowledged(route, run.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`Nested cleanup warning for ${run.id}: pause status update failed: ${message}`);
		}
		if (acted) stopped++;
	}
	return { stopped, warnings };
}

function appendNestedCleanupSummary(text: string, cascade: { stopped: number; warnings: string[] }): string {
	const lines = [text];
	if (cascade.stopped > 0) lines.push(`Nested cleanup: interrupt requested for ${cascade.stopped} live descendant${cascade.stopped === 1 ? "" : "s"}.`);
	lines.push(...cascade.warnings);
	return lines.join("\n");
}

function directNestedAsyncInterrupt(target: ResolvedSubagentRunId & { kind: "nested" }, verifyRunnerPid: typeof isExpectedAsyncRunnerPid): AgentToolResult<Details> | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const nestedStatus = readStatus(asyncDir);
	const pid = trustedRunningAsyncPid(nestedStatus);
	if (typeof pid !== "number" || !verifyRunnerPid(pid, run.id, nestedStatus?.runnerIdentity)) return undefined;
	try {
		process.kill(pid, ASYNC_INTERRUPT_SIGNAL);
		return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [] } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
	}
}

async function interruptNestedRun(target: ResolvedSubagentRunId & { kind: "nested" }, verifyRunnerPid: typeof isExpectedAsyncRunnerPid): Promise<AgentToolResult<Details>> {
	const run = target.match.run;
	if (run.state === "complete") return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "failed") return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "paused") return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	const direct = directNestedAsyncInterrupt(target, verifyRunnerPid);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeLiveNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string }): Promise<AgentToolResult<Details>> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message);
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
}): Promise<AgentToolResult<Details>> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	if (!followUp) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		const resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		if (resolved?.kind === "nested") {
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				return resumeLiveNestedRun({ target: resolved, message: followUp });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots, input.params.index);
		} else {
			target = resolveResumeTarget(input.params, input.deps.state);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live") {
		const delivered = await deliverSubagentIntercomMessageEvent(
			input.deps.pi.events,
			target.intercomTarget,
			`Follow-up for async run ${target.runId} (${target.agent}):\n\n${followUp}`,
			500,
			{ source: "async-resume", runId: target.runId, agent: target.agent, index: target.index },
		);
		if (delivered) {
			return {
				content: [{ type: "text", text: [`Delivered follow-up to live async child.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`].join("\n") }],
				details: { mode: "management", results: [] },
			};
		}
		return {
			content: [{ type: "text", text: [`Async child appears live but its intercom target is not registered.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`, `Wait for completion, then retry action='resume'.`].join("\n") }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discoveredAgents = input.deps.discoverAgents(effectiveCwd, scope).agents;
	const orchestratorTarget = resolveIntercomSessionTarget(
		input.deps.pi.getSessionName(),
		input.ctx.sessionManager.getSessionId(),
		process.env.PI_INTERCOM_SESSION_ID,
	);
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget,
		cwd: effectiveCwd,
		extensionDir: process.env[SUBAGENT_INTERCOM_EXTENSION_DIR_ENV],
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const agentConfig = agents.find((agent) => agent.name === target.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const runId = randomUUID().slice(0, 8);
	const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false };
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const sandbox = resolveSandboxConfig({ agent: agentConfig, run: input.params.sandbox });
	let scopedGitEndpoint: ScopedGitEndpointDescriptor | undefined;
	try {
		scopedGitEndpoint = target.nestedSelf
			? await reserveAsyncScopedEndpoint(input.scopedGitEndpoint, effectiveCwd, isolatedGitCommitRequired(followUp, agentConfig, sandbox))
			: undefined;
	} catch (error) {
		return { content: [{ type: "text", text: `Scoped Git endpoint preflight rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "management", results: [] } };
	}
	const result = executeAsyncSingle(runId, {
		agent: target.agent,
		task: buildRevivedAsyncTask(target, followUp),
		agentConfig,
		ctx: {
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			currentModelProvider: input.ctx.model?.provider,
		},
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput,
		artifactsDir: input.deps.tempArtifactsDir,
		artifactConfig,
		shareEnabled: input.params.share === true,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
		sessionFile: target.sessionFile,
		maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		availableModels,
		nestedRoute: target.nestedRoute,
		...(target.nestedSelf ? { nestedSelf: target.nestedSelf } : {}),
		sandbox,
		scopedGitEndpoint,
	});
	bindAsyncScopedWriter(scopedGitEndpoint, result);
	if (result.isError) return result;

	const revivedId = result.details.asyncId ?? runId;
	const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }], details: result.details };
}

function resultSummaryForIntercom(result: SingleResult): string {
	const output = getSingleResultOutput(result);
	if (result.exitCode !== 0 && result.error) {
		return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
	}
	return output || result.error || "(no output)";
}

function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
		pi: deps.pi,
		controlConfig: data.controlConfig,
		intercomBridge: data.intercomBridge,
		event,
	});
}

async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
	chainSteps?: number;
	nestedChildren?: NestedRunSummary[];
	worktreeSummary?: string;
	groupDiagnostics?: Details["groupDiagnostics"];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	if (!input.intercomBridge.active || !input.intercomBridge.orchestratorTarget) return null;
	const diagnosticChildren = (input.groupDiagnostics ?? []).map((diagnostic) => ({
		agent: diagnostic.agent,
		status: diagnostic.status,
		summary: diagnostic.error ?? diagnostic.finalOutput ?? diagnostic.output ?? "(no output)",
		groupId: diagnostic.groupId,
	}));
	// Keep detached acknowledgements in grouped receipts. They are genuine
	// indexed children (and remain non-terminal); a later terminal projection
	// clears the flag at the same canonical index. Dropping them here loses the
	// child entirely and shifts every following index.
	const children = input.results.map((result, index) => ({
		agent: result.agent,
		status: resolveSubagentResultStatus({
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			cancelled: result.cancelled,
			detached: result.detached,
			teardownUnproven: result.teardownUnproven,
		}),
		summary: resultSummaryForIntercom(result),
		...(result.fastMode ? { fastMode: result.fastMode } : {}),
		...(result.teardownUnproven ? { teardownUnproven: true } : {}),
		...(result.groupId ? { groupId: result.groupId } : result.flatIndex !== undefined ? { index: result.flatIndex } : { index }),
		artifactPath: result.artifactPaths?.outputPath,
		...(result.gitBundle ? { gitBundle: result.gitBundle } : {}),
		sessionPath: result.sessionFile,
		intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, result.flatIndex ?? index),
	}));
	if (children.length === 0 && diagnosticChildren.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		source: "foreground",
		children: attachNestedChildrenToResultChildren(input.runId, [...children, ...diagnosticChildren], input.nestedChildren),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
	});
	if (input.worktreeSummary) payload.message = `${payload.message}\n\n${input.worktreeSummary}`;
	const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
	if (!delivered) return null;
	return payload;
}

async function maybeBuildForegroundIntercomReceipt(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	nestedChildren?: NestedRunSummary[];
	worktreeSummary?: string;
}): Promise<{ text: string; details: Details } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
		groupDiagnostics: input.details.groupDiagnostics,
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
		...(input.worktreeSummary ? { worktreeSummary: input.worktreeSummary } : {}),
	});
	if (!payload) return null;
	return {
		text: `${formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload })}${input.worktreeSummary ? `\n\n${input.worktreeSummary}` : ""}`,
		details: stripDetailsOutputsForIntercomReceipt(input.details),
	};
}

async function reserveAsyncScopedEndpoint(descriptor: ScopedGitEndpointDescriptor | undefined, cwd: string, writer: boolean): Promise<ScopedGitEndpointDescriptor | undefined> {
	if (!descriptor) return undefined;
	return reserveScopedGitChildDescriptor(descriptor, { cwd, rights: writer ? "writer" : "read-only" });
}

function bindAsyncScopedWriter(descriptor: ScopedGitEndpointDescriptor | undefined, result: { details?: Details }): void {
	if (!descriptor) return;
	const identityData = (result.details as Details & { __scopedRunnerPid?: number; __scopedRunnerStartToken?: string; __scopedRunnerUid?: number } | undefined);
	if (!identityData?.__scopedRunnerPid || !identityData.__scopedRunnerStartToken || identityData.__scopedRunnerUid === undefined) return;
	const identity = readScopedGitProcessIdentity(identityData.__scopedRunnerPid);
	if (!identity || identity.startToken !== identityData.__scopedRunnerStartToken || identity.uid !== identityData.__scopedRunnerUid) return;
	void delegateScopedGitWriterDescriptor(descriptor, identity).catch(() => { /* owner remains fail-closed */ });
}

function validationErrorResult(mode: Details["mode"], text: string): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError: true, details: { mode, results: [] } };
}

function isRalphNestedWorkerAgentName(agent: unknown): boolean {
	return typeof agent === "string" && (
		agent === "work"
		|| agent === "worker"
		|| agent.endsWith("-work")
		|| agent.endsWith("-worker")
	);
}

function isOrchestratorInlineLoopAgentName(agent: unknown): boolean {
	if (typeof agent !== "string") return false;
	const role = agent.toLowerCase().split(".").at(-1);
	return ["explore", "explorer", "work", "worker", "review", "reviewer"].some((name) =>
		agent === name || agent.endsWith(`-${name}`) || role === name);
}

function collectRalphNestedLaunchAgentTargets(params: SubagentParamsLike): string[] {
	const targets: string[] = [];
	const visitAgent = (agent: unknown) => {
		if (typeof agent === "string") targets.push(agent);
	};

	if ((params.chain?.length ?? 0) > 0) {
		for (const step of params.chain ?? []) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) visitAgent(task.agent);
			} else if (isDynamicParallelStep(step)) {
				visitAgent(step.parallel.agent);
			} else {
				visitAgent((step as SequentialStep).agent);
			}
		}
	} else if ((params.tasks?.length ?? 0) > 0) {
		for (const task of params.tasks ?? []) visitAgent(task.agent);
	} else {
		visitAgent(params.agent);
	}
	return targets;
}

function isOrchestratorNestedLaunch(input: {
	params: SubagentParamsLike;
	inheritedNestedRoute?: NestedRouteInfo;
	nestedParentAddress?: NestedRunAddress;
}, matchesAgent: (agent: unknown) => boolean): boolean {
	if (process.env[SUBAGENT_CHILD_AGENT_ENV] !== "orchestrator") return false;
	if (!input.inheritedNestedRoute || !input.nestedParentAddress) return false;
	return collectRalphNestedLaunchAgentTargets(input.params).some(matchesAgent);
}

function isRalphOrchestratorNestedWorkerLaunch(input: {
	params: SubagentParamsLike;
	inheritedNestedRoute?: NestedRouteInfo;
	nestedParentAddress?: NestedRunAddress;
}): boolean {
	return isOrchestratorNestedLaunch(input, isRalphNestedWorkerAgentName);
}

function validateAcceptanceForExecution(params: SubagentParamsLike): AgentToolResult<Details> | null {
	const topLevelErrors = validateAcceptanceInput(params.acceptance);
	if (topLevelErrors.length > 0) return validationErrorResult("single", topLevelErrors.join(" "));
	for (const [index, task] of (params.tasks ?? []).entries()) {
		const errors = validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`);
		if (errors.length > 0) return validationErrorResult("parallel", errors.join(" "));
	}
	for (const [stepIndex, step] of (params.chain ?? []).entries()) {
		if (isParallelStep(step)) {
			if (Object.hasOwn(step, "acceptance")) return validationErrorResult("chain", `chain[${stepIndex}].acceptance is not supported on static parallel groups; set acceptance on each parallel task.`);
			for (const [taskIndex, task] of step.parallel.entries()) {
				const errors = validateAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`);
				if (errors.length > 0) return validationErrorResult("chain", errors.join(" "));
			}
		} else if (isDynamicParallelStep(step)) {
			if (Object.hasOwn(step, "acceptance")) return validationErrorResult("chain", `chain[${stepIndex}].acceptance is not supported on dynamic fanout groups; set acceptance on chain[${stepIndex}].parallel.acceptance for each materialized child.`);
			const errors = validateAcceptanceInput(step.parallel.acceptance, `chain[${stepIndex}].parallel.acceptance`);
			if (errors.length > 0) return validationErrorResult("chain", errors.join(" "));
		} else {
			const stepErrors = validateAcceptanceInput(step.acceptance, `chain[${stepIndex}].acceptance`);
			if (stepErrors.length > 0) return validationErrorResult("chain", stepErrors.join(" "));
		}
	}
	return null;
}

function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	const acceptanceError = validateAcceptanceForExecution(params);
	if (acceptanceError) return acceptanceError;

	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (isDynamicParallelStep(firstStep)) {
			return {
				content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

function applyAgentDefaultContext(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if (params.context !== undefined) return params;
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names.some((name) => byName.get(name)?.defaultContext === "fork")
		? { ...params, context: "fork" }
		: params;
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

function withForkContext(
	result: AgentToolResult<Details>,
	context: SubagentParamsLike["context"],
): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForIndex: (idx?: number) => string | undefined,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (let i = 0; i < step.parallel.length; i++) {
				sessionFiles.push(sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			sessionFiles.push(undefined);
			continue;
		}
		sessionFiles.push(sessionFileForIndex(flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}

function wrapChainTasksForFork(chain: ChainStep[], context: SubagentParamsLike["context"]): ChainStep[] {
	if (context !== "fork") return chain;
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapForkTask(task.task ?? "{previous}"),
				})),
			};
		}
		if (isDynamicParallelStep(step)) {
			return {
				...step,
				parallel: {
					...step.parallel,
					task: wrapForkTask(step.parallel.task ?? "{previous}"),
				},
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}")),
		};
	});
}

async function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details> | null> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	let asyncScopedEndpoint: ScopedGitEndpointDescriptor | undefined = data.scopedGitEndpoint;
	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		currentModelProvider: ctx.model?.provider,
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveRunMaxSubagentDepth(params.maxSubagentDepth, deps.config.maxSubagentDepth);
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;
	const sandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(params.agentScope));
	const sandbox = resolveSandboxConfig({
		settings: sandboxSettings,
		run: params.sandbox,
	});
	const sandboxIntercomBridge = resolveSandboxIntercomBridge(intercomBridge);

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveModelCandidate(task.model ?? agentConfigs[index]?.model, availableModels, currentProvider),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: params.context === "fork" ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(task.fastMode !== undefined ? { fastMode: task.fastMode } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.output === true ? (agentConfigs[index]?.output ? { output: agentConfigs[index]!.output } : {}) : task.output !== undefined ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
			...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
		}));
		try {
			const wantsWriter = params.tasks.some((task, index) => inferSandboxCwdWritable({ agentName: task.agent, tools: agentConfigs[index]?.tools, sandbox }));
			asyncScopedEndpoint = await reserveAsyncScopedEndpoint(asyncScopedEndpoint, effectiveCwd, wantsWriter);
		} catch (error) {
			return validationErrorResult("parallel", `Scoped Git endpoint reservation failed closed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const asyncResult = executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: "parallel",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((_, index) => sessionFileForIndex(index)),
			scopedGitEndpoint: asyncScopedEndpoint,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			sandbox,
			sandboxSettings,
			sandboxRun: params.sandbox,
			sandboxIntercomBridge,
		});
		bindAsyncScopedWriter(asyncScopedEndpoint, asyncResult);
		return asyncResult;
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
		try {
			const wantsWriter = chain.some((step) => {
				const tasks = isParallelStep(step) ? step.parallel : isDynamicParallelStep(step) ? [step.parallel] : [step];
				return tasks.some((task: any) => inferSandboxCwdWritable({ agentName: task.agent, tools: agents.find((candidate) => candidate.name === task.agent)?.tools, sandbox }));
			});
			asyncScopedEndpoint = await reserveAsyncScopedEndpoint(asyncScopedEndpoint, effectiveCwd, wantsWriter);
		} catch (error) {
			return validationErrorResult("chain", `Scoped Git endpoint reservation failed closed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const asyncResult = executeAsyncChain(id, {
			chain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForIndex),
			scopedGitEndpoint: asyncScopedEndpoint,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			sandbox,
			sandboxSettings,
			sandboxRun: params.sandbox,
			sandboxIntercomBridge,
		});
		bindAsyncScopedWriter(asyncScopedEndpoint, asyncResult);
		return asyncResult;
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveModelCandidate((params.model as string | undefined) ?? a.model, availableModels, currentProvider);
		const singleSandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(params.agentScope));
		let singleSandbox = resolveSandboxConfig({
			settings: singleSandboxSettings,
			agent: a,
			run: params.sandbox,
		});
		if (params.worktree === false && !asyncScopedEndpoint && singleSandbox?.gitMode === "isolated"
			&& worktreeOptOutIsAuthorized(singleSandboxSettings)
			&& a.canOptOutOfWorktree === true) {
			singleSandbox = { ...singleSandbox, gitMode: "read-only" };
		}
		try {
			asyncScopedEndpoint = await reserveAsyncScopedEndpoint(asyncScopedEndpoint, effectiveCwd, inferSandboxCwdWritable({ agentName: a.name, tools: a.tools, sandbox: singleSandbox }));
		} catch (error) {
			return validationErrorResult("single", `Scoped Git endpoint reservation failed closed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const asyncResult = executeAsyncSingle(id, {
			agent: params.agent!,
			task: params.context === "fork" ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForIndex(0),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			modelOverride,
			fastMode: params.fastMode,
			maxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
			acceptance: params.acceptance,
			sandbox: singleSandbox,
			sandboxSettings: singleSandboxSettings,
			sandboxRun: params.sandbox,
			worktree: params.worktree,
			sandboxIntercomBridge: resolveSandboxIntercomBridge(intercomBridge),
			scopedGitEndpoint: asyncScopedEndpoint,
		});
		bindAsyncScopedWriter(asyncScopedEndpoint, asyncResult);
		return asyncResult;
	}

	return null;
}

async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
	const currentMaxSubagentDepth = resolveRunMaxSubagentDepth(params.maxSubagentDepth, deps.config.maxSubagentDepth);
	const sandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(params.agentScope));
	const sandbox = resolveSandboxConfig({
		settings: sandboxSettings,
		run: params.sandbox,
	});
	const sandboxIntercomBridge = resolveSandboxIntercomBridge(data.intercomBridge);
	let terminalChainResults: SingleResult[] | undefined;
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onDetachedTerminal: (results) => {
			const priorTerminal = new Map((terminalChainResults ?? []).map((result) => [result.flatIndex, result]));
			terminalChainResults = results.map((result, position) => {
				const prior = priorTerminal.get(result.flatIndex) ?? terminalChainResults?.[position];
				return prior?.gitBundle && !result.gitBundle ? { ...result, ...prior, gitBundle: prior.gitBundle } : result;
			});
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, {
				runId,
				mode: "chain",
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				startedAt: foregroundControl?.startedAt,
				results: terminalChainResults,
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
		},
		onControlEvent,
		controlConfig,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		nestedFenceTimeoutMs: nestedFenceTimeoutForExecutor(deps),
		chainSkills,
		chainDir: params.chainDir,
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		sandbox,
		sandboxSettings,
		sandboxRun: params.sandbox,
		sandboxIntercomBridge,
		scopedGitEndpoint: data.scopedGitEndpoint,
		teardownHooks: deps.teardownHooks,
	});

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			currentModelProvider: ctx.model?.provider,
		};
		const asyncChain = wrapChainTasksForFork(chainResult.requestedAsync.chain, params.context);
		return executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			agents: data.asyncAgents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForIndex),
			scopedGitEndpoint: data.scopedGitEndpoint,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			nestedRoute: data.nestedRoute,
			sandbox,
			sandboxSettings,
			sandboxRun: params.sandbox,
			sandboxIntercomBridge,
		});
	}

	const chainDetails = chainResult.details ? compactForegroundDetails({ ...chainResult.details, runId }) : undefined;
	// Chain export/rejection diagnostics are attached to child results. Keep the
	// same diagnostic text in the public inline projection so callers without an
	// intercom bridge cannot lose the original execution error or packaging root.
	const chainResultErrors = chainDetails?.results
		.filter((result) => result.error)
		.map((result) => `${result.agent}: ${result.error}`) ?? [];
	const chainInlineText = chainResult.content[0]?.text;
	const chainVisibleText = chainInlineText && chainResultErrors.length > 0
		? `${chainInlineText}${chainResultErrors.every((message) => chainInlineText.includes(message)) ? "" : `\n\n${chainResultErrors.join("\n")}`}`
		: chainInlineText;
	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	if (chainDetails) {
		const prior = deps.state.foregroundRuns.get(runId);
		const terminalByIndex = new Map((terminalChainResults ?? []).filter((result) => result.flatIndex !== undefined).map((result) => [result.flatIndex!, result]));
		const priorByIndex = new Map((prior?.children ?? []).filter((child) => child.index !== undefined).map((child) => [child.index!, child]));
		const durableSource = terminalChainResults ?? chainDetails.results;
		const durableResults = durableSource.map((result, position) => {
			const terminalResult = terminalByIndex.get(result.flatIndex);
			const priorResult = priorByIndex.get(result.flatIndex) ?? prior?.children[position];
			if (terminalResult?.gitBundle) return { ...result, ...terminalResult, gitBundle: terminalResult.gitBundle };
			return result.gitBundle || !priorResult?.gitBundle ? result : { ...result, gitBundle: priorResult.gitBundle };
		});
		rememberForegroundRun(deps.state, {
			runId,
			mode: "chain",
			cwd: effectiveCwd,
			sessionId: deps.state.currentSessionId,
			startedAt: foregroundControl?.startedAt,
			results: durableResults,
			...(chainDetails.groupDiagnostics?.length ? { groupDiagnostics: chainDetails.groupDiagnostics } : {}),
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
	}
	const intercomReceipt = chainDetails && !chainResult.worktreeCaptureFailed && !chainDetails.results.some((result) => result.detached)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			...(chainResult.worktreeSummary ? { worktreeSummary: chainResult.worktreeSummary } : {}),
		})
		: null;
	if (intercomReceipt) {
		return {
			...chainResult,
			content: [{ type: "text", text: chainVisibleText && (chainResult.worktreePreserved || chainResultErrors.length > 0) ? `${chainVisibleText}\n\n${intercomReceipt.text}` : intercomReceipt.text }],
			details: intercomReceipt.details,
		};
	}

	return chainDetails
		? { ...chainResult, ...(chainVisibleText ? { content: [{ type: "text", text: chainVisibleText }] } : {}), details: chainDetails }
		: chainResult;
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	maxSubagentDepths: number[];
	nestedFenceTimeoutMs?: number;
	availableModels: ModelInfo[];
	modelOverrides: (string | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
	isolatedGitWorktrees?: (IsolatedGitWorktree | undefined)[];
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	sandbox?: ResolvedSandboxConfig;
	sandboxes?: (ResolvedSandboxConfig | undefined)[];
	parentRights?: "writer" | "read-only";
	sandboxIntercomBridge?: SandboxIntercomBridge;
	issueIsolatedGitCapability?: (worktree: IsolatedGitWorktree, rights: "writer" | "read-only", cwd: string) => Promise<import("../../sandbox/isolated-git.ts").IsolatedGitCapability>;
	teardownHooks?: TeardownHooks;
	progressPaths?: string[];
	onDetachedStarted?: (index: number, result: SingleResult) => void;
	onDetachedTerminal?: (index: number, result: SingleResult) => void | Promise<void>;
}

function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details>; teardownUnproven?: boolean } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: { ...buildParallelModeError(message), details: { mode: "parallel", results: [], ...(error instanceof WorktreeSetupHookTeardownError ? { teardownUnproven: true } : {}) } } };
	}
}

function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
	isolatedGitWorktrees?: (IsolatedGitWorktree | undefined)[],
): string {
	// Isolated Git mapping happens inside runSingleAttempt, where the exact
	// requested parent repository cwd is still available. Returning the private
	// path here would make that mapping reject its own worktree as outside the
	// assigned repository and would also discard task cwd subdirectories.
	if (isolatedGitWorktrees?.[index]) return resolveChildCwd(paramsCwd, task.cwd);
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = path.join(artifactsDir, "worktree-diffs");
	const diffs = diffWorktrees(worktreeSetup, tasks.map((task) => task.agent), diffsDir);
	return formatWorktreeDiffSummary(diffs);
}

function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	worktreeSetup?: WorktreeSetup;
	isolatedGitWorktrees?: (IsolatedGitWorktree | undefined)[];
	absoluteOnly?: boolean;
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		if (input.absoluteOnly && (typeof behavior.output !== "string" || !path.isAbsolute(behavior.output))) continue;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index, input.isolatedGitWorktrees);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const flatIndex = index;
		if (input.signal.aborted || input.foregroundControl?.interruptRequested) {
			const cancelled = input.signal.aborted && !input.foregroundControl?.interruptRequested;
			return {
				flatIndex,
				agent: task.agent,
				task: task.task,
				exitCode: cancelled ? 1 : 0,
				...(cancelled ? { cancelled: true } : { interrupted: true }),
				success: false,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				error: cancelled ? "Cancelled before this task started." : "Interrupted before this task started.",
			};
		}
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index, input.isolatedGitWorktrees);
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		// Issue capability after the resolved per-task sandbox is available and
		// before output/session/artifact path work begins.
		const isolatedCapability = input.isolatedGitWorktrees?.[index]
			? await (input.issueIsolatedGitCapability
				? input.issueIsolatedGitCapability(input.isolatedGitWorktrees[index]!, isolatedGitCommitRequired(task.task, agentConfig, input.sandboxes?.[index] ?? input.sandbox, input.parentRights) ? "writer" : "read-only", taskCwd)
				: input.isolatedGitWorktrees[index]!.runtime.issueInheritedContext({
					worktree: input.isolatedGitWorktrees[index]!,
					rights: isolatedGitCommitRequired(task.task, agentConfig, input.sandboxes?.[index] ?? input.sandbox, input.parentRights) ? "writer" : "read-only",
					cwd: taskCwd,
				}))
			: undefined;
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.paramsCwd, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd);
		const savedOutputPath = shouldPersistSavedOutput({
			output: behavior?.output,
			outputMode: behavior?.outputMode,
			tools: agentConfig?.tools,
		})
			? resolveSavedOutputPath({ runtimeCwd: input.ctx.cwd, requestedCwd: taskCwd, agent: task.agent, runId: input.runId, index })
			: undefined;
		const instructionOutputPath = outputPath ?? (behavior?.outputMode === "file-only" ? savedOutputPath : undefined);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			instructionOutputPath,
		);
		const interruptController = new AbortController();
		let unregisterInterrupt: (() => void) | undefined;
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = index;
			input.foregroundControl.currentActivityState = undefined;
			input.foregroundControl.currentModel = input.modelOverrides[index] ?? input.agents.find((agent) => agent.name === task.agent)?.model;
			input.foregroundControl.currentThinking = undefined;
			input.foregroundControl.currentFastMode = resolveFastModeStatus(
				behavior?.fastMode,
				input.foregroundControl.currentModel,
				input.availableModels,
				input.ctx.model?.provider,
			);
			input.foregroundControl.updatedAt = Date.now();
			input.foregroundControl.sessionFile = input.sessionFileForIndex(index);
			unregisterInterrupt = registerForegroundInterrupt(input.foregroundControl, () => {
				if (interruptController.signal.aborted) return false;
				interruptController.abort();
				input.foregroundControl!.currentActivityState = undefined;
				input.foregroundControl!.updatedAt = Date.now();
				return true;
			});
		}
		let settledResult: SingleResult | undefined;
		let isolatedCapabilityReleased = false;
		const releaseIsolatedCapability = async (terminal?: SingleResult): Promise<void> => {
			if (isolatedCapabilityReleased || !isolatedCapability || !input.isolatedGitWorktrees?.[index]) return;
			const runtime = input.isolatedGitWorktrees[index]!.runtime;
			if (terminal?.teardownUnproven) {
				runtime.markExportFenceFailed();
				return;
			}
			const fence = await (input.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(input.foregroundControl?.nestedRoute, input.runId, index, { timeoutMs: input.nestedFenceTimeoutMs });
			if (!fence.stopped) {
				runtime.markExportFenceFailed();
				if (terminal) {
					terminal.teardownUnproven = true;
					terminal.exitCode = terminal.exitCode === 0 ? 1 : terminal.exitCode;
					terminal.error = terminal.error ? `${terminal.error}\nNested descendants did not reach a proven terminal state; inherited capability retained for recovery.` : "Nested descendants did not reach a proven terminal state; inherited capability retained for recovery.";
					input.onUpdate?.({ content: [{ type: "text", text: terminal.error }], details: { mode: "parallel", results: input.liveResults.map((candidate, candidateIndex) => candidateIndex === index ? { ...terminal, detached: true } : candidate).filter((candidate): candidate is SingleResult => candidate !== undefined) } });
				}
				return;
			}
			try {
				(input.teardownHooks?.releaseInheritedContext ?? ((runtime, capability) => runtime.releaseInheritedContext(capability)))(runtime, isolatedCapability);
				isolatedCapabilityReleased = true;
			} catch (error) {
				if (terminal) {
					terminal.teardownUnproven = true;
					terminal.exitCode = terminal.exitCode === 0 ? 1 : terminal.exitCode;
					const detail = error instanceof Error ? error.message : String(error);
					terminal.error = terminal.error ? `${terminal.error}\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
					input.onUpdate?.({ content: [{ type: "text", text: terminal.error }], details: { mode: "parallel", results: input.liveResults.map((candidate, candidateIndex) => candidateIndex === index ? { ...terminal, detached: true } : candidate).filter((candidate): candidate is SingleResult => candidate !== undefined) } });
				}
				try { runtime.markExportFenceFailed(); } catch { /* retain terminal teardown evidence even if fence persistence also fails */ }
			}
		};
		try {
		const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			nestedFenceTimeoutMs: input.nestedFenceTimeoutMs,
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForIndex(index),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			outputPath,
			savedOutputPath,
			outputMode: behavior?.outputMode,
			maxSubagentDepth: input.maxSubagentDepths[index],
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			fastMode: input.behaviors[index]?.fastMode,
			availableModels: input.availableModels,
			preferredModelProvider: input.ctx.model?.provider,
			skills: effectiveSkills === false ? [] : effectiveSkills,
			acceptance: task.acceptance,
			acceptanceContext: { mode: "parallel" },
			sandbox: input.sandboxes?.[index] ?? input.sandbox,
			isolatedGit: input.isolatedGitWorktrees?.[index],
			isolatedGitCapability: isolatedCapability,
			isolatedGitBundleDir: input.artifactsDir,
			isolatedGitEndpoint: input.scopedGitEndpoint,
			isolatedGitRights: input.scopedGitEndpoint ? (isolatedGitCommitRequired(taskText, agentConfig, input.sandboxes?.[index] ?? input.sandbox) ? "writer" : "read-only") : undefined,
			isolatedGitCommitRequired: Boolean(input.isolatedGitWorktrees?.[index]) && isolatedGitCommitRequired(taskText, agentConfig, input.sandboxes?.[index] ?? input.sandbox),
			sandboxIntercomBridge: input.sandboxIntercomBridge,
			progressPaths: behavior?.progress ? input.progressPaths : undefined,
			onDetachedStarted: input.onDetachedStarted ? (result) => input.onDetachedStarted!(index, result) : undefined,
			onDetachedTerminal: async (result) => {
				// A parallel terminal callback is publication. Wait for descendant
				// termination and successful capability release before forwarding it.
				await releaseIsolatedCapability(result);
				if (result.teardownUnproven || (isolatedCapability && !isolatedCapabilityReleased)) return;
				await input.onDetachedTerminal?.(index, result);
			},
			onUpdate: input.onUpdate
				? (progressUpdate) => {
					const stepResults = progressUpdate.details?.results || [];
					const stepProgress = progressUpdate.details?.progress || [];
					if (input.foregroundControl && stepProgress.length > 0) {
						const current = stepProgress[0];
						input.foregroundControl.currentAgent = task.agent;
						input.foregroundControl.currentIndex = index;
						input.foregroundControl.currentActivityState = current?.activityState;
						input.foregroundControl.currentModel = stepResults[0]?.model ?? input.modelOverrides[index] ?? input.agents.find((agent) => agent.name === task.agent)?.model;
						input.foregroundControl.currentThinking = stepResults[0]?.thinking;
						input.foregroundControl.currentFastMode = stepResults[0]?.fastMode ?? input.foregroundControl.currentFastMode;
						input.foregroundControl.lastActivityAt = current?.lastActivityAt;
						input.foregroundControl.currentTool = current?.currentTool;
						input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
						input.foregroundControl.currentPath = current?.currentPath;
						input.foregroundControl.turnCount = current?.turnCount;
						input.foregroundControl.tokens = current?.tokens;
						input.foregroundControl.toolCount = current?.toolCount;
						input.foregroundControl.updatedAt = Date.now();
						input.foregroundControl.sessionFile = input.sessionFileForIndex(index);
					}
					if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
					if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
					const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
					const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
					input.onUpdate?.({
						content: progressUpdate.content,
						details: {
							mode: "parallel",
							results: mergedResults,
							progress: mergedProgress,
							controlEvents: progressUpdate.details?.controlEvents,
							totalSteps: input.tasks.length,
						},
					});
				}
				: undefined,
		});
		settledResult = result;
		return { ...result, flatIndex };
		} finally {
			unregisterInterrupt?.();
			unregisterInterrupt = undefined;
			if (input.foregroundControl?.currentIndex === index) input.foregroundControl.updatedAt = Date.now();
			if (isolatedCapability && input.isolatedGitWorktrees?.[index] && !settledResult?.detached) {
				await releaseIsolatedCapability(settledResult);
			}
		}
	});
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	let teardownUnproven = false;
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveRunMaxSubagentDepth(params.maxSubagentDepth, deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);
	const sandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(params.agentScope));
	const sandbox = resolveSandboxConfig({
		settings: sandboxSettings,
		run: params.sandbox,
	});
	const sandboxIntercomBridge = resolveSandboxIntercomBridge(data.intercomBridge);
	const explicitWorktreeOptOut = Object.hasOwn(params, "worktree") && params.worktree === false;
	const worktreeOptOutAllowed = explicitWorktreeOptOut
		&& worktreeOptOutIsAuthorized(sandboxSettings)
		&& agentConfigs.every((agent) => agent.canOptOutOfWorktree === true);
	const taskSandboxes = agentConfigs.map((agent) => {
		const resolved = resolveChildSandboxConfig({ settings: sandboxSettings, agent, run: params.sandbox });
		return worktreeOptOutAllowed && resolved?.gitMode === "isolated" ? { ...resolved, gitMode: "read-only" as const } : resolved;
	});
	const isolatedGitRequested = !data.scopedGitEndpoint && taskSandboxes.some((sandboxConfig) => sandboxConfig?.gitMode === "isolated");
	if (isolatedGitRequested && params.worktree) {
		return buildParallelModeError("isolated Git cannot be combined with parent-managed worktree mode; use isolated Git alone");
	}
	if (isolatedGitRequested && agentConfigs.some((agent, index) =>
		taskSandboxes[index]?.gitMode !== "isolated"
			&& inferSandboxCwdWritable({ agentName: agent.name, tools: agent.tools, sandbox: taskSandboxes[index] }),
	)) {
		return buildParallelModeError("isolated Git parallel runs cannot include a non-isolated write-capable task");
	}
	if (!params.worktree && !isolatedGitRequested && !data.scopedGitEndpoint && hasSandboxWritableAgent({ agents: agentConfigs.map((agent, index) => ({ agentName: agent.name, tools: agent.tools, sandbox: taskSandboxes[index] })) })
		&& !worktreeOptOutAllowed) {
		return buildParallelModeError(sandboxParallelWorktreeRequiredMessage());
	}

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined ? { output: task.output === true ? agentConfigs[index]?.output ?? false : task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
		...(task.fastMode !== undefined ? { fastMode: task.fastMode } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveModelCandidate(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
					agentConfigs.map((agent) => ({
						worktree: "isolated",
						sandbox: resolveSandboxConfig({ settings: sandboxSettings, agent, run: params.sandbox }),
						canOptOutOfWorktree: agent.canOptOutOfWorktree === true && sandboxSettings?.allowWorktreeOptOut === true,
						canOptOutOfSandbox: sandboxSettings?.allowSandboxOptOut === true,
					} satisfies ChainClarifyPolicy)),
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) {
				modelOverrides[i] = override.model;
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) behaviorOverrides[i]!.output = override.output;
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.fastMode !== undefined) behaviorOverrides[i]!.fastMode = override.fastMode;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			const parallelTasks = tasks.map((t, i) => {
				const taskText = params.context === "fork" ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!;
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				return {
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
					...(behaviorOverrides[i]?.fastMode !== undefined ? { fastMode: behaviorOverrides[i]!.fastMode } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(behaviorOverrides[i]?.output !== undefined ? { output: behaviorOverrides[i]!.output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
				};
			});
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
				resultMode: "parallel",
				agents: data.asyncAgents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((_, index) => sessionFileForIndex(index)),
				maxSubagentDepth: currentMaxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				sandbox,
				sandboxSettings,
				sandboxRun: params.sandbox,
				sandboxIntercomBridge,
				scopedGitEndpoint: data.scopedGitEndpoint,
			});
		}
	}

	const behaviors = agentConfigs.map((config, index) => suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]));
	// Request-only validation must happen before acquiring managed resources.
	const duplicateOutputError = findDuplicateParallelOutputPath({ tasks, behaviors, paramsCwd: effectiveCwd, ctxCwd: ctx.cwd, absoluteOnly: Boolean(params.worktree || isolatedGitRequested) });
	if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
	for (let index = 0; index < tasks.length; index++) {
		const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, undefined, index);
		// The base probe above precedes output/session path resolution and setup.
		const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd);
		const savedOutputPath = shouldPersistSavedOutput({
			output: behaviors[index]?.output,
			outputMode: behaviors[index]?.outputMode,
			tools: agentConfigs[index]?.tools,
		})
			? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: taskCwd, agent: tasks[index]!.agent, runId, index })
			: undefined;
		const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath ?? savedOutputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
		if (validationError) return buildParallelModeError(validationError);
	}
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult, teardownUnproven: setupTeardownUnproven } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	teardownUnproven ||= setupTeardownUnproven === true;
	if (errorResult) return errorResult;

	let isolatedRuntime: IsolatedGitRuntime | undefined;
	let isolatedGitWorktrees: (IsolatedGitWorktree | undefined)[] | undefined;
	const ownsIsolatedRuntime = true;
	if (isolatedGitRequested) {
		try {
			const isolatedConfigs = taskSandboxes.filter((sandboxConfig) => sandboxConfig?.gitMode === "isolated");
			const isolatedProvider = isolatedConfigs[0]?.provider;
			if (isolatedConfigs.some((sandboxConfig) => sandboxConfig?.provider !== "bubblewrap")) throw new Error("isolated Git requires the Bubblewrap sandbox provider; refusing to downgrade");
			isolatedRuntime = createIsolatedGitRuntime({
				cwd: effectiveCwd,
				runId,
				provider: isolatedProvider,
				network: isolatedConfigs[0]?.network,
				profile: isolatedConfigs[0]?.profile,
				fallback: isolatedConfigs[0]?.fallback,
				worktreeSetupHook: deps.config.worktreeSetupHook ? { hookPath: deps.config.worktreeSetupHook, timeoutMs: deps.config.worktreeSetupHookTimeoutMs } : undefined,
				extraReadOnlyMounts: [...new Set(isolatedConfigs.flatMap((sandboxConfig) => sandboxConfig?.extraReadOnlyMounts ?? []))],
				extraWritableMounts: [...new Set(isolatedConfigs.flatMap((sandboxConfig) => sandboxConfig?.extraWritableMounts ?? []))],
			});
			isolatedGitWorktrees = new Array(tasks.length).fill(undefined);
			for (let index = 0; index < tasks.length; index++) {
				if (taskSandboxes[index]?.gitMode === "isolated") {
					isolatedGitWorktrees[index] = createIsolatedGitWorktree(isolatedRuntime, { index, agent: tasks[index]?.agent });
				}
			}
		} catch (error) {
			const setupError = error instanceof Error ? error.message : String(error);
			const setupResults: SingleResult[] = [];
			if (isolatedRuntime) {
				// A setup hook can fail after registering its slot (and after partial
				// edits), before later planned slots are created. Materialize only the
				// known slots as clean recovery worktrees; never rerun the hook.
				const recoveryCreationFailures = new Set<number>();
				for (let index = 0; index < tasks.length; index++) {
					if (taskSandboxes[index]?.gitMode !== "isolated") continue;
					if (!isolatedRuntime.worktrees.some((candidate) => candidate.index === index)) {
						try {
							const recoveryWorktree = isolatedRuntime.createRecoveryWorktree({ index, agent: tasks[index]?.agent });
							isolatedGitWorktrees ??= new Array(tasks.length).fill(undefined);
							isolatedGitWorktrees[index] = recoveryWorktree;
						} catch (creationError) {
							recoveryCreationFailures.add(index);
							isolatedRuntime.markExportFailed();
							const detail = creationError instanceof Error ? creationError.message : String(creationError);
							setupResults.push({ flatIndex: index, agent: tasks[index]?.agent ?? `task-${index + 1}`, task: tasks[index]?.task ?? "parallel setup", exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, success: false, error: `${setupError}\nRecovery worktree creation failed: ${detail}. recover isolated runtime at ${isolatedRuntime.root}.` });
						}
					}
				}
				for (const worktree of isolatedRuntime.worktrees) {
					if (recoveryCreationFailures.has(worktree.index)) continue;
					let bundle: ReturnType<typeof exportIsolatedGitBundle> | undefined;
					let exportError: unknown;
					for (let attempt = 0; attempt < 2 && !bundle; attempt++) {
						try {
							bundle = exportIsolatedGitBundle(isolatedRuntime, {
								outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
								worktree,
								terminationState: "execution-rejected",
								agent: tasks[worktree.index]?.agent,
								commitRequired: tasks[worktree.index] ? isolatedGitCommitRequired(tasks[worktree.index]!.task, agents.find((candidate) => candidate.name === tasks[worktree.index]!.agent), taskSandboxes[worktree.index]) : undefined,
							});
						} catch (attemptError) { exportError = attemptError; }
					}
					const recoveryError = bundle
						? setupError
						: `${setupError}\nIsolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
					if (!bundle) isolatedRuntime.markExportFailed();
					setupResults.push({
						flatIndex: worktree.index,
						agent: tasks[worktree.index]?.agent ?? `task-${worktree.index + 1}`,
						task: tasks[worktree.index]?.task ?? "parallel setup",
						exitCode: 1,
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 },
						success: false,
						error: recoveryError,
						...(bundle ? { gitBundle: { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata } } : {}),
					});
				}
			}
			// The runtime constructor can fail before it registers any worktree. Still
			// materialize every planned slot so durable state is failed, never running
			// (or accidentally complete because the result list is empty).
			const representedSetupIndexes = new Set(setupResults.flatMap((result) => result.flatIndex === undefined ? [] : [result.flatIndex]));
			for (let index = 0; index < tasks.length; index++) {
				if (representedSetupIndexes.has(index)) continue;
				setupResults.push({
					flatIndex: index,
					agent: tasks[index]?.agent ?? `task-${index + 1}`,
					task: tasks[index]?.task ?? "parallel setup",
					exitCode: 1,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 },
					success: false,
					error: setupError,
				});
			}
			setupResults.sort((left, right) => (left.flatIndex ?? Number.MAX_SAFE_INTEGER) - (right.flatIndex ?? Number.MAX_SAFE_INTEGER));
			if (isolatedRuntime && !isolatedRuntime.exportFailed) {
				try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
				catch (cleanupError) {
					teardownUnproven = true;
					const message = `Isolated Git cleanup failed after setup rejection; recover isolated worktrees at ${isolatedRuntime.root}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
					isolatedRuntime.markExportFailed();
					for (const result of setupResults) { result.success = false; delete result.interrupted; delete result.cancelled; result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1); result.error = result.error ? `${result.error}\n${message}` : message; }
				}
			}
			if (worktreeSetup) {
				try { cleanupWorktrees(worktreeSetup, { preserve: Boolean(isolatedRuntime?.exportFailed) }); }
				catch (cleanupError) {
					teardownUnproven = true;
					const message = `Worktree cleanup failed; recover worktrees at ${worktreeSetup.worktrees.map((worktree) => worktree.path).join(", ")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
					for (const result of setupResults) { result.success = false; result.interrupted = undefined; result.cancelled = undefined; result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1); result.error = result.error ? `${result.error}\n${message}` : message; }
				}
			}
			// Setup rejection is terminal even though no child process started. Replace
			// the initial running projection before returning, retaining any exported
			// recovery bundle and the actionable runtime path in the child error.
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, {
				runId,
				mode: "parallel",
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				startedAt: foregroundControl?.startedAt,
				results: setupResults,
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
			const recovery = isolatedRuntime && fs.existsSync(isolatedRuntime.root) ? ` Recover isolated worktrees at ${isolatedRuntime.root}.` : "";
			return {
				content: [{ type: "text", text: `Isolated Git setup failed: ${setupError}${recovery}` }],
				isError: true,
				details: { mode: "parallel", runId, results: setupResults, ...(isolatedRuntime?.hookTeardownFailed ? { teardownUnproven: true } : {}) },
			};
		}
	}

	const detachedIndexes = new Set<number>();
	const detachedTerminalIndexes = new Set<number>();
	const exportDiagnostics = new Map<number, string>();
	let detachedCleanupComplete = false;
	let detachedAggregatePublished = false;
	let parallelExecutionSettled = false;
	let isolatedCleanupFailure: string | undefined;
	let parallelCleanupFailure: string | undefined;
	// Detached terminal acknowledgements can arrive before siblings have even
	// started. Keep those siblings in the durable projection as pending/running
	// placeholders; filtering them out would make the aggregate appear complete.
	const detachedProjectionResults = (): SingleResult[] => tasks.map((task, index) => liveResults[index] ?? {
		flatIndex: index,
		agent: task.agent,
		task: task.task,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			index,
			agent: task.agent,
			status: "pending",
			task: task.task,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
		},
	});
	const noteIsolatedCleanupFailure = (target?: SingleResult, cause?: unknown): string | undefined => {
		if (!isolatedRuntime) return undefined;
		if (cause === undefined && !isolatedRuntime.exportFailed && !fs.existsSync(isolatedRuntime.root)) return undefined;
		isolatedRuntime.markExportFailed();
		const base = `Isolated Git cleanup failed after export; recover isolated worktrees at ${isolatedRuntime.root}.`;
		const detail = cause instanceof Error ? ` ${cause.message}` : cause !== undefined ? ` ${String(cause)}` : "";
		const message = `${base}${detail}`;
		isolatedCleanupFailure ??= message;
		// Cleanup is a run-level teardown gate. Every planned isolated child must
		// receive a terminal failed projection, including children whose callback
		// rejected before it could publish a result.
		const affectedIndexes = new Set(isolatedRuntime.worktrees.map((worktree) => worktree.index));
		for (const index of affectedIndexes) {
			const task = tasks[index];
			const existing = liveResults[index];
			const result = existing ?? {
				agent: task?.agent ?? `task-${index + 1}`,
				task: task?.task ?? "parallel execution",
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			};
		result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
			result.success = false;
			result.interrupted = undefined;
			result.cancelled = undefined;
			result.teardownUnproven = true;
			result.error = result.error?.includes(message) ? result.error : result.error ? `${result.error}\n${message}` : message;
			liveResults[index] = result;
		}
		if (target && !target.error?.includes(message)) {
			target.exitCode = target.exitCode === 0 ? 1 : (target.exitCode ?? 1);
			target.success = false;
			target.interrupted = undefined;
			target.cancelled = undefined;
			target.teardownUnproven = true;
			target.error = target.error ? `${target.error}\n${message}` : message;
		}
		return message;
	};
	const exportBundleWithRetry = (options: Parameters<typeof exportIsolatedGitBundle>[1]): { bundle: ReturnType<typeof exportIsolatedGitBundle>; earlierAttemptFailed: boolean } => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try { return { bundle: exportIsolatedGitBundle(isolatedRuntime!, options), earlierAttemptFailed: attempt > 0 }; }
			catch (error) { lastError = error; }
		}
		throw lastError;
	};
	const exportRemainingIsolated = async (terminationState: "success" | "failure" | "execution-rejected" | "interrupted" | "cancelled", includeDetached = false): Promise<void> => {
		if (!isolatedRuntime || !ownsIsolatedRuntime) return;
		// A teardown callback may have already fenced this runtime after refusing
		// private-group proof. Never clear that fence and package/delete descendants.
		if (isolatedRuntime.exportFenceFailed) return;
		const effectiveTerminationFor = (index: number): "success" | "failure" | "execution-rejected" | "interrupted" | "cancelled" => {
			const existing = liveResults[index];
			if (!existing) return terminationState;
			if (existing.cancelled) return "cancelled";
			if (existing.interrupted) return "interrupted";
			if (existing.success === true && existing.exitCode === 0) return "success";
			if (existing.exitCode !== 0) return "failure";
			return terminationState;
		};
		const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, undefined, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
		if (!fence.stopped) {
			isolatedRuntime.markExportFenceFailed();
			teardownUnproven = true;
			const message = `Nested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktrees at ${isolatedRuntime.root}`;
			for (const worktree of isolatedRuntime.worktrees) {
				if (detachedIndexes.has(worktree.index) && (!includeDetached || !detachedTerminalIndexes.has(worktree.index))) continue;
				const existing = liveResults[worktree.index];
				liveResults[worktree.index] = existing
					? { ...existing, success: false, exitCode: 1, error: existing.error?.includes(message) ? existing.error : existing.error ? `${existing.error}\n${message}` : message }
					: { agent: tasks[worktree.index]?.agent ?? `task-${worktree.index + 1}`, task: tasks[worktree.index]?.task ?? "parallel execution", success: false, exitCode: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: message };
			}
			return;
		}
		isolatedRuntime.markExportFenceResolved();
		for (const worktree of isolatedRuntime.worktrees) {
			if (isolatedRuntime.isExported(worktree.index)) continue;
			if (!includeDetached && detachedIndexes.has(worktree.index)) continue;
			try {
				const retry = exportBundleWithRetry({
					outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
					worktree,
					syntheticPaths: worktree.syntheticPaths,
					terminationState: effectiveTerminationFor(worktree.index),
					agent: tasks[worktree.index]?.agent,
					commitRequired: tasks[worktree.index] ? isolatedGitCommitRequired(tasks[worktree.index]!.task, agents.find((candidate) => candidate.name === tasks[worktree.index]!.agent), taskSandboxes[worktree.index]) : undefined,
				});
				const bundle = retry.bundle;
				if (retry.earlierAttemptFailed) exportDiagnostics.set(worktree.index, "Isolated Git bundle export retry succeeded after an earlier diagnostic");
				const existing = liveResults[worktree.index];
				const gitBundle = {
					path: bundle.path,
					checksum: bundle.checksum,
					base: bundle.base,
					head: bundle.head,
					commits: bundle.commits,
					commitSummary: bundle.commitSummary,
					...(bundle.recovery ? { recovery: bundle.recovery } : {}),
					...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}),
					...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}),
					...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}),
					terminationState: bundle.terminationState,
					incomplete: bundle.incomplete,
					dirtySummary: bundle.dirtySummary,
					bundleSize: bundle.bundleSize,
					payloadChecksum: bundle.payloadChecksum,
					payloadSize: bundle.payloadSize,
					canonicalPayloadChecksum: bundle.canonicalPayloadChecksum,
					canonicalPayloadSize: bundle.canonicalPayloadSize,
					portableMetadata: bundle.portableMetadata,
				};
				const normalizedExistingError = stripIsolatedGitExportDiagnostics(existing?.error);
				const recoveredExportOnlyFailure = Boolean(existing && normalizedExistingError.onlyDiagnostics);
				liveResults[worktree.index] = existing
					? { ...existing, ...(normalizedExistingError.error ? { error: normalizedExistingError.error } : { error: undefined }), ...(recoveredExportOnlyFailure ? { success: true, exitCode: 0 } : {}), gitBundle }
					: {
						agent: tasks[worktree.index]?.agent ?? `task-${worktree.index + 1}`,
						task: tasks[worktree.index]?.task ?? "parallel execution",
						exitCode: 1,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						error: "Parallel execution failed unexpectedly.",
						gitBundle,
					};
				if (bundle.incomplete && existing?.success === true) {
					liveResults[worktree.index] = { ...liveResults[worktree.index]!, success: false, exitCode: liveResults[worktree.index]!.exitCode === 0 ? 1 : liveResults[worktree.index]!.exitCode, error: liveResults[worktree.index]!.error ?? "Isolated writer completed without a required authored commit; recovery bundle is incomplete." };
				}
				exportDiagnostics.delete(worktree.index);
			} catch (error) {
				isolatedRuntime.markExportFailed();
				teardownUnproven = true;
				const exportError = `Isolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${error instanceof Error ? error.message : String(error)}`;
				exportDiagnostics.set(worktree.index, exportError);
				const existing = liveResults[worktree.index];
				if (existing) liveResults[worktree.index] = { ...existing, exitCode: existing.exitCode === 0 ? 1 : existing.exitCode, success: false, interrupted: undefined, cancelled: undefined, teardownUnproven: true, error: existing.error ? `${existing.error}\n${exportError}` : exportError };
				else liveResults[worktree.index] = { agent: tasks[worktree.index]?.agent ?? `task-${worktree.index + 1}`, task: tasks[worktree.index]?.task ?? "parallel execution", exitCode: 1, success: false, teardownUnproven: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: exportError };
			}
		}
	};
	const buildIsolatedParallelError = async (message: string): Promise<AgentToolResult<Details>> => {
		await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal.aborted ? "cancelled" : "execution-rejected");
		if (ownsIsolatedRuntime && isolatedRuntime && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed) {
			try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
		}
		const projectedResults = liveResults.filter((result): result is SingleResult => result !== undefined);
		const failureDetails = projectedResults.filter((result) => result.exitCode !== 0 && result.error).map((result) => `${result.agent}: ${result.error}`);
		return {
			content: [{ type: "text", text: failureDetails.length > 0 ? `${message}\n\n${failureDetails.join("\n")}` : message }],
			isError: true,
			details: { mode: "parallel", runId, results: projectedResults },
		};
	};
	const finalizeDetachedIfReady = async (): Promise<void> => {
		if (!parallelExecutionSettled || detachedCleanupComplete || detachedIndexes.size === 0 || detachedTerminalIndexes.size < detachedIndexes.size) return;
		detachedCleanupComplete = true;
		await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal.aborted ? "cancelled" : "execution-rejected", true);
		if (ownsIsolatedRuntime && (isolatedRuntime?.exportFenceFailed || isolatedRuntime?.exportFailed)) return;
		if (worktreeSetup) {
			const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, undefined, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
			if (!fence.stopped) {
				const message = `Nested descendants did not reach a proven terminal state before worktree cleanup; ${formatRecoverableWorktreePaths(worktreeSetup)}`;
				isolatedCleanupFailure ??= message;
				for (let index = 0; index < tasks.length; index++) {
					const task = tasks[index]!;
					const result = liveResults[index] ?? { flatIndex: index, agent: task.agent, task: task.task, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
					result.success = false;
					result.interrupted = undefined;
					result.cancelled = undefined;
					result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
					result.error = result.error ? `${result.error}\n${message}` : message;
					liveResults[index] = result;
				}
			} else try { cleanupWorktrees(worktreeSetup); }
			catch (error) {
				teardownUnproven = true;
					const message = `Worktree cleanup failed; recover worktrees at ${worktreeSetup.worktrees.map((worktree) => worktree.path).join(", ")}: ${error instanceof Error ? error.message : String(error)}`;
				isolatedCleanupFailure ??= message;
				// Cleanup is a run-level teardown gate. Every sibling sharing this
				// worktree setup must become failed/actionable, not just the first
				// result that happened to finish before cleanup was attempted.
				for (let index = 0; index < tasks.length; index++) {
					const task = tasks[index]!;
					const result = liveResults[index] ?? {
						flatIndex: index,
						agent: task.agent,
						task: task.task,
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					};
					result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
					result.success = false;
					result.interrupted = undefined;
					result.cancelled = undefined;
					result.error = result.error ? `${result.error}\n${message}` : message;
					liveResults[index] = result;
				}
			}
		}
		if (ownsIsolatedRuntime && isolatedRuntime) {
			try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
			noteIsolatedCleanupFailure();
		}
	};
	const publishDetachedAggregate = async (): Promise<void> => {
		// Detached callbacks may settle in any order. Publication is deliberately
		// gated until mapConcurrent has settled every sibling, so no observer sees
		// an incomplete aggregate followed by a contradictory terminal receipt.
		if (detachedAggregatePublished || !parallelExecutionSettled || detachedIndexes.size === 0 || detachedTerminalIndexes.size < detachedIndexes.size) return;
		detachedAggregatePublished = true;
		const orderedResults = liveResults.filter((candidate): candidate is SingleResult => candidate !== undefined);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results: orderedResults,
			progress: params.includeProgress ? allProgress : undefined,
		});
		const text = orderedResults.map((result) => getSingleResultOutput(result) || result.error || "(no output)").join("\n\n")
			+ (isolatedCleanupFailure ? `\n\n${isolatedCleanupFailure}` : "");
		onUpdate?.({ content: [{ type: "text", text }], details });
		await emitForegroundResultIntercom({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			results: details.results,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
	};
	const onDetachedTerminal = async (index: number, result: SingleResult): Promise<void> => {
		const previous = liveResults[index];
		liveResults[index] = previous
			? { ...previous, ...result, gitBundle: result.gitBundle ?? previous.gitBundle }
			: result;
		detachedIndexes.add(index);
		if (result.teardownUnproven) {
			teardownUnproven = true;
			const details = compactForegroundDetails({ mode: "parallel", runId, results: detachedProjectionResults(), progress: params.includeProgress ? allProgress : undefined });
			onUpdate?.({ content: [{ type: "text", text: result.error ?? "Detached child teardown remains unproven." }], details });
			rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: data.effectiveCwd, sessionId: deps.state.currentSessionId, startedAt: foregroundControl?.startedAt, results: details.results, ...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}) });
			return;
		}
		if (data.scopedGitEndpoint) {
			const fence = await (deps.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(data.nestedRoute, runId, index, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
			if (!fence.observed || !fence.stopped) {
				teardownUnproven = true;
				result.teardownUnproven = true;
				result.success = false;
				result.interrupted = undefined;
				result.cancelled = undefined;
				result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
				const message = "Nested descendants did not reach a proven terminal state before scoped Git endpoint cleanup; recover retained isolated worktree evidence through the owning parent run";
				result.error = result.error ? `${result.error}\n${message}` : message;
				liveResults[index] = liveResults[index] ? { ...liveResults[index]!, ...result } : result;
				const details = compactForegroundDetails({ mode: "parallel", runId, results: detachedProjectionResults().map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, detached: true } : candidate), progress: params.includeProgress ? allProgress : undefined });
				onUpdate?.({ content: [{ type: "text", text: result.error }], details });
				if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
				rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: data.effectiveCwd, sessionId: deps.state.currentSessionId, startedAt: foregroundControl?.startedAt, results: details.results, ...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}) });
				return;
			}
		}
		if (isolatedRuntime && !isolatedRuntime.isExported(index)) {
			const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, index, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
			if (!fence.stopped) {
				if (ownsIsolatedRuntime) isolatedRuntime.markExportFenceFailed();
				teardownUnproven = true;
				result.teardownUnproven = true;
				result.success = false;
				result.interrupted = undefined;
				result.cancelled = undefined;
				result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
				result.error = result.error
					? `${result.error}\nNested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktree at ${isolatedRuntime.root}`
					: `Nested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktree at ${isolatedRuntime.root}`;
				liveResults[index] = liveResults[index] ? { ...liveResults[index]!, ...result } : result;
				if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
				rememberForegroundRun(deps.state, {
					runId,
					mode: "parallel",
					cwd: data.effectiveCwd,
					sessionId: deps.state.currentSessionId,
					startedAt: foregroundControl?.startedAt,
					results: detachedProjectionResults(),
					...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
				});
				await finalizeDetachedIfReady();
				return;
			}
		}
		// A detached worktree is terminal independently of its siblings. Export
		// that worktree before publishing its terminal receipt; the runtime itself
		// remains until every detached sibling has reached the same fence.
		if (ownsIsolatedRuntime && isolatedRuntime && !isolatedRuntime.isExported(index) && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed) {
			const worktree = isolatedRuntime.worktrees.find((candidate) => candidate.index === index);
			if (worktree) {
				try {
					const retry = exportBundleWithRetry({
						outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
						worktree,
						syntheticPaths: worktree.syntheticPaths,
						terminationState: result.cancelled ? "cancelled" : result.interrupted ? "interrupted" : result.exitCode === 0 ? "success" : "failure",
						agent: tasks[index]?.agent,
						commitRequired: tasks[index] ? isolatedGitCommitRequired(tasks[index]!.task, agents.find((candidate) => candidate.name === tasks[index]!.agent), taskSandboxes[index]) : undefined,
					});
					const bundle = retry.bundle;
					liveResults[index] = { ...liveResults[index]!, gitBundle: { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata } };
				} catch (error) {
					isolatedRuntime.markExportFailed();
					teardownUnproven = true;
					result.success = false;
					delete result.interrupted;
					delete result.cancelled;
					result.teardownUnproven = true;
					result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
					result.error = result.error ? `${result.error}\nIsolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${error instanceof Error ? error.message : String(error)}` : `Isolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
		liveResults[index] = liveResults[index] ? { ...liveResults[index]!, ...result } : result;
		detachedTerminalIndexes.add(index);
		await finalizeDetachedIfReady();
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		rememberForegroundRun(deps.state, {
			runId,
			mode: "parallel",
			cwd: data.effectiveCwd,
			sessionId: deps.state.currentSessionId,
			startedAt: foregroundControl?.startedAt,
			results: detachedProjectionResults(),
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (parallelExecutionSettled) await publishDetachedAggregate();
	};
	let preserveWorktree = false;
	try {
		const parallelProgressPrecreated = firstProgressIndex !== -1;
		if (parallelProgressPrecreated) writeInitialProgressFile(effectiveCwd);
		const progressPaths = parallelProgressPrecreated ? [path.join(effectiveCwd, "progress.md")] : undefined;

		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			agents,
			ctx,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			availableModels,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			nestedFenceTimeoutMs: nestedFenceTimeoutForExecutor(deps),
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
			isolatedGitWorktrees,
			scopedGitEndpoint: data.scopedGitEndpoint,
			sandbox,
			sandboxes: taskSandboxes,
			sandboxIntercomBridge,
			teardownHooks: deps.teardownHooks,
			progressPaths,
			onDetachedStarted: (index, result) => {
				detachedIndexes.add(index);
				// Retain the detached acknowledgement as the live sibling projection;
				// its terminal callback later merges the child truth and bundle.
				liveResults[index] = liveResults[index] ? { ...liveResults[index]!, ...result } : { ...result, flatIndex: index };
			},
			onDetachedTerminal,
		});
		parallelExecutionSettled = true;
		// The progress callback is optional. Seed the canonical map from the
		// actual settled results before export/recovery projection so siblings
		// cannot become synthetic failures merely because no progress was emitted.
		for (let i = 0; i < results.length; i++) {
			const settled = results[i];
			if (!settled) continue;
			const terminalAlreadyProjected = detachedTerminalIndexes.has(i) && settled.detached === true;
			liveResults[i] = liveResults[i]
				? terminalAlreadyProjected
					? { ...settled, ...liveResults[i], gitBundle: liveResults[i]!.gitBundle ?? settled.gitBundle }
					: { ...liveResults[i], ...settled, gitBundle: settled.gitBundle ?? liveResults[i]!.gitBundle }
				: settled;
		}
		for (let i = 0; i < results.length; i++) {
			if (results[i]?.detached) detachedIndexes.add(i);
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}
		const interrupted = results.find((result) => result.interrupted);
		let details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		for (let index = 0; index < results.length; index++) {
			if (results[index]?.detached) detachedIndexes.add(index);
		}
		if (detachedIndexes.size > 0) preserveWorktree = true;
		await finalizeDetachedIfReady();
		await publishDetachedAggregate();

		let worktreeSuffix = "";
		try {
			if (detachedIndexes.size === 0) worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		} catch (error) {
			preserveWorktree = true;
			const message = error instanceof WorktreeDiffCaptureError
				? error.message
				: `Failed to capture parallel worktree changes: ${error instanceof Error ? error.message : String(error)}`;
			// Capture failure is terminal, but recovery export still precedes the
			// returned error. Never rely on finally for the isolated runtime fence.
			if (detachedIndexes.size === 0) {
				await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal.aborted ? "cancelled" : "execution-rejected");
				if (ownsIsolatedRuntime && isolatedRuntime && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed) {
					try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
					catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
				}
				for (let index = 0; index < results.length; index++) {
					if (liveResults[index]) results[index] = { ...results[index], ...liveResults[index], gitBundle: liveResults[index]!.gitBundle ?? results[index]?.gitBundle };
				}
				details = compactForegroundDetails({ mode: "parallel", runId, results: liveResults.filter((candidate): candidate is SingleResult => candidate !== undefined), progress: params.includeProgress ? allProgress : undefined, artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined });
			}
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, {
				runId,
				mode: "parallel",
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				startedAt: foregroundControl?.startedAt,
				results: details.results,
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details,
			};
		}

		// Terminal isolated exports and all ordinary worktree cleanup must complete
		// before remembered status or grouped intercom publication. A fence refusal
		// or export failure intentionally leaves the runtime actionable.
		if (detachedIndexes.size === 0) {
			await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal.aborted ? "cancelled" : "execution-rejected");
			if (ownsIsolatedRuntime && isolatedRuntime && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed) {
				try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
				catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
				noteIsolatedCleanupFailure();
			}
			if (worktreeSetup && !preserveWorktree && !isolatedRuntime?.exportFailed && !isolatedRuntime?.exportFenceFailed) {
				const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, undefined, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
				if (!fence.stopped) {
					preserveWorktree = true;
					teardownUnproven = true;
					parallelCleanupFailure = `Nested descendants did not reach a proven terminal state before worktree cleanup; ${formatRecoverableWorktreePaths(worktreeSetup)}`;
					for (let index = 0; index < tasks.length; index++) {
						const task = tasks[index]!;
						const result = liveResults[index] ?? { flatIndex: index, agent: task.agent, task: task.task, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
						result.success = false;
						result.interrupted = undefined;
						result.cancelled = undefined;
						result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
						result.error = result.error ? `${result.error}\n${parallelCleanupFailure}` : parallelCleanupFailure;
						liveResults[index] = result;
					}
				} else try { cleanupWorktrees(worktreeSetup); }
				catch (cleanupError) {
					preserveWorktree = true;
					teardownUnproven = true;
					const message = `Worktree cleanup failed; recover worktrees at ${worktreeSetup.worktrees.map((worktree) => worktree.path).join(", ")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
					parallelCleanupFailure = message;
					for (let index = 0; index < tasks.length; index++) {
						const result = liveResults[index] ?? { agent: tasks[index]?.agent ?? `task-${index + 1}`, task: tasks[index]?.task ?? "parallel execution", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
						result.success = false; result.interrupted = undefined; result.cancelled = undefined; result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1); result.error = result.error ? `${result.error}\n${message}` : message; liveResults[index] = result;
					}
				}
			}
		}
		// Export can replace the stored result object with an enriched projection.
		// Rebuild the top-level details from that map so status, receipts, and the
		// immediate return cannot regress to the pre-export child result.
		for (let index = 0; index < results.length; index++) {
			if (!liveResults[index] && results[index]) liveResults[index] = results[index];
			else if (liveResults[index]) results[index] = { ...results[index], ...liveResults[index], gitBundle: liveResults[index]!.gitBundle ?? results[index]?.gitBundle };
		}
		const projectedResults = liveResults.filter((candidate): candidate is SingleResult => candidate !== undefined);
		if (detachedIndexes.size === 0 && projectedResults.length > 0) {
			details = compactForegroundDetails({
				mode: "parallel",
				runId,
				results: projectedResults,
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			});
		}
		if (teardownUnproven) details.teardownUnproven = true;
		if (parallelCleanupFailure) {
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, sessionId: deps.state.currentSessionId, startedAt: foregroundControl?.startedAt, results: projectedResults, ...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}) });
			return { content: [{ type: "text", text: parallelCleanupFailure }], isError: true, details };
		}
		if (isolatedRuntime?.exportFenceFailed || isolatedRuntime?.exportFailed) {
			// A failed export/fence returns early, so persist the enriched recovery
			// projection here rather than falling through to the normal remember block.
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, {
				runId,
				mode: "parallel",
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				startedAt: foregroundControl?.startedAt,
				results: projectedResults,
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
			const recoveryMessage = projectedResults.filter((result) => result.error).map((result) => `${result.agent}: ${result.error}`).join("\n") || `Recover isolated worktrees at ${isolatedRuntime.root}.`;
			return {
				content: [{ type: "text", text: recoveryMessage }],
				isError: true,
				details: compactForegroundDetails({ mode: "parallel", runId, results: projectedResults, progress: params.includeProgress ? allProgress : undefined }),
			};
		}
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		rememberForegroundRun(deps.state, {
			runId,
			mode: "parallel",
			cwd: effectiveCwd,
			sessionId: deps.state.currentSessionId,
			startedAt: foregroundControl?.startedAt,
			results: detachedIndexes.size > 0 ? projectedResults : details.results,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});

		const detachedIndex = results.findIndex((result, index) => result.detached || detachedIndexes.has(index));
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			const detachedPath = isolatedRuntime
				? `Recover isolated worktrees at ${isolatedRuntime.root} after the child reaches terminal state.`
				: data.scopedGitEndpoint
					? "Recover retained isolated worktree evidence through the owning parent run after the child reaches terminal state."
					: formatRecoverableWorktreePaths(worktreeSetup);
			const message = `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first. After the child reaches terminal state, the preserved worktree can be exported or recovered.${detachedPath ? `\n${detachedPath}` : ""}`;
			return {
				content: [{ type: "text", text: worktreeSuffix ? `${message}\n\n${worktreeSuffix}` : message }],
				details,
			};
		}

		if (interrupted) {
			const message = `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.`;
			const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
				pi: deps.pi,
				intercomBridge: data.intercomBridge,
				runId,
				mode: "parallel",
				details,
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
				...(worktreeSuffix ? { worktreeSummary: worktreeSuffix } : {}),
			});
			return {
				content: [{ type: "text", text: intercomReceipt ? `${message}\n\n${intercomReceipt.text}` : worktreeSuffix ? `${message}\n\n${worktreeSuffix}` : message }],
				details: intercomReceipt?.details ?? details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			...(worktreeSuffix ? { worktreeSummary: worktreeSuffix } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} catch (error) {
		// mapConcurrent settles already-started callbacks before rejecting. Keep its
		// settled result map so completed isolated siblings (including their bundle)
		// survive the top-level rejection projection.
		preserveWorktree = true;
		if (error instanceof MapConcurrentError) {
			// All started callbacks have settled before mapConcurrent rejects. Mark
			// the top-level execution terminal so a detached callback that raced the
			// rejection can run the same exactly-once cleanup gate as the happy path.
			parallelExecutionSettled = true;
			for (const [index, settled] of error.partialResults.entries()) {
				if (!settled) continue;
				// A detached terminal callback may have enriched liveResults with a
				// verified bundle before mapConcurrent exposes the sibling rejection.
				// Merge the settled value instead of replacing that terminal export.
				liveResults[index] = liveResults[index]
					? { ...liveResults[index], ...settled, gitBundle: settled.gitBundle ?? liveResults[index]!.gitBundle }
					: settled;
			}
		}
		await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal.aborted ? "cancelled" : "execution-rejected");
		const executionMessage = error instanceof MapConcurrentError
			? (error.reason instanceof Error ? error.reason.message : String(error.reason))
			: error instanceof Error ? error.message : String(error);
		if (error instanceof MapConcurrentError && error.rejectionIndex !== undefined) {
			const rejectedIndex = error.rejectionIndex;
			const rejectedTask = tasks[rejectedIndex];
			const rejectedResult = liveResults[rejectedIndex];
			liveResults[rejectedIndex] = {
				...(rejectedResult ?? {
					agent: rejectedTask?.agent ?? `task-${rejectedIndex + 1}`,
					task: rejectedTask?.task ?? "parallel execution",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				}),
				exitCode: 1,
				error: `Parallel execution failed unexpectedly: ${executionMessage}`,
			};
		}
		let recoveryNotice = formatRecoverableWorktreePaths(worktreeSetup);
		let worktreeSuffix = "";
		try {
			worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		} catch (captureError) {
			recoveryNotice = captureError instanceof WorktreeDiffCaptureError
				? captureError.message
				: `${recoveryNotice}${recoveryNotice ? " " : ""}Failed to capture parallel worktree changes: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
		}
		let details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results: liveResults.filter((result): result is SingleResult => result !== undefined),
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		const lines = [`Parallel execution failed unexpectedly: ${executionMessage}`];
		if (worktreeSuffix) lines.push(worktreeSuffix);
		if (recoveryNotice) lines.push(recoveryNotice);
		let inlineFailure = lines.join("\n\n");
		await finalizeDetachedIfReady();
		// Detached finalization can enrich terminal results with verified bundles;
		// refresh the failure projection before durable remember/publication.
		details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results: liveResults.filter((result): result is SingleResult => result !== undefined),
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		if (!detachedCleanupComplete && isolatedRuntime && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed) {
			try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
		}
		if (!detachedCleanupComplete && worktreeSetup) {
			try { cleanupWorktrees(worktreeSetup, { preserve: preserveWorktree || detachedIndexes.size > 0 || Boolean(isolatedRuntime?.exportFailed || isolatedRuntime?.exportFenceFailed) }); }
			catch (cleanupError) {
				preserveWorktree = true;
				teardownUnproven = true;
				const message = `Worktree cleanup failed; recover worktrees at ${worktreeSetup.worktrees.map((worktree) => worktree.path).join(", ")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
				parallelCleanupFailure = message;
				for (let index = 0; index < tasks.length; index++) {
					const result = liveResults[index] ?? { agent: tasks[index]?.agent ?? `task-${index + 1}`, task: tasks[index]?.task ?? "parallel execution", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
					result.success = false; result.interrupted = undefined; result.cancelled = undefined; result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1); result.error = result.error ? `${result.error}\n${message}` : message; liveResults[index] = result;
				}
			}
		}
		// Cleanup can mutate every sibling after the initial rejection details were
		// built. Rebuild all projections so durable status, returned details, and
		// intercom cannot retain a pre-cleanup success.
		details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results: liveResults.filter((result): result is SingleResult => result !== undefined),
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		if (teardownUnproven) details.teardownUnproven = true;
		if (parallelCleanupFailure && !inlineFailure.includes(parallelCleanupFailure)) inlineFailure = `${inlineFailure}\n\n${parallelCleanupFailure}`;
		rememberForegroundRun(deps.state, {
			runId,
			mode: "parallel",
			cwd: data.effectiveCwd,
			sessionId: deps.state.currentSessionId,
			startedAt: foregroundControl?.startedAt,
			results: details.results,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
		});
		return {
			content: [{ type: "text", text: intercomReceipt ? `${inlineFailure}\n\n${intercomReceipt.text}` : inlineFailure }],
			isError: true,
			details: intercomReceipt?.details ?? details,
		};
	}
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	let fastMode = params.fastMode ?? agentConfig.fastMode ?? false;
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveRunMaxSubagentDepth(params.maxSubagentDepth, deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);
	const sandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(params.agentScope));

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride, fastMode });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
					[{
						worktree: "isolated",
						sandbox: resolveSandboxConfig({ settings: sandboxSettings, agent: agentConfig, run: params.sandbox }),
						canOptOutOfWorktree: agentConfig.canOptOutOfWorktree === true && sandboxSettings?.allowWorktreeOptOut === true,
						canOptOutOfSandbox: sandboxSettings?.allowSandboxOptOut === true,
					}],
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.fastMode !== undefined) fastMode = override.fastMode;
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			const asyncAgentConfig = data.asyncAgents.find((a) => a.name === params.agent);
			if (!asyncAgentConfig) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const asyncSandboxSettings = sandboxSettings;
			let sandbox = resolveSandboxConfig({
				settings: asyncSandboxSettings,
				agent: asyncAgentConfig,
				run: params.sandbox,
			});
			if (params.worktree === false && !data.scopedGitEndpoint && sandbox?.gitMode === "isolated"
				&& worktreeOptOutIsAuthorized(asyncSandboxSettings)
				&& asyncAgentConfig.canOptOutOfWorktree === true) {
				sandbox = { ...sandbox, gitMode: "read-only" };
			}

			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: params.context === "fork" ? wrapForkTask(task) : task,
				agentConfig: asyncAgentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForIndex(0),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				outputMode: effectiveOutputMode,
				modelOverride,
				fastMode,
				maxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				nestedRoute: data.nestedRoute,
				sandbox,
				sandboxSettings: asyncSandboxSettings,
				sandboxRun: params.sandbox,
				worktree: params.worktree,
				scopedGitEndpoint: data.scopedGitEndpoint,
				sandboxIntercomBridge: resolveSandboxIntercomBridge(data.intercomBridge),
			});
		}
	}

	// Resolve sandbox policy before reserving any inherited endpoint subtree.
	// The owner retains lifecycle authority; this process borrows a narrowed lease.
	let sandbox: ReturnType<typeof resolveSandboxConfig>;
	try {
		sandbox = resolveSandboxConfig({
			settings: sandboxSettings,
			agent: agentConfig,
			run: params.sandbox,
		});
	} catch (error) {
		unregisterForegroundInterrupt();
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
	}
	if (params.worktree === false && !data.scopedGitEndpoint && sandbox?.gitMode === "isolated"
		&& worktreeOptOutIsAuthorized(sandboxSettings)
		&& agentConfig.canOptOutOfWorktree === true) {
		sandbox = { ...sandbox, gitMode: "read-only" };
	}
	if (data.scopedGitEndpoint) {
		// Force inherited Git/network/auth policy while retaining authorized
		// runtime mounts needed by the child command (for example its mock queue).
		sandbox = {
			...sandbox,
			provider: "bubblewrap",
			gitMode: "isolated",
			network: "none",
			profile: "host-toolchain",
			fallback: "fail",
			auth: "none",
		} as ReturnType<typeof resolveSandboxConfig>;
	}
	// Foreground nested authority is represented only by scopedGitEndpoint.
	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	const savedOutputPath = shouldPersistSavedOutput({
		output: effectiveOutput,
		outputMode: effectiveOutputMode,
		tools: agentConfig.tools,
	})
		? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: effectiveCwd, agent: params.agent!, runId, index: 0 })
		: undefined;
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath ?? savedOutputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	const instructionOutputPath = outputPath ?? (effectiveOutputMode === "file-only" ? savedOutputPath : undefined);
	task = injectSingleOutputInstruction(task, instructionOutputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	let unregisterInterrupt: (() => void) | undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const unregisterForegroundInterrupt = (): void => {
		unregisterInterrupt?.();
		unregisterInterrupt = undefined;
	};
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.currentModel = modelOverride ?? agentConfig.model;
		foregroundControl.currentThinking = undefined;
		foregroundControl.currentFastMode = resolveFastModeStatus(fastMode, modelOverride ?? agentConfig.model, availableModels, currentProvider);
		foregroundControl.updatedAt = Date.now();
		foregroundControl.sessionFile = sessionFileForIndex(0);
		unregisterInterrupt = registerForegroundInterrupt(foregroundControl, () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		});
	}

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.currentModel = update.details?.results?.[0]?.model ?? modelOverride ?? agentConfig.model;
				foregroundControl.currentThinking = update.details?.results?.[0]?.thinking;
				foregroundControl.currentFastMode = update.details?.results?.[0]?.fastMode ?? foregroundControl.currentFastMode;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.currentPath = firstProgress?.currentPath;
				foregroundControl.turnCount = firstProgress?.turnCount;
				foregroundControl.tokens = firstProgress?.tokens;
				foregroundControl.toolCount = firstProgress?.toolCount;
				foregroundControl.updatedAt = Date.now();
				foregroundControl.sessionFile = sessionFileForIndex(firstProgress?.index ?? 0);
			}
			onUpdate(update);
		}
		: undefined;

	if (data.scopedGitEndpoint) {
		// Force inherited Git/network/auth policy while retaining authorized
		// runtime mounts needed by the child command (for example its mock queue).
		sandbox = {
			...sandbox,
			provider: "bubblewrap",
			gitMode: "isolated",
			network: "none",
			profile: "host-toolchain",
			fallback: "fail",
			auth: "none",
		} as ReturnType<typeof resolveSandboxConfig>;
	}
	let isolatedRuntime: IsolatedGitRuntime | undefined;
	let isolatedWorktree: IsolatedGitWorktree | undefined;
	const noteSingleCleanupFailure = (target: SingleResult, cause?: unknown): string => {
		const root = isolatedRuntime?.root ?? effectiveCwd;
		isolatedRuntime?.markExportFailed();
		const message = `Isolated Git cleanup failed after export; recover isolated worktree at ${root}.${cause ? ` ${cause instanceof Error ? cause.message : String(cause)}` : ""}`;
		target.exitCode = target.exitCode === 0 ? 1 : (target.exitCode ?? 1);
		target.success = false;
		target.teardownUnproven = true;
		delete target.interrupted;
		delete target.cancelled;
		target.error = target.error ? `${target.error}\n${message}` : message;
		return message;
	};
	let detachedStarted = false;
	if (sandbox?.gitMode === "isolated" && !data.scopedGitEndpoint) {
		try {
			isolatedRuntime = createIsolatedGitRuntime({
				cwd: effectiveCwd,
				runId,
				provider: sandbox.provider,
				network: sandbox.network,
				profile: sandbox.profile,
				fallback: sandbox.fallback,
				worktreeSetupHook: deps.config.worktreeSetupHook ? { hookPath: deps.config.worktreeSetupHook, timeoutMs: deps.config.worktreeSetupHookTimeoutMs } : undefined,
				extraReadOnlyMounts: sandbox.extraReadOnlyMounts,
				extraWritableMounts: sandbox.extraWritableMounts,
			});
			isolatedWorktree = createIsolatedGitWorktree(isolatedRuntime, { index: 0, agent: params.agent });
		} catch (error) {
			// Remove the live interrupt callback before any recovery export/cleanup;
			// those operations can throw and must never leave a stale handler.
			unregisterForegroundInterrupt();
			const setupError = error instanceof Error ? error.message : String(error);
			let gitBundle: SingleResult["gitBundle"] | undefined;
			let exportError: unknown;
			const setupWorktree = isolatedWorktree ?? isolatedRuntime?.worktrees[0];
			if (isolatedRuntime && setupWorktree) {
				for (let attempt = 0; attempt < 2 && !gitBundle; attempt++) {
					try {
						const bundle = exportBundleWithRetries(isolatedRuntime, {
							outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
							worktree: setupWorktree,
							terminationState: "execution-rejected",
							agent: params.agent,
							commitRequired: isolatedGitCommitRequired(task, agentConfig, sandbox),
						});
						gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
					} catch (attemptError) { exportError = attemptError; }
				}
				if (!gitBundle) isolatedRuntime.markExportFailed();
				if (gitBundle && !isolatedRuntime.exportFailed) {
					try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
					catch (cleanupError) {
						isolatedRuntime.markExportFailed();
						const message = `Isolated Git cleanup failed after setup rejection; recover isolated worktree at ${isolatedRuntime.root}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
						exportError = new Error(message);
						gitBundle = undefined;
						// Keep the retained root actionable in the child projection below.
						isolatedRuntime.markExportFailed();
						isolatedWorktree = undefined;
					}
				}
			} else if (isolatedRuntime) {
				// A synchronous first-slot failure can happen before the local
				// worktree variable is assigned. If the runtime registered no slot,
				// close its endpoint owner and remove the empty runtime rather than
				// silently leaving active privileged state behind.
				try {
					if (isolatedRuntime.worktrees.length === 0) await cleanupIsolatedGitRuntime(isolatedRuntime);
					else isolatedRuntime.markExportFailed();
				} catch (cleanupError) {
					exportError = cleanupError;
					isolatedRuntime.markExportFailed();
				}
			}
			const recovery = gitBundle
				? ""
				: isolatedRuntime && fs.existsSync(isolatedRuntime.root)
					? `\nIsolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`
					: "";
			const child: SingleResult = {
				agent: params.agent!, task: cleanTask, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, success: false,
				error: `${setupError}${recovery}`,
				...(gitBundle ? { gitBundle } : {}),
			};
			rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, sessionId: deps.state.currentSessionId, startedAt: foregroundControl?.startedAt, results: [child], ...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}) });
			return { content: [{ type: "text", text: child.error! }], isError: true, details: compactForegroundDetails({ mode: "single", runId, results: [child] }) };
		}
	}
	let isolatedCapability: import("../../sandbox/isolated-git.ts").IsolatedGitCapability | undefined;
	try {
		if (isolatedWorktree) {
			isolatedCapability = isolatedWorktree.runtime.issueInheritedContext({
				worktree: isolatedWorktree,
				rights: isolatedGitCommitRequired(task, agentConfig, sandbox) ? "writer" : "read-only",
				cwd: effectiveCwd,
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", runId, results: [] } };
	}
	let r: SingleResult | undefined;
	try {
		r = await runSync(ctx.cwd, agents, params.agent!, task, {
		// Pass the requested parent cwd through; runSingleAttempt maps it to the
		// runtime-managed private worktree while preserving subdirectory intent.
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		nestedFenceTimeoutMs: nestedFenceTimeoutForExecutor(deps),
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForIndex(0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		outputPath,
		savedOutputPath,
		outputMode: effectiveOutputMode,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		onDetachedStarted: () => { detachedStarted = true; },
		onDetachedTerminal: async (detachedResult) => {
			// Detached execution owns the capability until terminal close and an exact
			// descendant fence, not merely acknowledgement. Retain authority when the
			// fence is unproven so the parent can recover/finish teardown.
			let releaseCapability = true;
			if (data.scopedGitEndpoint && !detachedResult.teardownUnproven) {
				const fence = await (deps.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
				if (!fence.observed || !fence.stopped) {
					detachedResult.teardownUnproven = true;
					detachedResult.success = false;
					delete detachedResult.interrupted;
					delete detachedResult.cancelled;
					detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
					const message = "Nested descendants did not reach a proven terminal state before scoped Git endpoint cleanup; recover retained isolated worktree evidence through the owning parent run";
					detachedResult.error = detachedResult.error ? `${detachedResult.error}\n${message}` : message;
				}
			}
			if (!isolatedRuntime && isolatedWorktree && !detachedResult.teardownUnproven) {
				const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
				if (!fence.stopped) {
					releaseCapability = false;
					detachedResult.teardownUnproven = true;
					detachedResult.success = false;
					delete detachedResult.interrupted;
					delete detachedResult.cancelled;
					detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
					detachedResult.error = detachedResult.error ? `${detachedResult.error}\nNested descendants did not reach a proven terminal state; inherited capability retained for recovery.` : "Nested descendants did not reach a proven terminal state; inherited capability retained for recovery.";
				}
			}
			if (detachedResult.teardownUnproven) releaseCapability = false;
			if (isolatedRuntime && isolatedWorktree && !isolatedRuntime.isExported(isolatedWorktree.index) && !detachedResult.teardownUnproven) {
				const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
				if (!fence.stopped) {
					releaseCapability = false;
					isolatedRuntime.markExportFenceFailed();
					detachedResult.teardownUnproven = true;
					detachedResult.success = false;
					delete detachedResult.interrupted;
					delete detachedResult.cancelled;
					const recovery = `Nested descendants did not reach a proven terminal state before export; recover isolated worktree at ${isolatedRuntime.root}`;
					detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
					detachedResult.error = detachedResult.error ? `${detachedResult.error}\n${recovery}` : recovery;
				} else {
					try {
						const bundle = exportBundleWithRetries(isolatedRuntime, {
							outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
							worktree: isolatedWorktree,
							syntheticPaths: isolatedWorktree.syntheticPaths,
							terminationState: detachedResult.cancelled ? "cancelled" : detachedResult.interrupted ? "interrupted" : detachedResult.exitCode === 0 ? "success" : "failure",
							agent: params.agent,
							commitRequired: isolatedGitCommitRequired(task, agentConfig, sandbox),
						});
						detachedResult.gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
						if (bundle.incomplete && isolatedGitCommitRequired(task, agentConfig, sandbox) && !detachedResult.error) {
							detachedResult.exitCode = 1;
							detachedResult.error = "Isolated writer completed without a required authored commit; recovery bundle is incomplete.";
						}
					} catch (error) {
						isolatedRuntime.markExportFailed();
						const exportError = `Isolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${error instanceof Error ? error.message : String(error)}`;
						detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
						delete detachedResult.interrupted;
						delete detachedResult.cancelled;
						detachedResult.error = detachedResult.error ? `${detachedResult.error}\n${exportError}` : exportError;
					}
				}
				if (releaseCapability && isolatedCapability && isolatedWorktree) {
					try {
						isolatedWorktree.runtime.releaseInheritedContext(isolatedCapability);
					} catch (error) {
						isolatedWorktree.runtime.markExportFenceFailed();
						detachedResult.teardownUnproven = true;
						detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
						const detail = error instanceof Error ? error.message : String(error);
						detachedResult.error = detachedResult.error ? `${detachedResult.error}\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
					}
				}
				if (isolatedRuntime.isExported(isolatedWorktree.index) && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed && !detachedResult.teardownUnproven) {
					try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
					catch (cleanupError) { noteSingleCleanupFailure(detachedResult, cleanupError); }
					if (isolatedRuntime.exportFailed || fs.existsSync(isolatedRuntime.root)) {
						const cleanupError = `Isolated Git cleanup failed after export; recover isolated worktree at ${isolatedRuntime.root}.`;
						detachedResult.exitCode = detachedResult.exitCode === 0 ? 1 : detachedResult.exitCode;
						detachedResult.success = false;
						delete detachedResult.interrupted;
						delete detachedResult.cancelled;
						detachedResult.error = detachedResult.error ? `${detachedResult.error}\n${cleanupError}` : cleanupError;
					}
				}
			}

			if (detachedResult.teardownUnproven) {
				// Keep the actionable recovery projection, but suppress terminal
				// detached publication when release or descendant termination was not
				// proven.
				rememberForegroundRun(deps.state, {
					runId,
					mode: "single",
					cwd: effectiveCwd,
					sessionId: deps.state.currentSessionId,
					results: [detachedResult],
					...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
				});
				return;
			}
			const terminalDetails = compactForegroundDetails({
				mode: "single",
				runId,
				results: [detachedResult],
				progress: params.includeProgress ? (detachedResult.progress ? [detachedResult.progress] : undefined) : undefined,
			});
			if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
			rememberForegroundRun(deps.state, {
				runId,
				mode: "single",
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				results: [detachedResult],
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
			forwardSingleUpdate?.({
				content: [{ type: "text", text: detachedResult.error || getSingleResultOutput(detachedResult) || "(no output)" }],
				details: terminalDetails,
			});
			await emitForegroundResultIntercom({
				pi: deps.pi,
				intercomBridge: data.intercomBridge,
				runId,
				mode: "single",
				results: [detachedResult],
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
		},
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		fastMode,
		availableModels,
		preferredModelProvider: currentProvider,
		skills: effectiveSkills,
		acceptance: params.acceptance,
		acceptanceContext: { mode: "single" },
		sandbox,
		hostGitDiagnostic: !sandbox && hasExplicitSandboxOptOut({ settings: sandboxSettings, agent: agentConfig, run: params.sandbox }),
		isolatedGit: isolatedWorktree,
		isolatedGitCapability: isolatedCapability,
		isolatedGitEndpoint: data.scopedGitEndpoint,
		isolatedGitRights: data.scopedGitEndpoint ? (isolatedGitCommitRequired(task, agentConfig, sandbox) ? "writer" : "read-only") : undefined,
		isolatedGitBundleDir: artifactsDir,
		isolatedGitCommitRequired: Boolean(isolatedWorktree) && isolatedGitCommitRequired(task, agentConfig, sandbox),
		isolatedGitOwner: true,
		sandboxIntercomBridge: resolveSandboxIntercomBridge(data.intercomBridge),
		}).then(async (settled) => {
			r = settled;
			if (data.scopedGitEndpoint && !settled.detached && !settled.teardownUnproven) {
				const fence = await (deps.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
				if (!fence.observed || !fence.stopped) {
					settled.teardownUnproven = true;
					settled.success = false;
					delete settled.interrupted;
					delete settled.cancelled;
					settled.exitCode = settled.exitCode === 0 ? 1 : settled.exitCode;
					const message = "Nested descendants did not reach a proven terminal state before scoped Git endpoint cleanup; recover retained isolated worktree evidence through the owning parent run";
					settled.error = settled.error ? `${settled.error}\\n${message}` : message;
				}
			}
			if (isolatedCapability && !settled.detached && isolatedWorktree) {
				if (settled.teardownUnproven) {
					isolatedWorktree.runtime.markExportFenceFailed();
				} else {
					const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
					if (fence.stopped) {
						try {
							isolatedWorktree.runtime.releaseInheritedContext(isolatedCapability);
						} catch (error) {
							isolatedWorktree.runtime.markExportFenceFailed();
							settled.teardownUnproven = true;
							settled.success = false;
							delete settled.interrupted;
							delete settled.cancelled;
							settled.exitCode = settled.exitCode === 0 ? 1 : settled.exitCode;
							const detail = error instanceof Error ? error.message : String(error);
							settled.error = settled.error ? `${settled.error}\\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
						}
					} else {
						isolatedWorktree.runtime.markExportFenceFailed();
						settled.teardownUnproven = true;
						settled.success = false;
						delete settled.interrupted;
						delete settled.cancelled;
						settled.exitCode = settled.exitCode === 0 ? 1 : settled.exitCode;
						settled.error = settled.error ? `${settled.error}\\nNested descendants did not reach a proven terminal state; inherited capability retained for recovery.` : "Nested descendants did not reach a proven terminal state; inherited capability retained for recovery.";
					}
				}
			}
			return settled;
		}).finally(() => unregisterForegroundInterrupt());
	} catch (error) {
		unregisterForegroundInterrupt();
		const executionMessage = `Foreground execution rejected: ${error instanceof Error ? error.message : String(error)}`;
		let recovery = "";
		let gitBundle: SingleResult["gitBundle"];
		if (isolatedRuntime) {
			const fence = await waitForNestedDescendantsToStop(data.nestedRoute, runId, 0, { timeoutMs: nestedFenceTimeoutForExecutor(deps) });
			if (!fence.stopped) {
				isolatedRuntime.markExportFenceFailed();
				recovery = `Nested descendants did not reach a proven terminal state before export; recover isolated worktree at ${isolatedRuntime.root}.`;
			} else if (isolatedWorktree && !isolatedRuntime.isExported(isolatedWorktree.index)) {
				try {
					const bundle = exportBundleWithRetries(isolatedRuntime, {
						outputDir: artifactsDir ?? path.join(os.tmpdir(), "isolated-git-bundles"),
						worktree: isolatedWorktree,
						terminationState: signal.aborted ? "cancelled" : "execution-rejected",
						agent: params.agent,
						commitRequired: isolatedGitCommitRequired(task, agentConfig, sandbox),
					});
					gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
				} catch (exportError) {
					isolatedRuntime.markExportFailed();
					recovery = `Isolated Git bundle export failed; recover worktree at ${isolatedRuntime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				}
			}
		}
		const child: SingleResult = {
			agent: params.agent!,
			task: cleanTask,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `${executionMessage}${recovery ? `\n${recovery}` : ""}`,
			...(gitBundle ? { gitBundle } : {}),
		};
		// Rejection is terminal: project the real child through durable status and
		// grouped result intercom before returning, never an empty result list.
		if (isolatedRuntime && !isolatedRuntime.exportFailed && !isolatedRuntime.exportFenceFailed && gitBundle) {
			try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
			catch (cleanupError) { noteSingleCleanupFailure(child, cleanupError); }
		}
		const rejectedDetails = compactForegroundDetails({ mode: "single", runId, results: [child] });
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		rememberForegroundRun(deps.state, {
			runId,
			mode: "single",
			cwd: effectiveCwd,
			sessionId: deps.state.currentSessionId,
			startedAt: foregroundControl?.startedAt,
			results: rejectedDetails.results,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details: rejectedDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		return {
			content: [{ type: "text", text: intercomReceipt?.text ?? child.error! }],
			details: intercomReceipt?.details ?? rejectedDetails,
			isError: true,
		};
	}
	if (foregroundControl?.currentIndex === 0) {
		unregisterInterrupt?.();
		unregisterInterrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.currentModel = r.model ?? modelOverride ?? agentConfig.model;
		foregroundControl.currentThinking = r.thinking;
		foregroundControl.currentFastMode = r.fastMode ?? foregroundControl.currentFastMode;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
		announceSavedPath: r.savedOutputAnnounced,
	});
	let details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
	});
	// A verified terminal export is the publication boundary: remove the private
	// runtime before durable status or grouped intercom observers can inspect it.
	// Detached, fence-refused, and failed-export runtimes remain recoverable;
	// cleanupIsolatedGitRuntime is deliberately a no-op for those states.
	if (isolatedRuntime && !r.detached) {
		try { await cleanupIsolatedGitRuntime(isolatedRuntime); }
		catch (cleanupError) { noteSingleCleanupFailure(r, cleanupError); }
		if (isolatedRuntime.exportFailed || fs.existsSync(isolatedRuntime.root)) {
			const cleanupError = `Isolated Git cleanup failed after export; recover isolated worktree at ${isolatedRuntime.root}.`;
			r.exitCode = r.exitCode === 0 ? 1 : r.exitCode;
			r.success = false;
		delete r.interrupted;
		delete r.cancelled;
		r.error = r.error ? `${r.error}\n${cleanupError}` : cleanupError;
			details = compactForegroundDetails({ mode: "single", runId, results: [r], progress: params.includeProgress ? allProgress : undefined, artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined, truncation: r.truncation });
		}
	}
	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	rememberForegroundRun(deps.state, {
		runId,
		mode: "single",
		cwd: effectiveCwd,
		sessionId: deps.state.currentSessionId,
		startedAt: foregroundControl?.startedAt,
		results: details.results,
		...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
	});

	if (r.teardownUnproven) {
		return {
			content: [{ type: "text", text: r.error || "Terminal cleanup remains unproven; recover the retained isolated worktree." }],
			details,
			isError: true,
		};
	}

	if (!r.detached) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached || detachedStarted) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first. After the child reaches terminal state, the preserved worktree can be exported or recovered.${isolatedRuntime ? ` Recover isolated worktree at ${isolatedRuntime.root}.` : ""}` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const verifyRunnerPid = deps.isExpectedAsyncRunnerPid ?? isExpectedAsyncRunnerPid;
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		let preAuthenticatedEndpoint: ScopedGitEndpointDescriptor | undefined;
		const rawEndpoint = process.env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV];
		if (rawEndpoint) { try { preAuthenticatedEndpoint = JSON.parse(rawEndpoint) as ScopedGitEndpointDescriptor; } catch (error) { return { content: [{ type: "text", text: `Scoped Git endpoint descriptor is malformed: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "single", results: [] } }; } }
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		let authenticatedInheritedRoute: ReturnType<typeof resolveRequiredInheritedNestedRouteFromEnv>;
		try {
			authenticatedInheritedRoute = resolveRequiredInheritedNestedRouteFromEnv();
		} catch (error) {
			return {
				content: [{ type: "text", text: `Inherited nested route rejected: ${error instanceof Error ? error.message : String(error)}` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (params.action) {
			if (params.action === "doctor") {
				let currentSessionFile: string | null = null;
				let currentSessionId = deps.state.currentSessionId;
				let sessionError: string | undefined;
				try {
					currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch (error) {
					sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				let orchestratorTarget: string | undefined;
				try {
					orchestratorTarget = resolveIntercomSessionTarget(
						deps.pi.getSessionName(),
						ctx.sessionManager.getSessionId(),
						process.env.PI_INTERCOM_SESSION_ID,
					);
				} catch {}
				return {
					content: [{
						type: "text",
						text: buildDoctorReport({
							cwd: requestCwd,
							config: deps.config,
							state: deps.state,
							context: paramsWithResolvedCwd.context,
							requestedSessionDir: paramsWithResolvedCwd.sessionDir,
							currentSessionFile,
							currentSessionId,
							orchestratorTarget,
							sessionError,
							expandTilde: deps.expandTilde,
						}),
					}],
					details: { mode: "management", results: [] },
				};
			}
			if (params.action === "status") {
				const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
				if (targetRunId) {
					try {
						const nestedScope = nestedResolutionScopeForExecutor(deps);
						const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) return foregroundStatusResult(foreground);
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				} else {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground) return foregroundStatusResult(foreground);
				}
				return inspectSubagentStatus(paramsWithResolvedCwd, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
			}
			if (params.action === "resume") {
				return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, scopedGitEndpoint: preAuthenticatedEndpoint });
			}
			if (params.action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (resolved?.kind === "nested") return interruptNestedRun(resolved, verifyRunnerPid);
				const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
				if (foreground?.interrupt) {
					const cascade = cascadeStopNestedDescendants({ route: foreground.nestedRoute, children: foreground.nestedChildren, sourceRunId: foreground.runId, verifyRunnerPid });
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						foreground.currentActivityState = undefined;
						try {
							updateForegroundNestedProjection(foreground);
						} catch {
							// Non-fatal: cascadeStopNestedDescendants already made a best-effort status update.
						}
						return {
							content: [{ type: "text", text: appendNestedCleanupSummary(`Interrupt requested for foreground run ${foreground.runId}.`, cascade) }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId, verifyRunnerPid);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (!(SUBAGENT_ACTIONS as readonly string[]).includes(params.action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(params.action)) {
				return {
					content: [{ type: "text", text: `Action '${params.action}' is not available from child-safe subagent fanout mode.` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(params.action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;
		// Keep the pre-default, raw request for override policy. In particular,
		// context inferred from agent frontmatter is not a caller override.
		const rawOverrideParams = normalizedParams;

		let effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope).agents;
		const sandboxSettings = readSandboxSettings(effectiveCwd, scope);
		// provider:none is intentionally not a normal agent default. It is only
		// accepted when a trusted user-global setting explicitly enables the
		// escape hatch; project settings and child requests cannot grant it.
		effectiveParams = applyAgentDefaultContext(effectiveParams, discoveredAgents);
		const orchestratorTarget = resolveIntercomSessionTarget(
			deps.pi.getSessionName(),
			ctx.sessionManager.getSessionId(),
			process.env.PI_INTERCOM_SESSION_ID,
		);
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context,
			orchestratorTarget,
			cwd: effectiveCwd,
			extensionDir: process.env[SUBAGENT_INTERCOM_EXTENSION_DIR_ENV],
		});
		const runId = randomUUID().slice(0, 8);
		const inheritedNestedRoute = authenticatedInheritedRoute;
		let scopedGitEndpoint: ScopedGitEndpointDescriptor | undefined = effectiveParams.isolatedGitEndpoint ?? preAuthenticatedEndpoint;
		if (scopedGitEndpoint) {
			const relativeSubtree = scopedGitEndpoint.relativeSubtree;
			if (typeof relativeSubtree !== "string" || !relativeSubtree || path.isAbsolute(relativeSubtree) || relativeSubtree.split(/[\\/]/u).some((part) => part === "..")) {
				return { content: [{ type: "text", text: "Scoped Git endpoint descriptor rejected: invalid scoped endpoint descriptor" }], isError: true, details: { mode: "single", results: [] } };
			}
		}
		if (scopedGitEndpoint) {
			try {
				await validateScopedGitChildDescriptor(scopedGitEndpoint, { cwd: effectiveCwd, rights: effectiveParams.isolatedGitRights ?? "writer" });
			} catch (error) {
				return { content: [{ type: "text", text: `Scoped Git endpoint preflight rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "single", results: [] } };
			}
		}
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
		const shareEnabled = effectiveParams.share === true;
		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
		const targetAgentsForSandboxPolicy = hasSingle
			? [discoveredAgents.find((agent) => agent.name === effectiveParams.agent)].filter((agent): agent is AgentConfig => Boolean(agent))
			: hasTasks
				? (effectiveParams.tasks ?? []).map((task) => discoveredAgents.find((agent) => agent.name === task.agent)).filter((agent): agent is AgentConfig => Boolean(agent))
				: (effectiveParams.chain ?? []).flatMap((step) => isParallelStep(step)
					? step.parallel.map((task) => discoveredAgents.find((agent) => agent.name === task.agent))
					: isDynamicParallelStep(step)
						? [discoveredAgents.find((agent) => agent.name === step.parallel.agent)]
						: step.agent ? [discoveredAgents.find((agent) => agent.name === step.agent)] : []).filter((agent): agent is AgentConfig => Boolean(agent));
		const nestedSelfDecontainment = Boolean(inheritedNestedRoute);
		const topLevelWorktreeOptOut = Object.hasOwn(effectiveParams, "worktree") && effectiveParams.worktree === false;
		const chainWorktreeOptOutSteps = (effectiveParams.chain ?? []).filter((step) => Object.hasOwn(step, "worktree") && (step as { worktree?: boolean }).worktree === false);
		const chainWorktreeOptOutAgents = chainWorktreeOptOutSteps.flatMap((step) => isParallelStep(step)
			? step.parallel.map((task) => discoveredAgents.find((agent) => agent.name === task.agent))
			: isDynamicParallelStep(step) ? [discoveredAgents.find((agent) => agent.name === step.parallel.agent)] : [])
			.filter((agent): agent is AgentConfig => Boolean(agent));
		const explicitWorktreeOptOut = topLevelWorktreeOptOut || chainWorktreeOptOutSteps.length > 0;
		const worktreeOptOutTargetAgents = topLevelWorktreeOptOut ? targetAgentsForSandboxPolicy : chainWorktreeOptOutAgents;
		const rawProvider = effectiveParams.sandbox?.provider;
		const rawProviderNone = typeof rawProvider === "string" && rawProvider.trim() === "none";
		const frontmatterProviderNone = targetAgentsForSandboxPolicy.some((agent) => agent.sandbox?.provider?.trim() === "none");
		if (nestedSelfDecontainment && (explicitWorktreeOptOut || rawProviderNone || frontmatterProviderNone)) {
			return validationErrorResult(
				getRequestedModeLabel(effectiveParams),
				"Child self-decontainment denied before spawn: nested children must retain inherited scoped isolation and cannot request worktree:false or sandbox.provider:none.",
			);
		}
		const sandboxOptOutRequested = hasExplicitSandboxOptOut({ settings: sandboxSettings, run: effectiveParams.sandbox })
			|| frontmatterProviderNone;
		if (sandboxOptOutRequested && sandboxSettings?.allowSandboxOptOut !== true) {
			return validationErrorResult(getRequestedModeLabel(effectiveParams), "Sandbox opt-out denied: provider:none requires trusted user-global sandbox.allowSandboxOptOut=true; project settings and child agents cannot enable it.");
		}
		const worktreeOptOutAllowed = explicitWorktreeOptOut
			&& worktreeOptOutIsAuthorized(sandboxSettings)
			&& worktreeOptOutTargetAgents.length > 0
			&& worktreeOptOutTargetAgents.every((agent) => agent.canOptOutOfWorktree === true);
		if (explicitWorktreeOptOut && !worktreeOptOutAllowed) {
			return validationErrorResult(
				getRequestedModeLabel(effectiveParams),
				"Worktree opt-out denied: worktree:false requires trusted user-global sandbox.allowWorktreeOptOut=true and every target agent must set canOptOutOfWorktree=true.",
			);
		}
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const nestedLaunchContext = {
			params: effectiveParams,
			inheritedNestedRoute,
			nestedParentAddress,
		};
		const ralphNestedWorkerLaunch = isRalphOrchestratorNestedWorkerLaunch(nestedLaunchContext);
		const orchestratorInlineLoopLaunch = isOrchestratorNestedLaunch(nestedLaunchContext, isOrchestratorInlineLoopAgentName);

		// The orchestrator must consume explore/work/review results before it can
		// reserve the next scoped stage. An ambient async default must not detach these
		// omitted-async loop calls; an explicit async value still wins.
		const requestedAsync = orchestratorInlineLoopLaunch && effectiveParams.async === undefined
			? false
			: effectiveParams.async ?? deps.asyncByDefault;
		const backgroundRequestedWhileClarifying = (hasChain || hasTasks) && requestedAsync && effectiveParams.clarify === true;
		const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
		const asyncAgents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const foregroundAgents = discoveredAgents.map((agent) => stripContactSupervisorFromAgent(agent));
		const agents = effectiveAsync ? asyncAgents : foregroundAgents;
		// Model metadata is resolved by the execution path that needs it. Do not
		// read the registry here: setup and preflight must preserve their prior
		// behavior even when a test/runtime registry is unavailable.
		const availableModels: ModelInfo[] = [];
		const currentProvider = ctx.model?.provider;

		// Ralph orchestrator sandbox preflight: check gh auth, git probe, and worktree pointer
		// before launching nested workers, so environmental failures are detected early.
		let preflightSummaryForResult: string | undefined;
		if (ralphNestedWorkerLaunch) {
			const sandboxSettings = readSandboxSettings(effectiveCwd, resolveExecutionAgentScope(effectiveParams.agentScope));
			const ralphWorkerTargetAgentName = collectRalphNestedLaunchAgentTargets(effectiveParams).find(isRalphNestedWorkerAgentName);
			const ralphWorkerTargetAgent = ralphWorkerTargetAgentName ? discoveredAgents.find((a) => a.name === ralphWorkerTargetAgentName) : undefined;
			const sandboxInput = { settings: sandboxSettings, agent: ralphWorkerTargetAgent, run: effectiveParams.sandbox };
			const sandboxConfig = resolveSandboxConfig(sandboxInput);
			// Explicit provider `none` is the documented opt-out from Bubblewrap;
			// it must also opt out of sandbox-only Git/preflight requirements.
			if (!hasExplicitSandboxOptOut(sandboxInput) && sandboxConfig?.provider !== "none") {
				const sandboxRoot = effectiveCwd;
				const extraMountRoots = [
					...(sandboxConfig?.extraReadOnlyMounts ?? []),
					...(sandboxConfig?.extraWritableMounts ?? []),
				];
				const preflight = runSandboxPreflight({
					cwd: effectiveCwd,
					sandboxRoot,
					extraMountRoots: extraMountRoots.length > 0 ? extraMountRoots : undefined,
					requireGitWorktree: true,
				});
				if (!preflight.passed) {
					console.warn(preflight.summary);
					return validationErrorResult(
						getRequestedModeLabel(effectiveParams),
						`Ralph orchestrator sandbox preflight failed:\n${preflight.summary}`,
					);
				}
				console.log(preflight.summary);
				preflightSummaryForResult = preflight.summary;
			}
		}

		const validationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (validationError) return validationError;

		const overridePolicyError = validateAndFormatAgentOverridePolicy(rawOverrideParams, discoveredAgents);
		if (overridePolicyError) {
			return validationErrorResult(getRequestedModeLabel(effectiveParams), overridePolicyError);
		}

		let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		try {
			sessionFileForIndex = createForkContextResolver(ctx.sessionManager, effectiveParams.context).sessionFileForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error);
		}
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
		};
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.config.defaultSessionDir
				? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
				: deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);
		const childSessionFileForIndex = (idx?: number) =>
			sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");

		const onUpdateWithContext = (onUpdate || (inheritedNestedRoute && nestedParentAddress))
			? (r: AgentToolResult<Details>) => {
				if (!effectiveAsync) {
					const childResults = r.details?.results ?? [];
					const detachedAcknowledgement = childResults.some((child) => child.detached === true)
						|| (r.details?.progress ?? []).some((progress) => progress.status === "detached")
						|| r.content.some((item) => item.type === "text" && /detached for intercom coordination/i.test(item.text));
					const terminalUpdate = !detachedAcknowledgement && r.details?.teardownUnproven !== true && childResults.length > 0 && childResults.every((child) => typeof child.exitCode === "number" && (!child.progress || child.progress.status === "completed" || child.progress.status === "failed"));
					writeNestedForegroundEvent(terminalUpdate ? "subagent.nested.completed" : "subagent.nested.updated", r);
				}
				onUpdate?.(withForkContext(r, effectiveParams.context));
			}
			: undefined;

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			asyncAgents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			artifactConfig,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			controlConfig,
			intercomBridge,
			nestedRoute,
			inheritedNestedRoute,
			scopedGitEndpoint,
		};

		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		let foregroundChildren: PersistedForegroundStep[] = [];
		if (!effectiveAsync) {
			try {
				foregroundChildren = initialForegroundChildren(effectiveParams, childSessionFileForIndex, agents, availableModels, currentProvider);
			} catch (error) {
				return toExecutionErrorResult(effectiveParams, error);
			}
		}
		const foregroundControl = effectiveAsync
			? undefined
			: {
				runId,
				mode: foregroundMode,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				currentAgent: undefined,
				currentIndex: undefined,
				currentActivityState: undefined,
				currentModel: foregroundChildren[0]?.model,
				nestedRoute,
				interrupt: undefined,
			};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
			persistForegroundStatus({
				runId,
				mode: foregroundMode,
				cwd: effectiveCwd,
				sessionId: deps.state.currentSessionId,
				state: "running",
				startedAt: foregroundControl.startedAt,
				updatedAt: foregroundControl.updatedAt,
				children: foregroundChildren,
			});
		}

		const writeNestedForegroundEvent = (type: "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed", result?: AgentToolResult<Details>): void => {
			if (!inheritedNestedRoute || !nestedParentAddress) return;
			const now = Date.now();
			const tokenUsageFromResult = (child: Details["results"][number]) => child.usage
				? { input: child.usage.input ?? 0, output: child.usage.output ?? 0, total: (child.usage.input ?? 0) + (child.usage.output ?? 0) }
				: undefined;
			const details = result?.details;
			const detachedAcknowledgement = details?.results.some((child) => child.detached === true || child.progress?.status === "detached") === true
				|| (details?.progress ?? []).some((progress) => progress.status === "detached")
				|| result?.content.some((item) => item.type === "text" && /detached for intercom coordination/i.test(item.text)) === true;
			const terminalResult = details?.results.length
				? details.results.every((child) => child.detached !== true && typeof child.exitCode === "number" && (!child.progress || child.progress.status === "completed" || child.progress.status === "failed"))
				: false;
			const state = detachedAcknowledgement || details?.teardownUnproven === true
				? "running"
				: type === "subagent.nested.completed" || (type === "subagent.nested.updated" && terminalResult)
					? resolveNestedTerminalState(details?.results ?? [], result?.isError === true)
					: "running";
			const eventType = detachedAcknowledgement || details?.teardownUnproven === true ? "subagent.nested.updated" : type;
			const resultText = result?.content.find((item) => item.type === "text")?.text;
			const errorText = result?.isError ? resultText : undefined;
			const agentsForSummary = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => task.agent)
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step)
						? step.parallel.map((task) => task.agent)
						: isDynamicParallelStep(step)
							? [step.parallel.agent]
							: [(step as SequentialStep).agent])
					: effectiveParams.agent ? [effectiveParams.agent] : [];
			let availableModels: ModelInfo[] = [];
			try {
				availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
			} catch {
				availableModels = [];
			}
			const currentProvider = ctx.model?.provider;
			const resolveConfiguredModel = (agentName: string | undefined, explicitModel: string | undefined): string | undefined => {
				const fallback = explicitModel ?? agents.find((agent) => agent.name === agentName)?.model;
				if (!fallback) return undefined;
				try {
					return resolveModelCandidate(fallback, availableModels, currentProvider) ?? fallback;
				} catch {
					return fallback;
				}
			};
			const configuredModels = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => resolveConfiguredModel(task.agent, task.model))
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step)
						? step.parallel.map((task) => resolveConfiguredModel(task.agent, task.model))
						: isDynamicParallelStep(step)
							? [resolveConfiguredModel(step.parallel.agent, step.parallel.model)]
							: [resolveConfiguredModel((step as SequentialStep).agent, (step as SequentialStep).model)])
					: effectiveParams.agent
						? [resolveConfiguredModel(effectiveParams.agent, effectiveParams.model as string | undefined)]
						: [];
			const configuredFastModeRequests = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => task.fastMode ?? agents.find((agent) => agent.name === task.agent)?.fastMode)
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step)
						? step.parallel.map((task) => task.fastMode ?? agents.find((agent) => agent.name === task.agent)?.fastMode)
						: isDynamicParallelStep(step)
							? [step.parallel.fastMode ?? agents.find((agent) => agent.name === step.parallel.agent)?.fastMode]
							: [(step as SequentialStep).fastMode ?? agents.find((agent) => agent.name === (step as SequentialStep).agent)?.fastMode])
					: effectiveParams.agent
						? [effectiveParams.fastMode ?? agents.find((agent) => agent.name === effectiveParams.agent)?.fastMode]
						: [];
			const configuredFastModes = configuredModels.map((model, index) => resolveFastModeStatus(
				configuredFastModeRequests[index],
				model,
				availableModels,
				currentProvider,
			));
			const leafIntercomTarget = intercomBridge.active && agentsForSummary[0]
				? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
				: undefined;
			const totalTokensFromResults = details?.results.reduce((acc, child) => {
				const usage = tokenUsageFromResult(child);
				if (!usage) return acc;
				return { input: acc.input + usage.input, output: acc.output + usage.output, total: acc.total + usage.total };
			}, { input: 0, output: 0, total: 0 });
			const totalProgressTokens = details?.progress?.reduce((acc, progress) => acc + (progress.tokens ?? 0), 0);
			const totalTokens = totalTokensFromResults && totalTokensFromResults.total > 0
				? totalTokensFromResults
				: approximateTokenUsage(totalProgressTokens);
			const progressByIndex = new Map((details?.progress ?? []).map((progress) => [progress.index, progress] as const));
			const stepCount = Math.max(agentsForSummary.length, configuredModels.length, details?.progress?.length ?? 0, details?.results.length ?? 0);
			const steps = Array.from({ length: stepCount }, (_, index) => {
				const progress = progressByIndex.get(index) ?? details?.progress?.[index];
				const child = details?.results[index];
				const agent = progress?.agent ?? child?.agent ?? agentsForSummary[index];
				if (!agent) return undefined;
				const stepStatus = type === "subagent.nested.completed"
					? child
						? resolveNestedStepState(child)
						: progress?.status === "failed" ? "failed" : progress?.status === "completed" ? "complete" : progress?.status === "pending" ? "pending" : "running"
					: progress?.status === "failed" ? "failed" : progress?.status === "completed" ? "complete" : progress?.status === "pending" ? "pending" : "running";
				const stepTokens = child ? tokenUsageFromResult(child) : approximateTokenUsage(progress?.tokens);
				const stepModel = child?.model ?? configuredModels[index];
				const stepThinking = child?.thinking ?? (index === (foregroundControl?.currentIndex ?? 0) ? foregroundControl?.currentThinking : undefined);
				const stepFastMode = child?.fastMode ?? configuredFastModes[index];
				return {
					agent,
					status: stepStatus,
					...(child?.sessionFile ? { sessionFile: child.sessionFile } : childSessionFileForIndex(index) ? { sessionFile: childSessionFileForIndex(index) } : {}),
					...(progress?.activityState ? { activityState: progress.activityState } : {}),
					...(progress?.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}),
					...(progress?.currentTool ? { currentTool: progress.currentTool } : {}),
					...(progress?.currentToolStartedAt !== undefined ? { currentToolStartedAt: progress.currentToolStartedAt } : {}),
					...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
					...(progress?.turnCount !== undefined ? { turnCount: progress.turnCount } : {}),
					...(progress?.toolCount !== undefined ? { toolCount: progress.toolCount } : {}),
					...(stepModel ? { model: stepModel } : {}),
					...(stepThinking ? { thinking: stepThinking } : {}),
					...(stepFastMode ? { fastMode: stepFastMode } : {}),
					...(stepTokens ? { totalTokens: stepTokens } : {}),
					...(foregroundControl?.startedAt ? { startedAt: foregroundControl.startedAt } : {}),
					...(child?.error ?? progress?.error ? { error: child?.error ?? progress?.error } : {}),
				};
			}).filter((step): step is NonNullable<NestedRunSummary["steps"]>[number] => Boolean(step));
			const currentIndex = foregroundControl?.currentIndex ?? 0;
			const modelFromParams = type === "subagent.nested.completed"
				? details?.results[currentIndex]?.model ?? details?.results.find((child) => child.model)?.model ?? configuredModels[currentIndex] ?? configuredModels.find(Boolean)
				: configuredModels[currentIndex] ?? configuredModels.find(Boolean);
			const thinkingFromParams = type === "subagent.nested.completed"
				? details?.results[currentIndex]?.thinking ?? details?.results.find((child) => child.model)?.thinking
				: foregroundControl?.currentThinking;
			const fastModeFromParams = details?.results[currentIndex]?.fastMode ?? configuredFastModes[currentIndex];
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: eventType,
					ts: now,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					child: {
						id: runId,
						parentRunId: nestedParentAddress.parentRunId,
						parentStepIndex: nestedParentAddress.parentStepIndex,
						depth: nestedParentAddress.depth,
						path: nestedParentAddress.path,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget,
						intercomTarget: leafIntercomTarget,
						ownerState: state === "running" ? "live" : "gone",
						mode: foregroundMode,
						state,
						agent: agentsForSummary[0],
						agents: agentsForSummary,
						startedAt: foregroundControl?.startedAt ?? now,
						...(state !== "running" ? { endedAt: now } : {}),
						lastUpdate: now,
						...(foregroundControl?.currentActivityState ? { activityState: foregroundControl.currentActivityState } : {}),
						...(foregroundControl?.lastActivityAt !== undefined ? { lastActivityAt: foregroundControl.lastActivityAt } : {}),
						...(foregroundControl?.currentTool ? { currentTool: foregroundControl.currentTool } : {}),
						...(foregroundControl?.currentToolStartedAt !== undefined ? { currentToolStartedAt: foregroundControl.currentToolStartedAt } : {}),
						...(foregroundControl?.currentPath ? { currentPath: foregroundControl.currentPath } : {}),
						...(foregroundControl?.turnCount !== undefined ? { turnCount: foregroundControl.turnCount } : {}),
						...(foregroundControl?.toolCount !== undefined ? { toolCount: foregroundControl.toolCount } : {}),
						...(modelFromParams ? { model: modelFromParams } : {}),
						...(thinkingFromParams ? { thinking: thinkingFromParams } : {}),
						...(fastModeFromParams ? { fastMode: fastModeFromParams } : {}),
						...(totalTokens ? { totalTokens } : {}),
						...(errorText ? { error: errorText } : {}),
						...(resultText ? { summary: resultText } : {}),
						...(details?.teardownUnproven || details?.results.some((child) => child.teardownUnproven) ? { teardownUnproven: true } : {}),
						...(steps.length ? { steps } : {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested foreground status event:", error);
			}
		};

		// Prepend preflight summary to result text for orchestrator visibility.
		const withPreflightSummary = (result: AgentToolResult<Details>): AgentToolResult<Details> => {
			if (!preflightSummaryForResult) return result;
			const textIndex = result.content.findIndex((c): c is { type: "text"; text: string } => c.type === "text");
			if (textIndex === -1) return result;
			const newContent = [...result.content];
			newContent[textIndex] = { type: "text" as const, text: `${preflightSummaryForResult}\n${newContent[textIndex].text}` };
			return { ...result, content: newContent };
		};

		let nestedForegroundStarted = false;
		try {
			const asyncResult = await runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(withPreflightSummary(asyncResult), effectiveParams.context);
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasChain && effectiveParams.chain) {
				const result = await runChainPath(execData, deps);
				const wrappedResult = withPreflightSummary(result);
				const detachedAcknowledgement = result.details?.results.some((child) => child.detached === true || child.progress?.status === "detached") === true || result.content.some((item) => item.type === "text" && /detached for intercom coordination/i.test(item.text));
				const teardownUnproven = result.details?.teardownUnproven === true;
				writeNestedForegroundEvent(detachedAcknowledgement || teardownUnproven ? "subagent.nested.updated" : "subagent.nested.completed", wrappedResult);
				return withForkContext(wrappedResult, effectiveParams.context);
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				const wrappedResult = withPreflightSummary(result);
				const detachedAcknowledgement = result.details?.results.some((child) => child.detached === true || child.progress?.status === "detached") === true || result.content.some((item) => item.type === "text" && /detached for intercom coordination/i.test(item.text));
				const teardownUnproven = result.details?.teardownUnproven === true;
				writeNestedForegroundEvent(detachedAcknowledgement || teardownUnproven ? "subagent.nested.updated" : "subagent.nested.completed", wrappedResult);
				return withForkContext(wrappedResult, effectiveParams.context);
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				const wrappedResult = withPreflightSummary(result);
				const detachedAcknowledgement = result.details?.results.some((child) => child.detached === true || child.progress?.status === "detached") === true || result.content.some((item) => item.type === "text" && /detached for intercom coordination/i.test(item.text));
				const teardownUnproven = result.details?.teardownUnproven === true;
				writeNestedForegroundEvent(detachedAcknowledgement || teardownUnproven ? "subagent.nested.updated" : "subagent.nested.completed", wrappedResult);
				return withForkContext(wrappedResult, effectiveParams.context);
			}
		} catch (error) {
			const errorResult = toExecutionErrorResult(effectiveParams, error);
			const wrappedErrorResult = withPreflightSummary(errorResult);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", wrappedErrorResult);
			return wrappedErrorResult;
		} finally {
			if (foregroundControl) {
				clearPendingForegroundControlNotices(deps.state, runId);
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, effectiveParams.context);
	};

	return { execute };
}
