/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { hasExplicitSandboxOptOut, resolveSandboxConfig, resolveGitMode, worktreeOptOutIsAuthorized } from "../../sandbox/config.ts";
import { createIsolatedGitRuntime, createIsolatedGitWorktree, exportIsolatedGitBundle, cleanupIsolatedGitRuntime, stripIsolatedGitExportDiagnostics, type IsolatedGitCapability, type ScopedGitEndpointDescriptor, type IsolatedGitRuntime, type IsolatedGitWorktree } from "../../sandbox/isolated-git.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride, type ChainClarifyPolicy } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	taskDisallowsFileUpdates,
	resolveParallelBehaviors,
	buildChainInstructions,
	writeInitialProgressFile,
	createParallelDirs,
	suppressProgressForReadOnlyTask,
	aggregateParallelOutputs,
	isDynamicParallelStep,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type ParallelStep,
	type SequentialStep,
	type ParallelTaskResult,
	type ResolvedStepBehavior,
	type ResolvedTemplates,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { runSync } from "./execution.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import { MapConcurrentError } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
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
	type ActivityState,
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type IntercomEventBus,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type SandboxIntercomBridge,
	type SingleResult,
	MAX_CONCURRENCY,
	TEMP_ARTIFACTS_DIR,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import type { ResolvedSandboxConfig, SandboxRunConfig, SandboxSettingsDefaults } from "../../sandbox/types.ts";
import { hasSandboxWritableAgent, inferSandboxCwdWritable, sandboxDynamicFanoutUnsupportedMessage, sandboxParallelWorktreeRequiredMessage } from "../../sandbox/write-inference.ts";
import { resolveCapabilityRights } from "../shared/capability-rights.ts";
import { resolvePackagedAgentRole } from "../shared/agent-role.ts"
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { resolveFastModeStatus } from "../../shared/fast-mode.ts";
import { injectSingleOutputInstruction, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { resolveSavedOutputPath, shouldPersistSavedOutput } from "../../shared/output-paths.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, outputEntryFromResult, resolveOutputReferences, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { attachNestedChildrenToResultChildren, buildSubagentResultIntercomPayload, deliverSubagentResultIntercomEvent, resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection, type DynamicCollectedResult } from "../shared/dynamic-fanout.ts";
import type { ChainOutputMap } from "../../shared/types.ts";
import { waitForNestedDescendantsToStop } from "../shared/nested-events.ts";
import { registerForegroundInterrupt } from "../shared/foreground-control.ts";

interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	currentStepIndex?: number;
	runId: string;
	outputs?: ChainOutputMap;
	currentFlatIndex?: number;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: "pending" | "running" | "completed" | "failed" | "paused" | "cancelled" | "detached"; error?: string; acceptance?: SingleResult["acceptance"] }>;
}

interface TeardownHooks {
	waitForNestedDescendantsToStop?: typeof waitForNestedDescendantsToStop;
	releaseInheritedContext?: (runtime: IsolatedGitRuntime, capability: IsolatedGitCapability) => void;
}

interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	chainDir: string;
	prev: string;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	globalTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		currentModel?: string;
		sessionFile?: string;
		interrupt?: () => boolean;
	};
	results: SingleResult[];
	allProgress: AgentProgress[];
	outputs: ChainOutputMap;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	dynamicChildren?: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses?: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	teardownUnproven?: boolean;
	worktreeSetup?: WorktreeSetup;
	isolatedGitWorktrees?: (IsolatedGitWorktree | undefined)[];
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	nestedFenceTimeoutMs?: number;
	sandbox?: ResolvedSandboxConfig;
	sandboxSettings?: SandboxSettingsDefaults;
	sandboxRun?: SandboxRunConfig;
	sandboxes?: (ResolvedSandboxConfig | undefined)[];
	sandboxIntercomBridge?: SandboxIntercomBridge;
	issueIsolatedGitCapability?: (worktree: IsolatedGitWorktree, rights: "writer" | "read-only", cwd: string) => Promise<IsolatedGitCapability>;
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	/** Internal lifecycle test seam; production uses the shared fence/release implementations. */
	teardownHooks?: TeardownHooks;
	progressPaths?: string[];
	onDetachedStarted?: (index: number, result: SingleResult) => void;
	onDetachedTerminal?: (index: number, result: SingleResult) => void | Promise<void>;
}

function buildChainExecutionDetails(input: ChainExecutionDetailsInput): Details {
	const groupDiagnostics = Object.entries(input.dynamicGroupStatuses ?? {})
		.filter(([, diagnostic]) => diagnostic.status === "completed" || diagnostic.status === "failed" || diagnostic.status === "paused" || diagnostic.status === "cancelled")
		.map(([stepIndex, diagnostic]) => ({
			groupId: `dynamic-group-${stepIndex}`,
			unindexed: true as const,
			agent: input.chainSteps[Number(stepIndex)] && isDynamicParallelStep(input.chainSteps[Number(stepIndex)]!) ? input.chainSteps[Number(stepIndex)]!.parallel.agent : "dynamic-group",
			status: diagnostic.status === "failed" ? "failed" as const : diagnostic.status === "completed" ? "complete" as const : diagnostic.status,
			...(diagnostic.error ? { error: diagnostic.error, output: diagnostic.error, finalOutput: diagnostic.error } : {}),
		}));
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length ? { dir: input.artifactsDir, files: input.allArtifactPaths } : undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		outputs: input.outputs,
		groupDiagnostics: groupDiagnostics.length ? groupDiagnostics : undefined,
		...(input.teardownUnproven ? { teardownUnproven: true } : {}),
		workflowGraph: buildWorkflowGraphSnapshot({
			runId: input.runId,
			mode: "chain",
			steps: input.chainSteps,
			results: input.results,
			currentStepIndex: input.currentStepIndex,
			currentFlatIndex: input.currentFlatIndex,
			dynamicChildren: input.dynamicChildren,
			dynamicGroupStatuses: input.dynamicGroupStatuses,
		}),
	});
}

function buildChainExecutionErrorResult(message: string, input: ChainExecutionDetailsInput): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

function captureParallelWorktreeSummary(
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string | undefined {
	if (!worktreeSetup) return undefined;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	return formatWorktreeDiffSummary(diffs) || undefined;
}

function resolveParallelCleanTask(input: Pick<ParallelChainRunInput, "parallelTemplates" | "outputs" | "originalTask" | "prev" | "chainDir">, taskIndex: number): string {
	let cleanTask = resolveOutputReferences(input.parallelTemplates[taskIndex] ?? "{previous}", input.outputs);
	cleanTask = cleanTask.replace(/\{task\}/g, input.originalTask);
	cleanTask = cleanTask.replace(/\{previous\}/g, input.prev);
	cleanTask = cleanTask.replace(/\{chain_dir\}/g, input.chainDir);
	return cleanTask;
}

function commitRequiredForParallelTask(input: Pick<ParallelChainRunInput, "parallelTemplates" | "outputs" | "originalTask" | "prev" | "chainDir">, taskIndex: number, agent: AgentConfig | undefined, sandbox: ResolvedSandboxConfig | undefined, parentRights?: "writer" | "read-only"): boolean {
	const task = resolveParallelCleanTask(input, taskIndex);
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

async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	let parallelResults: SingleResult[];
	try {
	parallelResults = await mapConcurrent(
		input.step.parallel,
		concurrency,
		async (task, taskIndex) => {
			const flatIndex = input.globalTaskIndex + taskIndex;
			if (input.signal?.aborted || input.foregroundControl?.interruptRequested) {
				const cancelled = input.signal?.aborted && !input.foregroundControl?.interruptRequested;
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
				} as SingleResult;
			}
			if (aborted && failFast) {
				return {
					agent: task.agent,
					task: "(skipped)",
					exitCode: -1,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					error: "Skipped due to fail-fast",
				} as SingleResult;
			}

			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
			const templateHasPrevious = taskTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
				templateHasPrevious ? undefined : input.prev,
			);

			const cleanTask = resolveParallelCleanTask(input, taskIndex);
			let taskStr = prefix + cleanTask + suffix;

			const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
			const effectiveModel =
				(task.model ? resolveModelCandidate(task.model, input.availableModels, input.ctx.model?.provider) : null)
				?? resolveModelCandidate(taskAgentConfig?.model, input.availableModels, input.ctx.model?.provider);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);

			const isolatedGit = input.isolatedGitWorktrees?.[taskIndex];
			// Keep the requested parent cwd until runSingleAttempt maps it into the
			// private worktree. This preserves task subdirectories for isolated Git.
			const taskCwd = isolatedGit
				? resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd)
				: (input.worktreeSetup
					? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
					: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd));
			// Scope-check each isolated task's canonical requested cwd before any
			// per-task output/session/interrupt/artifact path or runtime setup.
			// Issue capability only after the resolved sandbox is known, but before
			// output/session/structured paths or other path-sensitive side effects.
			const packagedRole = resolvePackagedAgentRole(task.agent, taskAgentConfig?.source);
			const taskSandbox = input.sandboxes?.[taskIndex] ?? input.sandbox;
			const capabilityRights = resolveCapabilityRights({
				packagedRole,
				agentTools: taskAgentConfig?.tools,
				sandbox: taskSandbox,
				taskMutationProhibited: taskDisallowsFileUpdates(cleanTask),
				writableCwd: inferSandboxCwdWritable({ agentName: task.agent, tools: taskAgentConfig?.tools, sandbox: taskSandbox }),
				exclusiveLease: true,
			});
			const isolatedCapability = isolatedGit
				? await (input.issueIsolatedGitCapability
					? input.issueIsolatedGitCapability(isolatedGit, capabilityRights, taskCwd)
					: isolatedGit.runtime.issueInheritedContext({ worktree: isolatedGit, rights: capabilityRights, cwd: taskCwd }))
				: undefined;

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
				: undefined;
			const savedOutputPath = shouldPersistSavedOutput({
				output: behavior.output,
				outputMode: behavior.outputMode,
				tools: taskAgentConfig?.tools,
			})
				? resolveSavedOutputPath({ runtimeCwd: input.ctx.cwd, requestedCwd: taskCwd, agent: task.agent, runId: input.runId, index: input.globalTaskIndex + taskIndex })
				: undefined;
			const instructionOutputPath = outputPath ?? (behavior.outputMode === "file-only" ? savedOutputPath : undefined);
			taskStr = injectSingleOutputInstruction(taskStr, instructionOutputPath);
			const interruptController = new AbortController();
			let unregisterInterrupt: (() => void) | undefined;
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.currentModel = effectiveModel;
				input.foregroundControl.currentThinking = undefined;
				input.foregroundControl.currentFastMode = resolveFastModeStatus(
					behavior.fastMode,
					effectiveModel,
					input.availableModels,
					input.ctx.model?.provider,
				);
				input.foregroundControl.updatedAt = Date.now();
				if (input.sessionFileForIndex) {
					input.foregroundControl.sessionFile = input.sessionFileForIndex(input.globalTaskIndex + taskIndex);
				}
				unregisterInterrupt = registerForegroundInterrupt(input.foregroundControl, () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				});
			}

			let structuredRuntime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
			try {
				structuredRuntime = task.outputSchema
					? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
					: undefined;
			} catch (error) {
				unregisterInterrupt?.();
				unregisterInterrupt = undefined;
				throw error;
			}
			let result: SingleResult;
			let detachedCapabilityReleased = false;
			let detachedEndpointFenceProven = false;
			const releaseDetachedCapability = async (terminal?: SingleResult): Promise<void> => {
				if (detachedCapabilityReleased || detachedEndpointFenceProven || (!isolatedCapability || !isolatedGit) && !input.scopedGitEndpoint || terminal?.teardownUnproven) {
					if (terminal?.teardownUnproven) isolatedGit?.runtime.markExportFenceFailed();
					return;
				}
				const fence = await (input.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(input.nestedRoute, input.runId, input.globalTaskIndex + taskIndex, { timeoutMs: input.nestedFenceTimeoutMs });
				if (!fence.observed || !fence.stopped) {
					if (isolatedGit) isolatedGit.runtime.markExportFenceFailed();
					if (terminal) {
						terminal.teardownUnproven = true;
						terminal.exitCode = terminal.exitCode === 0 ? 1 : terminal.exitCode;
						terminal.error = terminal.error ?? "Nested descendants did not reach a proven terminal state; inherited capability retained for recovery.";
						input.onUpdate?.({ content: [{ type: "text", text: terminal.error }], details: { mode: "chain", results: [{ ...terminal, detached: true }] } });
					}
					return;
				}
				if (input.scopedGitEndpoint) {
					detachedEndpointFenceProven = true;
					return;
				}
				try {
					(input.teardownHooks?.releaseInheritedContext ?? ((runtime, capability) => runtime.releaseInheritedContext(capability)))(isolatedGit.runtime, isolatedCapability!);
					detachedCapabilityReleased = true;
				} catch (error) {
					// A release/revocation failure is not proof of teardown. Keep the
					// lease and runtime recoverable instead of publishing terminal truth.
					if (terminal) {
						terminal.teardownUnproven = true;
						terminal.exitCode = terminal.exitCode === 0 ? 1 : terminal.exitCode;
						const detail = error instanceof Error ? error.message : String(error);
						terminal.error = terminal.error ? `${terminal.error}\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
					}
					try { isolatedGit?.runtime.markExportFenceFailed(); } catch { /* retain terminal teardown evidence if fence persistence also fails */ }
					if (terminal) input.onUpdate?.({ content: [{ type: "text", text: terminal.error ?? "Capability release was not proven." }], details: { mode: "chain", results: [{ ...terminal, detached: true }] } });
				}
			};
			try {
				result = await runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index: input.globalTaskIndex + taskIndex,
				sessionDir: input.sessionDirForIndex(input.globalTaskIndex + taskIndex),
				sessionFile: input.sessionFileForIndex?.(input.globalTaskIndex + taskIndex),
				share: input.shareEnabled,
				artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
				artifactConfig: input.artifactConfig,
				outputPath,
				savedOutputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				intercomSessionName: input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex),
				orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				nestedRoute: input.nestedRoute,
				nestedFenceTimeoutMs: input.nestedFenceTimeoutMs,
				modelOverride: effectiveModel,
				fastMode: behavior.fastMode,
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: task.acceptance,
				acceptanceContext: { mode: "chain" },
				sandbox: input.sandboxes?.[taskIndex] ?? input.sandbox,
				hostGitDiagnostic: !(input.sandboxes?.[taskIndex] ?? input.sandbox)
					&& hasExplicitSandboxOptOut({ settings: input.sandboxSettings, run: input.sandboxRun }),
				isolatedGit,
				isolatedGitCapability: isolatedCapability,
				isolatedGitEndpoint: input.scopedGitEndpoint,
				isolatedGitRights: input.scopedGitEndpoint ? capabilityRights : undefined,
				isolatedGitBundleDir: input.artifactsDir,
				isolatedGitCommitRequired: Boolean(isolatedGit) && commitRequiredForParallelTask(input, taskIndex, taskAgentConfig, input.sandboxes?.[taskIndex] ?? input.sandbox),
				sandboxIntercomBridge: input.sandboxIntercomBridge,
				progressPaths: behavior.progress ? input.progressPaths : undefined,
				onDetachedStarted: () => input.onDetachedStarted?.(input.globalTaskIndex + taskIndex, {
					agent: task.agent,
					task: cleanTask,
					exitCode: 0,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 },
				}),
				onDetachedTerminal: async (terminalResult) => {
					// Descendant terminal publication is downstream of both the exact
					// descendant-stop fence and capability revocation. A failed release
					// remains recoverable and must not be presented as terminal truth.
					await releaseDetachedCapability(terminalResult);
					if (terminalResult.teardownUnproven || (isolatedCapability && !detachedCapabilityReleased) || (input.scopedGitEndpoint && !detachedEndpointFenceProven)) return;
					await input.onDetachedTerminal?.(input.globalTaskIndex + taskIndex, terminalResult);
				},
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.currentModel = stepResults[0]?.model ?? effectiveModel;
							input.foregroundControl.currentThinking = stepResults[0]?.thinking;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.currentPath = current?.currentPath;
							input.foregroundControl.turnCount = current?.turnCount;
							input.foregroundControl.tokens = current?.tokens;
							input.foregroundControl.toolCount = current?.toolCount;
							input.foregroundControl.updatedAt = Date.now();
							if (input.sessionFileForIndex) {
								input.foregroundControl.sessionFile = input.sessionFileForIndex(input.globalTaskIndex + taskIndex);
							}
						}
						input.onUpdate?.({
							...progressUpdate,
							details: {
								mode: "chain",
								results: input.results.concat(stepResults),
								progress: input.allProgress.concat(stepProgress),
								controlEvents: progressUpdate.details?.controlEvents,
								chainAgents: input.chainAgents,
								totalSteps: input.totalSteps,
								currentStepIndex: input.stepIndex,
								outputs: input.outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId: input.runId,
									mode: "chain",
									steps: input.chainSteps,
									results: input.results.concat(stepResults),
									currentStepIndex: input.stepIndex,
									currentFlatIndex: input.globalTaskIndex + taskIndex,
									dynamicChildren: input.dynamicChildren,
									dynamicGroupStatuses: input.dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
				});
			} finally {
				unregisterInterrupt?.();
				unregisterInterrupt = undefined;
				if (!result?.detached) await releaseDetachedCapability(result);
			}
			if (result.detached) input.onDetachedStarted?.(input.globalTaskIndex + taskIndex, result);
			if (input.foregroundControl?.currentIndex === input.globalTaskIndex + taskIndex) {
				input.foregroundControl.currentModel = result.model ?? effectiveModel;
				input.foregroundControl.currentThinking = result.thinking;
				input.foregroundControl.updatedAt = Date.now();
			}

			if (result.exitCode !== 0 && failFast) {
				aborted = true;
			}
			recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			return { ...result, flatIndex: input.globalTaskIndex + taskIndex };
		},
	);
	} catch (error) {
		const rejection = error instanceof MapConcurrentError ? error.reason : error;
		const partialResults = error instanceof MapConcurrentError ? error.partialResults : [];
		const rejectedIndex = error instanceof MapConcurrentError ? error.rejectionIndex : undefined;
		const recoveryPath = formatRecoverableWorktreePaths(input.worktreeSetup);
		const message = `Parallel execution failed unexpectedly: ${rejection instanceof Error ? rejection.message : String(rejection)}${recoveryPath ? `; ${recoveryPath}` : ""}`;
		const fence = await waitForNestedDescendantsToStop(input.nestedRoute, input.runId, undefined, { timeoutMs: input.nestedFenceTimeoutMs });
		parallelResults = input.step.parallel.map((task, taskIndex) => {
			const flatIndex = input.globalTaskIndex + taskIndex;
			const settled = partialResults[taskIndex];
			if (settled) return { ...settled, flatIndex, ...(!fence.stopped ? { teardownUnproven: true } : {}) };
			const worktree = input.isolatedGitWorktrees?.[taskIndex];
			let gitBundle: SingleResult["gitBundle"];
			if (worktree && fence.stopped && !worktree.runtime.isExported(worktree.index)) {
			try {
				const bundle = exportIsolatedGitBundle(worktree.runtime, {
					outputDir: input.artifactsDir,
					worktree,
					syntheticPaths: worktree.syntheticPaths,
					terminationState: input.signal?.aborted ? "cancelled" : "execution-rejected",
					agent: task.agent,
					commitRequired: commitRequiredForParallelTask(input, taskIndex, input.agents.find((agent) => agent.name === task.agent), input.sandboxes?.[taskIndex] ?? input.sandbox),
				});
				gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
			} catch (exportError) {
				worktree.runtime.markExportFailed();
				const packaging = `Isolated Git bundle export failed; recover isolated worktree at ${worktree.runtime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				return { flatIndex, agent: task.agent, task: task.task, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: `${message}; ${packaging}` };
			}
			}
			if (!fence.stopped && worktree) worktree.runtime.markExportFenceFailed();
			const fencedMessage = !fence.stopped
				? `${message}; nested descendants did not reach a proven terminal state before export; recover isolated worktree at ${worktree?.runtime.root ?? "the runtime root"}`
				: taskIndex === rejectedIndex ? message : `${message}; execution rejected before this task completed`;
			return { flatIndex, agent: task.agent, task: task.task, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: fencedMessage, ...(!fence.stopped ? { teardownUnproven: true } : {}), ...(gitBundle ? { gitBundle } : {}) };
		});
	}

	return parallelResults;
}

interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onDetachedTerminal?: (results: SingleResult[]) => void | Promise<void>;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		currentModel?: string;
		sessionFile?: string;
		interrupt?: () => boolean;
		nestedChildren?: NestedRunSummary[];
	};
	chainSkills?: string[];
	chainDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	nestedFenceTimeoutMs?: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	sandbox?: ResolvedSandboxConfig;
	sandboxSettings?: SandboxSettingsDefaults;
	sandboxRun?: SandboxRunConfig;
	sandboxIntercomBridge?: SandboxIntercomBridge;
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	/** Internal lifecycle test seam; production uses the shared fence/release implementations. */
	teardownHooks?: TeardownHooks;
}

interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	/** Runtime-captured worktree diff summary that must survive intercom relay and cleanup. */
	worktreeSummary?: string;
	/** Capture failures must remain inline so preserved worktree paths are not hidden by an intercom receipt. */
	worktreeCaptureFailed?: boolean;
	/** Unexpected rejection preserves worktrees because sibling callbacks may still be settling. */
	worktreePreserved?: boolean;
	isError?: boolean;
	/** User requested async execution via TUI - caller should dispatch to executeAsyncChain */
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
}

/**
 * Execute a chain of subagent steps
 */
export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
	} = params;
	const chainSkills = chainSkillsParam ?? [];
	const sharedSandbox = params.sandbox?.provider === "none" ? undefined : params.sandbox;
	const hasSandboxResolutionInputs = params.sandboxSettings !== undefined || params.sandboxRun !== undefined;
	const resolveStepSandbox = (agent: AgentConfig): ResolvedSandboxConfig | undefined => hasSandboxResolutionInputs
		? resolveSandboxConfig({ settings: params.sandboxSettings, agent, run: params.sandboxRun })
		: params.sandbox
			? resolveSandboxConfig({ agent, run: params.sandbox })
			: resolveSandboxConfig({ agent });

	const results: SingleResult[] = [];
	const outputs: ChainOutputMap = {};
	const dynamicChildren: ChainExecutionDetailsInput["dynamicChildren"] = {};
	const dynamicGroupStatuses: ChainExecutionDetailsInput["dynamicGroupStatuses"] = {};
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const worktreeSummaries: string[] = [];
	// Retain the current step cleanup in the outer lifecycle so synchronous
	// setup/run exceptions cannot bypass the per-promise finally.
	let activeInterruptCleanup: (() => void) | undefined;

	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `expand:${step.parallel.agent}`
			: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;
	let teardownUnproven = false;
	// Worktree indexes are global materialized indexes, not source-chain indexes.
	// Keep the actual item policy alongside each created checkout so fallback
	// exports remain correct after dynamic/static expansion.
	const isolatedWorktreePolicies = new Map<number, { agent: string; task: string; commitRequired: boolean }>();
	const isolatedFallbackProjected = new Set<number>();
	const detachedIndexes = new Set<number>();
	const detachedTerminalIndexes = new Set<number>();
	let chainExecutionSettled = false;
	let detachedAggregatePublished = false;
	const upsertChainResult = (index: number, result: SingleResult): SingleResult => {
		// An export diagnostic is removable only after a bundle proves that the
		// retry succeeded. Preserve the diagnostic on failed fallback projections.
		// Group diagnostics are intentionally unindexed; assigning them a child
		// slot would collide with a real materialized result.
		const indexedResult = result.flatIndex === undefined && !result.groupId ? { ...result, flatIndex: index } : result;
		const normalizedError = indexedResult.gitBundle ? stripIsolatedGitExportDiagnostics(indexedResult.error) : { error: indexedResult.error, onlyDiagnostics: false };
		const normalized = indexedResult.gitBundle && normalizedError.onlyDiagnostics
			? { ...indexedResult, error: undefined, success: true, exitCode: 0 }
			: normalizedError.error !== indexedResult.error
				? { ...indexedResult, ...(normalizedError.error ? { error: normalizedError.error } : { error: undefined }) }
				: indexedResult;
		const existingIndex = results.findIndex((candidate) => candidate.flatIndex === index);
		const existing = existingIndex >= 0 ? results[existingIndex] : undefined;
		let merged: SingleResult;
		if (!existing) {
			results.push(normalized);
			merged = normalized;
		} else {
			// A detached acknowledgement is only a placeholder. If its terminal
			// callback raced the acknowledgement merge, retain the already projected
			// sibling failure/output instead of overwriting it with detached=true and
			// an empty error.
			const terminalAlreadyProjected = detachedTerminalIndexes.has(index) && normalized.detached === true;
			merged = terminalAlreadyProjected
				? { ...normalized, ...existing, gitBundle: normalized.gitBundle ?? existing.gitBundle }
				: { ...existing, ...normalized, gitBundle: normalized.gitBundle ?? existing.gitBundle };
			results[existingIndex] = merged;
		}
		// Detached callbacks may settle out of order. Keep indexed children in
		// canonical flat-index order while retaining unindexed diagnostics.
		results.sort((left, right) => {
			if (left.flatIndex === undefined) return 1;
			if (right.flatIndex === undefined) return -1;
			return left.flatIndex - right.flatIndex;
		});
		return merged;
	};

	const makeDetailsInput = (overrides: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex"> = {}): ChainExecutionDetailsInput => ({
		results,
		...(includeProgress !== undefined ? { includeProgress } : {}),
		allProgress,
		allArtifactPaths,
		artifactsDir,
		chainAgents,
		chainSteps,
		totalSteps,
		runId,
		outputs,
		dynamicChildren,
		dynamicGroupStatuses,
		teardownUnproven,
		...overrides,
	});
	let isolatedCleanupFailure: string | undefined;
	const noteIsolatedCleanupFailure = (target?: SingleResult, cause?: unknown): void => {
		if (!isolatedGitRuntime) return;
		if (cause === undefined && !isolatedGitRuntime.exportFailed && !fs.existsSync(isolatedGitRuntime.root)) return;
		isolatedGitRuntime.markExportFailed();
		const base = `Isolated Git cleanup failed after export; recover isolated worktrees at ${isolatedGitRuntime.root}.`;
		const message = `${base}${cause instanceof Error ? ` ${cause.message}` : cause !== undefined ? ` ${String(cause)}` : ""}`;
		isolatedCleanupFailure ??= message;
		for (const worktree of isolatedGitRuntime.worktrees) {
			const policy = isolatedWorktreePolicies.get(worktree.index);
			const existing = results.find((result) => result.flatIndex === worktree.index);
			const projected = existing ?? { flatIndex: worktree.index, agent: policy?.agent ?? `task-${worktree.index + 1}`, task: policy?.task ?? "chain execution", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
			projected.exitCode = projected.exitCode === 0 ? 1 : (projected.exitCode ?? 1);
			projected.success = false;
			projected.teardownUnproven = true;
			// Cleanup failure has failure precedence over cancellation/interruption.
			delete projected.cancelled;
			delete projected.interrupted;
			projected.error = projected.error?.includes(message) ? projected.error : projected.error ? `${projected.error}\n${message}` : message;
			upsertChainResult(worktree.index, projected);
		}
		if (target && !target.error?.includes(message)) {
			target.exitCode = target.exitCode === 0 ? 1 : (target.exitCode ?? 1);
			target.success = false;
			target.teardownUnproven = true;
			delete target.cancelled;
			delete target.interrupted;
			target.error = target.error ? `${target.error}\n${message}` : message;
		}
	};

	const exportBundleWithRetry = (options: Parameters<typeof exportIsolatedGitBundle>[1]): { bundle: ReturnType<typeof exportIsolatedGitBundle>; earlierAttemptFailed: boolean } => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try { return { bundle: exportIsolatedGitBundle(isolatedGitRuntime!, options), earlierAttemptFailed: attempt > 0 }; }
			catch (error) { lastError = error; }
		}
		throw lastError;
	};
	const exportRemainingIsolated = async (terminationState: "success" | "failure" | "execution-rejected" | "interrupted" | "cancelled", reason = "Chain execution rejected", includeDetached = false): Promise<{ fenced: boolean }> => {
		if (!isolatedGitRuntime || !ownsIsolatedGitRuntime) return { fenced: true };
		// A teardown callback may have already fenced this runtime after refusing
		// private-group proof. Never clear that fence and package/delete descendants.
		if (isolatedGitRuntime.exportFenceFailed) return { fenced: false };
		const effectiveTerminationFor = (_index: number): "success" | "failure" | "execution-rejected" | "interrupted" | "cancelled" => {
			// A shared sequential checkout represents the complete group, not the
			// first flat-index step. Later review/fix failures must remain visible in
			// the exported terminal state.
			if (results.some((result) => result.cancelled)) return "cancelled";
			if (results.some((result) => result.interrupted)) return "interrupted";
			if (results.some((result) => result.success !== true || result.exitCode !== 0)) return "failure";
			return terminationState;
		};
		const fence = await waitForNestedDescendantsToStop(params.nestedRoute, runId, undefined, { timeoutMs: params.nestedFenceTimeoutMs });
		if (!fence.stopped) {
			isolatedGitRuntime.markExportFenceFailed();
			teardownUnproven = true;
			const message = `Nested descendants did not reach a proven terminal state before export; recover isolated worktrees at ${isolatedGitRuntime.root}`;
			for (const worktree of isolatedGitRuntime.worktrees) {
				if (isolatedGitRuntime.isExported(worktree.index) || isolatedFallbackProjected.has(worktree.index)) continue;
				if (detachedIndexes.has(worktree.index) && (!includeDetached || !detachedTerminalIndexes.has(worktree.index))) continue;
				const policy = isolatedWorktreePolicies.get(worktree.index);
				isolatedFallbackProjected.add(worktree.index);
				const existing = results.find((result) => result.flatIndex === worktree.index);
				upsertChainResult(worktree.index, existing
					? { ...existing, success: false, exitCode: 1, interrupted: undefined, cancelled: undefined, error: existing.error ? `${existing.error}\n${reason}; ${message}` : `${reason}; ${message}` }
					: { flatIndex: worktree.index, agent: policy?.agent ?? `task-${worktree.index + 1}`, task: policy?.task ?? "chain execution", success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, error: `${reason}; ${message}` });
			}
			return { fenced: false };
		}
		isolatedGitRuntime.markExportFenceResolved();
		for (const worktree of isolatedGitRuntime.worktrees) {
			if (isolatedGitRuntime.isExported(worktree.index) || isolatedFallbackProjected.has(worktree.index)) continue;
			if (detachedIndexes.has(worktree.index) && (!includeDetached || !detachedTerminalIndexes.has(worktree.index))) continue;
			const policy = isolatedWorktreePolicies.get(worktree.index);
			try {
				const retry = exportBundleWithRetry({
					outputDir: artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
					worktree,
					syntheticPaths: worktree.syntheticPaths,
					terminationState: effectiveTerminationFor(worktree.index),
					agent: policy?.agent,
					commitRequired: policy?.commitRequired,
				});
				const bundle = retry.bundle;
				isolatedFallbackProjected.add(worktree.index);
				const existing = results.find((result) => result.flatIndex === worktree.index);
				const normalized = stripIsolatedGitExportDiagnostics(existing?.error);
				const exportOnly = Boolean(existing && normalized.onlyDiagnostics);
				const fallback = existing
					? { ...existing, ...(normalized.error ? { error: normalized.error } : exportOnly ? { error: undefined } : {}), ...(exportOnly ? { success: true, exitCode: 0 } : {}) }
					: { flatIndex: worktree.index, agent: policy?.agent ?? `task-${worktree.index + 1}`, task: policy?.task ?? "chain execution", success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }, error: `${reason}; isolated worktree exported for recovery`, gitBundle: { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata } };
				const gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
				const effectiveFallback = bundle.incomplete && fallback.success === true
					? { ...fallback, success: false, exitCode: fallback.exitCode === 0 ? 1 : fallback.exitCode, error: fallback.error ?? "Isolated writer completed without a required authored commit; recovery bundle is incomplete." }
					: fallback;
				upsertChainResult(worktree.index, { ...effectiveFallback, gitBundle });
			} catch (error) {
				isolatedGitRuntime.markExportFailed();
				isolatedFallbackProjected.add(worktree.index);
				upsertChainResult(worktree.index, { flatIndex: worktree.index, agent: policy?.agent ?? `task-${worktree.index + 1}`, task: policy?.task ?? "chain execution", success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: `${reason}; Isolated Git bundle export failed; recover isolated worktree at ${isolatedGitRuntime.root}: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
		return { fenced: true };
	};
	const finalizeBeforePublication = async (terminationState: "execution-rejected" | "interrupted" | "cancelled"): Promise<void> => {
		await exportRemainingIsolated(terminationState);
		if (ownsIsolatedGitRuntime && isolatedGitRuntime && detachedIndexes.size === 0 && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) {
			try { await cleanupIsolatedGitRuntime(isolatedGitRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
			noteIsolatedCleanupFailure();
		}
	};
	const isolatedRecoveryNotice = (): string => isolatedCleanupFailure
		? ` ${isolatedCleanupFailure}`
		: isolatedGitRuntime && (isolatedGitRuntime.exportFailed || fs.existsSync(isolatedGitRuntime.root))
			? ` Recover isolated worktrees at ${isolatedGitRuntime.root}; cleanup was not proven.`
			: "";
	const publishDetachedTerminal = async (index: number, result: SingleResult): Promise<void> => {
		upsertChainResult(index, result);
		// Detached callbacks may settle out of order. Wait until the chain and all
		// detached siblings have settled before emitting one complete aggregate.
		if (detachedAggregatePublished || !chainExecutionSettled || detachedIndexes.size === 0 || detachedTerminalIndexes.size < detachedIndexes.size) return;
		detachedAggregatePublished = true;
		const publicationDetails = buildChainExecutionDetails(makeDetailsInput());
		params.onUpdate?.({
			content: [{ type: "text", text: results.map((candidate) => candidate.error || getSingleResultOutput(candidate) || "(no output)").join("\n\n") }],
			details: publicationDetails,
		});
		if (params.intercomEvents && params.orchestratorIntercomTarget) {
			const publicationChildren = results.map((candidate, position) => ({
				agent: candidate.agent,
				status: resolveSubagentResultStatus({ exitCode: candidate.exitCode, interrupted: candidate.interrupted, cancelled: candidate.cancelled, detached: candidate.detached }),
				summary: candidate.error || getSingleResultOutput(candidate) || "(no output)",
				index: candidate.flatIndex ?? position,
				...(candidate.gitBundle ? { gitBundle: candidate.gitBundle } : {}),
			}));
			const payload = buildSubagentResultIntercomPayload({
				to: params.orchestratorIntercomTarget,
				runId: params.runId,
				mode: "chain",
				source: "foreground",
				chainSteps: totalSteps,
				children: attachNestedChildrenToResultChildren(params.runId, publicationChildren, foregroundControl?.nestedChildren),
			});
			await deliverSubagentResultIntercomEvent(params.intercomEvents, payload);
		}
		await params.onDetachedTerminal?.(results.slice());
	};
	const onDetachedTerminal = async (index: number, result: SingleResult): Promise<void> => {
		detachedIndexes.add(index);
		if (result.teardownUnproven) {
			teardownUnproven = true;
			upsertChainResult(index, result);
			params.onUpdate?.({ content: [{ type: "text", text: result.error ?? "Detached child teardown remains unproven." }], details: buildChainExecutionDetails(makeDetailsInput({ currentFlatIndex: index })) });
			return;
		}
		// A detached child's stdio close is not enough even without an isolated
		// runtime: fence nested descendants before any terminal publication.
		const fence = await waitForNestedDescendantsToStop(params.nestedRoute, runId, index, { timeoutMs: params.nestedFenceTimeoutMs });
		if (!fence.stopped) {
			teardownUnproven = true;
			result.teardownUnproven = true;
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			result.error = result.error
				? `${result.error}\nNested descendants did not reach a proven terminal state before detached publication`
				: "Nested descendants did not reach a proven terminal state before detached publication";
			upsertChainResult(index, result);
			params.onUpdate?.({ content: [{ type: "text", text: result.error }], details: buildChainExecutionDetails(makeDetailsInput({ currentFlatIndex: index })) });
			return;
		}
		if (!isolatedGitRuntime || isolatedGitRuntime.isExported(index)) {
			detachedTerminalIndexes.add(index);
			await publishDetachedTerminal(index, result);
			return;
		}
		const worktree = isolatedGitRuntime.worktrees.find((candidate) => candidate.index === index);
		const policy = isolatedWorktreePolicies.get(index);
		if (!worktree) {
			detachedTerminalIndexes.add(index);
			await publishDetachedTerminal(index, result);
			return;
		}
		detachedTerminalIndexes.add(index);
		try {
			const retry = exportBundleWithRetry({
				outputDir: artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
				worktree,
				syntheticPaths: worktree.syntheticPaths,
				terminationState: result.cancelled ? "cancelled" : result.interrupted ? "interrupted" : result.exitCode === 0 ? "success" : "failure",
				agent: policy?.agent ?? result.agent,
				commitRequired: policy?.commitRequired,
			});
			const bundle = retry.bundle;
			result.gitBundle = { path: bundle.path, checksum: bundle.checksum, base: bundle.base, head: bundle.head, commits: bundle.commits, commitSummary: bundle.commitSummary, ...(bundle.recovery ? { recovery: bundle.recovery } : {}), ...(bundle.stagedSnapshot ? { stagedSnapshot: bundle.stagedSnapshot } : {}), ...(bundle.stagedTree ? { stagedTree: bundle.stagedTree } : {}), ...(bundle.recoveryTree ? { recoveryTree: bundle.recoveryTree } : {}), terminationState: bundle.terminationState, incomplete: bundle.incomplete, dirtySummary: bundle.dirtySummary, bundleSize: bundle.bundleSize, payloadChecksum: bundle.payloadChecksum, payloadSize: bundle.payloadSize, canonicalPayloadChecksum: bundle.canonicalPayloadChecksum, canonicalPayloadSize: bundle.canonicalPayloadSize, portableMetadata: bundle.portableMetadata };
			if (bundle.incomplete && policy?.commitRequired && !result.error) {
				result.exitCode = 1;
				result.error = "Isolated writer completed without a required authored commit; recovery bundle is incomplete.";
			}
		} catch (error) {
			isolatedGitRuntime.markExportFailed();
			teardownUnproven = true;
			result.success = false;
			delete result.interrupted;
			delete result.cancelled;
			result.teardownUnproven = true;
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			result.error = result.error ? `${result.error}\nIsolated Git bundle export failed; recover isolated worktree at ${isolatedGitRuntime.root}: ${error instanceof Error ? error.message : String(error)}` : `Isolated Git bundle export failed; recover isolated worktree at ${isolatedGitRuntime.root}: ${error instanceof Error ? error.message : String(error)}`;
		}
		// Detached acknowledgements were already projected to the caller. Finish
		// cleanup before publishing the eventual terminal object so no recovery
		// truth changes after durable status/result/intercom publication.
		if (ownsIsolatedGitRuntime && isolatedGitRuntime.worktrees.length > 0 && isolatedGitRuntime.worktrees.every((candidate) => isolatedGitRuntime!.isExported(candidate.index)) && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) {
			try { await cleanupIsolatedGitRuntime(isolatedGitRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(result, cleanupError); }
			noteIsolatedCleanupFailure(result);
		}
		upsertChainResult(index, result);
		await publishDetachedTerminal(index, result);
	};
	const buildIsolatedChainError = async (message: string, input: ChainExecutionDetailsInput): Promise<ChainExecutionResult> => {
		await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected", message);
		if (ownsIsolatedGitRuntime && isolatedGitRuntime && detachedIndexes.size === 0 && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) {
			try { await cleanupIsolatedGitRuntime(isolatedGitRuntime); }
			catch (cleanupError) { noteIsolatedCleanupFailure(undefined, cleanupError); }
		}
		const projectedFailures = results
			.filter((result) => result.exitCode !== 0 && result.error)
			.map((result) => `${result.agent}: ${result.error}`);
		const visibleMessage = projectedFailures.length > 0
			? `${message}\n\n${projectedFailures.join("\n")}${isolatedRecoveryNotice()}`
			: `${message}${isolatedRecoveryNotice()}`;
		return buildChainExecutionErrorResult(visibleMessage, input);
	};

	const firstStep = chainSteps[0]!;
	const originalTask = params.task
		?? (isParallelStep(firstStep)
			? firstStep.parallel[0]!.task!
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task!
				: (firstStep as SequentialStep).task!);
	try {
		validateChainOutputBindings(chainSteps, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}
		throw error;
	}

	const chainDir = createChainDir(runId, chainDirBase);
	const hasParallelSteps = chainSteps.some((step) => isParallelStep(step) || isDynamicParallelStep(step));
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const shouldClarify = clarify !== false && ctx.hasUI && !hasParallelSteps;
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const availableSkills = discoverAvailableSkills(cwd ?? ctx.cwd);
	// A foreground chain owns one sanitized Git base for its entire top-level
	// run. Each isolated child still receives a distinct writable metadata and
	// worktree layer, while the packed base remains shared read-only.
	let isolatedGitRuntime: IsolatedGitRuntime | undefined;
	const ownsIsolatedGitRuntime = !params.scopedGitEndpoint;
	// Sequential packaged stages deliberately share one checkout. A capability
	// is issued for each stage so reviewers can narrow it to read-only while the
	// next writer inherits the same HEAD and authored history.
	let sequentialIsolatedGitWorktree: IsolatedGitWorktree | undefined;
	let sequentialIsolatedGitCapability: import("../../sandbox/isolated-git.ts").IsolatedGitCapability | undefined;
	let sequentialIsolatedGitCommitRequired = false;
	const ensureIsolatedGitRuntime = (sandbox: ResolvedSandboxConfig): IsolatedGitRuntime => {
		if (resolveGitMode(sandbox) !== "isolated") throw new Error("isolated Git runtime requested for a non-isolated sandbox");
		if (sandbox.provider !== "bubblewrap") throw new Error("isolated Git requires the Bubblewrap sandbox provider; refusing to downgrade");
		if (!isolatedGitRuntime) {
			isolatedGitRuntime = createIsolatedGitRuntime({
				cwd: path.resolve(cwd ?? ctx.cwd),
				runId: `${runId}-isolated`,
				provider: sandbox.provider,
				network: sandbox.network,
				profile: sandbox.profile,
				fallback: sandbox.fallback,
				extraReadOnlyMounts: sandbox.extraReadOnlyMounts,
				extraWritableMounts: sandbox.extraWritableMounts,
				worktreeSetupHook: params.worktreeSetupHook ? { hookPath: params.worktreeSetupHook, timeoutMs: params.worktreeSetupHookTimeoutMs } : undefined,
			});
		}
		return isolatedGitRuntime;
	};

	if (shouldClarify) {
		const seqSteps = chainSteps as SequentialStep[];
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: seqSteps.indexOf(step) })),
				};
			}
			agentConfigs.push(config);
		}

		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
			fastMode: step.fastMode,
		}));

		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
		);
		const flatTemplates = templates as string[];

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui,
					theme,
					agentConfigs,
					flatTemplates,
					originalTask,
					chainDir,
					resolvedBehaviors,
					availableModels,
					ctx.model?.provider,
					availableSkills,
					done,
					"chain",
					agentConfigs.map((agent) => ({
						worktree: "inherited",
						sandbox: resolveStepSandbox(agent),
						canOptOutOfWorktree: agent.canOptOutOfWorktree === true && params.sandboxSettings?.allowWorktreeOptOut === true,
						canOptOutOfSandbox: params.sandboxSettings?.allowSandboxOptOut === true,
					} satisfies ChainClarifyPolicy)),
				),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
			},
		);

		if (!result || !result.confirmed) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}

		if (result.runInBackground) {
			removeChainDir(chainDir);
			const updatedChain: ChainStep[] = chainSteps.map((step, i) => {
				if (isParallelStep(step)) return step;
				const override = result.behaviorOverrides[i];
				return {
					...step,
					task: result.templates[i]!,
					...(override?.model ? { model: override.model } : {}),
					...(override?.output !== undefined ? { output: override.output } : {}),
					...("outputMode" in step && step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
					...(override?.reads !== undefined ? { reads: override.reads } : {}),
					...(override?.progress !== undefined ? { progress: override.progress } : {}),
					...(override?.skills !== undefined ? { skill: override.skills } : {}),
				};
			});
			return {
				content: [{ type: "text", text: "Launching in background..." }],
				details: buildChainExecutionDetails(makeDetailsInput()),
				requestedAsync: { chain: updatedChain, chainSkills },
			};
		}

		templates = result.templates;
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	let prev = "";
	let globalTaskIndex = 0;
	let progressCreated = false;

	try {
	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;

		if (isParallelStep(step)) {
			// Capture the group's canonical base before globalTaskIndex advances;
			// cleanup/recovery synthetic children must retain these flat identities.
			const groupBaseIndex = globalTaskIndex;
			const parallelTemplates = stepTemplates as string[];
			const parallelCwd = resolveChildCwd(cwd ?? ctx.cwd, step.cwd);
			const stepAgentConfigs = step.parallel
				.map((task) => agents.find((agent) => agent.name === task.agent))
				.filter((agent): agent is AgentConfig => Boolean(agent));
			const explicitWorktreeOptOut = Object.hasOwn(step, "worktree") && step.worktree === false;
			const worktreeOptOutAllowed = explicitWorktreeOptOut
				&& worktreeOptOutIsAuthorized(params.sandboxSettings)
				&& stepAgentConfigs.every((agent) => agent.canOptOutOfWorktree === true);
			if (explicitWorktreeOptOut && !worktreeOptOutAllowed) {
				return buildChainExecutionErrorResult("Worktree opt-out denied: worktree:false requires trusted user-global sandbox.allowWorktreeOptOut=true and every target agent must set canOptOutOfWorktree=true.", makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			const stepSandboxes = stepAgentConfigs.map((agent) => {
				const resolved = resolveStepSandbox(agent);
				return worktreeOptOutAllowed && resolved?.gitMode === "isolated" ? { ...resolved, gitMode: "read-only" as const } : resolved;
			});
			const isolatedGitRequested = !params.scopedGitEndpoint && stepSandboxes.some((sandboxConfig) => sandboxConfig?.gitMode === "isolated");
			if (isolatedGitRequested && step.worktree) {
				return buildChainExecutionErrorResult("isolated Git cannot be combined with parent-managed worktree mode", makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			if (isolatedGitRequested && stepAgentConfigs.some((agent, index) =>
				stepSandboxes[index]?.gitMode !== "isolated"
					&& inferSandboxCwdWritable({ agentName: agent.name, tools: agent.tools, sandbox: stepSandboxes[index] }),
			)) {
				return buildChainExecutionErrorResult("isolated Git parallel steps cannot include a non-isolated write-capable task", makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			if (!isolatedGitRequested && !params.scopedGitEndpoint && !step.worktree && hasSandboxWritableAgent({ agents: stepAgentConfigs.map((agent, index) => ({ agentName: agent.name, tools: agent.tools, sandbox: stepSandboxes[index] })) })
				&& !worktreeOptOutAllowed) {
				return buildChainExecutionErrorResult(
					sandboxParallelWorktreeRequiredMessage(`Parallel sandboxed chain step ${stepIndex + 1}`),
					makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }),
				);
			}
			// File-only output is pure input validation; reject it before creating
			// isolated runtimes/worktrees so a malformed chain cannot leak them.
			const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex, chainSkills)
				.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task, originalTask));
			for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
				const behavior = parallelBehaviors[taskIndex]!;
				const task = step.parallel[taskIndex]!;
				const taskAgentConfig = agents.find((agent) => agent.name === task.agent);
				const taskCwd = resolveChildCwd(parallelCwd, task.cwd);
				const outputPath = typeof behavior.output === "string" ? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output)) : undefined;
				const savedOutputPath = shouldPersistSavedOutput({ output: behavior.output, outputMode: behavior.outputMode, tools: taskAgentConfig?.tools })
					? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: taskCwd, agent: task.agent, runId, index: globalTaskIndex + taskIndex }) : undefined;
				const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath ?? savedOutputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${task.agent})`);
				if (validationError) return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
			}
			let worktreeSetup: WorktreeSetup | undefined;
			let isolatedGitWorktrees: (IsolatedGitWorktree | undefined)[] | undefined;
			if (isolatedGitRequested) {
				let runtime: IsolatedGitRuntime | undefined;
				try {
					runtime = ensureIsolatedGitRuntime(stepSandboxes.find((sandboxConfig) => resolveGitMode(sandboxConfig) === "isolated")!);
					isolatedGitWorktrees = step.parallel.map((task, index) => {
						if (stepSandboxes[index]?.gitMode !== "isolated") return undefined;
						const materializedIndex = globalTaskIndex + index;
						const policy = {
							agent: task.agent,
							task: resolveParallelCleanTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, index),
							commitRequired: commitRequiredForParallelTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, index, agents.find((candidate) => candidate.name === task.agent), stepSandboxes[index]),
						};
						isolatedWorktreePolicies.set(materializedIndex, policy);
						return createIsolatedGitWorktree(runtime, { index: materializedIndex, agent: task.agent });
					});
				} catch (error) {
					let recoveryCreationError = "";
					if (runtime) {
						for (let index = 0; index < step.parallel.length; index++) {
							if (stepSandboxes[index]?.gitMode !== "isolated") continue;
							const materializedIndex = globalTaskIndex + index;
							const task = step.parallel[index]!;
							const taskText = resolveParallelCleanTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, index);
							isolatedWorktreePolicies.set(materializedIndex, {
								agent: task.agent,
								task: taskText,
								commitRequired: commitRequiredForParallelTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, index, agents.find((candidate) => candidate.name === task.agent), stepSandboxes[index]),
							});
							if (!runtime.worktrees.some((candidate) => candidate.index === materializedIndex)) {
								try { runtime.createRecoveryWorktree({ index: materializedIndex, agent: task.agent }); }
								catch (creationError) {
									runtime.markExportFailed();
									const detail = creationError instanceof Error ? creationError.message : String(creationError);
									recoveryCreationError = `Recovery worktree creation failed for slot ${materializedIndex}: ${detail}. Recover isolated runtime at ${runtime.root}.`;
									upsertChainResult(materializedIndex, { flatIndex: materializedIndex, agent: task.agent, task: taskText, success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, error: `${error instanceof Error ? error.message : String(error)}; ${recoveryCreationError}` });
								}
							}
						}
					}
					return await buildIsolatedChainError(`Isolated Git setup failed: ${error instanceof Error ? error.message : String(error)}`, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}
			if (step.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(step.parallel, parallelCwd);
				if (worktreeTaskCwdConflict) {
					return await buildIsolatedChainError(
						`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
						makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }),
					);
				}
				try {
					worktreeSetup = createWorktrees(parallelCwd, `${runId}-s${stepIndex}`, step.parallel.length, {
						agents: step.parallel.map((task) => task.agent),
						setupHook: params.worktreeSetupHook
							? { hookPath: params.worktreeSetupHook, timeoutMs: params.worktreeSetupHookTimeoutMs }
							: undefined,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (error instanceof WorktreeSetupHookTeardownError) teardownUnproven = true;
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}

			let preserveWorktree = false;
			try {
				const agentNames = step.parallel.map((task) => task.agent);
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const behavior = parallelBehaviors[taskIndex]!;
					const task = step.parallel[taskIndex]!;
					const taskAgentConfig = agents.find((agent) => agent.name === task.agent);
					const taskCwd = isolatedGitWorktrees?.[taskIndex]
						? resolveChildCwd(cwd ?? ctx.cwd, task.cwd)
						: (worktreeSetup
							? worktreeSetup.worktrees[taskIndex]!.agentCwd
							: resolveChildCwd(cwd ?? ctx.cwd, task.cwd));
					const outputPath = typeof behavior.output === "string"
						? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
						: undefined;
					const savedOutputPath = shouldPersistSavedOutput({
						output: behavior.output,
						outputMode: behavior.outputMode,
						tools: taskAgentConfig?.tools,
					})
						? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: taskCwd, agent: task.agent, runId, index: globalTaskIndex + taskIndex })
						: undefined;
					const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath ?? savedOutputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]!.agent})`);
					if (validationError) return await buildIsolatedChainError(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
				progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
				createParallelDirs(chainDir, stepIndex, step.parallel.length, agentNames);

				const parallelResults = await runParallelChainTasks({
					step,
					parallelTemplates,
					parallelBehaviors,
					agents,
					stepIndex,
					availableModels,
					chainDir,
					prev,
					originalTask,
					ctx,
					intercomEvents,
					// Preserve the chain step's requested parent cwd for isolated Git
					// subdirectory mapping.
					cwd: parallelCwd,
					runId,
					globalTaskIndex,
					sessionDirForIndex,
					sessionFileForIndex,
					shareEnabled,
					artifactConfig,
					artifactsDir,
					signal,
					onUpdate,
					results,
					allProgress,
					outputs,
					chainAgents,
					chainSteps,
					totalSteps,
					dynamicChildren,
					dynamicGroupStatuses,
					controlConfig,
					onControlEvent,
					childIntercomTarget,
					orchestratorIntercomTarget,
					foregroundControl,
					nestedRoute: params.nestedRoute,
					nestedFenceTimeoutMs: params.nestedFenceTimeoutMs,
					worktreeSetup,
					isolatedGitWorktrees,
					maxSubagentDepth: params.maxSubagentDepth,
					sandbox: sharedSandbox,
					sandboxSettings: params.sandboxSettings,
					sandboxRun: params.sandboxRun,
					sandboxes: stepSandboxes,
					sandboxIntercomBridge: params.sandboxIntercomBridge,
					scopedGitEndpoint: params.scopedGitEndpoint,
					teardownHooks: params.teardownHooks,
					progressPaths: [path.join(chainDir, "progress.md")],
					onDetachedStarted: (index) => detachedIndexes.add(index),
					onDetachedTerminal,
				});
				globalTaskIndex += step.parallel.length;

				for (let resultIndex = 0; resultIndex < parallelResults.length; resultIndex++) {
					const result = parallelResults[resultIndex]!;
					const materializedIndex = globalTaskIndex - step.parallel.length + resultIndex;
					if (result.detached) detachedIndexes.add(materializedIndex);
					upsertChainResult(materializedIndex, { ...result, flatIndex: materializedIndex });
					if (result.progress) allProgress.push(result.progress);
					if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
				}
				if (detachedIndexes.size > 0) preserveWorktree = true;

				let worktreeSummaryForStep: string | undefined;
				try {
					if (detachedIndexes.size === 0) worktreeSummaryForStep = captureParallelWorktreeSummary(
						worktreeSetup,
						path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
						agentNames,
					);
				} catch (error) {
					preserveWorktree = true;
					if (!(error instanceof WorktreeDiffCaptureError)) throw error;
					const captureResult = buildChainExecutionErrorResult(error.message, makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - step.parallel.length,
					}));
					return { ...captureResult, worktreeCaptureFailed: true };
				}
				if (worktreeSummaryForStep) worktreeSummaries.push(worktreeSummaryForStep);
				const worktreeSummaryForResult = worktreeSummaries.join("\n\n");

				const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
				const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
				if (interrupted) {
					const message = `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.`;
					await finalizeBeforePublication("interrupted");
					return {
						content: [{ type: "text", text: worktreeSummaryForResult ? `${message}\n\n${worktreeSummaryForResult}` : message }],
						isError: teardownUnproven || Boolean(isolatedCleanupFailure),
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + interruptedIndexInStep,
						})),
						...(worktreeSummaryForResult ? { worktreeSummary: worktreeSummaryForResult } : {}),
					};
				}
				const detachedIndexInStep = parallelResults.findIndex((result, resultIndex) => result.detached || detachedIndexes.has(globalTaskIndex - step.parallel.length + resultIndex));
				const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
				// A detached sibling must not hide a MapConcurrentError from another
				// started sibling; preserve failure propagation while detached workers
				// continue through their terminal callbacks.
				const hasSiblingFailure = parallelResults.some((candidate) => !candidate.cancelled && !candidate.interrupted && candidate.exitCode !== 0 && candidate.exitCode !== -1);
				if (detached && !hasSiblingFailure) {
					chainExecutionSettled = true;
					for (const detachedIndex of detachedIndexes) {
						if (detachedTerminalIndexes.has(detachedIndex)) {
							const terminal = results.find((candidate) => candidate.flatIndex === detachedIndex);
							if (terminal) await publishDetachedTerminal(detachedIndex, terminal);
						}
					}
					const detachedPath = isolatedGitRuntime
						? `Recover isolated worktrees at ${isolatedGitRuntime.root} after the child reaches terminal state.`
						: params.scopedGitEndpoint
							? "Recover retained isolated worktree evidence through the owning parent run after the child reaches terminal state."
							: formatRecoverableWorktreePaths(worktreeSetup);
					const message = `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child reaches terminal state, the preserved worktree can be exported or recovered.${detachedPath ? `\n${detachedPath}` : ""}`;
					return {
						content: [{ type: "text", text: worktreeSummaryForResult ? `${message}\n\n${worktreeSummaryForResult}` : message }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + detachedIndexInStep,
						})),
						...(worktreeSummaryForResult ? { worktreeSummary: worktreeSummaryForResult } : {}),
					};
				}

				const failures = parallelResults
					.map((result, originalIndex) => ({ ...result, originalIndex }))
					.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
				if (failures.length > 0) {
					if (worktreeSetup && failures.some((failure) => failure.error?.includes("Parallel execution failed unexpectedly"))) preserveWorktree = true;
					const failureSummary = failures
						.map((failure) => `- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`)
						.join("\n");
					const aggregate = resolveAggregateState(parallelResults.map((result) => ({
						state: result.teardownUnproven ? "running" : result.cancelled ? "cancelled" : result.interrupted ? "paused" : result.exitCode === 0 ? "completed" : "failed",
						teardownUnproven: result.teardownUnproven,
					})));
					const cancelled = aggregate === "cancelled" || (aggregate !== "failed" && Boolean(signal?.aborted && !foregroundControl?.interruptRequested));
					const errorMsg = `Parallel step ${stepIndex + 1} ${cancelled ? "cancelled" : "failed"}:\n${failureSummary}`;
					const summary = buildChainSummary(chainSteps, results, chainDir, cancelled ? "cancelled" : "failed", {
						index: stepIndex,
						error: errorMsg,
					});
					await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
					return {
						content: [{ type: "text", text: worktreeSummaryForResult ? `${summary}\n\n${worktreeSummaryForResult}` : summary }],
						isError: !cancelled || teardownUnproven || Boolean(isolatedCleanupFailure),
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + failures[0]!.originalIndex,
						})),
						...(worktreeSummaryForResult ? { worktreeSummary: worktreeSummaryForResult } : {}),
					};
				}

				for (let taskIndex = 0; taskIndex < parallelResults.length; taskIndex++) {
					const outputName = step.parallel[taskIndex]?.as;
					if (outputName) outputs[outputName] = outputEntryFromResult(parallelResults[taskIndex]!, stepIndex);
				}

				const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => {
					const outputTarget = parallelBehaviors[i]?.output;
					const outputTargetPath = typeof outputTarget === "string"
						? (path.isAbsolute(outputTarget) ? outputTarget : path.join(chainDir, outputTarget))
						: undefined;
					return {
						agent: result.agent,
						taskIndex: i,
						output: getSingleResultOutput(result),
						exitCode: result.exitCode,
						error: result.error,
						outputTargetPath,
						outputTargetExists: outputTargetPath ? fs.existsSync(outputTargetPath) : undefined,
					};
				});
				prev = aggregateParallelOutputs(taskResults);
				if (worktreeSummaryForStep) prev = `${prev}\n\n${worktreeSummaryForStep}`;
			} catch (error) {
				// mapConcurrent rejects as soon as one callback rejects, while sibling
				// callbacks may still be editing. Preserve first, then capture only as
				// supplemental evidence; never let cleanup race away the only changes.
				preserveWorktree = true;
				const executionMessage = error instanceof Error ? error.message : String(error);
				let recoveryNotice = formatRecoverableWorktreePaths(worktreeSetup);
				let captureFailed = false;
				let worktreeSummary: string | undefined;
				try {
					worktreeSummary = captureParallelWorktreeSummary(
						worktreeSetup,
						path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
						step.parallel.map((task) => task.agent),
					);
				} catch (captureError) {
					captureFailed = true;
					recoveryNotice = captureError instanceof WorktreeDiffCaptureError
						? captureError.message
						: `${recoveryNotice}${recoveryNotice ? " " : ""}Failed to capture parallel worktree changes: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
				}
				const lines = [`Parallel chain step ${stepIndex + 1} failed unexpectedly: ${executionMessage}`];
				if (worktreeSummary) lines.push(worktreeSummary);
				if (recoveryNotice) lines.push(recoveryNotice);
				const captureResult = buildChainExecutionErrorResult(lines.join("\n\n"), makeDetailsInput({
					currentStepIndex: stepIndex,
					currentFlatIndex: globalTaskIndex,
				}));
				await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
				return {
					...captureResult,
					...(worktreeSummary ? { worktreeSummary } : {}),
					worktreePreserved: true,
					...(captureFailed ? { worktreeCaptureFailed: true } : {}),
				};
			} finally {
				if (worktreeSetup && !preserveWorktree) {
					const fence = await waitForNestedDescendantsToStop(params.nestedRoute, runId, undefined, { timeoutMs: params.nestedFenceTimeoutMs });
					if (!fence.stopped) {
						teardownUnproven = true;
						preserveWorktree = true;
						const message = `Nested descendants did not reach a proven terminal state before worktree cleanup; ${formatRecoverableWorktreePaths(worktreeSetup)}`;
						for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
							const index = groupBaseIndex + taskIndex;
							const existing = results.find((result) => result.flatIndex === index);
							upsertChainResult(index, existing
								? { ...existing, success: false, exitCode: existing.exitCode === 0 ? 1 : (existing.exitCode ?? 1), error: existing.error ? `${existing.error}\n${message}` : message }
								: { flatIndex: index, agent: step.parallel[taskIndex]?.agent ?? `task-${taskIndex + 1}`, task: step.parallel[taskIndex]?.task ?? "parallel execution", success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, error: message });
						}
						throw new Error(message);
					}
				}
				if (worktreeSetup) {
					try { cleanupWorktrees(worktreeSetup, { preserve: preserveWorktree }); }
					catch (cleanupError) {
						teardownUnproven = true;
						preserveWorktree = true;
						const message = `Worktree cleanup failed; recover worktrees at ${worktreeSetup.worktrees.map((worktree) => worktree.path).join(", ")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
						for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
							const index = groupBaseIndex + taskIndex;
							const existing = results.find((result) => result.flatIndex === index);
							upsertChainResult(index, existing
								? { ...existing, success: false, exitCode: existing.exitCode === 0 ? 1 : (existing.exitCode ?? 1), error: existing.error ? `${existing.error}\n${message}` : message }
								: { flatIndex: index, agent: step.parallel[taskIndex]?.agent ?? `task-${taskIndex + 1}`, task: step.parallel[taskIndex]?.task ?? "parallel execution", success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, error: message });
						}
						throw new Error(message);
					}
				}
			}
		} else if (isDynamicParallelStep(step)) {
			const dynamicAgentConfig = agents.find((agent) => agent.name === step.parallel.agent);
			const resolvedDynamicSandbox = dynamicAgentConfig ? resolveStepSandbox(dynamicAgentConfig) : undefined;
			const explicitDynamicWorktreeOptOut = step.worktree === false;
			const dynamicWorktreeOptOutAllowed = explicitDynamicWorktreeOptOut
				&& worktreeOptOutIsAuthorized(params.sandboxSettings)
				&& dynamicAgentConfig?.canOptOutOfWorktree === true;
			if (explicitDynamicWorktreeOptOut && !dynamicWorktreeOptOutAllowed) {
				const message = "Worktree opt-out denied: worktree:false requires trusted user-global sandbox.allowWorktreeOptOut=true and every target agent must set canOptOutOfWorktree=true.";
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			const dynamicSandbox = dynamicWorktreeOptOutAllowed && resolvedDynamicSandbox?.gitMode === "isolated"
				? { ...resolvedDynamicSandbox, gitMode: "read-only" as const }
				: resolvedDynamicSandbox;
			if (dynamicAgentConfig && dynamicSandbox?.gitMode !== "isolated" && hasSandboxWritableAgent({ agents: [{ agentName: dynamicAgentConfig.name, tools: dynamicAgentConfig.tools, sandbox: dynamicSandbox }] }) && !dynamicWorktreeOptOutAllowed) {
				const message = sandboxDynamicFanoutUnsupportedMessage(`Dynamic sandboxed chain step ${stepIndex + 1}`);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			if (Object.hasOwn(step, "acceptance")) {
				const message = `Dynamic fanout step ${stepIndex + 1} does not support group-level acceptance; set acceptance on the child template instead.`;
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: params.dynamicFanoutMaxItems });
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}

			dynamicChildren[stepIndex] = materialized.items.map((item, itemIndex) => ({
				agent: step.parallel.agent,
				label: materialized.parallel[itemIndex]?.label,
				flatIndex: globalTaskIndex + itemIndex,
				itemKey: item.key,
				structured: Boolean(step.parallel.outputSchema),
			}));

			if (materialized.parallel.length === 0) {
				const collection: DynamicCollectedResult[] = [];
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				// Cancellation can race materialization. An empty fanout must not
				// manufacture a successful completion after the caller already asked
				// this chain to stop.
				if (signal?.aborted || foregroundControl?.interruptRequested) {
					const interrupted = Boolean(foregroundControl?.interruptRequested);
					const cancelledMessage = interrupted ? "Interrupted before dynamic fanout completion." : "Cancelled before dynamic fanout completion.";
					dynamicGroupStatuses[stepIndex] = { status: interrupted ? "paused" : "cancelled", error: cancelledMessage };
					// Project cancellation/interrupt as a terminal child state instead of
					// an empty isError result, so nested parents retain paused/cancelled
					// semantics rather than coercing this group to failed.
					upsertChainResult(globalTaskIndex, {
						flatIndex: globalTaskIndex,
						agent: step.parallel.agent,
						task: step.parallel.task,
						exitCode: interrupted ? 0 : 1,
						success: false,
						...(interrupted ? { interrupted: true } : { cancelled: true }),
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 },
						error: cancelledMessage,
					});
					await finalizeBeforePublication(interrupted ? "interrupted" : "cancelled");
					return {
						content: [{ type: "text", text: cancelledMessage }],
						isError: teardownUnproven || Boolean(isolatedCleanupFailure),
						details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex })),
					};
				}
				dynamicGroupStatuses[stepIndex] = { status: "completed" };
				prev = "Dynamic fanout produced 0 results.";
				continue;
			}

			const dynamicParallelStep: ParallelStep = {
				parallel: materialized.parallel,
				concurrency: step.concurrency,
				failFast: step.failFast,
				worktree: step.worktree,
			};
			const parallelTemplates = materialized.parallel.map((task) => task.task ?? "{previous}");
			const parallelBehaviors = resolveParallelBehaviors(dynamicParallelStep.parallel, agents, stepIndex, chainSkills)
				.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? dynamicParallelStep.parallel[taskIndex]?.task, originalTask));
			// Validate expanded output bindings before acquiring this group's resources.
			for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
				const behavior = parallelBehaviors[taskIndex]!;
				const task = dynamicParallelStep.parallel[taskIndex]!;
				const taskAgentConfig = agents.find((agent) => agent.name === task.agent);
				const taskCwd = resolveChildCwd(cwd ?? ctx.cwd, task.cwd);
				const outputPath = typeof behavior.output === "string" ? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output)) : undefined;
				const savedOutputPath = shouldPersistSavedOutput({ output: behavior.output, outputMode: behavior.outputMode, tools: taskAgentConfig?.tools })
					? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: taskCwd, agent: task.agent, runId, index: globalTaskIndex + taskIndex }) : undefined;
				const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath ?? savedOutputPath, `Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${task.agent})`);
				if (validationError) {
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: validationError };
					return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
			}
			let dynamicIsolatedGitWorktrees: (IsolatedGitWorktree | undefined)[] | undefined;
			if (dynamicSandbox?.gitMode === "isolated" && !params.scopedGitEndpoint) {
				let runtime: IsolatedGitRuntime | undefined;
				try {
					runtime = ensureIsolatedGitRuntime(dynamicSandbox);
					dynamicIsolatedGitWorktrees = dynamicParallelStep.parallel.map((task, taskIndex) => {
						const materializedIndex = globalTaskIndex + taskIndex;
						const policy = {
							agent: task.agent,
							task: resolveParallelCleanTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, taskIndex),
							commitRequired: commitRequiredForParallelTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, taskIndex, agents.find((candidate) => candidate.name === task.agent), dynamicSandbox),
						};
						isolatedWorktreePolicies.set(materializedIndex, policy);
						return createIsolatedGitWorktree(runtime, { index: materializedIndex, agent: task.agent });
					});
				} catch (error) {
					let recoveryCreationError = "";
					if (runtime) {
						for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
							const task = dynamicParallelStep.parallel[taskIndex]!;
							const materializedIndex = globalTaskIndex + taskIndex;
							const taskText = resolveParallelCleanTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, taskIndex);
							isolatedWorktreePolicies.set(materializedIndex, {
								agent: task.agent,
								task: taskText,
								commitRequired: commitRequiredForParallelTask({ parallelTemplates, outputs, originalTask, prev, chainDir }, taskIndex, agents.find((candidate) => candidate.name === task.agent), dynamicSandbox),
							});
							if (!runtime.worktrees.some((candidate) => candidate.index === materializedIndex)) {
								try { runtime.createRecoveryWorktree({ index: materializedIndex, agent: task.agent }); }
								catch (creationError) {
									runtime.markExportFailed();
									const detail = creationError instanceof Error ? creationError.message : String(creationError);
									recoveryCreationError = `Recovery worktree creation failed for slot ${materializedIndex}: ${detail}. Recover isolated runtime at ${runtime.root}.`;
									upsertChainResult(materializedIndex, { flatIndex: materializedIndex, agent: task.agent, task: taskText, success: false, exitCode: 1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, error: `${error instanceof Error ? error.message : String(error)}; ${recoveryCreationError}` });
								}
							}
						}
					}
					return await buildIsolatedChainError(`Isolated Git setup failed: ${error instanceof Error ? error.message : String(error)}`, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}


			progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
			createParallelDirs(chainDir, stepIndex, dynamicParallelStep.parallel.length, dynamicParallelStep.parallel.map((task) => task.agent));
			const parallelResults = await runParallelChainTasks({
				step: dynamicParallelStep,
				parallelTemplates,
				parallelBehaviors,
				agents,
				stepIndex,
				availableModels,
				chainDir,
				prev,
				originalTask,
				ctx,
				intercomEvents,
				cwd,
				runId,
				globalTaskIndex,
				sessionDirForIndex,
				sessionFileForIndex,
				shareEnabled,
				artifactConfig,
				artifactsDir,
				signal,
				onUpdate,
				results,
				allProgress,
				outputs,
				chainAgents,
				chainSteps,
				totalSteps,
				dynamicChildren,
				dynamicGroupStatuses,
				controlConfig,
				onControlEvent,
				childIntercomTarget,
				orchestratorIntercomTarget,
				foregroundControl,
				nestedRoute: params.nestedRoute,
				nestedFenceTimeoutMs: params.nestedFenceTimeoutMs,
				maxSubagentDepth: params.maxSubagentDepth,
				sandbox: sharedSandbox,
				sandboxSettings: params.sandboxSettings,
				sandboxRun: params.sandboxRun,
				sandboxes: dynamicParallelStep.parallel.map(() => dynamicSandbox),
				isolatedGitWorktrees: dynamicIsolatedGitWorktrees,
				sandboxIntercomBridge: params.sandboxIntercomBridge,
				scopedGitEndpoint: params.scopedGitEndpoint,
				teardownHooks: params.teardownHooks,
				progressPaths: [path.join(chainDir, "progress.md")],
				onDetachedStarted: (index) => detachedIndexes.add(index),
				onDetachedTerminal,
			});
			globalTaskIndex += dynamicParallelStep.parallel.length;

			for (let resultIndex = 0; resultIndex < parallelResults.length; resultIndex++) {
				const result = parallelResults[resultIndex]!;
				const materializedIndex = globalTaskIndex - dynamicParallelStep.parallel.length + resultIndex;
				if (result.detached) detachedIndexes.add(materializedIndex);
				upsertChainResult(materializedIndex, { ...result, flatIndex: materializedIndex });
				if (result.progress) allProgress.push(result.progress);
				if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
			}
			const collected = collectDynamicResults(step, materialized.items, parallelResults);
			const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
			const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
			if (interrupted) {
				await finalizeBeforePublication("interrupted");
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + interruptedIndexInStep,
					})),
				};
			}
			const detachedIndexInStep = parallelResults.findIndex((result, resultIndex) => result.detached || detachedIndexes.has(globalTaskIndex - dynamicParallelStep.parallel.length + resultIndex));
			const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
			const hasSiblingFailure = parallelResults.some((candidate) => !candidate.cancelled && !candidate.interrupted && candidate.exitCode !== 0 && candidate.exitCode !== -1);
			if (detached && !hasSiblingFailure) {
				// Dynamic fanout detachment settles the chain acknowledgement now;
				// terminal callbacks still gate aggregate publication later. A failed
				// sibling keeps the chain on its failure path, matching static groups.
				chainExecutionSettled = true;
				for (const detachedIndex of detachedIndexes) {
					if (detachedTerminalIndexes.has(detachedIndex)) {
						const terminal = results.find((candidate) => candidate.flatIndex === detachedIndex);
						if (terminal) await publishDetachedTerminal(detachedIndex, terminal);
					}
				}
				const detachedPath = isolatedGitRuntime
					? `Recover isolated worktrees at ${isolatedGitRuntime.root} after the child reaches terminal state.`
					: params.scopedGitEndpoint
						? "Recover retained isolated worktree evidence through the owning parent run after the child reaches terminal state."
						: "";
				return {
					content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child reaches terminal state, the preserved worktree can be exported or recovered.${detachedPath ? `\n${detachedPath}` : ""}` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + detachedIndexInStep,
					})),
				};
			}
			const failures = parallelResults
				.map((result, originalIndex) => ({ ...result, originalIndex }))
				.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length > 0) {
				const failureSummary = failures
					.map((failure) => `- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`)
					.join("\n");
				const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
				const aggregate = resolveAggregateState(parallelResults.map((result) => ({
					state: result.teardownUnproven ? "running" : result.cancelled ? "cancelled" : result.interrupted ? "paused" : result.exitCode === 0 ? "completed" : "failed",
					teardownUnproven: result.teardownUnproven,
				})));
				const cancelled = aggregate === "cancelled" || (aggregate !== "failed" && Boolean(signal?.aborted && !foregroundControl?.interruptRequested));
				dynamicGroupStatuses[stepIndex] = { status: aggregate === "failed" ? "failed" : cancelled ? "cancelled" : "paused", error: errorMsg };
				const summary = buildChainSummary(chainSteps, results, chainDir, cancelled ? "cancelled" : "failed", {
					index: stepIndex,
					error: errorMsg,
				});
				await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
				return {
					content: [{ type: "text", text: `${summary}${isolatedRecoveryNotice()}` }],
					// Cancellation is a truthful terminal state, not a generic tool
					// failure. Static parallel cancellation uses the same projection.
					isError: !cancelled || teardownUnproven || Boolean(isolatedCleanupFailure),
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + failures[0]!.originalIndex,
					})),
				};
			}
			try {
				validateDynamicCollection(step.collect.outputSchema, collected);
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length }));
			}
			outputs[step.collect.as] = {
				text: JSON.stringify(collected),
				structured: collected,
				agent: step.parallel.agent,
				stepIndex,
			};
			dynamicGroupStatuses[stepIndex] = { status: "completed" };
			const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => ({
				agent: result.agent,
				taskIndex: i,
				output: getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			}));
			prev = aggregateParallelOutputs(taskResults, (i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`);
		} else {
			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex })),
				};
			}

			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				outputMode: seqStep.outputMode,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
				fastMode: tuiOverride?.fastMode !== undefined ? tuiOverride.fastMode : seqStep.fastMode,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfig, stepOverride, chainSkills), stepTemplate, originalTask);
			const stepSandbox = resolveStepSandbox(agentConfig);

			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			const templateHasPrevious = stepTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				chainDir,
				isFirstProgress,
				templateHasPrevious ? undefined : prev,
			);

			let stepTask = resolveOutputReferences(stepTemplate, outputs);
			stepTask = stepTask.replace(/\{task\}/g, originalTask);
			stepTask = stepTask.replace(/\{previous\}/g, prev);
			stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);
			const cleanTask = stepTask;
			stepTask = prefix + stepTask + suffix;

			const effectiveModel =
				tuiOverride?.model
				?? (seqStep.model ? resolveModelCandidate(seqStep.model, availableModels, ctx.model?.provider) : null)
				?? resolveModelCandidate(agentConfig.model, availableModels, ctx.model?.provider);

			const stepCwd = resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd);
			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
				: undefined;
			const savedOutputPath = shouldPersistSavedOutput({
				output: behavior.output,
				outputMode: behavior.outputMode,
				tools: agentConfig.tools,
			})
				? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: stepCwd, agent: seqStep.agent, runId, index: globalTaskIndex })
				: undefined;
			const instructionOutputPath = outputPath ?? (behavior.outputMode === "file-only" ? savedOutputPath : undefined);
			stepTask = injectSingleOutputInstruction(stepTask, instructionOutputPath);
			const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath ?? savedOutputPath, `Chain step ${stepIndex + 1} (${seqStep.agent})`);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agentConfig.maxSubagentDepth);
			const interruptController = new AbortController();
			let unregisterInterrupt: (() => void) | undefined;
			const unregisterForegroundInterrupt = (): void => {
				unregisterInterrupt?.();
				unregisterInterrupt = undefined;
			};
			if (foregroundControl) {
				foregroundControl.currentAgent = seqStep.agent;
				foregroundControl.currentIndex = globalTaskIndex;
				foregroundControl.currentActivityState = undefined;
				foregroundControl.currentModel = effectiveModel;
				foregroundControl.currentThinking = undefined;
				foregroundControl.currentFastMode = resolveFastModeStatus(
					behavior.fastMode,
					effectiveModel,
					availableModels,
					ctx.model?.provider,
				);
				foregroundControl.updatedAt = Date.now();
				if (params.sessionFileForIndex) {
					foregroundControl.sessionFile = params.sessionFileForIndex(globalTaskIndex);
				}
				unregisterInterrupt = registerForegroundInterrupt(foregroundControl, () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					foregroundControl.currentActivityState = undefined;
					foregroundControl.updatedAt = Date.now();
					return true;
				});
				activeInterruptCleanup = unregisterForegroundInterrupt;
			}

			let structuredRuntime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
			try {
				structuredRuntime = seqStep.outputSchema
					? createStructuredOutputRuntime(seqStep.outputSchema, path.join(chainDir, "structured-output"))
				: undefined;
			} catch (error) {
				unregisterForegroundInterrupt();
				throw error;
			}
			let isolatedWorktree: IsolatedGitWorktree | undefined;
			let isolatedWorktreeReadOnly = false;
			let writer = resolveCapabilityRights({
				packagedRole: resolvePackagedAgentRole(agentConfig.name, agentConfig.source),
				agentTools: agentConfig.tools,
				sandbox: stepSandbox,
				taskMutationProhibited: taskDisallowsFileUpdates(stepTask),
				writableCwd: inferSandboxCwdWritable({ agentName: agentConfig.name, tools: agentConfig.tools, sandbox: stepSandbox }),
				exclusiveLease: true,
			}) === "writer";
			if (stepSandbox && resolveGitMode(stepSandbox) === "isolated" && !params.scopedGitEndpoint) {
				try {
					const packagedRole = resolvePackagedAgentRole(agentConfig.name, agentConfig.source);
					writer = resolveCapabilityRights({
						packagedRole,
						agentTools: agentConfig.tools,
						sandbox: stepSandbox,
						taskMutationProhibited: taskDisallowsFileUpdates(stepTask),
						writableCwd: inferSandboxCwdWritable({ agentName: agentConfig.name, tools: agentConfig.tools, sandbox: stepSandbox }),
						exclusiveLease: true,
					}) === "writer";
					isolatedWorktreeReadOnly = !writer;
					const runtime = ensureIsolatedGitRuntime(stepSandbox);
					isolatedWorktree = sequentialIsolatedGitWorktree ??= createIsolatedGitWorktree(runtime, { index: globalTaskIndex, agent: seqStep.agent });
					sequentialIsolatedGitCapability = runtime.issueInheritedContext({ worktree: isolatedWorktree, rights: writer ? "writer" : "read-only", cwd: stepCwd });
					sequentialIsolatedGitCommitRequired ||= writer;
					const previousPolicy = isolatedWorktreePolicies.get(isolatedWorktree.index);
					isolatedWorktreePolicies.set(isolatedWorktree.index, {
						agent: seqStep.agent,
						task: seqStep.task,
						commitRequired: Boolean(previousPolicy?.commitRequired || sequentialIsolatedGitCommitRequired),
					});
				} catch (error) {
					unregisterForegroundInterrupt();
					return await buildIsolatedChainError(`Isolated Git setup failed: ${error instanceof Error ? error.message : String(error)}`, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}
			const detachedTerminalIndex = globalTaskIndex;
			const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
				// runSingleAttempt maps the exact requested repository/subdirectory cwd.
				cwd: stepCwd,
				signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents,
				runId,
				index: globalTaskIndex,
				sessionDir: sessionDirForIndex(globalTaskIndex),
				sessionFile: sessionFileForIndex?.(globalTaskIndex),
				share: shareEnabled,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				outputPath,
				savedOutputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig,
				onControlEvent,
				intercomSessionName: childIntercomTarget?.(seqStep.agent, globalTaskIndex),
				orchestratorIntercomTarget,
				nestedRoute: params.nestedRoute,
				nestedFenceTimeoutMs: params.nestedFenceTimeoutMs,
				modelOverride: effectiveModel,
				fastMode: behavior.fastMode,
				availableModels,
				preferredModelProvider: ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: seqStep.acceptance,
				acceptanceContext: { mode: "chain" },
				hostGitDiagnostic: !stepSandbox && hasExplicitSandboxOptOut({ settings: params.sandboxSettings, run: params.sandbox }),
				sandbox: stepSandbox,
				isolatedGit: isolatedWorktree,
				isolatedGitCapability: sequentialIsolatedGitCapability,
				isolatedGitEndpoint: params.scopedGitEndpoint,
				isolatedGitRights: params.scopedGitEndpoint ? (writer ? "writer" : "read-only") : (isolatedWorktreeReadOnly ? "read-only" : "writer"),
				isolatedGitBundleDir: artifactsDir,
				isolatedGitCommitRequired: Boolean(isolatedWorktree) && !isolatedWorktreeReadOnly,
				// The shared sequential context is exported once, after the terminal
				// descendant fence, not once per child.
				exportIsolatedGitBundle: Boolean(isolatedWorktree) ? false : undefined,
				sandboxIntercomBridge: params.sandboxIntercomBridge,
				progressPaths: behavior.progress ? [path.join(chainDir, "progress.md")] : undefined,
				onDetachedStarted: () => detachedIndexes.add(detachedTerminalIndex),
				onDetachedTerminal: async (result) => {
					if (params.scopedGitEndpoint && !result.teardownUnproven) {
						const fence = await (params.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(params.nestedRoute, runId, detachedTerminalIndex, { timeoutMs: params.nestedFenceTimeoutMs });
						if (!fence.observed || !fence.stopped) {
							result.teardownUnproven = true;
							result.success = false;
							delete result.interrupted;
							delete result.cancelled;
							result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
							const recoveryMessage = "Nested descendants did not reach a proven terminal state before scoped Git endpoint cleanup; recover retained isolated worktree evidence through the owning parent run";
							result.error = result.error ? `${result.error}\n${recoveryMessage}` : recoveryMessage;
							onUpdate?.({ content: [{ type: "text", text: result.error }], details: { mode: "chain", results: results.concat([{ ...result, detached: true }]) } });
						}
					}
					if (sequentialIsolatedGitCapability && isolatedWorktree && !result.teardownUnproven) {
						const fence = await (params.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(params.nestedRoute, runId, detachedTerminalIndex, { timeoutMs: params.nestedFenceTimeoutMs });
						if (fence.stopped) {
							try {
								(params.teardownHooks?.releaseInheritedContext ?? ((runtime, capability) => runtime.releaseInheritedContext(capability)))(isolatedWorktree.runtime, sequentialIsolatedGitCapability);
								sequentialIsolatedGitCapability = undefined;
							} catch (error) {
								isolatedWorktree.runtime.markExportFenceFailed();
								result.teardownUnproven = true;
								result.success = false;
								delete result.interrupted;
								delete result.cancelled;
								result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
								const detail = error instanceof Error ? error.message : String(error);
								result.error = result.error ? `${result.error}\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
								onUpdate?.({ content: [{ type: "text", text: result.error }], details: { mode: "chain", results: results.concat([{ ...result, detached: true }]) } });
							}
						} else {
							isolatedWorktree.runtime.markExportFenceFailed();
							result.teardownUnproven = true;
							result.success = false;
							delete result.interrupted;
							delete result.cancelled;
							result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
							result.error = result.error ? `${result.error}\nNested descendants did not reach a proven terminal state; inherited capability retained for recovery.` : "Nested descendants did not reach a proven terminal state; inherited capability retained for recovery.";
							onUpdate?.({ content: [{ type: "text", text: result.error }], details: { mode: "chain", results: results.concat([{ ...result, detached: true }]) } });
						}
					}
					// A failed fence/release remains recoverable and must not publish a
					// terminal detached projection.
					if (result.teardownUnproven || sequentialIsolatedGitCapability) return;
					await onDetachedTerminal(detachedTerminalIndex, result);
				},
				onUpdate: onUpdate
					? (p) => {
						const stepResults = p.details?.results || [];
						const stepProgress = p.details?.progress || [];
						if (foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							foregroundControl.currentAgent = seqStep.agent;
							foregroundControl.currentIndex = globalTaskIndex;
							foregroundControl.currentActivityState = current?.activityState;
							foregroundControl.currentModel = stepResults[0]?.model ?? effectiveModel;
							foregroundControl.currentThinking = stepResults[0]?.thinking;
							foregroundControl.currentFastMode = stepResults[0]?.fastMode ?? foregroundControl.currentFastMode;
							foregroundControl.lastActivityAt = current?.lastActivityAt;
							foregroundControl.currentTool = current?.currentTool;
							foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							foregroundControl.currentPath = current?.currentPath;
							foregroundControl.turnCount = current?.turnCount;
							foregroundControl.tokens = current?.tokens;
							foregroundControl.toolCount = current?.toolCount;
							foregroundControl.updatedAt = Date.now();
							if (params.sessionFileForIndex) {
								foregroundControl.sessionFile = params.sessionFileForIndex(globalTaskIndex);
							}
						}
						onUpdate({
							...p,
							details: {
								mode: "chain",
								results: results.concat(stepResults),
								progress: allProgress.concat(stepProgress),
								controlEvents: p.details?.controlEvents,
								chainAgents,
								totalSteps,
								currentStepIndex: stepIndex,
								outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId,
									mode: "chain",
									steps: chainSteps,
									results: results.concat(stepResults),
									currentStepIndex: stepIndex,
									currentFlatIndex: globalTaskIndex,
									dynamicChildren,
									dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			}).then(async (settled) => {
				if (sequentialIsolatedGitCapability && isolatedWorktree && !settled.teardownUnproven) {
					// runSync defers shared-checkout export; release only after the
					// exact nested descendant fence for this stage is proven.
					const fence = await (params.teardownHooks?.waitForNestedDescendantsToStop ?? waitForNestedDescendantsToStop)(params.nestedRoute, runId, globalTaskIndex, { timeoutMs: params.nestedFenceTimeoutMs });
					if (fence.stopped) {
						try {
							(params.teardownHooks?.releaseInheritedContext ?? ((runtime, capability) => runtime.releaseInheritedContext(capability)))(isolatedWorktree.runtime, sequentialIsolatedGitCapability);
							sequentialIsolatedGitCapability = undefined;
						} catch (error) {
							// Revocation is part of the terminal fence. If it cannot be
							// proven, retain authority and make the result recoverable.
							settled.teardownUnproven = true;
							settled.exitCode = settled.exitCode === 0 ? 1 : settled.exitCode;
							const detail = error instanceof Error ? error.message : String(error);
							settled.error = settled.error ? `${settled.error}\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
							try { isolatedWorktree.runtime.markExportFenceFailed(); } catch { /* retain terminal teardown evidence if fence persistence also fails */ }
						}
					} else {
						try { isolatedWorktree.runtime.markExportFenceFailed(); } catch { /* retain terminal state if fence persistence also fails */ }
						settled.teardownUnproven = true;
						settled.exitCode = settled.exitCode === 0 ? 1 : settled.exitCode;
					}
				} else if (sequentialIsolatedGitCapability && settled.teardownUnproven) {
					isolatedWorktree?.runtime.markExportFenceFailed();
				}
				return settled;
			}).finally(async () => {
				unregisterForegroundInterrupt();
				if (activeInterruptCleanup === unregisterForegroundInterrupt) activeInterruptCleanup = undefined;
			});
			if (foregroundControl?.currentIndex === globalTaskIndex) {
				foregroundControl.currentModel = r.model ?? effectiveModel;
				foregroundControl.currentThinking = r.thinking;
				foregroundControl.currentFastMode = r.fastMode ?? foregroundControl.currentFastMode;
				foregroundControl.updatedAt = Date.now();
			}
			recordRun(seqStep.agent, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

			globalTaskIndex++;
			// Detached terminal callbacks may have inserted/enriched this slot before
			// the acknowledgement path resumes. Merge idempotently instead of
			// appending a duplicate child.
			if (results[globalTaskIndex - 1] !== r) upsertChainResult(globalTaskIndex - 1, r);
			if (r.progress) allProgress.push(r.progress);
			if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

			const singleAggregate = resolveAggregateState([
				{ state: r.cancelled ? "cancelled" : r.interrupted ? "paused" : r.exitCode === 0 ? "completed" : "failed", teardownUnproven: r.teardownUnproven },
				...(r.exitCode !== 0 && !r.cancelled ? [{ state: "failed" }] : []),
			]);
			if (r.interrupted && singleAggregate === "paused") {
				await finalizeBeforePublication("interrupted");
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${r.agent}). Waiting for explicit next action.${isolatedRecoveryNotice()}` }],
					isError: teardownUnproven || Boolean(isolatedCleanupFailure),
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}
			if (r.detached || detachedIndexes.has(globalTaskIndex - 1)) {
				detachedIndexes.add(globalTaskIndex - 1);
				chainExecutionSettled = true;
				if (detachedTerminalIndexes.has(globalTaskIndex - 1)) await publishDetachedTerminal(globalTaskIndex - 1, r);
				const detachedPath = isolatedGitRuntime
					? `Recover isolated worktrees at ${isolatedGitRuntime.root} after the child reaches terminal state.`
					: params.scopedGitEndpoint
						? "Recover retained isolated worktree evidence through the owning parent run after the child reaches terminal state."
						: "";
				return {
					content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${r.agent}). Reply to the supervisor request first. After the child reaches terminal state, the preserved worktree can be exported or recovered.${detachedPath ? `\n${detachedPath}` : ""}` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}

			if (r.exitCode !== 0) {
				await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
				if (isolatedGitRuntime?.exportFailed) {
					const recovery = `Isolated Git bundle export failed; recover isolated worktree at ${isolatedGitRuntime.root}`;
					const current = results[globalTaskIndex - 1];
					if (current && !current.error?.includes("Isolated Git bundle export failed;")) current.error = current.error ? `${current.error}\n${recovery}` : recovery;
					if (!r.error?.includes("Isolated Git bundle export failed;")) r.error = r.error ? `${r.error}\n${recovery}` : recovery;
				}
				const cancelled = singleAggregate === "cancelled" || (singleAggregate !== "failed" && Boolean(signal?.aborted && !foregroundControl?.interruptRequested));
				const summary = buildChainSummary(chainSteps, results, chainDir, cancelled ? "cancelled" : "failed", {
					index: stepIndex,
					error: r.error || (cancelled ? "Chain cancelled" : "Chain failed"),
				});
				await finalizeBeforePublication(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected");
				return {
					content: [{ type: "text", text: `${summary}${isolatedRecoveryNotice()}` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
					isError: !cancelled || teardownUnproven || Boolean(isolatedCleanupFailure),
				};
			}

			if (behavior.output) {
				try {
					const expectedPath = path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(chainDir, behavior.output);
					if (!fs.existsSync(expectedPath)) {
						const dirFiles = fs.readdirSync(chainDir);
						const mdFiles = dirFiles.filter((file) => file.endsWith(".md") && file !== "progress.md");
						const warning = mdFiles.length > 0
							? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
							: `Agent did not create expected output file: ${behavior.output}`;
						r.error = r.error ? `${r.error}\n${warning}` : warning;
					}
				} catch {
					// Ignore validation errors; this diagnostic should not mask successful chain output.
				}
			}

			if (seqStep.as) outputs[seqStep.as] = outputEntryFromResult(r, stepIndex);
			prev = getSingleResultOutput(r);
		}
	}

	chainExecutionSettled = true;
	if (detachedIndexes.size > 0) {
		for (const index of detachedIndexes) {
			if (!detachedTerminalIndexes.has(index)) continue;
			const settled = results.find((candidate) => candidate.flatIndex === index);
			if (settled) await publishDetachedTerminal(index, settled);
		}
	}
	const summary = buildChainSummary(chainSteps, results, chainDir, "completed");
	const worktreeSummary = worktreeSummaries.join("\n\n");
	if (ownsIsolatedGitRuntime && isolatedGitRuntime && detachedIndexes.size === 0) {
		const chainTermination = results.some((result) => result.cancelled)
			? "cancelled" as const
			: results.some((result) => result.interrupted)
				? "interrupted" as const
				: results.some((result) => result.success !== true || result.exitCode !== 0)
					? "failure" as const
					: "success" as const;
		const exportOutcome = await exportRemainingIsolated(chainTermination, "Chain completed but isolated Git export failed");
		if (!exportOutcome.fenced || isolatedGitRuntime.exportFailed || isolatedGitRuntime.exportFenceFailed) {
			const packaging = !exportOutcome.fenced
				? `Nested descendants did not reach a proven terminal state before export; recover isolated worktrees at ${isolatedGitRuntime.root}.`
				: `Isolated Git bundle export failed; recover isolated worktrees at ${isolatedGitRuntime.root}.`;
			return {
				...buildChainExecutionErrorResult(`${summary}\n\n${packaging}`, makeDetailsInput()),
				...(worktreeSummary ? { worktreeSummary } : {}),
				worktreePreserved: true,
			};
		}
		if (ownsIsolatedGitRuntime && isolatedGitRuntime && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) {
			const cleanupError = `Isolated Git cleanup failed after export; recover isolated worktrees at ${isolatedGitRuntime.root}.`;
			try {
				await cleanupIsolatedGitRuntime(isolatedGitRuntime);
			} catch (error) {
				// A refusal may surface as either a retained root or a filesystem
				// exception. Both are terminal recovery state, not a successful child.
				isolatedGitRuntime.markExportFailed();
				isolatedCleanupFailure = `${cleanupError} ${error instanceof Error ? error.message : String(error)}`;
			}
			if (isolatedGitRuntime.exportFailed || fs.existsSync(isolatedGitRuntime.root)) {
				// Cleanup refusal is a terminal child failure, not merely a top-level
				// tool error. Project it before building details so foreground observers
				// persist failed/incomplete status while retaining the exported bundle.
				noteIsolatedCleanupFailure();
				return {
					...buildChainExecutionErrorResult(`${summary}\n\n${isolatedCleanupFailure ?? cleanupError}`, makeDetailsInput()),
					...(worktreeSummary ? { worktreeSummary } : {}),
					worktreePreserved: true,
				};
			}
		}
	}

	return {
		content: [{ type: "text", text: worktreeSummary ? `${summary}\n\n${worktreeSummary}` : summary }],
		details: buildChainExecutionDetails(makeDetailsInput()),
		...(worktreeSummary ? { worktreeSummary } : {}),
	};
	} catch (error) {
		activeInterruptCleanup?.();
		activeInterruptCleanup = undefined;
		const executionMessage = `Chain execution rejected: ${error instanceof Error ? error.message : String(error)}`;
		const exportOutcome = await exportRemainingIsolated(foregroundControl?.interruptRequested ? "interrupted" : signal?.aborted ? "cancelled" : "execution-rejected", executionMessage);
		if (ownsIsolatedGitRuntime && isolatedGitRuntime && exportOutcome.fenced && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) {
			try {
				await cleanupIsolatedGitRuntime(isolatedGitRuntime);
			} catch (cleanupError) {
				isolatedGitRuntime.markExportFailed();
				isolatedCleanupFailure ??= `Isolated Git cleanup failed after export; recover isolated worktrees at ${isolatedGitRuntime.root}. ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
				noteIsolatedCleanupFailure();
			}
		}
		const recovery = !exportOutcome.fenced && isolatedGitRuntime
			? `\nNested descendants did not reach a proven terminal state before export; recover isolated worktrees at ${isolatedGitRuntime.root}.`
			: isolatedGitRuntime && (isolatedGitRuntime.exportFailed || fs.existsSync(isolatedGitRuntime.root))
				? `\nIsolated Git cleanup/export failed; recover isolated worktrees at ${isolatedGitRuntime.root}.`
				: "";
		const projectedFailures = results.filter((result) => result.exitCode !== 0 && result.error).map((result) => `${result.agent}: ${result.error}`);
		const projectedError = projectedFailures.length > 0 ? `\n\n${projectedFailures.join("\n")}` : "";
		return {
			content: [{ type: "text", text: `${executionMessage}${projectedError}${recovery}` }],
			isError: true,
			details: buildChainExecutionDetails(makeDetailsInput()),
		};
	}
}
