import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { resolveProjectLocalPiPackageResources } from "../../agents/pi-packages.ts";
import { PI_CHILD_RUNTIME_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { createSandboxProvider } from "../../sandbox/provider.ts";
import { resolveGitMode } from "../../sandbox/config.ts";
import { createIsolatedGitRuntime, createIsolatedGitWorktree, exportIsolatedGitBundle, cleanupIsolatedGitRuntime, isInheritedIsolatedGitRuntime, mapIsolatedGitCwd, stripIsolatedGitExportDiagnostics, type IsolatedGitCapability, type IsolatedGitRuntime, type IsolatedGitWorktree } from "../../sandbox/isolated-git.ts";
import { diagnoseSandboxFailure, sandboxResultDetails } from "../../sandbox/diagnostics.ts";
import { buildSubagentSandboxMounts, type SubagentSandboxMountInput } from "../../sandbox/mount-policy.ts";
import { inferSandboxCwdWritable, hasSandboxWritableAgent, sandboxDynamicFanoutUnsupportedMessage, sandboxParallelWorktreeRequiredMessage } from "../../sandbox/write-inference.ts";
import type { ResolvedSandboxConfig, SandboxResultDetails, SpawnableInvocation } from "../../sandbox/types.ts";
import { writeSavedOutput } from "../../shared/output-paths.ts";
import { appendSavedOutputSystemPrompt, captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	type AcceptanceFinalizationTurn,
	type AcceptanceLedger,
	type ActivityState,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChainOutputMap,
	type ModelAttempt,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SandboxIntercomBridge,
	type SubagentRunMode,
	type TokenUsage,
	type Usage,
	type WorkflowGraphSnapshot,
	DEFAULT_MAX_OUTPUT,
	TEMP_ARTIFACTS_DIR,
	type MaxOutputConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	MapConcurrentError,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir, SUBAGENT_SCOPED_GIT_ENDPOINT_ENV } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { formatAsyncRunnerIdentity, readProcessStartToken } from "./pid-identity.ts";
import { hasLiveNestedDescendantsForParent, nestedSummaryFromAsyncStatus, projectNestedEvents, waitForNestedDescendantsToStop, writeNestedEvent } from "../shared/nested-events.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { shouldRequestFastMode, type FastModeStatus } from "../../shared/fast-mode.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, isChildProcessGroupGone, processControlUnsupported, signalChildProcessGroup } from "../../shared/post-exit-stdio-guard.ts";
import { cancelScopedGitChildDescriptor, delegateScopedGitWriterDescriptor, readScopedGitProcessIdentity, reserveScopedGitChildDescriptor, scopedGitDescriptorMounts, waitForScopedGitChildRelease, waitForScopedGitProcessGone, type ScopedGitEndpointDescriptor } from "../../sandbox/scoped-git-endpoint.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import { resolvePackagedAgentRole } from "../shared/agent-role.ts";
import { resolveCapabilityRights } from "../shared/capability-rights.ts";
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
import { resolveCandidateLaunchThinking, resolveEffectiveThinking } from "../../shared/model-info.ts";
import { taskDisallowsFileUpdates, writeInitialProgressFile } from "../../shared/settings.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	acceptanceFailureMessage,
	acceptanceSelfReviewConfig,
	attachFinalizationToLedger,
	buildFinalizationProcessFailureLedger,
	createFinalizationProcessFailureTurn,
	createFinalizationTurn,
	evaluateAcceptance,
	formatAcceptanceFinalizationPrompt,
	formatAcceptancePrompt,
	shouldRunAcceptanceFinalization,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

interface SubagentRunConfig {
	id: string;
	/** Minimal endpoint descriptor inherited by a nested async runner. */
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piEntrypointOverride?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	sandbox?: ResolvedSandboxConfig;
	progressPaths?: string[];
	sandboxIntercomBridge?: SandboxIntercomBridge;
	ownerPid?: number;
	ownerStartToken?: string;
}

interface StepResult {
	flatIndex?: number;
	groupId?: string;
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	interrupted?: boolean;
	cancelled?: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	outputMode?: "inline" | "file-only";
	savedOutputPath?: string;
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	sandbox?: SandboxResultDetails;
	teardownUnproven?: boolean;
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
		terminationState?: "success" | "failure" | "timeout" | "cancelled" | "execution-rejected" | "interrupted" | "unknown";
		incomplete?: boolean;
		dirtySummary?: string;
		bundleSize?: number;
		payloadChecksum?: string;
		canonicalPayloadChecksum?: string;
		canonicalPayloadSize?: number;
		portableMetadata?: string;
		payloadSize?: number;
	};
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
// This signal is an interrupt/pause operation only. There is deliberately no
// async cancellation producer in this runner; persisted/reconciled cancelled
// states are consumed by projection paths, but SIGUSR2 must never become one.
// Internal integration seam only. It is intentionally not part of the async
// request/config schema and production does nothing unless a test process opts
// in with the exact run id after the real child has returned.
const TEST_REJECT_AFTER_CHILD_ENV = "PI_SUBAGENTS_TEST_REJECT_AFTER_CHILD";
// Test-only synchronization seam for exercising socket replacement after the
// inherited endpoint has been validated but before the first child subtree is
// reserved. It is inert unless a test supplies an explicit gate path.
const TEST_PAUSE_AFTER_INHERITED_AUTH_ENV = "PI_SUBAGENTS_TEST_PAUSE_AFTER_INHERITED_AUTH";

async function waitForTestInheritedAuthGate(): Promise<void> {
	const gate = process.env[TEST_PAUSE_AFTER_INHERITED_AUTH_ENV];
	if (!gate) return;
	const ready = `${gate}.ready`;
	fs.writeFileSync(ready, "authenticated\n", { mode: 0o600 });
	const deadline = Date.now() + 15_000;
	while (fs.existsSync(gate) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	try { fs.unlinkSync(ready); } catch { /* test cleanup owns the gate directory */ }
	if (fs.existsSync(gate)) throw new Error("test inherited-auth gate timed out");
}

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session lookup is optional metadata.
		return null;
	}
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	for (const attempt of attempts) {
		input += attempt.usage?.input ?? 0;
		output += attempt.usage?.output ?? 0;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : null;
}

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
	step.recentTools = [];
	step.recentOutput = [];
}

function initialFastModeStatus(step: SubagentStep): FastModeStatus | undefined {
	return step.fastModeCandidates?.[0]
		?? (step.fastMode
			? {
				requested: true,
				eligible: "unknown",
				active: "unknown",
				...(step.model ? { model: step.model } : {}),
			}
			: undefined);
}

interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	observedMutationAttempt?: boolean;
	sandbox?: SandboxResultDetails;
}

interface RunPiStreamingSandboxInput extends SubagentSandboxMountInput {
	config: ResolvedSandboxConfig;
	isolatedGit?: IsolatedGitWorktree;
	isolatedGitCapability?: import("../../sandbox/isolated-git.ts").IsolatedGitCapability;
	isolatedGitRights?: "read-only" | "writer";
	/** Reserved endpoint subtree for this exact child process. */
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	scopedGitOwnerEndpoint?: ScopedGitEndpointDescriptor;
	scopedGitWriter?: boolean;
}

function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piEntrypointOverride?: string,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
	sandbox?: RunPiStreamingSandboxInput,
	hostGitDiagnostic = false,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		// Authentication below must precede caller-controlled output/package effects.
		let outputStream: fs.WriteStream | undefined;
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		let piSpawnSpec: ReturnType<typeof getPiSpawnCommand> | undefined;
		let spawnSpec: SpawnableInvocation;
		let sandboxDetails: SandboxResultDetails | undefined = sandbox ? sandboxResultDetails(sandbox.config) : undefined;
		// An authorized provider:none launch intentionally runs against host Git;
		// preserve the same prominent warning used by foreground execution.
		if (hostGitDiagnostic || sandbox?.config.provider === "none") {
			const diagnosticConfig = sandbox?.config ?? {
				provider: "none",
				gitMode: "read-only",
				profile: "host",
				network: "host",
				auth: "none",
				fallback: "none",
			} as ResolvedSandboxConfig;
			sandboxDetails = {
				...(sandboxDetails ?? sandboxResultDetails(diagnosticConfig)),
				diagnostics: [
					...(sandboxDetails?.diagnostics ?? []),
					{ level: "warning", message: "NO ISOLATION: this child is using the host checkout and host Git metadata. Changes are not protected by a managed isolated worktree." },
				],
			};
		}
		let effectiveSandboxMounts: ReturnType<typeof buildSubagentSandboxMounts> = [];
		let scopedGitWriterBound = false;
		const cancelScopedWriter = async () => {
			if (!sandbox?.scopedGitWriter || scopedGitWriterBound || !sandbox.scopedGitEndpoint || !sandbox.scopedGitOwnerEndpoint) return;
			try { await cancelScopedGitChildDescriptor(sandbox.scopedGitOwnerEndpoint, sandbox.scopedGitEndpoint); }
			catch { /* A pending reservation remains fail-closed when cancellation is unproven. */ }
		};
		try {
			if (sandbox?.config && resolveGitMode(sandbox.config) === "isolated" && !sandbox.isolatedGit && !sandbox.scopedGitEndpoint) {
				throw new Error("isolated Git requires a runtime-managed isolated worktree handle or scoped endpoint; refusing ordinary checkout execution");
			}
			if (sandbox) {
				// The capability must be present before any caller-controlled resource
				// path participates in mount construction. Owner-held scope and lease
				// checks run before the step endpoint is mounted.
				if (sandbox.isolatedGit && !sandbox.isolatedGitCapability) {
					throw new Error("isolated Git execution requires an explicit runtime-issued capability");
				}
				if (sandbox.isolatedGit && sandbox.isolatedGitCapability) {
					sandbox.isolatedGit.runtime.assertCapability(sandbox.isolatedGitCapability, sandbox.isolatedGit);
				}
				// Authenticated isolated steps may now resolve the executable needed
				// to construct the sandbox command and mounts.
				piSpawnSpec = getPiSpawnCommand(args, {
					...(piPackageRoot ? { piPackageRoot } : {}),
					...(piEntrypointOverride ? { entrypointOverride: piEntrypointOverride } : {}),
					preferNodeCli: true,
				});
				effectiveSandboxMounts = sandbox.isolatedGit
					? buildSubagentSandboxMounts({
						...sandbox,
						includeCwd: false,
						cwd,
						protectedGitPaths: sandbox.isolatedGit.runtime.getProtectedMountPaths(sandbox.isolatedGit),
						extraReadOnlyMounts: sandbox.config.extraReadOnlyMounts,
						extraWritableMounts: sandbox.config.extraWritableMounts,
						spawnCommand: piSpawnSpec!.command,
						spawnArgs: piSpawnSpec!.args,
					})
					: buildSubagentSandboxMounts({
					...sandbox,
					includeCwd: sandbox.scopedGitEndpoint ? false : sandbox.includeCwd,
					extraReadOnlyMounts: sandbox.config.extraReadOnlyMounts,
					extraWritableMounts: sandbox.config.extraWritableMounts,
					spawnCommand: piSpawnSpec!.command,
					spawnArgs: piSpawnSpec!.args,
					});
				if (sandbox.scopedGitEndpoint) effectiveSandboxMounts.push(...scopedGitDescriptorMounts(sandbox.scopedGitEndpoint));
				const wrapped = sandbox.isolatedGit
					? { invocation: sandbox.isolatedGit.runtime.wrapInvocation(sandbox.isolatedGitCapability!, { command: piSpawnSpec!.command, args: piSpawnSpec!.args, cwd }, effectiveSandboxMounts, sandbox.config), diagnostics: [] }
					: createSandboxProvider(sandbox.config).wrapInvocation({
						config: sandbox.config,
						invocation: { command: piSpawnSpec!.command, args: piSpawnSpec!.args, cwd },
						mounts: effectiveSandboxMounts,
					});
				if (wrapped.mounts?.length) {
					const seenDiagnosticMounts = new Set(effectiveSandboxMounts.map((mount) => `${mount.mode}:${mount.source}`));
					for (const mount of wrapped.mounts) {
						const key = `${mount.mode}:${mount.path}`;
						if (seenDiagnosticMounts.has(key)) continue;
						seenDiagnosticMounts.add(key);
						effectiveSandboxMounts.push({ source: mount.path, mode: mount.mode });
					}
				}
				sandboxDetails = sandboxResultDetails(sandbox.config, wrapped);
				spawnSpec = {
					command: wrapped.invocation.command,
					args: wrapped.invocation.args,
					cwd: wrapped.invocation.cwd ?? cwd,
					env: wrapped.invocation.env ?? spawnEnv,
				};
			} else {
				// No-sandbox execution still needs the resolved Pi command. The
				// sandbox branch initializes this before mount construction, but an
				// omitted sandbox used to dereference an undefined spawn spec here.
				piSpawnSpec = getPiSpawnCommand(args, {
					...(piPackageRoot ? { piPackageRoot } : {}),
					...(piEntrypointOverride ? { entrypointOverride: piEntrypointOverride } : {}),
					preferNodeCli: true,
				});
				spawnSpec = { command: piSpawnSpec.command, args: piSpawnSpec.args, cwd, env: spawnEnv };
			}
		} catch (setupError) {
			const message = setupError instanceof Error ? setupError.message : String(setupError);
			cancelScopedWriter();
			cleanupTempDir(sandbox?.tempDir);
			outputStream?.end();
			resolve({
				stderr: message,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				error: `Sandbox setup failed: ${message}`,
				finalOutput: "",
				...(sandboxDetails ? { sandbox: sandboxDetails } : {}),
			});
			return;
		}
		// Resolve the package executable only after the inherited capability and
		// all authenticated mount construction have succeeded.
		try {
			piSpawnSpec = getPiSpawnCommand(args, {
				...(piPackageRoot ? { piPackageRoot } : {}),
				...(piEntrypointOverride ? { entrypointOverride: piEntrypointOverride } : {}),
				preferNodeCli: true,
			});
		} catch (resolveError) {
			const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
			cancelScopedWriter();
			cleanupTempDir(sandbox?.tempDir);
			resolve({ stderr: message, exitCode: 1, messages: [], usage: emptyUsage(), error: message, finalOutput: "", ...(sandboxDetails ? { sandbox: sandboxDetails } : {}) });
			return;
		}
		const processControlError = processControlUnsupported();
		if (processControlError) {
			cancelScopedWriter();
			cleanupTempDir(sandbox?.tempDir);
			outputStream?.end();
			resolve({
				stderr: processControlError,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				error: processControlError,
				finalOutput: "",
				...(sandboxDetails ? { sandbox: sandboxDetails } : {}),
			});
			return;
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: spawnSpec.cwd ?? cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: spawnSpec.env ?? spawnEnv,
				// Give every subagent its own process group so interruption also
				// terminates Bubblewrap, shells, and tool descendants.
				detached: process.platform === "linux",
				windowsHide: true,
			});
		} catch (spawnError) {
			cancelScopedWriter();
			cleanupTempDir(sandbox?.tempDir);
			resolve({ stderr: String(spawnError), exitCode: 1, messages: [], usage: emptyUsage(), error: spawnError instanceof Error ? spawnError.message : String(spawnError), finalOutput: "" });
			return;
		}
		let scopedGitBindError: string | undefined;
		let scopedGitBindingReady = !Boolean(sandbox?.scopedGitWriter && sandbox.scopedGitEndpoint);
		let pendingScopedClose: { kind: "close"; exitCode: number | null; signal?: NodeJS.Signals } | { kind: "error"; error: Error } | undefined;
		if (sandbox?.scopedGitWriter && sandbox.scopedGitEndpoint) {
			// Bind only after the spawned wrapper has a stable /proc identity. Hold
			// terminal publication until exact bind and release proof complete.
			void (async () => {
				let identity;
				let previousKey: string | undefined;
				try {
					for (let attempt = 0; attempt < 150 && !identity; attempt += 1) {
						const current = readScopedGitProcessIdentity(child.pid!);
						const key = current && `${current.startToken}:${current.ppid}:${current.pgid}:${current.argv.join("\\0")}`;
						if (current && key === previousKey) identity = current;
						previousKey = key;
						if (!identity) await new Promise((resolve) => setTimeout(resolve, 2));
					}
					if (!identity) throw new Error("exact child identity was not observed before process exit");
					await delegateScopedGitWriterDescriptor(sandbox.scopedGitEndpoint, identity);
					scopedGitWriterBound = true;
					await waitForScopedGitProcessGone(identity);
					if (sandbox.scopedGitOwnerEndpoint) await waitForScopedGitChildRelease(sandbox.scopedGitOwnerEndpoint, sandbox.scopedGitEndpoint);
				} catch (error) {
					if (!scopedGitWriterBound) await cancelScopedWriter();
					// The terminal result is completed below with this diagnostic.
					scopedGitBindError = `Scoped Git writer teardown was not proven: ${error instanceof Error ? error.message : String(error)}`;
				} finally {
					scopedGitBindingReady = true;
					if (pendingScopedClose) {
						const pending = pendingScopedClose;
						pendingScopedClose = undefined;
						if (pending.kind === "close") child.emit("close", pending.exitCode, pending.signal);
						else child.emit("error", pending.error);
					}
				}
			})();
		}
		// Opening output is intentionally last: rejected inherited authority cannot
		// create or truncate the caller-selected output path.
		outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let observedMutationAttempt = false;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream!.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			let journalEvent = event;
			if (event.type === "message_update") {
				// Pi emits the entire accumulated message in both `message` and `partial`
				// with every token delta. Deltas plus message_end retain the event history.
				const { message: _message, ...compactMessageUpdate } = event;
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent && typeof assistantEvent === "object" && !Array.isArray(assistantEvent)) {
					const { partial: _partial, ...compactAssistantEvent } = assistantEvent as Record<string, unknown>;
					journalEvent = { ...compactMessageUpdate, assistantMessageEvent: compactAssistantEvent };
				} else {
					journalEvent = compactMessageUpdate;
				}
			} else if (event.type === "tool_execution_update") {
				// Tool updates repeat fixed args and accumulated output snapshots. The start/end
				// events carry those payloads; keep only update identity in the journal.
				const { args: _args, partialResult: _partialResult, ...compactToolUpdate } = event;
				journalEvent = compactToolUpdate;
			}
			appendJsonl(childEventContext.eventsPath, JSON.stringify({
				...journalEvent,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}));
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				if (stopReason === "stop" && !hasToolCall) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					startFinalDrain();
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream!.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		// Guard both cases that can leave the parent waiting on `close` forever:
		// a lingering stdio holder after `exit`, or a child that never exits.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let interruptTermTimer: NodeJS.Timeout | undefined;
		let interruptKillTimer: NodeJS.Timeout | undefined;
		let interruptKillExecuted = false;
		let mandatoryKillExecuted = false;
		let pendingTerminalClose: { kind: "close" | "error"; exitCode?: number | null; signal?: NodeJS.Signals; error?: Error } | undefined;
		let teardownPollTimer: NodeJS.Timeout | undefined;
		let teardownFailure: string | undefined;
		let settled = false;
		const clearStdioGuard = attachPostExitStdioGuard(child, {
			idleMs: 2000,
			hardMs: 8000,
			killProcessGroupOnCutoff: process.platform === "linux",
			onHardCutoff: () => { mandatoryKillExecuted = true; },
			onTeardownFailure: (reason) => {
				teardownFailure = reason;
				forcedTerminationSignal = true;
				if (sandbox?.isolatedGit) {
					// Synthetic close is only a publication escape hatch. Fence first so
					// isolated export/cleanup cannot delete a runtime with unknown heirs.
					sandbox.isolatedGit.runtime.markExportFenceFailed();
					const recovery = `Subagent teardown failed before isolated Git cleanup could be proven; recover isolated worktree at ${sandbox.isolatedGit.runtime.root}`;
					error = error ? `${error}\n${recovery}` : recovery;
				}
				error ??= `Subagent teardown failed closed: ${reason}. Runtime evidence is retained for recovery.`;
				// The hard cutoff is bounded even when the private group cannot be
				// proven gone. Re-enter the normal terminal path so callers receive a
				// failed/incomplete result instead of an unbounded close poll.
				queueMicrotask(() => child.emit("close", 1, "SIGKILL"));
			},
		});
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		registerInterrupt?.(() => {
			if (settled) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			signalChildProcessGroup(child, "SIGINT");
			if (!interruptTermTimer) {
				interruptTermTimer = setTimeout(() => {
					interruptTermTimer = undefined;
					if (settled) return;
					signalChildProcessGroup(child, "SIGTERM");
					// The child owns a private process group. If it ignores both
					// graceful signals, force-kill that group rather than leaving
					// Bubblewrap/shell descendants running indefinitely.
					interruptKillTimer = setTimeout(() => {
						interruptKillTimer = undefined;
						if (settled) return;
						interruptKillExecuted = true;
						mandatoryKillExecuted = true;
						signalChildProcessGroup(child, "SIGKILL");
					}, 2000);
					interruptKillTimer.unref?.();
				}, 1000);
				interruptTermTimer.unref?.();
			}
		});
		const clearDrainTimers = () => {
			if (teardownPollTimer) {
				clearInterval(teardownPollTimer);
				teardownPollTimer = undefined;
			}
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
			if (interruptTermTimer) {
				clearTimeout(interruptTermTimer);
				interruptTermTimer = undefined;
			}
			if (interruptKillTimer) {
				clearTimeout(interruptKillTimer);
				interruptKillTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = signalChildProcessGroup(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || isChildProcessGroupGone(child)) return;
					mandatoryKillExecuted = true;
					forcedTerminationSignal = signalChildProcessGroup(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		child.on("exit", () => {
			childExited = true;
			// Preserve owed interrupt/final-drain escalation; wrapper exit is not
			// proof that the detached process group has disappeared.
			if (!interrupted && !finalDrainTimer && !finalHardKillTimer) clearDrainTimers();
		});
		const attachFailureDiagnostics = (message?: string): void => {
			if (!sandboxDetails || !sandbox) return;
			const diagnostics = diagnoseSandboxFailure({
				stderr,
				error: message,
				mounts: effectiveSandboxMounts,
				cwd,
			});
			if (diagnostics.length === 0) return;
			sandboxDetails = {
				...sandboxDetails,
				diagnostics: [...(sandboxDetails.diagnostics ?? []), ...diagnostics],
			};
		};

		child.on("close", (exitCode, signal) => {
			if (settled) return;
			if (!scopedGitBindingReady) {
				pendingScopedClose ??= { kind: "close", exitCode, signal: signal ?? undefined };
				return;
			}
			// A close event only proves the wrapper streams closed. Keep the
			// escalation timer alive until the private group is absent or KILL has
			// executed, then replay this terminal event through the normal path.
			if (process.platform === "linux" && !isChildProcessGroupGone(child) && !teardownFailure) {
				pendingTerminalClose ??= { kind: "close", exitCode, signal: signal ?? undefined };
				if (!teardownPollTimer) {
					teardownPollTimer = setInterval(() => {
						if (settled || !pendingTerminalClose) return;
						if (!isChildProcessGroupGone(child)) return;
						const pending = pendingTerminalClose;
						pendingTerminalClose = undefined;
						if (teardownPollTimer) clearInterval(teardownPollTimer);
						teardownPollTimer = undefined;
						child.emit("close", pending.exitCode, pending.signal);
					}, 25);
					teardownPollTimer.unref?.();
				}
				return;
			}
			pendingTerminalClose = undefined;
			// A child that exited before writer binding cannot retain authority;
			// cancel its pending reservation only after the private group fence.
			cancelScopedWriter();
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream?.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const finalError = error ?? assistantError ?? scopedGitBindError;
			if ((exitCode ?? 0) !== 0 || finalError) attachFailureDiagnostics(finalError);
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			resolve({
				stderr,
				teardownUnproven: Boolean(teardownFailure || scopedGitBindError),
				exitCode: teardownFailure ? 1 : interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: teardownFailure ? finalError : interrupted ? (error ?? "Interrupted. Waiting for explicit next action.") : forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput,
				interrupted: teardownFailure ? undefined : interrupted,
				observedMutationAttempt,
				...(sandboxDetails ? { sandbox: sandboxDetails } : {}),
			});
		});

		child.on("error", (spawnError) => {
			if (settled) return;
			if (!scopedGitBindingReady) {
				pendingScopedClose ??= { kind: "error", error: spawnError instanceof Error ? spawnError : new Error(String(spawnError)) };
				return;
			}
			if (process.platform === "linux" && !isChildProcessGroupGone(child) && !teardownFailure) {
				pendingTerminalClose ??= { kind: "error", error: spawnError };
				if (!teardownPollTimer) {
					teardownPollTimer = setInterval(() => {
						if (settled || !pendingTerminalClose) return;
						if (!isChildProcessGroupGone(child)) return;
						const pending = pendingTerminalClose;
						pendingTerminalClose = undefined;
						if (teardownPollTimer) clearInterval(teardownPollTimer);
						teardownPollTimer = undefined;
						if (pending.kind === "error") child.emit("error", pending.error);
						else child.emit("close", pending.exitCode, pending.signal);
					}, 25);
					teardownPollTimer.unref?.();
				}
				return;
			}
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			outputStream?.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			attachFailureDiagnostics(spawnErrorMessage);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: error ?? assistantError ?? scopedGitBindError ?? spawnErrorMessage, finalOutput, observedMutationAttempt, ...(scopedGitBindError ? { teardownUnproven: true } : {}), ...(sandboxDetails ? { sandbox: sandboxDetails } : {}) });
		});
	});
}

function resolvePiPackageRootFallback(): string {
	const root = resolveInstalledPiPackageRoot();
	if (root) return root;
	throw new Error(`Could not resolve ${PI_CHILD_RUNTIME_PACKAGE} package root`);
}

async function exportSessionHtml(sessionFile: string, outputDir: string, piPackageRoot?: string): Promise<string> {
	const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
	const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
	const moduleUrl = pathToFileURL(exportModulePath).href;
	const mod = await import(moduleUrl);
	const exportFromFile = (mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string })
		.exportFromFile;
	if (typeof exportFromFile !== "function") {
		throw new Error("exportFromFile not available");
	}
	const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
	return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(htmlPath: string): { shareUrl: string; gistUrl: string } | { error: string } {
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
		if (result.status !== 0) {
			const err = (result.stderr || "").trim() || "Failed to create gist.";
			return { error: err };
		}
		const gistUrl = (result.stdout || "").trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) return { error: "Failed to parse gist ID." };
		const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
		return { shareUrl, gistUrl };
	} catch (err) {
		return { error: String(err) };
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m${seconds}s`;
}

function writeRunLog(
	logPath: string,
	input: {
		id: string;
		mode: SubagentRunMode;
		cwd: string;
		startedAt: number;
		endedAt: number;
		steps: Array<{
			agent: string;
			status: string;
			durationMs?: number;
			sandbox?: SandboxResultDetails;
		}>;
		summary: string;
		truncated: boolean;
		artifactsDir?: string;
		sessionFile?: string;
		shareUrl?: string;
		shareError?: string;
	},
): void {
	const lines: string[] = [];
	lines.push(`# Subagent run ${input.id}`);
	lines.push("");
	lines.push(`- **Mode:** ${input.mode}`);
	lines.push(`- **CWD:** ${input.cwd}`);
	lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
	lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
	lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
	if (input.sessionFile) lines.push(`- **Session:** ${input.sessionFile}`);
	if (input.shareUrl) lines.push(`- **Share:** ${input.shareUrl}`);
	if (input.shareError) lines.push(`- **Share error:** ${input.shareError}`);
	if (input.artifactsDir) lines.push(`- **Artifacts:** ${input.artifactsDir}`);
	lines.push("");
	lines.push("## Steps");
	lines.push("| Step | Agent | Status | Duration |");
	lines.push("| --- | --- | --- | --- |");
	input.steps.forEach((step, i) => {
		const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
		lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
	});
	const sandboxSteps = input.steps
		.map((step, index) => ({ ...step, index }))
		.filter((step) => step.sandbox);
	if (sandboxSteps.length > 0) {
		lines.push("");
		lines.push("## Sandbox diagnostics");
		for (const step of sandboxSteps) {
			const sandbox = step.sandbox!;
			lines.push(`- Step ${step.index + 1} (${step.agent}): provider=${sandbox.provider}, profile=${sandbox.profile}, network=${sandbox.network}, auth=${sandbox.auth}, fallback=${sandbox.fallbackMode}, fallbackOccurred=${sandbox.fallbackOccurred}`);
			for (const diagnostic of sandbox.diagnostics ?? []) lines.push(`  - ${diagnostic.level}: ${diagnostic.message}`);
			if (sandbox.mounts?.length) {
				const summary = sandbox.mounts.map((mount) => `${mount.mode}:${mount.path}`).join(", ");
				lines.push(`  - mounts: ${summary}`);
			}
		}
	}
	lines.push("");
	lines.push("## Summary");
	if (input.truncated) {
		lines.push("_Output truncated_");
		lines.push("");
	}
	lines.push(input.summary.trim() || "(no output)");
	lines.push("");
	fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}

/** Context for running a single step */
interface SingleStepContext {
	previousOutput: string;
	outputs?: ChainOutputMap;
	placeholder: string;
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	piPackageRoot?: string;
	piEntrypointOverride?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	sandbox?: ResolvedSandboxConfig;
	/** Explicit authorized provider:none diagnostic; not an execution authority. */
	hostGitDiagnostic?: boolean;
	isolatedGit?: IsolatedGitWorktree;
	isolatedGitCapability?: import("../../sandbox/isolated-git.ts").IsolatedGitCapability;
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	scopedGitOwnerEndpoint?: ScopedGitEndpointDescriptor;
	scopedGitWriter?: boolean;
	isolatedGitRights?: "read-only" | "writer";
	/** Sequential chains export their shared context only at outer finalization. */
	deferIsolatedGitExport?: boolean;
	progressPaths?: string[];
	sandboxIntercomBridge?: SandboxIntercomBridge;
	onAttemptStart?: (attempt: { model?: string; thinking?: string }) => void;
	onChildEvent?: (event: ChildEvent) => void;
}

/** Run a single pi agent step, returning output and metadata. */
async function runSingleStepInner(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	flatIndex: number;
	agent: string;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	teardownUnproven?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	outputMode?: "inline" | "file-only";
	savedOutputPath?: string;
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
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
		terminationState?: "success" | "failure" | "timeout" | "cancelled" | "execution-rejected" | "interrupted" | "unknown";
		incomplete?: boolean;
		dirtySummary?: string;
		bundleSize?: number;
		payloadChecksum?: string;
		canonicalPayloadChecksum?: string;
		canonicalPayloadSize?: number;
		portableMetadata?: string;
		payloadSize?: number;
	};
}> {
	// Authenticate before resolving step cwd, package resources, structured
	// output paths, or assembling any mount candidates. A forged or stale
	// endpoint descriptor must have no mount-side effects.
	if (ctx.isolatedGit) {
		if (!ctx.isolatedGitCapability) throw new Error("isolated Git execution requires an explicit runtime-issued capability");
		ctx.isolatedGit.runtime.assertCapability(ctx.isolatedGitCapability, ctx.isolatedGit);
		ctx.isolatedGit.runtime.authorizeRequestedCwd(ctx.isolatedGitCapability, step.cwd ?? ctx.cwd);
	}
	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	// Reserve inherited endpoint scope before any artifact, output, session, or
	// sandbox setup side effects. A stale/forged descriptor therefore fails at
	// the authority boundary rather than after creating caller-visible files.
	let effectiveScopedGitEndpoint = ctx.scopedGitEndpoint;
	if (ctx.scopedGitEndpoint) {
		effectiveScopedGitEndpoint = await reserveScopedGitChildDescriptor(ctx.scopedGitEndpoint, {
			cwd: step.cwd ?? ctx.cwd,
			rights: ctx.isolatedGitRights ?? "writer",
		});
	}

	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
	}

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	const effectiveSandbox = step.sandbox ?? ctx.sandbox;
	const stepCwd = step.cwd ?? ctx.cwd;
	const executionCwd = ctx.isolatedGit ? mapIsolatedGitCwd(ctx.isolatedGit, stepCwd) : stepCwd;
	// Every nested child receives a fresh endpoint subtree. The writer subtree
	// was reserved above, before caller-visible setup; read-only siblings can be
	// issued independently without consuming the lease.
	const projectLocalPackageResources = effectiveSandbox?.packageDiscovery === "project-local"
		? resolveProjectLocalPiPackageResources(stepCwd)
		: undefined;
	const closedSandboxRuntime = Boolean(effectiveSandbox && effectiveSandbox.packageDiscovery !== "ambient");
	const effectiveSystemPrompt = appendSavedOutputSystemPrompt(step.systemPrompt, {
		outputPath: step.outputPath,
		savedOutputPath: step.savedOutputPath,
	});
	const sandboxIntercomBridgeApplies = effectiveSystemPrompt.includes(INTERCOM_BRIDGE_MARKER);
	const buildSandboxInput = (input: { args: string[]; tempDir?: string; sessionDir?: string; sessionFile?: string; outputFile: string; structuredOutput?: { schemaPath?: string; outputPath?: string } }): RunPiStreamingSandboxInput | undefined => {
		const sandbox = effectiveSandbox;
		if (!sandbox) return undefined;
		return {
			config: sandbox,
			isolatedGit: ctx.isolatedGit,
			isolatedGitCapability: ctx.isolatedGitCapability,
			isolatedGitRights: ctx.isolatedGitRights,
			scopedGitEndpoint: effectiveScopedGitEndpoint,
			...(ctx.scopedGitEndpoint ? { scopedGitOwnerEndpoint: ctx.scopedGitEndpoint, scopedGitWriter: ctx.isolatedGitRights !== "read-only" } : {}),
			cwd: executionCwd,
			cwdMode: inferSandboxCwdWritable({
				agentName: step.agent,
				tools: step.tools,
				sandbox,
			}) ? "rw" : "ro",
			gitMode: sandbox.gitMode,
			...(ctx.scopedGitEndpoint ? { includeCwd: false } : {}),
			tempDir: input.tempDir,
			sessionDir: input.sessionDir,
			sessionFile: input.sessionFile,
			artifactsDir: ctx.artifactsDir,
			jsonlPath: input.outputFile,
			outputPath: step.outputPath,
			progressPaths: ctx.progressPaths,
			statusPaths: [path.join(path.dirname(input.outputFile), "status.json"), eventsPath],
			structuredOutput: input.structuredOutput,
			piArgs: input.args,
			packageRoots: projectLocalPackageResources?.packageRoots,
			authMode: sandbox.auth,
			intercomStateDir: sandbox.packageDiscovery !== "ambient" && sandboxIntercomBridgeApplies ? ctx.sandboxIntercomBridge?.stateDir : undefined,
			nestedRoute: ctx.nestedRoute,
		};
	};
	let finalResult: RunPiStreamingResult | undefined;
	let finalFastModeStatus: FastModeStatus | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const fastModeStatus = step.fastModeCandidates?.[index] ?? (step.fastMode ? { requested: true, eligible: "unknown", active: "unknown", ...(candidate ? { model: candidate } : {}) } : undefined);
		finalFastModeStatus = fastModeStatus;
		ctx.onAttemptStart?.({ model: candidate, thinking: resolveCandidateLaunchThinking(candidate, step.thinking) });
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const { args, env, tempDir } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			fastMode: shouldRequestFastMode(fastModeStatus),
			thinking: resolveCandidateLaunchThinking(candidate, step.thinking),
			inheritProjectContext: step.inheritProjectContext,
			inheritSkills: step.inheritSkills,
			tools: step.tools,
			extensions: step.extensions,
			packageExtensions: projectLocalPackageResources?.extensions,
			systemPrompt: effectiveSystemPrompt,
			systemPromptMode: step.systemPromptMode,
			mcpDirectTools: step.mcpDirectTools,
			cwd: executionCwd,
			promptFileStem: step.agent,
			intercomSessionName: ctx.childIntercomTarget,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
			parentEventSink: ctx.nestedRoute?.eventSink,
			parentControlInbox: ctx.nestedRoute?.controlInbox,
			parentRootRunId: ctx.nestedRoute?.rootRunId,
			parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
			scopedGitEndpoint: effectiveScopedGitEndpoint ?? (ctx.isolatedGit?.runtime && ctx.isolatedGitCapability
				? ctx.isolatedGit.runtime.getScopedGitEndpointDescriptor(ctx.isolatedGitCapability)
				: undefined),
			structuredOutput: effectiveStructuredOutput,
			sandbox: closedSandboxRuntime,
			sandboxIntercomExtensionDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? ctx.sandboxIntercomBridge?.extensionDir : undefined,
			sandboxIntercomStateDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? ctx.sandboxIntercomBridge?.stateDir : undefined,
		});
		let run: RunPiStreamingResult;
		try {
			run = await runPiStreaming(
			args,
			executionCwd,
			ctx.outputFile,
			env,
			ctx.piPackageRoot,
			ctx.piEntrypointOverride,
			step.maxSubagentDepth,
			{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			ctx.registerInterrupt,
			ctx.onChildEvent,
			buildSandboxInput({ args, tempDir, sessionDir, sessionFile: step.sessionFile, outputFile: ctx.outputFile, structuredOutput: effectiveStructuredOutput }),
			ctx.hostGitDiagnostic === true,
			);
		} finally {
			// runPiStreaming resolves only after child/group teardown; its finally
			// also covers spawn/setup rejection and interrupt paths.
			cleanupTempDir(tempDir);
		}
		if (process.env[TEST_REJECT_AFTER_CHILD_ENV] === ctx.id) {
			throw new Error("test callback rejection after child completion");
		}

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError) {
			const structured = readStructuredOutput({
				schema: effectiveStructuredOutput.schema,
				schemaPath: effectiveStructuredOutput.schemaPath,
				outputPath: effectiveStructuredOutput.outputPath,
			});
			if (structured.error) structuredError = structured.error;
			else structuredOutput = structured.value;
		}
		const effectiveExitCode = structuredError
			? 1
			: hiddenError?.hasError
			? (hiddenError.exitCode ?? 1)
			: run.error && run.exitCode === 0
				? 1
				: run.exitCode;
		const error = structuredError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			fastMode: fastModeStatus,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		finalOutputSnapshot = outputSnapshot;
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput } as RunPiStreamingResult & { structuredOutput?: unknown };
		if (attempt.success) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	let savedOutputPath = step.outputMode === "file-only" ? resolvedOutput.savedPath : undefined;
	let savedOutputContent = output;
	let outputSaveError = resolvedOutput.saveError;
	if (step.savedOutputPath && (finalResult?.exitCode ?? 1) === 0) {
		try {
			const saved = writeSavedOutput({
				targetPath: step.savedOutputPath,
				agent: step.agent,
				runId: ctx.id,
				index: ctx.flatIndex,
				content: output,
			});
			if (!savedOutputPath) {
				savedOutputPath = saved.savedPath;
				savedOutputContent = saved.savedContent;
			}
		} catch (error) {
			outputSaveError = `Failed to save output history: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (!savedOutputPath && resolvedOutput.savedPath) {
		savedOutputPath = resolvedOutput.savedPath;
		savedOutputContent = output;
	}
	const announceSavedOutput = Boolean(step.outputPath) || step.outputMode === "file-only";
	const outputReference = savedOutputPath ? formatSavedOutputReference(savedOutputPath, savedOutputContent) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	const outputForAcceptance = rawOutput;
	const finalizedOutput = finalizeSingleOutput({
		fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: savedOutputPath,
		outputReference,
		saveError: outputSaveError,
		announceSavedPath: announceSavedOutput,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const acceptanceForInitialReport = step.effectiveAcceptance && shouldRunAcceptanceFinalization(step.effectiveAcceptance)
		? acceptanceSelfReviewConfig(step.effectiveAcceptance)
		: step.effectiveAcceptance;
	let acceptance = acceptanceForInitialReport
		? await evaluateAcceptance({
			acceptance: acceptanceForInitialReport,
			output: outputForAcceptance,
			cwd: executionCwd,
		})
		: undefined;
	if (acceptance && step.effectiveAcceptance && shouldRunAcceptanceFinalization(step.effectiveAcceptance) && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted) {
		const sessionFile = step.sessionFile ?? (sessionDir ? findLatestSessionFile(sessionDir) ?? undefined : undefined);
		const maxTurns = step.effectiveAcceptance.finalization.maxTurns;
		const turns: AcceptanceFinalizationTurn[] = [];
		if (!sessionFile) {
			const message = "Acceptance finalization requires a session file for same-session continuation.";
			turns.push(createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message }));
			acceptance = buildFinalizationProcessFailureLedger({ initialLedger: acceptance, turns, maxTurns, message });
		} else {
			const selfReviewAcceptance = acceptanceSelfReviewConfig(step.effectiveAcceptance);
			let previousFailure = acceptanceFailureMessage(acceptance);
			let authoritativeLedger = acceptance;
			for (let turn = 1; turn <= maxTurns; turn++) {
				const prompt = formatAcceptanceFinalizationPrompt({
					acceptance: step.effectiveAcceptance,
					initialOutput: outputForAcceptance,
					initialLedger: acceptance,
					turn,
					maxTurns,
					...(previousFailure ? { previousFailure } : {}),
				});
				// Keep the configured provider-qualified candidate for continuation;
				// child telemetry may report only the provider-local model id.
				const finalizationModel = modelAttempts.find((attempt) => attempt.success)?.model
					?? attemptedModels.at(-1)
					?? step.model
					?? finalResult?.model;
				const { args, env, tempDir } = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: prompt,
					sessionEnabled: true,
					sessionFile,
					model: finalizationModel,
					fastMode: shouldRequestFastMode(step.fastModeCandidates?.find((status) => status?.model === finalizationModel)),
					thinking: resolveCandidateLaunchThinking(finalizationModel, step.thinking),
					inheritProjectContext: step.inheritProjectContext,
					inheritSkills: step.inheritSkills,
					tools: step.tools,
					extensions: step.extensions,
					packageExtensions: projectLocalPackageResources?.extensions,
					systemPrompt: effectiveSystemPrompt,
					systemPromptMode: step.systemPromptMode,
					mcpDirectTools: step.mcpDirectTools,
					cwd: executionCwd,
					promptFileStem: `${step.agent}-acceptance-finalization`,
					intercomSessionName: ctx.childIntercomTarget,
					orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
					runId: ctx.id,
					childAgentName: step.agent,
					childIndex: ctx.flatIndex,
					parentEventSink: ctx.nestedRoute?.eventSink,
					parentControlInbox: ctx.nestedRoute?.controlInbox,
					parentRootRunId: ctx.nestedRoute?.rootRunId,
					parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
					scopedGitEndpoint: effectiveScopedGitEndpoint ?? (ctx.isolatedGit?.runtime && ctx.isolatedGitCapability
						? ctx.isolatedGit.runtime.getScopedGitEndpointDescriptor(ctx.isolatedGitCapability)
						: undefined),
					sandbox: closedSandboxRuntime,
				});
				ctx.onAttemptStart?.({ model: finalizationModel, thinking: resolveCandidateLaunchThinking(finalizationModel, step.thinking) });
				const finalizationOutputFile = `${ctx.outputFile}.finalization-${turn}.log`;
				let finalizationRun: RunPiStreamingResult;
				try {
					finalizationRun = await runPiStreaming(
					args,
					executionCwd,
					finalizationOutputFile,
					env,
					ctx.piPackageRoot,
					ctx.piEntrypointOverride,
					step.maxSubagentDepth,
					{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
					ctx.registerInterrupt,
					ctx.onChildEvent,
					buildSandboxInput({ args, tempDir, sessionFile, outputFile: finalizationOutputFile }),
					ctx.hostGitDiagnostic === true,
					);
				} finally {
					cleanupTempDir(tempDir);
				}
				modelAttempts.push({
					model: finalizationModel ?? finalizationRun.model ?? "default",
					success: finalizationRun.exitCode === 0 && !finalizationRun.error,
					fastMode: step.fastModeCandidates?.find((status) => status?.model === finalizationModel),
					exitCode: finalizationRun.exitCode,
					error: finalizationRun.error,
					usage: finalizationRun.usage,
				});
				const finalizationOutput = finalizationRun.finalOutput;
				if (finalizationRun.error || finalizationRun.interrupted || (finalizationRun.exitCode !== 0 && !finalizationOutput.trim())) {
					const message = finalizationRun.error ?? "Acceptance finalization turn did not complete successfully.";
					turns.push(createFinalizationProcessFailureTurn({ turn, prompt, rawOutput: finalizationOutput, message }));
					acceptance = buildFinalizationProcessFailureLedger({ initialLedger: acceptance, turns, maxTurns, message });
					break;
				}
				const selfReviewLedger = await evaluateAcceptance({
					acceptance: selfReviewAcceptance,
					output: finalizationOutput,
					cwd: executionCwd,
				});
				authoritativeLedger = selfReviewLedger;
				turns.push(createFinalizationTurn({ turn, prompt, rawOutput: finalizationOutput, ledger: selfReviewLedger }));
				const failure = acceptanceFailureMessage(selfReviewLedger);
				if (!failure) {
					authoritativeLedger = step.effectiveAcceptance === selfReviewAcceptance
						? selfReviewLedger
						: await evaluateAcceptance({
							acceptance: step.effectiveAcceptance,
							output: finalizationOutput,
							cwd: executionCwd,
						});
					acceptance = attachFinalizationToLedger({ initialLedger: acceptance, authoritativeLedger, turns, status: "completed", maxTurns });
					break;
				}
				previousFailure = failure;
				if (turn === maxTurns) acceptance = attachFinalizationToLedger({ initialLedger: acceptance, authoritativeLedger, turns, status: "failed", maxTurns });
			}
		}
	}
	const acceptanceFailure = acceptance ? acceptanceFailureMessage(acceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && acceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted;
	let gitBundle: {
		path: string;
		checksum: string;
		base: string;
		head: string;
		commitSummary: string;
		recovery?: string;
		stagedSnapshot?: string;
		stagedTree?: string;
		recoveryTree?: string;
		terminationState?: "success" | "failure" | "timeout" | "cancelled" | "execution-rejected" | "interrupted" | "unknown";
		incomplete?: boolean;
		dirtySummary?: string;
		bundleSize?: number;
		payloadChecksum?: string;
		canonicalPayloadChecksum?: string;
		canonicalPayloadSize?: number;
		portableMetadata?: string;
		payloadSize?: number;
	} | undefined;
	if (ctx.isolatedGit && !ctx.deferIsolatedGitExport && !isInheritedIsolatedGitRuntime(ctx.isolatedGit.runtime)) {
		const nestedFence = await waitForNestedDescendantsToStop(ctx.nestedRoute, ctx.id, ctx.flatIndex);
		if (!nestedFence.stopped) {
			ctx.isolatedGit.runtime.markExportFenceFailed();
			const recovery = `Nested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktree at ${ctx.isolatedGit.runtime.root}`;
			if (finalResult) {
				finalResult.teardownUnproven = true;
				finalResult.exitCode = finalResult.exitCode === 0 ? 1 : finalResult.exitCode;
				finalResult.error = finalResult.error ? `${finalResult.error}\n${recovery}` : recovery;
			} else {
				return { flatIndex: ctx.flatIndex, agent: step.agent, output: outputForSummary, exitCode: 1, error: recovery, teardownUnproven: true, model: finalResult?.model, acceptance };
			}
		}
		const terminationState = finalResult?.interrupted
			? "interrupted"
			: acceptanceCanFailRun || (finalResult?.exitCode ?? 1) !== 0 || Boolean(finalResult?.error)
				? /timeout|timed out/i.test(finalResult?.error ?? "") ? "timeout" : "failure"
				: "success";
		try {
			if (!nestedFence.stopped) {
				// The runtime is deliberately retained until descendants publish a
				// terminal event; stdio closure is not a stop proof.
				throw new Error(`nested export fence timed out; recover isolated worktree at ${ctx.isolatedGit.runtime.root}`);
			}
			const bundle = exportIsolatedGitBundle(ctx.isolatedGit.runtime, {
				outputDir: ctx.artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
				worktree: ctx.isolatedGit,
				syntheticPaths: ctx.isolatedGit.syntheticPaths,
				terminationState,
				agent: step.agent,
				commitRequired: resolveCapabilityRights({
					packagedRole: resolvePackagedAgentRole(step.agent, step.source),
					agentTools: step.tools,
					sandbox: step.sandbox ?? ctx.sandbox,
					taskMutationProhibited: taskDisallowsFileUpdates(step.task),
					parentRights: ctx.isolatedGitCapability?.rights,
					writableCwd: inferSandboxCwdWritable({ agentName: step.agent, tools: step.tools, sandbox: step.sandbox ?? ctx.sandbox }),
					exclusiveLease: true,
				}) === "writer",
			});
			gitBundle = {
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
			const requiresAuthoredCommit = resolveCapabilityRights({
			packagedRole: resolvePackagedAgentRole(step.agent, step.source),
			agentTools: step.tools,
			sandbox: step.sandbox ?? ctx.sandbox,
			taskMutationProhibited: taskDisallowsFileUpdates(step.task),
			parentRights: ctx.isolatedGitCapability?.rights,
			writableCwd: inferSandboxCwdWritable({ agentName: step.agent, tools: step.tools, sandbox: step.sandbox ?? ctx.sandbox }),
			exclusiveLease: true,
		}) === "writer";
			if (bundle.incomplete && requiresAuthoredCommit && !finalResult?.error) {
				if (finalResult) {
					finalResult.exitCode = 1;
					finalResult.error = "Isolated writer completed without a required authored commit; recovery bundle is incomplete.";
					delete finalResult.interrupted;
					delete finalResult.cancelled;
				}
			}
		} catch (error) {
			ctx.isolatedGit.runtime.markExportFailed();
			const exportError = `Isolated Git bundle export failed; recover isolated worktree at ${ctx.isolatedGit.runtime.root}: ${error instanceof Error ? error.message : String(error)}`;
			if (finalResult) {
				finalResult.error = finalResult.error ? `${finalResult.error}\n${exportError}` : exportError;
				if (finalResult.exitCode === 0) finalResult.exitCode = 1;
				delete finalResult.interrupted;
				delete finalResult.cancelled;
			} else {
				return { flatIndex: ctx.flatIndex, agent: step.agent, output: outputForSummary, exitCode: 1, error: exportError, model: finalResult?.model, acceptance };
			}
		}
	}
	const effectiveFinalExitCode = acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const effectiveFinalError = acceptanceCanFailRun
		? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
		: finalResult?.error;

	if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify({
					runId: ctx.id,
					agent: step.agent,
					task,
					exitCode: effectiveFinalExitCode,
					model: finalResult?.model,
					fastMode: finalFastModeStatus,
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}

	return {
		flatIndex: ctx.flatIndex,
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		thinking: resolveCandidateLaunchThinking(finalResult?.model, step.thinking),
		fastMode: finalFastModeStatus,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
		interrupted: finalResult?.interrupted,
		teardownUnproven: finalResult?.teardownUnproven,
		outputMode: step.outputMode,
		savedOutputPath,
		savedOutputAnnounced: announceSavedOutput,
		outputReference,
		outputSaveError,
		structuredOutput: (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: effectiveStructuredOutput?.schemaPath,
		acceptance,
		sandbox: finalResult?.sandbox,
		gitBundle,
	};
}

/** Release per-step runtime authority only after proven terminal close. */
async function runSingleStep(step: SubagentStep, ctx: SingleStepContext): Promise<Awaited<ReturnType<typeof runSingleStepInner>>> {
	let terminal: Awaited<ReturnType<typeof runSingleStepInner>> | undefined;
	try {
		terminal = await runSingleStepInner(step, ctx);
		return terminal;
	} finally {
		if (ctx.isolatedGitCapability && ctx.isolatedGit) {
			// teardownUnproven is an explicit recovery state, not a transient result
			// that a later event may silently clear. Retain the parent lease until an
			// operator/recovery path proves termination.
			if (terminal?.teardownUnproven) {
				ctx.isolatedGit.runtime.markExportFenceFailed();
			} else {
				const fence = await waitForNestedDescendantsToStop(ctx.nestedRoute, ctx.id, ctx.flatIndex);
				if (fence.stopped) {
					try {
						ctx.isolatedGit.runtime.releaseInheritedContext(ctx.isolatedGitCapability);
					} catch (releaseError) {
						// Revocation failure is recovery state, not a replacement for the
						// already-observed child outcome. Preserve the lease and make the
						// result explicitly non-terminal until an owner proves teardown.
						ctx.isolatedGit.runtime.markExportFenceFailed();
						if (terminal) {
							terminal.teardownUnproven = true;
							const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
							terminal.error = terminal.error ? `${terminal.error}\\nCapability release was not proven: ${detail}` : `Capability release was not proven: ${detail}`;
							terminal.exitCode = terminal.exitCode === 0 ? 1 : terminal.exitCode;
						}
					}
				} else {
					ctx.isolatedGit.runtime.markExportFenceFailed();
					if (terminal) terminal.teardownUnproven = true;
				}
			}
		}
	}
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};

function markParallelGroupSetupFailure(input: {
	statusPayload: RunnerStatusPayload;
	results: StepResult[];
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	setupError: string;
	failedAt: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
	teardownUnproven?: boolean;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "failed";
		input.statusPayload.steps[flatTaskIndex].startedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].endedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].durationMs = 0;
		input.statusPayload.steps[flatTaskIndex].exitCode = 1;
		input.results.push({ flatIndex: flatTaskIndex, agent: input.group.parallel[taskIndex].agent, output: input.setupError, success: false, exitCode: 1, sessionFile: input.group.parallel[taskIndex].sessionFile });
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	if (input.teardownUnproven) input.statusPayload.teardownUnproven = true;
	input.statusPayload.lastUpdate = input.failedAt;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.completed",
		ts: input.failedAt,
		runId: input.runId,
		stepIndex: input.stepIndex,
		success: false,
	}));
}

function markParallelGroupRunning(input: {
	statusPayload: RunnerStatusPayload;
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	groupStartTime: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "pending";
		input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
		input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
		input.statusPayload.steps[flatTaskIndex].activityState = undefined;
		input.statusPayload.steps[flatTaskIndex].error = undefined;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.activityState = undefined;
	input.statusPayload.lastActivityAt = input.groupStartTime;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.started",
		ts: input.groupStartTime,
		runId: input.runId,
		stepIndex: input.stepIndex,
		agents: input.group.parallel.map((task) => task.agent),
		count: input.group.parallel.length,
	}));
}

function prepareParallelTaskRun(
	task: SubagentStep,
	cwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	taskIndex: number,
): { taskForRun: SubagentStep; taskCwd: string } {
	if (!worktreeSetup) return { taskForRun: task, taskCwd: cwd };
	return {
		taskForRun: { ...task, cwd: undefined },
		taskCwd: worktreeSetup.worktrees[taskIndex]!.agentCwd,
	};
}

function captureParallelWorktreeSummary(
	worktreeSetup: WorktreeSetup | undefined,
	asyncDir: string,
	stepIndex: number,
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>,
): string | undefined {
	if (!worktreeSetup) return undefined;
	const diffsDir = path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`);
	const diffs = diffWorktrees(worktreeSetup, group.parallel.map((task) => task.agent), diffsDir);
	return formatWorktreeDiffSummary(diffs) || undefined;
}

function ensureParallelProgressFile(cwd: string, group: Extract<RunnerStep, { parallel: SubagentStep[] }>): void {
	const progressPath = path.join(cwd, "progress.md");
	if (!group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) return;
	writeInitialProgressFile(cwd);
}

type ParallelStepResult = Awaited<ReturnType<typeof runSingleStep>> & { skipped?: boolean; flatIndex?: number };

function readScopedGitEndpointFromEnvironment(configEndpoint?: ScopedGitEndpointDescriptor): ScopedGitEndpointDescriptor | undefined {
	const raw = configEndpoint ? JSON.stringify(configEndpoint) : process.env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV];
	if (!raw) return undefined;
	try { return JSON.parse(raw) as ScopedGitEndpointDescriptor; } catch { throw new Error("scoped Git endpoint descriptor is malformed"); }
}

async function runSubagentCore(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
	const scopedEndpointFromEnvironment = readScopedGitEndpointFromEnvironment(config.scopedGitEndpoint);
	const scopedEndpointEnv = config.scopedGitEndpoint
		? JSON.stringify(config.scopedGitEndpoint)
		: process.env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV];
	let previousOutput = "";
	const outputs: ChainOutputMap = {};
	const results: StepResult[] = [];
	// Keep a durable result projection keyed by materialized flat index. Export
	// finalization can run after a callback/mapConcurrent failure, and a later
	// fallback must never discard a bundle that was already verified.
	const canonicalResults = new Map<number, StepResult>();
	const syncCanonicalResults = (): void => {
		for (const result of results) {
			if (result.flatIndex !== undefined) canonicalResults.set(result.flatIndex, result);
		}
	};
	const projectCanonicalResults = (): void => {
		for (const [flatIndex, canonical] of canonicalResults) {
			const existingIndex = results.findIndex((result) => result.flatIndex === flatIndex);
			if (existingIndex >= 0) results[existingIndex] = { ...results[existingIndex], ...canonical, gitBundle: canonical.gitBundle ?? results[existingIndex]?.gitBundle };
			else results.push(canonical);
		}
		// Persisted receipts/details must not inherit detached callback order.
		results.sort((left, right) => {
			if (left.flatIndex === undefined) return 1;
			if (right.flatIndex === undefined) return -1;
			return left.flatIndex - right.flatIndex;
		});
	};
	const worktreeSummaries: string[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const activeChildInterrupts = new Set<() => void>();
	const registerChildInterrupt = () => {
		let current: (() => void) | undefined;
		return (interrupt: (() => void) | undefined): void => {
			if (current) activeChildInterrupts.delete(current);
			current = interrupt;
			if (interrupt) activeChildInterrupts.add(interrupt);
		};
	};
	let interrupted = false;
	let worktreeCaptureError: string | undefined;
	let worktreeExecutionError: string | undefined;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let ownerLivenessTimer: NodeJS.Timeout | undefined;
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;
	// Setup can fail before the async signal handler is installed. Keep the
	// callback optional and track registration so cleanup never invokes or removes
	// an uninitialized listener (or masks the original setup error).
	let interruptRunner: (() => void) | undefined;
	let interruptHandlerRegistered = false;
	// Once terminal status/result publication starts, recovery state is frozen;
	// cleanup/fallback work must never run from finally afterward.
	let terminalPublicationStarted = false;

	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				initialStatusSteps.push({
					agent: task.agent,
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					fastMode: initialFastModeStatus(task),
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					...((task.sandbox ?? config.sandbox) ? { sandbox: sandboxResultDetails((task.sandbox ?? config.sandbox)!) } : {}),
					recentTools: [],
					recentOutput: [],
				});
			}
			flatStepCount += step.parallel.length;
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				...((step.parallel.sandbox ?? config.sandbox) ? { sandbox: sandboxResultDetails((step.parallel.sandbox ?? config.sandbox)!) } : {}),
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		} else {
			initialStatusSteps.push({
				agent: step.agent,
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				status: "pending",
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				skills: step.skills,
				model: step.model,
				thinking: step.thinking,
				fastMode: initialFastModeStatus(step),
				attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
				...((step.sandbox ?? config.sandbox) ? { sandbox: sandboxResultDetails((step.sandbox ?? config.sandbox)!) } : {}),
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		}
	}
	const flatSteps = flattenSteps(steps);
	const sequentialFlatIndices = new Set<number>();
	let sequentialCursor = 0;
	for (const candidate of steps) {
		if (isParallelGroup(candidate)) sequentialCursor += candidate.parallel.length;
		else if (isDynamicRunnerGroup(candidate)) sequentialCursor += 1;
		else sequentialFlatIndices.add(sequentialCursor++);
	}
	let isolatedGitRuntime: IsolatedGitRuntime | undefined;
	const isolatedGitWorktrees = new Map<number, IsolatedGitWorktree>();
	let sequentialSharedIsolatedGitWorktree: IsolatedGitWorktree | undefined;
	let sequentialSharedCommitRequired = false;
	const scopedGitEndpoint = scopedEndpointFromEnvironment;
	// The source `flatSteps` excludes dynamic fanout items. Persist the exact
	// materialized step policy for every created runtime worktree so fallback
	// exports cannot project the placeholder agent/commit policy.
	const materializedWorktreePolicies = new Map<number, { step: SubagentStep; agent: string; commitRequired: boolean }>();
	const isolatedSandboxConfigs = [
		...(config.sandbox?.gitMode === "isolated" ? [config.sandbox] : []),
		...flatSteps.map((step) => step.sandbox).filter((sandbox): sandbox is ResolvedSandboxConfig => sandbox?.gitMode === "isolated"),
		...steps
			.filter(isDynamicRunnerGroup)
			.map((step) => step.parallel.sandbox ?? config.sandbox)
			.filter((sandbox): sandbox is ResolvedSandboxConfig => sandbox?.gitMode === "isolated"),
	];
	const hasIsolatedGit = isolatedSandboxConfigs.length > 0;
	if (scopedEndpointEnv && !hasIsolatedGit) {
		throw new Error("inherited scoped Git endpoint requires an isolated Bubblewrap sandbox");
	}
	let exportRemainingIsolated: ((terminationState: "success" | "failure" | "execution-rejected" | "interrupted") => Promise<void>) | undefined;
	let statusPayloadReady = false;
	let statusPayload: RunnerStatusPayload;
	let summary = "";
	let truncated = false;
	type PendingTerminalPublication = {
		result: Awaited<ReturnType<typeof runSingleStep>>;
		agent: string;
		startedAt: number;
		endedAt: number;
	};
	const pendingTerminalPublications = new Map<number, PendingTerminalPublication>();
	const publishedTerminalIndexes = new Set<number>();
	try {
	if (hasIsolatedGit) {
		if (isolatedSandboxConfigs.some((sandbox) => sandbox.provider !== "bubblewrap")) {
			throw new Error("isolated Git requires the Bubblewrap sandbox provider; refusing to downgrade");
		}
		if (!scopedGitEndpoint) {
			isolatedGitRuntime = createIsolatedGitRuntime({
			cwd,
			runId: id,
			provider: isolatedSandboxConfigs[0]?.provider,
			network: isolatedSandboxConfigs[0]?.network,
			profile: isolatedSandboxConfigs[0]?.profile,
			fallback: isolatedSandboxConfigs[0]?.fallback,
			worktreeSetupHook: config.worktreeSetupHook ? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs } : undefined,
			extraReadOnlyMounts: [...new Set(isolatedSandboxConfigs.flatMap((sandbox) => sandbox.extraReadOnlyMounts ?? []))],
			extraWritableMounts: [...new Set(isolatedSandboxConfigs.flatMap((sandbox) => sandbox.extraWritableMounts ?? []))],
		});
		}
	}
	const resolveIsolatedGitWorktree = (step: SubagentStep, flatIndex: number): IsolatedGitWorktree | undefined => {
		const sandbox = step.sandbox ?? config.sandbox;
		if (sandbox?.gitMode !== "isolated" || scopedGitEndpoint) return undefined;
		const sequential = sequentialFlatIndices.has(flatIndex);
		const packagedRole = resolvePackagedAgentRole(step.agent, step.source);
		const writer = resolveCapabilityRights({
			packagedRole,
			agentTools: step.tools,
			sandbox,
			taskMutationProhibited: taskDisallowsFileUpdates(step.task),
			parentRights: undefined,
			writableCwd: inferSandboxCwdWritable({ agentName: step.agent, tools: step.tools, sandbox }),
			exclusiveLease: true,
		}) === "writer";
		const existing = sequential
			? sequentialSharedIsolatedGitWorktree
			: isolatedGitWorktrees.get(flatIndex) ?? isolatedGitRuntime?.worktrees.find((candidate) => candidate.index === flatIndex);
		if (existing) {
			isolatedGitWorktrees.set(flatIndex, existing);
			if (sequential) {
				sequentialSharedCommitRequired ||= writer;
			}
			materializedWorktreePolicies.set(existing.index, { step, agent: step.agent, commitRequired: Boolean(sequentialSharedCommitRequired || writer) });
			return existing;
		}
		if (!isolatedGitRuntime) throw new Error("isolated Git runtime was not created");
		const policy = {
			step,
			agent: step.agent,
			commitRequired: sequential ? (sequentialSharedCommitRequired ||= writer) : writer,
		};
		// Materialize policy before checkout/setup so a failing hook still has the
		// correct agent and commitRequired metadata for its recovery bundle.
		materializedWorktreePolicies.set(flatIndex, policy);
		const worktree = createIsolatedGitWorktree(isolatedGitRuntime, { index: flatIndex, agent: step.agent });
		if (sequential) {
			sequentialSharedIsolatedGitWorktree = worktree;
		}
		isolatedGitWorktrees.set(flatIndex, worktree);
		return worktree;
	};
	/** Reserve per-step authority beneath the runner-owned scoped endpoint. */
	const issueIsolatedCapability = async (
		worktree: IsolatedGitWorktree,
		rights: "writer" | "read-only",
		cwd: string | undefined,
		fallbackCwd: string,
	): Promise<IsolatedGitCapability> => {
		const resolvedCwd = cwd ?? fallbackCwd;
		return worktree.runtime.issueInheritedContext({ worktree, rights, cwd: resolvedCwd });
	};
	/**
	 * Create a missing recovery slot without invoking the user setup hook.
	 * Existing registered slots are always reused, including slots whose hook
	 * failed after making edits.
	 */
	const createRecoverySlot = (step: SubagentStep, flatIndex: number): IsolatedGitWorktree | undefined => {
		const sandbox = step.sandbox ?? config.sandbox;
		if (sandbox?.gitMode !== "isolated" || scopedGitEndpoint) return undefined;
		const existing = isolatedGitWorktrees.get(flatIndex) ?? isolatedGitRuntime?.worktrees.find((candidate) => candidate.index === flatIndex);
		if (existing) {
			isolatedGitWorktrees.set(flatIndex, existing);
			materializedWorktreePolicies.set(flatIndex, { step, agent: step.agent, commitRequired: resolveCapabilityRights({ packagedRole: resolvePackagedAgentRole(step.agent, step.source), agentTools: step.tools, sandbox, taskMutationProhibited: taskDisallowsFileUpdates(step.task), parentRights: undefined, writableCwd: inferSandboxCwdWritable({ agentName: step.agent, tools: step.tools, sandbox }), exclusiveLease: true }) === "writer" });
			return existing;
		}
		if (!isolatedGitRuntime) throw new Error("isolated Git runtime was not created");
		const policy = {
			step,
			agent: step.agent,
			commitRequired: resolveCapabilityRights({ packagedRole: resolvePackagedAgentRole(step.agent, step.source), agentTools: step.tools, sandbox, taskMutationProhibited: taskDisallowsFileUpdates(step.task), parentRights: undefined, writableCwd: inferSandboxCwdWritable({ agentName: step.agent, tools: step.tools, sandbox }), exclusiveLease: true }) === "writer",
		};
		materializedWorktreePolicies.set(flatIndex, policy);
		const worktree = isolatedGitRuntime.createRecoveryWorktree({ index: flatIndex, agent: step.agent });
		isolatedGitWorktrees.set(flatIndex, worktree);
		return worktree;
	};
	const tryCreateRecoverySlot = (step: SubagentStep, flatIndex: number): { worktree?: IsolatedGitWorktree; error?: string } => {
		try {
			return { worktree: createRecoverySlot(step, flatIndex) };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (ownsIsolatedGitRuntime) isolatedGitRuntime?.markExportFailed();
			return { error: `Recovery worktree creation failed for slot ${flatIndex} (${step.agent}): ${detail}. Preserve the isolated runtime at ${isolatedGitRuntime?.root ?? "the runtime root"} for manual recovery.` };
		}
	};
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const ownsIsolatedGitRuntime = Boolean(isolatedGitRuntime) && !isInheritedIsolatedGitRuntime(isolatedGitRuntime!);
	let isolatedGitCleanupVerified = !isolatedGitRuntime || !ownsIsolatedGitRuntime;
	statusPayload = {
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		runnerIdentity: process.argv[2]
			? formatAsyncRunnerIdentity(
				fileURLToPath(import.meta.url),
				process.argv[2],
				id,
				readProcessStartToken(process.pid),
				typeof process.getuid === "function" ? process.getuid() : undefined,
				(() => {
					try {
						const raw = fs.readFileSync(`/proc/${process.pid}/cmdline`, "utf8");
						const argv = raw.split("\0").filter(Boolean);
						return argv.length > 0 ? argv : process.argv;
					} catch { return process.argv; }
				})(),
			)
			: `run:${id}`,
		...(readProcessStartToken(process.pid) ? { runnerStartToken: readProcessStartToken(process.pid) } : {}),
		...(typeof process.getuid === "function" ? { runnerUid: process.getuid() } : {}),
		...(config.ownerPid ? { ownerPid: config.ownerPid } : {}),
		...(config.ownerStartToken ? { ownerStartToken: config.ownerStartToken } : {}),
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
		...(config.nestedRoute ? { nestedRoute: config.nestedRoute, nestedRouteRequired: true as const } : {}),
	};
	statusPayloadReady = true;

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "cancelled" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "cancelled") return "cancelled";
			if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				const state = resolveAggregateState(node.children.map((child) => ({
					state: child.status,
					teardownUnproven: child.flatIndex !== undefined && statusPayload.steps[child.flatIndex]?.teardownUnproven === true,
				})));
				node.status = state === "completed" ? "completed" : state as typeof node.status;
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	const writeStatusPayload = (): void => {
		const terminalState = statusPayload.state === "complete" || statusPayload.state === "failed" || statusPayload.state === "paused" || statusPayload.state === "cancelled";
		// A hook group that survived teardown is still live/actionable; do not emit
		// a terminal nested event until a later explicit acknowledgement proves it.
		if (isolatedGitRuntime?.hookTeardownFailed) statusPayload.teardownUnproven = true;
		// A teardown refusal is live recovery state even when child setup already
		// produced failed projections. Keep the durable status nonterminal so parent
		// fences cannot mistake an updated event for proof that writers stopped.
		if (statusPayload.teardownUnproven) {
			statusPayload.incomplete = true;
			statusPayload.state = "running";
		}
		// Do not expose a terminal isolated run while its verified export/cleanup
		// fence is still pending. Export failures and fence refusals are explicitly
		// publishable because the runtime remains the recovery artifact.
		if (terminalState && isolatedGitRuntime && !isolatedGitCleanupVerified && !isolatedGitRuntime.exportFailed && !isolatedGitRuntime.exportFenceFailed) return;
		refreshWorkflowGraph();
		if (config.nestedRoute) {
			try {
				statusPayload.nestedChildren = projectNestedEvents(config.nestedRoute).children;
			} catch (error) {
				console.error("Failed to project nested subagent events for async status:", error);
			}
		}
		writeAtomicJson(statusPath, statusPayload);
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" || isolatedGitRuntime?.hookTeardownFailed ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const persistGroupDiagnostic = (diagnostic: { groupId: string; agent: string; status: "failed" | "complete" | "paused" | "cancelled"; output?: string; error?: string }): void => {
		statusPayload.groupDiagnostics ??= [];
		const existing = statusPayload.groupDiagnostics.findIndex((entry) => entry.groupId === diagnostic.groupId);
		const value = { ...diagnostic, unindexed: true as const, finalOutput: diagnostic.output };
		if (existing >= 0) statusPayload.groupDiagnostics[existing] = value;
		else statusPayload.groupDiagnostics.push(value);
	};
	const applyChildTerminal = (flatIndex: number, pending: PendingTerminalPublication, publishEvent: boolean): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const { agent, startedAt, endedAt } = pending;
		const canonical = canonicalResults.get(flatIndex);
		const result = canonical ? { ...pending.result, ...canonical, gitBundle: canonical.gitBundle ?? pending.result.gitBundle } : pending.result;
		// The interrupt handler marks only children that were running. A callback
		// arriving afterward must retain that paused truth instead of deriving a
		// successful completion from the child's exit code.
		const cancelled = result.cancelled === true || step.status === "cancelled";
		const paused = !cancelled && (result.interrupted || step.status === "paused");
		if (paused) interrupted = true;
		if (step.status !== "paused" && step.status !== "cancelled") step.status = cancelled ? "cancelled" : paused ? "paused" : result.exitCode === 0 ? "complete" : "failed";
		step.endedAt ??= endedAt;
		step.durationMs ??= endedAt - startedAt;
		step.exitCode = result.exitCode;
		step.model = result.model;
		step.thinking = resolveEffectiveThinking(result.model, step.thinking);
		step.fastMode = result.fastMode;
		step.attemptedModels = result.attemptedModels;
		step.modelAttempts = result.modelAttempts;
		step.error = paused && step.error ? step.error : result.error;
		step.success = result.exitCode === 0 && !paused && !cancelled;
		step.finalOutput = result.output;
		step.interrupted = Boolean(result.interrupted);
		step.cancelled = cancelled;
		step.structuredOutput = result.structuredOutput;
		step.structuredOutputPath = result.structuredOutputPath;
		step.structuredOutputSchemaPath = result.structuredOutputSchemaPath;
		step.acceptance = result.acceptance;
		step.sandbox = result.sandbox;
		step.gitBundle = result.gitBundle ?? step.gitBundle;
		step.teardownUnproven = result.teardownUnproven === true || step.teardownUnproven === true ? true : undefined;
		if (result.teardownUnproven) statusPayload.teardownUnproven = true;
		statusPayload.lastUpdate = endedAt;
		if (!publishEvent) return;
		writeStatusPayload();
		// An unproven teardown is actionable running truth, not a terminal child
		// publication. The status write above still persists the recovery flag.
		if (result.teardownUnproven === true || step.teardownUnproven === true) return;
		appendJsonl(eventsPath, JSON.stringify({
			type: cancelled ? "subagent.step.cancelled" : paused ? "subagent.step.paused" : result.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
			ts: endedAt, runId: id, stepIndex: flatIndex, agent,
			exitCode: result.exitCode, durationMs: step.durationMs,
		}));
		publishedTerminalIndexes.add(flatIndex);
	};
	const recordChildTerminal = (flatIndex: number, result: Awaited<ReturnType<typeof runSingleStep>>, agent: string, startedAt: number, endedAt: number): void => {
		const pending = { result, agent, startedAt, endedAt };
		if (isolatedGitRuntime) pendingTerminalPublications.set(flatIndex, pending);
		else applyChildTerminal(flatIndex, pending, true);
	};
	const publishPendingTerminalPublications = (): void => {
		for (const [flatIndex, pending] of pendingTerminalPublications) applyChildTerminal(flatIndex, pending, true);
		pendingTerminalPublications.clear();
	};
	exportRemainingIsolated = async (terminationState: "success" | "failure" | "execution-rejected" | "interrupted"): Promise<void> => {
		if (!ownsIsolatedGitRuntime || !isolatedGitRuntime || isolatedGitRuntime.exportFenceFailed) return;
		// A child process can close before its nested foreground/background
		// descendants publish terminal events. Never package or remove the runtime
		// until the route is fenced on those terminal events.
		const fence = await waitForNestedDescendantsToStop(config.nestedRoute, id);
		const exportErrors: string[] = [];
		if (!fence.stopped) {
			isolatedGitRuntime.markExportFenceFailed();
			statusPayload.teardownUnproven = true;
			const message = `Nested descendants did not reach a proven terminal state before export; recover isolated worktrees at ${isolatedGitRuntime.root}`;
			exportErrors.push(message);
			statusPayload.state = "failed";
			statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${message}` : message;
			const endedAt = Date.now();
			for (const worktree of isolatedGitRuntime.worktrees) {
				const existing = canonicalResults.get(worktree.index) ?? results.find((result) => result.flatIndex === worktree.index);
				const error = existing?.error?.includes(message) ? existing.error : existing?.error ? `${existing.error}\n${message}` : message;
				const fallback = existing
					? { ...existing, success: false, exitCode: 1, error, interrupted: undefined, cancelled: undefined, teardownUnproven: true }
					: { flatIndex: worktree.index, agent: materializedWorktreePolicies.get(worktree.index)?.agent ?? `task-${worktree.index + 1}`, output: "(isolated task did not reach a fenced terminal state)", success: false, exitCode: 1, error, teardownUnproven: true };
				canonicalResults.set(worktree.index, fallback);
				const resultIndex = results.findIndex((result) => result.flatIndex === worktree.index);
				if (resultIndex >= 0) results[resultIndex] = fallback;
				else results.push(fallback);
				const statusStep = statusPayload.steps[worktree.index];
				if (statusStep) {
					statusStep.status = "failed";
					statusStep.interrupted = undefined;
					statusStep.cancelled = undefined;
					statusStep.exitCode = 1;
					statusStep.endedAt = statusStep.endedAt ?? endedAt;
					statusStep.durationMs = statusStep.durationMs ?? (statusStep.startedAt ? endedAt - statusStep.startedAt : 0);
					statusStep.error = error;
					statusStep.teardownUnproven = true;
				}
			}
			statusPayload.lastUpdate = endedAt;
			return;
		}
		isolatedGitRuntime.markExportFenceResolved();
		for (const worktree of isolatedGitRuntime.worktrees) {
			if (isolatedGitRuntime.isExported(worktree.index)) continue;
			const policy = materializedWorktreePolicies.get(worktree.index);
			const step = policy?.step;
			let bundle: ReturnType<typeof exportIsolatedGitBundle> | undefined;
			let exportError: unknown;
			// Complete the fence and verified export, including one bounded retry,
			// before any terminal projection is published.
			for (let attempt = 0; attempt < 2 && !bundle; attempt++) {
				try {
					bundle = exportIsolatedGitBundle(isolatedGitRuntime, {
						outputDir: artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
						worktree,
						syntheticPaths: worktree.syntheticPaths,
						terminationState,
						agent: policy?.agent,
						commitRequired: policy?.commitRequired,
					});
				} catch (error) {
					exportError = error;
				}
			}
			if (bundle) {
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
				const existing = canonicalResults.get(worktree.index) ?? results.find((result) => result.flatIndex === worktree.index);
				const normalizedExistingError = stripIsolatedGitExportDiagnostics(existing?.error);
				const recoveredExportOnlyFailure = Boolean(existing && normalizedExistingError.onlyDiagnostics);
				const recoveredExisting = existing && normalizedExistingError.error !== existing.error
					? { ...existing, ...(normalizedExistingError.error ? { error: normalizedExistingError.error } : { error: undefined }), ...(recoveredExportOnlyFailure ? { success: true, exitCode: 0 } : {}) }
					: existing;
				const projected = recoveredExisting
					? { ...recoveredExisting, gitBundle }
					: { flatIndex: worktree.index, agent: step?.agent ?? `task-${worktree.index + 1}`, output: "(isolated task did not start)", success: false, exitCode: 1, error: "Execution rejected before this isolated task completed.", gitBundle };
				const effectiveProjected = bundle.incomplete && projected.success === true
					? { ...projected, success: false, exitCode: projected.exitCode === 0 ? 1 : projected.exitCode, error: projected.error ?? "Isolated writer completed without a required authored commit; recovery bundle is incomplete." }
					: projected;
				canonicalResults.set(worktree.index, effectiveProjected);
				const resultIndex = results.findIndex((result) => result.flatIndex === worktree.index);
				if (resultIndex >= 0) results[resultIndex] = effectiveProjected;
				else results.push(effectiveProjected);
				const statusStep = statusPayload.steps[worktree.index];
				if (statusStep) {
					const recovered = recoveredExportOnlyFailure;
					const incompleteFailure = bundle.incomplete && existing?.success === true;
					const childPaused = Boolean(existing?.interrupted) || statusStep.status === "paused";
					statusStep.status = childPaused ? "paused" : incompleteFailure ? "failed" : recovered ? "complete" : "failed";
					statusStep.exitCode = childPaused ? (statusStep.exitCode ?? 0) : incompleteFailure ? 1 : recovered ? 0 : statusStep.exitCode ?? 1;
					statusStep.endedAt ??= Date.now();
					statusStep.gitBundle = gitBundle;
					if (recovered && !childPaused && !incompleteFailure) statusStep.error = undefined;
					else if (incompleteFailure) statusStep.error = "Isolated writer completed without a required authored commit; recovery bundle is incomplete.";
					else if (!recovered) statusStep.error ??= "Execution rejected before this isolated task completed.";
				}
			} else {
				isolatedGitRuntime.markExportFailed();
				const packaging = `Isolated Git bundle export failed; recover isolated worktree at ${isolatedGitRuntime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				const existing = canonicalResults.get(worktree.index) ?? results.find((result) => result.flatIndex === worktree.index);
				const original = existing?.error ?? statusPayload.steps[worktree.index]?.error ?? statusPayload.error ?? "Execution rejected before isolated export completed.";
				const message = `${original}\n${packaging}`;
				exportErrors.push(message);
				const paused = terminationState === "interrupted";
				const fallback = existing
					? { ...existing, success: false, interrupted: existing.interrupted || paused, exitCode: existing.exitCode ?? (paused ? 0 : 1), error: message }
					: { flatIndex: worktree.index, agent: step?.agent ?? `task-${worktree.index + 1}`, output: "(isolated task did not start)", success: false, interrupted: paused, exitCode: paused ? 0 : 1, error: message };
				canonicalResults.set(worktree.index, fallback);
				const resultIndex = results.findIndex((result) => result.flatIndex === worktree.index);
				if (resultIndex >= 0) results[resultIndex] = fallback;
				else results.push(fallback);
				const statusStep = statusPayload.steps[worktree.index];
				if (statusStep) {
					statusStep.status = paused ? "paused" : "failed";
					statusStep.exitCode = statusStep.exitCode ?? fallback.exitCode ?? 1;
					statusStep.endedAt = statusStep.endedAt ?? Date.now();
					statusStep.durationMs = statusStep.durationMs ?? (statusStep.startedAt ? statusStep.endedAt - statusStep.startedAt : 0);
					statusStep.error = message;
				}
			}

		}
		if (exportErrors.length > 0) {
			statusPayload.state = terminationState === "interrupted" ? "paused" : "failed";
			statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${exportErrors.join("\n")}` : exportErrors.join("\n");
		}
		projectCanonicalResults();
		statusPayload.lastUpdate = Date.now();
	};
	const markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "running" | "paused", error?: string, acceptance?: AcceptanceLedger): void => {
		const groupNode = statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		groupNode.error = error;
		groupNode.acceptanceStatus = acceptance?.status ?? groupNode.acceptanceStatus;
	};

	const stepOutputActivityAt = (index: number): number => {
		const step = statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
		const outputPath = path.join(asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	const emittedControlEventKeys = new Set<string>();
	const activeLongRunningSteps = new Set<number>();
	const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
	const mutatingFailureAttentionSteps = initialStatusSteps.map(() => false);
	const pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined> = initialStatusSteps.map(() => undefined);
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
		const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
		const channels = event.type === "active_long_running"
			? controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
			: controlConfig.notifyChannels;
		if (channels.length === 0 || !claimControlNotification(controlConfig, event, emittedControlEventKeys, childIntercomTarget)) return;
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.control",
			event,
			channels,
			childIntercomTarget,
			noticeText: formatControlNoticeMessage(event, childIntercomTarget),
			...(config.controlIntercomTarget && channels.includes("intercom") ? {
				intercom: {
					to: config.controlIntercomTarget,
					message: formatControlIntercomMessage(event, childIntercomTarget),
				},
			} : {}),
		}));
	};
	const syncTopLevelCurrentTool = (): void => {
		const activeStep = statusPayload.steps
			.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		statusPayload.currentTool = activeStep?.currentTool;
		statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		statusPayload.currentPath = activeStep?.currentPath;
	};
	const nextTopLevelActivityState = (): ActivityState | undefined => statusPayload.steps.some((step) => step.activityState === "needs_attention")
		? "needs_attention"
		: statusPayload.steps.some((step) => step.activityState === "active_long_running")
			? "active_long_running"
			: undefined;
	const syncTopLevelActivityState = (): boolean => {
		const nextRunState = nextTopLevelActivityState();
		if (nextRunState === statusPayload.activityState) return false;
		currentActivityState = nextRunState;
		statusPayload.activityState = nextRunState;
		return true;
	};
	const clearMutatingFailureAttentionAfterActivity = (flatIndex: number): boolean => {
		if (!mutatingFailureAttentionSteps[flatIndex]) return false;
		mutatingFailureAttentionSteps[flatIndex] = false;
		const step = statusPayload.steps[flatIndex];
		if (!step || step.activityState !== "needs_attention") return false;
		step.activityState = undefined;
		return true;
	};
	const maybeEmitActiveLongRunning = (flatIndex: number, now: number): boolean => {
		if (!controlConfig.enabled || activeLongRunningSteps.has(flatIndex)) return false;
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const reason = nextLongRunningTrigger(controlConfig, {
			startedAt: step.startedAt ?? overallStartTime,
			now,
			turns: step.turnCount ?? 0,
			tokens: step.tokens?.total ?? 0,
		});
		if (!reason) return false;
		activeLongRunningSteps.add(flatIndex);
		const previous = step.activityState;
		step.activityState = "active_long_running";
		statusPayload.activityState = statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
		const event = buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} is still active but long-running`,
			reason,
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: now - (step.startedAt ?? overallStartTime),
		});
		appendControlEvent(event);
		return true;
	};
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		step.model = model;
		step.thinking = thinking;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		let activityStateChanged = clearMutatingFailureAttentionAfterActivity(flatIndex);
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(state, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, mutatingFailureWindowMs);
				if (controlConfig.enabled && shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention)) {
					mutatingFailureAttentionSteps[flatIndex] = true;
					if (step.activityState !== "needs_attention") {
						const previous = step.activityState;
						step.activityState = "needs_attention";
						statusPayload.activityState = "needs_attention";
						appendControlEvent(buildControlEvent({
							type: "needs_attention",
							from: previous,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index: flatIndex,
							ts: now,
							message: `${step.agent} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							turns: step.turnCount,
							tokens: step.tokens?.total,
							toolCount: step.toolCount,
							currentTool: toolSnapshot.tool,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							currentPath: toolSnapshot.path,
							recentFailureSummary: summarizeRecentMutatingFailures(state),
						}));
					}
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(step, stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10));
			if (event.message.model) {
				step.model = event.message.model;
				step.thinking = resolveEffectiveThinking(event.message.model, step.thinking);
			}
			step.turnCount = (step.turnCount ?? 0) + 1;
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		if (maybeEmitActiveLongRunning(flatIndex, now)) {
			activityStateChanged = true;
		}
		if (activityStateChanged) syncTopLevelActivityState();
		writeStatusPayload();
	};
	let cachedNestedChildren: typeof statusPayload.nestedChildren | undefined;
	let cachedNestedChildrenProjected = false;
	const hasCachedNestedActivity = (index: number): boolean => {
		if (!config.nestedRoute) return false;
		if (!cachedNestedChildrenProjected) {
			cachedNestedChildrenProjected = true;
			try {
				cachedNestedChildren = projectNestedEvents(config.nestedRoute).children;
				statusPayload.nestedChildren = cachedNestedChildren;
			} catch {
				cachedNestedChildren = [];
			}
		}
		return hasLiveNestedDescendantsForParent(cachedNestedChildren, id, index);
	};
	const updateRunnerActivityState = (now: number): boolean => {
		cachedNestedChildren = undefined;
		cachedNestedChildrenProjected = false;
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				// When a background runner has a live nested child for this step,
				// treat it as active rather than idle (issue #47).
				if (hasCachedNestedActivity(index)) {
					if (step.activityState === "needs_attention" && !mutatingFailureAttentionSteps[index]) {
						step.activityState = undefined;
						changed = true;
					}
				} else {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					if (previous !== "needs_attention") {
						appendControlEvent(buildControlEvent({
							from: previous,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index,
							ts: now,
							lastActivityAt,
						}));
						changed = true;
					}
				}
			} else {
				if (step.activityState === "needs_attention" && !mutatingFailureAttentionSteps[index]) {
					step.activityState = undefined;
					changed = true;
				}
				if (maybeEmitActiveLongRunning(index, now)) {
					changed = true;
				}
			}
		}
		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		if (syncTopLevelActivityState()) {
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeStatusPayload();
		return changed;
	};
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (statusPayload.state !== "running") return;
			const now = Date.now();
			updateRunnerActivityState(now);
		}, 1000);
		activityTimer.unref?.();
	}

	// Monitor owner process liveness. If the parent Pi session exits without
	// graceful shutdown (e.g. SIGKILL), the child runner detects the owner death
	// and pauses itself, preventing orphaned runs from continuing indefinitely.
	if (typeof config.ownerPid === "number" && Number.isFinite(config.ownerPid) && Number.isInteger(config.ownerPid) && config.ownerPid > 0) {
		const ownerPid = config.ownerPid;
		const ownerStartToken = config.ownerStartToken;
		ownerLivenessTimer = setInterval(() => {
			if (interrupted || statusPayload.state !== "running") return;
			// PID existence alone is unsafe: after owner exit the PID may be reused.
			// Linux start-time identity is authoritative even when a launcher or
			// reparenting boundary means getppid() is not the original Pi owner.
			if (process.platform === "linux" && ownerStartToken) {
				if (readProcessStartToken(ownerPid) !== ownerStartToken) {
					console.warn(`[pi-subagents] Owner process ${ownerPid} start identity changed or is unavailable. Pausing async run ${id}.`);
					interruptRunner?.();
				}
				return;
			}
			// On platforms without a process-start token, and during rolling upgrades
			// from an older parent that did not persist one, the direct-parent relation
			// is the only safe ownership proof; do not probe arbitrary PID existence
			// (which is vulnerable to reuse and EPERM ambiguity).
			if (process.ppid !== ownerPid) {
				console.warn(`[pi-subagents] Owner process ${ownerPid} is no longer the runner parent. Pausing async run ${id}.`);
				interruptRunner?.();
			}

		}, 3000);
		ownerLivenessTimer.unref?.();
	}

	interruptRunner = () => {
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		const now = Date.now();
		statusPayload.state = "paused";
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status === "running") {
				step.status = "paused";
				step.activityState = undefined;
				step.endedAt = now;
				step.durationMs = step.startedAt ? now - step.startedAt : undefined;
				step.lastActivityAt = now;
			}
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.paused",
			ts: now,
			runId: id,
		}));
		for (const interrupt of [...activeChildInterrupts]) interrupt();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	interruptHandlerRegistered = true;
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	let flatIndex = 0;

	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		if (interrupted) break;
		const step = steps[stepIndex];

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			const dynamicSandbox = step.parallel.sandbox ?? config.sandbox;
			if (dynamicSandbox && dynamicSandbox.gitMode !== "isolated" && inferSandboxCwdWritable({ agentName: step.parallel.agent, tools: step.parallel.tools, sandbox: dynamicSandbox }) && !step.worktreeOptOutAuthorized) {
				const now = Date.now();
				const message = sandboxDynamicFanoutUnsupportedMessage(`Dynamic sandboxed chain step ${stepIndex + 1}`);
				statusPayload.state = "failed";
				statusPayload.error = message;
				statusPayload.currentStep = flatIndex;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "failed";
					placeholder.error = message;
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
					placeholder.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", message);
				results.push({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
				persistGroupDiagnostic({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, status: "failed", output: message, error: message });
				writeStatusPayload();
				break;
			}
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, { maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true });
				if (materialized.collectedOnEmpty) validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
			} catch (error) {
				const now = Date.now();
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				statusPayload.state = "failed";
				statusPayload.error = message;
				statusPayload.currentStep = flatIndex;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "failed";
					placeholder.error = message;
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
					placeholder.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", message);
				results.push({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
				persistGroupDiagnostic({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, status: "failed", output: message, error: message });
				writeStatusPayload();
				break;
			}

			if (materialized.parallel.length === 0) {
				const now = Date.now();
				const collection = materialized.collectedOnEmpty ?? [];
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				statusPayload.outputs = outputs;
				// The placeholder exists only to make pre-materialization status
				// renderable. An empty fanout has no child in the workflow graph, so
				// retaining that slot would shift every later sequential child.
				statusPayload.steps.splice(groupStartFlatIndex, 1);
				mutatingFailureStates.splice(groupStartFlatIndex, 1);
				mutatingFailureAttentionSteps.splice(groupStartFlatIndex, 1);
				pendingToolResults.splice(groupStartFlatIndex, 1);
				for (const group of statusPayload.parallelGroups) {
					if (group.stepIndex === stepIndex) group.count = 0;
					else if (group.start > groupStartFlatIndex) group.start--;
				}
				statusPayload.parallelGroups = statusPayload.parallelGroups.filter((group) => group.stepIndex !== stepIndex);
				if (config.childIntercomTargets) {
					config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
				}
				previousOutput = "Dynamic fanout produced 0 results.";
				// Preserve the completed logical group as unindexed metadata. The
				// placeholder is removed from the canonical child array so the next
				// child retains this flat index, while the TUI still gets a completed
				// group row instead of a phantom pending child.
				persistGroupDiagnostic({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, status: "complete", output: previousOutput });
				// Persist the logical group receipt alongside indexed children without
				// consuming a flat child slot. Result-only consumers must retain this
				// diagnostic even when status.json is unavailable after cleanup.
				results.push({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, output: previousOutput, success: true, exitCode: 0 });
				// No status step was consumed; the next sequential child reuses this
				// index and will publish the real current step.
				flatIndex = groupStartFlatIndex;
				statusPayload.currentStep = statusPayload.steps.length > 0 ? Math.min(groupStartFlatIndex, statusPayload.steps.length - 1) : 0;
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "completed");
				writeStatusPayload();
				continue;
			}

			const dynamicSteps = materialized.parallel.map((task, itemIndex) => ({
				...step.parallel,
				task: task.task ?? step.parallel.task,
				label: task.label ?? step.parallel.label,
				structuredOutput: undefined,
				structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
			}));
			const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task) => ({
					agent: task.agent,
					phase: task.phase ?? step.phase,
					label: task.label,
					outputName: undefined,
					structured: Boolean(task.structuredOutputSchema),
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					fastMode: initialFastModeStatus(task),
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				}));
			statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
			if (config.childIntercomTargets) {
				config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
			}
			mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
			mutatingFailureAttentionSteps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => false));
			pendingToolResults.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => undefined));
			const materializedDelta = dynamicStatusSteps.length - 1;
			for (const group of statusPayload.parallelGroups) {
				if (group.stepIndex === stepIndex) {
					group.start = groupStartFlatIndex;
					group.count = dynamicStatusSteps.length;
				} else if (group.start > groupStartFlatIndex) {
					group.start += materializedDelta;
				}
			}
			if (statusPayload.workflowGraph) {
				const shiftFlatIndexes = (nodes: NonNullable<typeof statusPayload.workflowGraph>["nodes"]): void => {
					for (const node of nodes) {
						if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) {
							node.flatIndex += materializedDelta;
						}
						if (node.children) shiftFlatIndexes(node.children);
					}
				};
				shiftFlatIndexes(statusPayload.workflowGraph.nodes);
				const groupNode = statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
				if (groupNode) {
					groupNode.children = materialized.items.map((item, itemIndex) => ({
						id: `step-${stepIndex}-item-${item.idKey}`,
						kind: "agent",
						agent: step.parallel.agent,
						phase: dynamicSteps[itemIndex]?.phase ?? step.phase,
						label: dynamicSteps[itemIndex]?.label?.trim() || `${step.parallel.agent} ${item.key}`,
						status: "pending",
						flatIndex: groupStartFlatIndex + itemIndex,
						stepIndex,
						itemKey: item.key,
						structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
					}));
				}
			}
			writeStatusPayload();

			const concurrency = step.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = step.failFast ?? false;
			let aborted = false;
			let parallelResults: ParallelStepResult[];
			try {
			parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx) => {
				const fi = groupStartFlatIndex + taskIdx;
				if (interrupted) {
					const pausedAt = Date.now();
					const statusStep = statusPayload.steps[fi];
					if (statusStep) {
						statusStep.status = "paused";
						statusStep.error = "Interrupted before this task started.";
						statusStep.startedAt = undefined;
						statusStep.endedAt = pausedAt;
						statusStep.durationMs = 0;
						statusStep.exitCode = 0;
					}
					statusPayload.lastUpdate = pausedAt;
					writeStatusPayload();
					return { flatIndex: fi, agent: task.agent, output: "(interrupted before this task started)", exitCode: 0, interrupted: true, skipped: true };
				}
				if (aborted && failFast) {
					const skippedAt = Date.now();
					statusPayload.steps[fi].status = "failed";
					statusPayload.steps[fi].error = "Skipped due to fail-fast";
					statusPayload.steps[fi].startedAt = skippedAt;
					statusPayload.steps[fi].endedAt = skippedAt;
					statusPayload.steps[fi].durationMs = 0;
					statusPayload.steps[fi].exitCode = -1;
					statusPayload.lastUpdate = skippedAt;
					writeStatusPayload();
					return { flatIndex: fi, agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
				}
				const taskStartTime = Date.now();
				statusPayload.currentStep = fi;
				statusPayload.steps[fi].status = "running";
				statusPayload.steps[fi].error = undefined;
				statusPayload.steps[fi].activityState = undefined;
				mutatingFailureAttentionSteps[fi] = false;
				resetStepLiveDetail(statusPayload.steps[fi]);
				statusPayload.steps[fi].startedAt = taskStartTime;
				statusPayload.steps[fi].lastActivityAt = taskStartTime;
				statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
				statusPayload.lastActivityAt = taskStartTime;
				statusPayload.lastUpdate = taskStartTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));
				const dynamicWorktree = resolveIsolatedGitWorktree(task, fi);
				const packagedRole = resolvePackagedAgentRole(task.agent, task.source);
				const dynamicReadOnly = resolveCapabilityRights({
					packagedRole,
					agentTools: task.tools,
					sandbox: task.sandbox ?? config.sandbox,
					taskMutationProhibited: taskDisallowsFileUpdates(task.task),
					parentRights: undefined,
					writableCwd: inferSandboxCwdWritable({ agentName: task.agent, tools: task.tools, sandbox: task.sandbox ?? config.sandbox }),
					exclusiveLease: true,
				}) !== "writer";
				const dynamicCapability = dynamicWorktree
					? await issueIsolatedCapability(dynamicWorktree, dynamicReadOnly ? "read-only" : "writer", task.cwd, config.cwd)
					: undefined;
				const singleResult = await runSingleStep(task, {
					previousOutput, placeholder, cwd, sessionEnabled,
					outputs,
					sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
					artifactsDir, artifactConfig, id,
					flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
					outputFile: path.join(asyncDir, `output-${fi}.log`),
					piPackageRoot: config.piPackageRoot,
					piEntrypointOverride: config.piEntrypointOverride,
					childIntercomTarget: config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: config.controlIntercomTarget,
					nestedRoute: config.nestedRoute,
					sandbox: config.sandbox,
					hostGitDiagnostic: task.hostGitDiagnostic,
					isolatedGit: dynamicWorktree,
					isolatedGitCapability: dynamicCapability,
					scopedGitEndpoint,
					isolatedGitRights: dynamicReadOnly ? "read-only" : "writer",
					progressPaths: config.progressPaths,
					sandboxIntercomBridge: config.sandboxIntercomBridge,
					registerInterrupt: registerChildInterrupt(),
					onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
					onChildEvent: (event) => updateStepFromChildEvent(fi, event),
				});
				const taskEndTime = Date.now();
				const childStatusSnapshot = isolatedGitRuntime ? structuredClone(statusPayload.steps[fi]) : undefined;
				if (singleResult.interrupted || statusPayload.steps[fi]?.status === "paused") interrupted = true;
				if (isolatedGitRuntime) {
					pendingTerminalPublications.set(fi, { result: singleResult, agent: task.agent, startedAt: taskStartTime, endedAt: taskEndTime });
					if (childStatusSnapshot) statusPayload.steps[fi] = childStatusSnapshot;
				} else {
					applyChildTerminal(fi, { result: singleResult, agent: task.agent, startedAt: taskStartTime, endedAt: taskEndTime }, true);
				}
				if (singleResult.exitCode !== 0 && failFast) aborted = true;
				return { ...singleResult, skipped: false };
				});
			} catch (error) {
				const reason = error instanceof MapConcurrentError ? error.reason : error;
				const message = `Dynamic fanout execution rejected: ${reason instanceof Error ? reason.message : String(reason)}`;
				const partialResults = error instanceof MapConcurrentError ? error.partialResults : [];
				const rejectedIndex = error instanceof MapConcurrentError ? error.rejectionIndex : undefined;
				statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${message}` : message;
				statusPayload.state = "failed";
				const endedAt = Date.now();
				parallelResults = dynamicSteps.map((task, taskIdx) => {
					const fi = groupStartFlatIndex + taskIdx;
					const settled = partialResults[taskIdx];
					if (settled) return { ...settled, flatIndex: fi, skipped: false };
					const taskMessage = taskIdx === rejectedIndex ? message : `${message}; execution rejected before this task completed`;
					const statusStep = statusPayload.steps[fi];
					if (statusStep) {
						statusStep.status = "failed";
						statusStep.exitCode = 1;
						statusStep.endedAt = endedAt;
						statusStep.error = statusStep.error ? `${statusStep.error}\n${taskMessage}` : taskMessage;
					}
					const recovery = !interrupted ? tryCreateRecoverySlot(task, fi) : {};
					const projectedError = recovery.error ? `${taskMessage}\n${recovery.error}` : taskMessage;
					return { flatIndex: fi, agent: task.agent, output: "(dynamic fanout execution rejected)", error: projectedError, exitCode: 1, skipped: false };
				});
				statusPayload.lastUpdate = endedAt;
				writeStatusPayload();
			}

			if (parallelResults.some((result) => result.interrupted)) interrupted = true;
			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				const childInterrupted = pr.interrupted || (pr.flatIndex !== undefined && statusPayload.steps[pr.flatIndex]?.status === "paused");
				results.push({
					flatIndex: pr.flatIndex,
					agent: pr.agent,
					output: pr.output,
					error: pr.error,
					success: pr.exitCode === 0 && !childInterrupted,
					interrupted: childInterrupted,
					cancelled: pr.cancelled,
					exitCode: pr.exitCode,
					skipped: pr.skipped,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					thinking: pr.thinking,
					fastMode: pr.fastMode,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					artifactPaths: pr.artifactPaths,
					outputMode: pr.outputMode,
					savedOutputPath: pr.savedOutputPath,
					outputReference: pr.outputReference,
					outputSaveError: pr.outputSaveError,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
					sandbox: pr.sandbox,
					teardownUnproven: pr.teardownUnproven,
					gitBundle: pr.gitBundle,
				});
			}
			const collection = collectDynamicResults(step as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults);
			const failures = parallelResults.filter((result) => (result.exitCode !== 0 && result.exitCode !== -1) || result.interrupted);
			if (failures.length === 0) {
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
					outputs[step.collect.as] = {
						text: JSON.stringify(collection),
						structured: collection,
						agent: step.parallel.agent,
						stepIndex,
					};
					statusPayload.outputs = outputs;
					markDynamicGraphGroup(stepIndex, "completed");
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					// Collection validation describes the group, not a materialized child slot.
					// Keep it unindexed so canonical child projection cannot overwrite the first item.
					results.push({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection });
					persistGroupDiagnostic({ groupId: `dynamic-group-${stepIndex}`, agent: step.parallel.agent, status: "failed", output: message, error: message });
					statusPayload.error = message;
					markDynamicGraphGroup(stepIndex, "failed", message);
				}
			}
			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r, i) => ({
					agent: r.agent,
					taskIndex: i,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
				})),
				(i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`,
			);
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.dynamic.completed",
				ts: Date.now(),
				runId: id,
				stepIndex,
				success: failures.length === 0,
			}));
			const aggregateState = resolveAggregateState(parallelResults.map((result) => ({
				state: result.teardownUnproven ? "running" : result.cancelled ? "cancelled" : result.interrupted ? "paused" : result.exitCode === 0 ? "completed" : "failed",
				teardownUnproven: result.teardownUnproven,
			})));
			const aggregateError = failures[0]?.error ?? "Dynamic fanout child failed.";
			if (aggregateState === "failed") markDynamicGraphGroup(stepIndex, "failed", aggregateError);
			else if (aggregateState === "cancelled") markDynamicGraphGroup(stepIndex, "cancelled", failures[0]?.error ?? "Dynamic fanout child cancelled.");
			else if (aggregateState === "paused") markDynamicGraphGroup(stepIndex, "paused", failures[0]?.error ?? "Dynamic fanout child interrupted.");
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			if (aggregateState === "failed" || aggregateState === "cancelled" || aggregateState === "paused" || statusPayload.error) break;
			continue;
		}

		if (isParallelGroup(step)) {
			const group = step;
			const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = group.failFast ?? false;
			const groupStartFlatIndex = flatIndex;
			let aborted = false;
			let worktreeSetup: WorktreeSetup | undefined;
			if (!group.worktree
				&& !group.worktreeOptOutAuthorized
				&& !group.parallel.some((task) => (task.sandbox ?? config.sandbox)?.gitMode === "isolated")
				&& hasSandboxWritableAgent({ agents: group.parallel.map((task) => ({ ...task, agentName: task.agent, sandbox: task.sandbox ?? config.sandbox })) })) {
				const failedAt = Date.now();
				markParallelGroupSetupFailure({
					statusPayload,
					results,
					group,
					groupStartFlatIndex,
					setupError: sandboxParallelWorktreeRequiredMessage(`Parallel sandboxed chain step ${stepIndex + 1}`),
					failedAt,
					statusPath,
					eventsPath,
					asyncDir,
					runId: id,
					stepIndex,
				});
				flatIndex += group.parallel.length;
				break;
			}
			if (group.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, cwd);
				if (worktreeTaskCwdConflict) {
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, cwd),
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
				try {
					worktreeSetup = createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, {
						agents: group.parallel.map((task) => task.agent),
						setupHook: config.worktreeSetupHook
							? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs }
							: undefined,
					});
				} catch (error) {
					const setupError = error instanceof Error ? error.message : String(error);
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError,
						failedAt,
						teardownUnproven: error instanceof WorktreeSetupHookTeardownError,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
			}

			let preserveWorktree = false;
			try {
				if (group.worktree) ensureParallelProgressFile(cwd, group);
				const groupStartTime = Date.now();
				markParallelGroupRunning({
					statusPayload,
					group,
					groupStartFlatIndex,
					groupStartTime,
					statusPath,
					eventsPath,
					asyncDir,
					runId: id,
					stepIndex,
				});
				let parallelResults: ParallelStepResult[] = [];
				let parallelExecutionError: string | undefined;
				let worktreeSummaryForGroup: string | undefined;
				try {
					parallelResults = await mapConcurrent(
						group.parallel,
						concurrency,
						async (task, taskIdx) => {
						const fi = groupStartFlatIndex + taskIdx;
						if (interrupted) {
							const pausedAt = Date.now();
							const statusStep = statusPayload.steps[fi];
							if (statusStep) {
								statusStep.status = "paused";
								statusStep.error = "Interrupted before this task started.";
								statusStep.endedAt = pausedAt;
								statusStep.durationMs = 0;
								statusStep.exitCode = 0;
							}
							statusPayload.lastUpdate = pausedAt;
							writeStatusPayload();
							return { flatIndex: fi, agent: task.agent, output: "(interrupted before this task started)", exitCode: 0, interrupted: true, skipped: true };
						}
						if (aborted && failFast) {
							const skippedAt = Date.now();
							statusPayload.steps[fi].status = "failed";
							statusPayload.steps[fi].error = "Skipped due to fail-fast";
							statusPayload.steps[fi].startedAt = skippedAt;
							statusPayload.steps[fi].endedAt = skippedAt;
							statusPayload.steps[fi].durationMs = 0;
							statusPayload.steps[fi].exitCode = -1;
							statusPayload.steps[fi].activityState = undefined;
							statusPayload.lastUpdate = skippedAt;
							writeStatusPayload();
							appendJsonl(eventsPath, JSON.stringify({
								type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0,
							}));
							return { flatIndex: fi, agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
						}

						const taskStartTime = Date.now();
						statusPayload.currentStep = fi;
						statusPayload.steps[fi].status = "running";
						statusPayload.steps[fi].error = undefined;
						statusPayload.steps[fi].activityState = undefined;
						mutatingFailureAttentionSteps[fi] = false;
						resetStepLiveDetail(statusPayload.steps[fi]);
						statusPayload.steps[fi].startedAt = taskStartTime;
						statusPayload.steps[fi].endedAt = undefined;
						statusPayload.steps[fi].durationMs = undefined;
						statusPayload.steps[fi].lastActivityAt = taskStartTime;
						statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
						statusPayload.lastActivityAt = taskStartTime;
						statusPayload.lastUpdate = taskStartTime;
						writeStatusPayload();

						appendJsonl(eventsPath, JSON.stringify({
							type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent,
						}));

						const taskSessionDir = config.sessionDir
							? path.join(config.sessionDir, `parallel-${taskIdx}`)
							: undefined;
						const { taskForRun, taskCwd: preparedTaskCwd } = prepareParallelTaskRun(task, cwd, worktreeSetup, taskIdx);
						const isolatedGit = resolveIsolatedGitWorktree(taskForRun, fi);
						const packagedRole = resolvePackagedAgentRole(taskForRun.agent, taskForRun.source);
						const isolatedGitRights = resolveCapabilityRights({
							packagedRole,
							agentTools: taskForRun.tools,
							sandbox: taskForRun.sandbox ?? config.sandbox,
							taskMutationProhibited: taskDisallowsFileUpdates(taskForRun.task),
							parentRights: undefined,
							writableCwd: inferSandboxCwdWritable({ agentName: taskForRun.agent, tools: taskForRun.tools, sandbox: taskForRun.sandbox ?? config.sandbox }),
							exclusiveLease: true,
						});
						const isolatedGitCapability = isolatedGit
							? await issueIsolatedCapability(isolatedGit, isolatedGitRights, preparedTaskCwd, cwd)
							: undefined;
						// Keep the requested parent cwd in the step context; runSingleStep
						// maps it to the private worktree and preserves subdirectories.
						const taskCwd = preparedTaskCwd;

						const singleResult = await runSingleStep(taskForRun, {
							previousOutput, placeholder, cwd: taskCwd, sessionEnabled,
							outputs,
							sessionDir: taskSessionDir,
							artifactsDir, artifactConfig, id,
							flatIndex: fi, flatStepCount: flatSteps.length,
							outputFile: path.join(asyncDir, `output-${fi}.log`),
							piPackageRoot: config.piPackageRoot,
							piEntrypointOverride: config.piEntrypointOverride,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							nestedRoute: config.nestedRoute,
							sandbox: config.sandbox,
							hostGitDiagnostic: taskForRun.hostGitDiagnostic,
							isolatedGit,
							isolatedGitCapability,
							scopedGitEndpoint,
							isolatedGitRights: scopedGitEndpoint ? isolatedGitRights : (isolatedGitCapability ? isolatedGitRights : "writer"),
							progressPaths: config.progressPaths,
							sandboxIntercomBridge: config.sandboxIntercomBridge,
							registerInterrupt: registerChildInterrupt(),
							onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
							onChildEvent: (event) => updateStepFromChildEvent(fi, event),
						});
						if (task.sessionFile) {
							latestSessionFile = task.sessionFile;
						}

						const taskEndTime = Date.now();
						const taskDuration = taskEndTime - taskStartTime;
						const childStatusSnapshot = isolatedGitRuntime ? structuredClone(statusPayload.steps[fi]) : undefined;
						if (singleResult.interrupted || statusPayload.steps[fi]?.status === "paused") interrupted = true;
						if (isolatedGitRuntime) {
							pendingTerminalPublications.set(fi, { result: singleResult, agent: task.agent, startedAt: taskStartTime, endedAt: taskEndTime });
							if (childStatusSnapshot) statusPayload.steps[fi] = childStatusSnapshot;
						} else {
							applyChildTerminal(fi, { result: singleResult, agent: task.agent, startedAt: taskStartTime, endedAt: taskEndTime }, true);
						}

						if (singleResult.exitCode !== 0 && failFast) aborted = true;
						return { ...singleResult, skipped: false };
					},
					);
				} catch (error) {
					preserveWorktree = true;
					const rejection = error instanceof MapConcurrentError ? error.reason : error;
					const partialResults = error instanceof MapConcurrentError ? error.partialResults : [];
					const rejectedIndex = error instanceof MapConcurrentError ? error.rejectionIndex : undefined;
					const executionBase = `Parallel execution failed unexpectedly: ${rejection instanceof Error ? rejection.message : String(rejection)}`;
					try {
						worktreeSummaryForGroup = captureParallelWorktreeSummary(worktreeSetup, asyncDir, stepIndex, group);
					} catch (captureError) {
						worktreeCaptureError = captureError instanceof WorktreeDiffCaptureError
							? captureError.message
							: `Failed to capture parallel worktree changes: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
					}
					const recoveryPaths = formatRecoverableWorktreePaths(worktreeSetup);
					parallelExecutionError = `${executionBase}${recoveryPaths ? `; ${recoveryPaths}` : ""}`;
					worktreeExecutionError = worktreeExecutionError
						? `${worktreeExecutionError}\n${parallelExecutionError}`
						: parallelExecutionError;
					statusPayload.worktreeExecutionError = worktreeExecutionError;
					const stepError = worktreeCaptureError
						? `${parallelExecutionError}\n${worktreeCaptureError}`
						: parallelExecutionError;
					const endedAt = Date.now();
					for (let taskIndex = 0; taskIndex < group.parallel.length; taskIndex++) {
						if (partialResults[taskIndex]) continue;
						const step = statusPayload.steps[groupStartFlatIndex + taskIndex];
						if (!step) continue;
						step.status = "failed";
						step.endedAt = endedAt;
						step.durationMs = step.startedAt ? endedAt - step.startedAt : 0;
						step.exitCode = 1;
						const taskError = taskIndex === rejectedIndex ? stepError : `${stepError}; execution rejected before this task completed`;
						step.error = step.error ? `${step.error}\n${taskError}` : taskError;
					}
					statusPayload.error = stepError;
					statusPayload.lastUpdate = endedAt;
					writeStatusPayload();
					const nestedFence = await waitForNestedDescendantsToStop(config.nestedRoute, id);
					if (!nestedFence.stopped) {
						if (ownsIsolatedGitRuntime) isolatedGitRuntime?.markExportFenceFailed();
						parallelExecutionError = `${parallelExecutionError}; nested descendants did not reach a proven terminal state before export; recover isolated worktrees at ${isolatedGitRuntime?.root ?? "the runtime root"}`;
						statusPayload.error = parallelExecutionError;
						worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${parallelExecutionError}` : parallelExecutionError;
						statusPayload.worktreeExecutionError = worktreeExecutionError;
					}
					parallelResults = group.parallel.map((task, taskOffset) => {
						const fi = groupStartFlatIndex + taskOffset;
						const settled = partialResults[taskOffset];
						if (settled) return { ...settled, flatIndex: fi, skipped: false };
						const taskExecutionError = taskOffset === rejectedIndex ? parallelExecutionError! : `${parallelExecutionError}; execution rejected before this task completed`;
						const recovery = tryCreateRecoverySlot(task, fi);
						const isolatedGit = recovery.worktree;
						const projectedTaskError = recovery.error ? `${taskExecutionError}\n${recovery.error}` : taskExecutionError;
						let gitBundle;
						if (ownsIsolatedGitRuntime && nestedFence.stopped && isolatedGit && !isolatedGit.runtime.isExported(isolatedGit.index)) {
							try {
								const bundle = exportIsolatedGitBundle(isolatedGit.runtime, {
									outputDir: artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
									worktree: isolatedGit,
									syntheticPaths: isolatedGit.syntheticPaths,
									terminationState: "execution-rejected",
									agent: task.agent,
									commitRequired: resolveCapabilityRights({ packagedRole: resolvePackagedAgentRole(task.agent, task.source), agentTools: task.tools, sandbox: task.sandbox ?? config.sandbox, taskMutationProhibited: taskDisallowsFileUpdates(task.task), parentRights: undefined, writableCwd: inferSandboxCwdWritable({ agentName: task.agent, tools: task.tools, sandbox: task.sandbox ?? config.sandbox }), exclusiveLease: true }) === "writer",
								});
								gitBundle = {
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
							} catch (exportError) {
								isolatedGit.runtime.markExportFailed();
								parallelExecutionError = `${parallelExecutionError}; recover isolated worktree at ${isolatedGit.runtime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
							}
						}
						const projectedStep = statusPayload.steps[fi];
						if (projectedStep) {
							projectedStep.gitBundle = gitBundle;
							projectedStep.error = projectedStep.error ? `${projectedStep.error}\n${projectedTaskError}` : projectedTaskError;
						}
						return {
							flatIndex: fi,
							agent: task.agent,
							output: "(parallel execution failed unexpectedly)",
							error: projectedTaskError,
							exitCode: 1,
							skipped: false,
							gitBundle,
						};
					});
					statusPayload.state = "failed";
					statusPayload.lastUpdate = Date.now();
					writeStatusPayload();
				}

				if (parallelResults.some((result) => result.interrupted)) interrupted = true;
				flatIndex += group.parallel.length;

				// Materialize child results before post-child lifecycle work. If status,
				// artifact, or event aggregation rejects, successful child output must
				// remain available in the serialized top-level failure.
				for (const pr of parallelResults) {
					const childInterrupted = pr.interrupted || (pr.flatIndex !== undefined && statusPayload.steps[pr.flatIndex]?.status === "paused");
					results.push({
						flatIndex: pr.flatIndex,
						agent: pr.agent,
						output: pr.output,
						error: pr.error,
						success: pr.exitCode === 0 && !childInterrupted,
						interrupted: childInterrupted,
						cancelled: pr.cancelled,
						exitCode: pr.exitCode,
						skipped: pr.skipped,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						thinking: pr.thinking,
						fastMode: pr.fastMode,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						artifactPaths: pr.artifactPaths,
						structuredOutput: pr.structuredOutput,
						structuredOutputPath: pr.structuredOutputPath,
						structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
						acceptance: pr.acceptance,
						sandbox: pr.sandbox,
						teardownUnproven: pr.teardownUnproven,
						gitBundle: pr.gitBundle,
					});
				}

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					if (!taskTokens) continue;
					statusPayload.steps[fi].tokens = taskTokens;
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + taskTokens.input,
						output: previousCumulativeTokens.output + taskTokens.output,
						total: previousCumulativeTokens.total + taskTokens.total,
					};
				}
				statusPayload.totalTokens = { ...previousCumulativeTokens };
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();

				if (!parallelExecutionError) {
					try {
						worktreeSummaryForGroup = captureParallelWorktreeSummary(worktreeSetup, asyncDir, stepIndex, group);
					} catch (error) {
						preserveWorktree = true;
						worktreeCaptureError = error instanceof WorktreeDiffCaptureError
							? error.message
							: `Failed to capture parallel worktree changes: ${error instanceof Error ? error.message : String(error)}`;
						statusPayload.error = worktreeCaptureError;
						for (let taskIndex = 0; taskIndex < group.parallel.length; taskIndex++) {
							const step = statusPayload.steps[groupStartFlatIndex + taskIndex];
							if (!step) continue;
							step.error = step.error ? `${step.error}\n${worktreeCaptureError}` : worktreeCaptureError;
						}
					}
				}

				for (let t = 0; t < group.parallel.length; t++) {
					const outputName = group.parallel[t]?.outputName;
					if (outputName) outputs[outputName] = outputEntryFromAsyncResult({
						agent: parallelResults[t]!.agent,
						output: parallelResults[t]!.output,
						structuredOutput: parallelResults[t]!.structuredOutput,
					}, stepIndex);
				}
				statusPayload.outputs = outputs;

				previousOutput = aggregateParallelOutputs(
					parallelResults.map((r) => ({
						agent: r.agent,
						output: r.output,
						exitCode: r.exitCode,
						error: r.error,
						model: r.model,
						attemptedModels: r.attemptedModels,
					})),
				);
				if (worktreeSummaryForGroup) {
					previousOutput = `${previousOutput}\n\n${worktreeSummaryForGroup}`;
					worktreeSummaries.push(worktreeSummaryForGroup);
				}
				if (worktreeCaptureError) previousOutput = `${previousOutput}\n\n${worktreeCaptureError}`;

				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: !worktreeCaptureError && parallelResults.every((r) => (r.exitCode === 0 || r.exitCode === -1) && !r.interrupted),
				}));

				if (worktreeCaptureError || parallelResults.some((r) => (r.exitCode !== 0 && r.exitCode !== -1) || r.interrupted)) {
					break;
				}
			} catch (error) {
				// Also guard status/artifact aggregation after the child await. Any
				// rejection before the normal capture point makes cleanup untrusted.
				preserveWorktree = true;
				const executionBase = `Parallel lifecycle failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
				let recoveryNotice = formatRecoverableWorktreePaths(worktreeSetup);
				let capturedSummary: string | undefined;
				try {
					capturedSummary = captureParallelWorktreeSummary(worktreeSetup, asyncDir, stepIndex, group);
				} catch (captureError) {
					recoveryNotice = captureError instanceof WorktreeDiffCaptureError
						? captureError.message
						: `${recoveryNotice}${recoveryNotice ? " " : ""}Failed to capture parallel worktree changes: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
				}
				if (capturedSummary) worktreeSummaries.push(capturedSummary);
				const lifecycleError = `${executionBase}${recoveryNotice ? `; ${recoveryNotice}` : ""}`;
				worktreeExecutionError = worktreeExecutionError
					? `${worktreeExecutionError}\n${lifecycleError}`
					: lifecycleError;
				statusPayload.worktreeExecutionError = worktreeExecutionError;
				statusPayload.error = lifecycleError;
				const endedAt = Date.now();
				for (let taskIndex = 0; taskIndex < group.parallel.length; taskIndex++) {
					const step = statusPayload.steps[groupStartFlatIndex + taskIndex];
					if (!step) continue;
					step.status = "failed";
					const finishedAt = step.endedAt ?? endedAt;
					step.endedAt = finishedAt;
					step.durationMs = step.durationMs ?? (step.startedAt ? finishedAt - step.startedAt : 0);
					step.exitCode = 1;
					step.error = step.error ? `${step.error}\n${lifecycleError}` : lifecycleError;
				}
				statusPayload.lastUpdate = endedAt;
				writeStatusPayload();
				break;
			} finally {
				if (worktreeSetup && !preserveWorktree) {
					const fence = await waitForNestedDescendantsToStop(config.nestedRoute, id);
					if (!fence.stopped) {
						preserveWorktree = true;
						statusPayload.teardownUnproven = true;
						const message = `Nested descendants did not reach a proven terminal state before worktree cleanup; ${formatRecoverableWorktreePaths(worktreeSetup)}`;
						worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${message}` : message;
						statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${message}` : message;
						statusPayload.worktreeExecutionError = worktreeExecutionError;
						for (const worktree of worktreeSetup.worktrees) {
							const result = results.find((candidate) => candidate.flatIndex === worktree.index);
							if (result) {
								result.success = false;
								result.interrupted = undefined;
								result.cancelled = undefined;
								result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
								result.error = result.error ? `${result.error}\n${message}` : message;
							}
							const step = statusPayload.steps[worktree.index];
							if (step) {
								step.status = "failed";
								step.success = false;
								step.interrupted = undefined;
								step.cancelled = undefined;
								step.exitCode = step.exitCode === 0 ? 1 : (step.exitCode ?? 1);
								step.error = step.error ? `${step.error}\n${message}` : message;
							}
						}
						writeStatusPayload();
					} else try { cleanupWorktrees(worktreeSetup); }
					catch (cleanupError) {
						preserveWorktree = true;
						statusPayload.teardownUnproven = true;
						const message = `Worktree cleanup failed; recover worktrees at ${formatRecoverableWorktreePaths(worktreeSetup)}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
						worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${message}` : message;
						statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${message}` : message;
						statusPayload.worktreeExecutionError = worktreeExecutionError;
						const endedAt = Date.now();
						for (const worktree of worktreeSetup.worktrees) {
							const index = worktree.index;
							const step = statusPayload.steps[index];
							if (step) {
								step.status = "failed";
								step.success = false;
								step.interrupted = undefined;
								step.cancelled = undefined;
								step.exitCode = step.exitCode === 0 ? 1 : (step.exitCode ?? 1);
								step.endedAt ??= endedAt;
								step.error = step.error ? `${step.error}\n${message}` : message;
							}
							const result = results.find((candidate) => candidate.flatIndex === index);
							if (result) {
								result.success = false;
								result.interrupted = undefined;
								result.cancelled = undefined;
								result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
								result.error = result.error ? `${result.error}\n${message}` : message;
							}
						}
						statusPayload.lastUpdate = endedAt;
						writeStatusPayload();
					}
				}
			}
		} else {
			const seqStep = step as SubagentStep;
			const stepStartTime = Date.now();
			statusPayload.currentStep = flatIndex;
			statusPayload.steps[flatIndex].status = "running";
			statusPayload.steps[flatIndex].activityState = undefined;
			mutatingFailureAttentionSteps[flatIndex] = false;
			statusPayload.activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			}));

			const isolatedGit = resolveIsolatedGitWorktree(seqStep, flatIndex);
			const packagedRole = resolvePackagedAgentRole(seqStep.agent, seqStep.source);
			const isolatedGitRights = resolveCapabilityRights({
				packagedRole,
				agentTools: seqStep.tools,
				sandbox: seqStep.sandbox ?? config.sandbox,
				taskMutationProhibited: taskDisallowsFileUpdates(seqStep.task),
				parentRights: undefined,
				writableCwd: inferSandboxCwdWritable({ agentName: seqStep.agent, tools: seqStep.tools, sandbox: seqStep.sandbox ?? config.sandbox }),
				exclusiveLease: true,
			});
			const isolatedGitCapability = isolatedGit
				? await issueIsolatedCapability(isolatedGit, isolatedGitRights, seqStep.cwd, cwd)
				: undefined;
			let singleResult: Awaited<ReturnType<typeof runSingleStep>>;
			try {
				singleResult = await runSingleStep(seqStep, {
				previousOutput, placeholder, cwd, sessionEnabled,
				outputs,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: flatSteps.length,
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				piPackageRoot: config.piPackageRoot,
				piEntrypointOverride: config.piEntrypointOverride,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				sandbox: config.sandbox,
				hostGitDiagnostic: seqStep.hostGitDiagnostic,
				isolatedGit,
				isolatedGitCapability,
				scopedGitEndpoint,
				isolatedGitRights,
				deferIsolatedGitExport: Boolean(isolatedGit),
				progressPaths: config.progressPaths,
				sandboxIntercomBridge: config.sandboxIntercomBridge,
				registerInterrupt: registerChildInterrupt(),
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
				});
			} catch (error) {
				// A sequential callback can reject after its isolated worktree has
				// been materialized (for example during artifact persistence). Mark
				// the real step and package it before the outer terminal projection.
				let rejection = `Sequential execution rejected: ${error instanceof Error ? error.message : String(error)}`;
				const statusStep = statusPayload.steps[flatIndex];
				if (singleResult && statusStep?.gitBundle === undefined && singleResult.gitBundle) statusStep.gitBundle = singleResult.gitBundle;
				if (isolatedGit && (!ownsIsolatedGitRuntime || !isolatedGit.runtime.isExported(isolatedGit.index))) {
					const fence = await waitForNestedDescendantsToStop(config.nestedRoute, id);
					if (!fence.stopped) {
						if (ownsIsolatedGitRuntime) isolatedGit.runtime.markExportFenceFailed();
						statusPayload.teardownUnproven = true;
						if (singleResult) singleResult.teardownUnproven = true;
						rejection = `${rejection}; nested descendants did not reach a proven terminal state before export; recover isolated worktree at ${isolatedGit.runtime.root}`;
					} else if (ownsIsolatedGitRuntime && !isolatedGit.runtime.isExported(isolatedGit.index)) {
						try {
							const bundle = exportIsolatedGitBundle(isolatedGit.runtime, {
								outputDir: artifactsDir ?? path.join(TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
								worktree: isolatedGit,
								syntheticPaths: isolatedGit.syntheticPaths,
								terminationState: interrupted ? "interrupted" : "execution-rejected",
								agent: seqStep.agent,
								commitRequired: resolveCapabilityRights({ packagedRole: resolvePackagedAgentRole(seqStep.agent, seqStep.source), agentTools: seqStep.tools, sandbox: seqStep.sandbox ?? config.sandbox, taskMutationProhibited: taskDisallowsFileUpdates(seqStep.task), parentRights: undefined, writableCwd: inferSandboxCwdWritable({ agentName: seqStep.agent, tools: seqStep.tools, sandbox: seqStep.sandbox ?? config.sandbox }), exclusiveLease: true }) === "writer",
							});
							if (statusStep) statusStep.gitBundle = {
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
						} catch (exportError) {
							isolatedGit.runtime.markExportFailed();
							rejection = `${rejection}\nIsolated Git bundle export failed; recover isolated worktree at ${isolatedGit.runtime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
						}
					}
				}
				if (statusStep) {
					statusStep.status = "failed";
					statusStep.exitCode = 1;
					statusStep.endedAt = Date.now();
					statusStep.error = rejection;
				}
				statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${rejection}` : rejection;
				worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${rejection}` : rejection;
				statusPayload.lastUpdate = Date.now();
				// Keep this rejection in the normal terminal path. Publishing status
				// here would race runtime cleanup and expose a live isolated checkout.
				results.push({
					flatIndex,
					agent: seqStep.agent,
					output: "",
					error: rejection,
					success: false,
					exitCode: 1,
					gitBundle: statusStep?.gitBundle,
				});
				break;
			}
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			const childInterrupted = singleResult.interrupted || statusPayload.steps[flatIndex]?.status === "paused";
			const childCancelled = singleResult.cancelled === true || statusPayload.steps[flatIndex]?.status === "cancelled";
			results.push({
				flatIndex,
				agent: singleResult.agent,
				output: singleResult.output,
				error: singleResult.error,
				success: singleResult.exitCode === 0 && !childInterrupted && !childCancelled,
				interrupted: childInterrupted,
				...(childCancelled ? { cancelled: true } : {}),
				exitCode: singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				thinking: singleResult.thinking,
				fastMode: singleResult.fastMode,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				artifactPaths: singleResult.artifactPaths,
				outputMode: singleResult.outputMode,
				savedOutputPath: singleResult.savedOutputPath,
				outputReference: singleResult.outputReference,
				outputSaveError: singleResult.outputSaveError,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				sandbox: singleResult.sandbox,
				teardownUnproven: singleResult.teardownUnproven,
				gitBundle: singleResult.gitBundle,
			});
			if (seqStep.outputName) {
				outputs[seqStep.outputName] = outputEntryFromAsyncResult({
					agent: singleResult.agent,
					output: singleResult.output,
					structuredOutput: singleResult.structuredOutput,
				}, stepIndex);
			}
			statusPayload.outputs = outputs;

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			let stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
					};
				}
			}

			const stepEndTime = Date.now();
			const childStatusSnapshot = isolatedGitRuntime ? structuredClone(statusPayload.steps[flatIndex]) : undefined;
			if (singleResult.interrupted || statusPayload.steps[flatIndex]?.status === "paused") interrupted = true;
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			if (isolatedGitRuntime) {
				pendingTerminalPublications.set(flatIndex, { result: singleResult, agent: seqStep.agent, startedAt: stepStartTime, endedAt: stepEndTime });
				if (childStatusSnapshot) statusPayload.steps[flatIndex] = childStatusSnapshot;
			} else {
				applyChildTerminal(flatIndex, { result: singleResult, agent: seqStep.agent, startedAt: stepStartTime, endedAt: stepEndTime }, true);
			}

			flatIndex++;
			if (singleResult.interrupted || singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	// Preserve positional identity for every queued sequential child after an
	// interrupt. These are synthetic paused results: no worktree is created and
	// no child process is spawned, but consumers still receive one slot per step.
	if (interrupted) {
		const pausedAt = Date.now();
		for (let index = flatIndex; index < flatSteps.length; index++) {
			if (results.some((result) => result.flatIndex === index)) continue;
			const queued = flatSteps[index];
			if (!queued) continue;
			const statusStep = statusPayload.steps[index];
			if (statusStep) {
				statusStep.status = "paused";
				statusStep.error ??= "Interrupted before this task started.";
				statusStep.exitCode = 0;
				statusStep.endedAt ??= pausedAt;
				statusStep.durationMs ??= 0;
			}
			results.push({ flatIndex: index, agent: queued.agent, output: "(interrupted before this task started)", error: "Interrupted before this task started.", success: false, interrupted: true, exitCode: 0 });
		}
	}

	summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	truncated = false;

	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, config, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}
	if (worktreeSummaries.length > 0) summary = summary ? `${summary}\n\n${worktreeSummaries.join("\n\n")}` : worktreeSummaries.join("\n\n");
	if (worktreeExecutionError) summary = summary ? `${summary}\n\n${worktreeExecutionError}` : worktreeExecutionError;
	if (worktreeCaptureError) summary = summary ? `${summary}\n\n${worktreeCaptureError}` : worktreeCaptureError;

	// Export before terminal status/result serialization so every projection sees
	// the same bundle or actionable export failure details.
	if (isolatedGitRuntime) {
		syncCanonicalResults();
		await exportRemainingIsolated?.(interrupted ? "interrupted" : results.every((result) => result.exitCode === 0 && !result.error) ? "success" : "failure");
		projectCanonicalResults();
		// Verified exports are the cleanup fence. Keep failed/detached/fence-
		// refused runtimes live, with the terminal projection below reporting the
		// actionable recovery path.
		if (ownsIsolatedGitRuntime && !isolatedGitRuntime.exportFenceFailed && !isolatedGitRuntime.exportFailed) await cleanupIsolatedGitRuntime(isolatedGitRuntime);
		isolatedGitCleanupVerified = !ownsIsolatedGitRuntime || !fs.existsSync(isolatedGitRuntime.root);
		if (!isolatedGitCleanupVerified) {
			// Cleanup refusal is itself an unproven teardown fence. Mark it before
			// terminal status serialization so the guarded publisher emits the
			// failed recovery state rather than suppressing it as an in-progress run.
			isolatedGitRuntime.markExportFenceFailed();
			statusPayload.teardownUnproven = true;
			const recovery = `Isolated Git cleanup was not proven; recover isolated worktrees at ${isolatedGitRuntime.root}.`;
			worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${recovery}` : recovery;
			statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${recovery}` : recovery;
			summary = summary ? `${summary}\n\n${recovery}` : recovery;
			const isolatedIndexes = new Set(isolatedGitRuntime.worktrees.map((worktree) => worktree.index));
			// Cleanup refusal is a child failure, not merely run-level commentary.
			// Apply the failed/nonzero/error projection before status, events, and
			// watcher result publication, including deferred isolated terminals.
			for (const result of results) {
				if (!isolatedIndexes.has(result.flatIndex ?? -1)) continue;
				result.success = false;
				delete result.interrupted;
				delete result.cancelled;
				result.exitCode = 1;
				result.error = result.error ? `${result.error}\n${recovery}` : recovery;
			}
			for (const pending of pendingTerminalPublications.values()) {
				pending.result.exitCode = 1;
				pending.result.error = pending.result.error ? `${pending.result.error}\n${recovery}` : recovery;
				pending.result.interrupted = undefined;
				pending.result.cancelled = undefined;
			}
			for (const index of isolatedIndexes) {
				const step = statusPayload.steps[index];
				if (!step) continue;
				step.status = "failed";
				step.success = false;
				step.interrupted = undefined;
				step.cancelled = undefined;
				step.exitCode = 1;
				step.error = step.error ? `${step.error}\n${recovery}` : recovery;
			}
		}
		// Export/recovery is now final. Publish deferred child terminals only after
		// the verified bundle or fail-closed recovery projection is in place.
		publishPendingTerminalPublications();
		for (const worktree of isolatedGitRuntime.worktrees) {
			if (publishedTerminalIndexes.has(worktree.index)) continue;
			const step = statusPayload.steps[worktree.index];
			if (!step || step.teardownUnproven === true || !["complete", "completed", "failed", "paused"].includes(step.status)) continue;
			appendJsonl(eventsPath, JSON.stringify({
				type: step.status === "paused" ? "subagent.step.paused" : step.status === "failed" ? "subagent.step.failed" : "subagent.step.completed",
				ts: step.endedAt ?? Date.now(), runId: id, stepIndex: worktree.index, agent: step.agent,
				exitCode: step.exitCode,
				durationMs: step.durationMs,
			}));
			publishedTerminalIndexes.add(worktree.index);
		}
	}
	const resultMode = config.resultMode ?? statusPayload.mode;
	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
		: resultMode === "parallel"
			? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
			: `chain:${flatSteps.map((s) => s.agent).join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) {
		clearInterval(activityTimer);
		activityTimer = undefined;
	}
	if (ownerLivenessTimer) {
		clearInterval(ownerLivenessTimer);
		ownerLivenessTimer = undefined;
	}
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	const exportFailure = Boolean(isolatedGitRuntime?.exportFenceFailed || isolatedGitRuntime?.exportFailed);
	statusPayload.teardownUnproven = statusPayload.teardownUnproven || isolatedGitRuntime?.hookTeardownFailed || isolatedGitRuntime?.exportFenceFailed ? true : undefined;
	const finalAggregate = resolveAggregateState([
		...(exportFailure || worktreeCaptureError || worktreeExecutionError ? [{ state: "failed" }] : []),
		...(interrupted ? [{ state: "paused" }] : []),
		...results.map((result) => ({
			state: result.teardownUnproven ? "running" : result.cancelled ? "cancelled" : result.interrupted ? "paused" : result.success ? "completed" : "failed",
			teardownUnproven: result.teardownUnproven,
		})),
	]);
	statusPayload.state = statusPayload.teardownUnproven
		? "running"
		: finalAggregate === "completed" ? "complete"
			: finalAggregate === "failed" ? "failed"
				: finalAggregate === "cancelled" ? "cancelled"
					: finalAggregate === "paused" ? "paused"
						: "failed";
	statusPayload.worktreeExecutionError = worktreeExecutionError;
	statusPayload.finalOutput = summary;
	statusPayload.activityState = undefined;
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	// All export/retry/cleanup truth is finalized before this terminal write.
	// A teardown fence keeps the run actionable and must not enter the terminal
	// publication path, even if a later log/result write rejects.
	terminalPublicationStarted = statusPayload.state !== "running";
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeStatusPayload();
	if (statusPayload.state !== "running") try {
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.run.completed",
				ts: runEndedAt,
				runId: id,
				status: statusPayload.state,
				durationMs: runEndedAt - overallStartTime,
			}),
		);
	} catch (error) {
		// A final event-journal failure must not mask the serialized run result.
		console.error(`Failed to append async completion event for '${id}':`, error);
	}
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
			sandbox: step.sandbox,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		writeAtomicJson(resultPath, {
			id,
			agent: agentName,
			mode: resultMode,
			success: statusPayload.state === "complete",
			state: statusPayload.state,
			teardownUnproven: statusPayload.teardownUnproven,
			finalOutput: summary,
			summary: worktreeCaptureError || worktreeExecutionError ? summary : interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => ({
				flatIndex: r.flatIndex,
				groupId: r.groupId,
				agent: r.agent,
				// finalOutput is canonical; output remains for legacy consumers.
				finalOutput: r.output,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				thinking: r.thinking,
				fastMode: r.fastMode,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				outputMode: r.outputMode,
				interrupted: r.interrupted,
				cancelled: r.cancelled,
				savedOutputPath: r.savedOutputPath,
				outputReference: r.outputReference,
				outputSaveError: r.outputSaveError,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
				sandbox: r.sandbox,
				gitBundle: r.gitBundle,
				teardownUnproven: r.teardownUnproven,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			...(worktreeSummaries.length > 0 ? { worktreeSummary: worktreeSummaries.join("\n\n") } : {}),
			...(worktreeCaptureError ? { worktreeCaptureError } : {}),
			...(worktreeExecutionError ? { worktreeExecutionError } : {}),
			exitCode: statusPayload.state === "complete" ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			...(config.nestedRoute ? { nestedRoute: config.nestedRoute, nestedRouteRequired: true as const } : {}),
			...(config.nestedSelf ? { nestedSelf: config.nestedSelf } : {}),
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}
	} catch (error) {
		let cleanupFailureProjected = false;
		// Setup/callback failures before terminal publication still receive the
		// same fenced export and remain recoverable on permanent failure. Once a
		// terminal write began, do not mutate recovery truth here.
		if (!statusPayloadReady) throw error;
		const teardownUnproven = statusPayload.teardownUnproven === true
			|| statusPayload.steps.some((step) => step.teardownUnproven === true)
			|| results.some((result) => result.teardownUnproven === true)
			|| isolatedGitRuntime?.hookTeardownFailed === true
			|| isolatedGitRuntime?.exportFenceFailed === true;
		if (teardownUnproven) statusPayload.teardownUnproven = true;
		if (!terminalPublicationStarted) {
			const lifecycleError = error instanceof Error ? error.message : String(error);
			statusPayload.state = teardownUnproven ? "running" : "failed";
			statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${lifecycleError}` : lifecycleError;
			const endedAt = Date.now();
			for (const step of statusPayload.steps) {
				if (!teardownUnproven && (step.status === "running" || step.status === "pending")) {
					step.status = interrupted ? "paused" : "failed";
					step.exitCode = step.exitCode ?? (interrupted ? 0 : 1);
					step.endedAt = step.endedAt ?? endedAt;
					step.durationMs = step.durationMs ?? (step.startedAt ? endedAt - step.startedAt : 0);
					step.error = step.error ? `${step.error}\n${lifecycleError}` : lifecycleError;
				}
			}
		}
		if (!terminalPublicationStarted && isolatedGitRuntime) {
			const projectIsolatedCleanupFailure = (message: string): void => {
				// A first cleanup observation changes child truth even when retry later
				// succeeds; force the workflow graph to rebuild from those projections.
				cleanupFailureProjected = true;
				const isolatedIndexes = new Set(isolatedGitRuntime!.worktrees.map((worktree) => worktree.index));
				for (const result of results) {
					if (!isolatedIndexes.has(result.flatIndex ?? -1)) continue;
					result.success = false;
					delete result.interrupted;
					delete result.cancelled;
					result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
					result.error = result.error?.includes(message) ? result.error : result.error ? `${result.error}\n${message}` : message;
				}
				for (const pending of pendingTerminalPublications.values()) {
					pending.result.success = false;
					delete pending.result.interrupted;
					delete pending.result.cancelled;
					pending.result.exitCode = pending.result.exitCode === 0 ? 1 : (pending.result.exitCode ?? 1);
					pending.result.error = pending.result.error?.includes(message) ? pending.result.error : pending.result.error ? `${pending.result.error}\n${message}` : message;
				}
				for (const index of isolatedIndexes) {
					const step = statusPayload.steps[index];
					if (!step) continue;
					step.status = "failed";
					step.success = false;
					delete step.interrupted;
					delete step.cancelled;
					step.exitCode = step.exitCode === 0 ? 1 : (step.exitCode ?? 1);
					step.error = step.error?.includes(message) ? step.error : step.error ? `${step.error}\n${message}` : message;
					if (statusPayload.teardownUnproven !== true && step.teardownUnproven !== true) {
						try { appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.failed", ts: Date.now(), runId: id, stepIndex: index, agent: step.agent, exitCode: step.exitCode, durationMs: step.durationMs })); } catch { /* outer fallback still writes status/result */ }
					}
				}
			};
			const cleanupFailure = `Isolated Git cleanup/recovery finalization failed; recover worktree at ${isolatedGitRuntime.root}.`;
			statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${cleanupFailure}` : cleanupFailure;
			worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${cleanupFailure}` : cleanupFailure;
			summary = summary ? `${summary}\n\n${cleanupFailure}` : cleanupFailure;
			// Project before retrying cleanup: a throw is already a failed teardown
			// observation, even if a later retry happens to remove the root.
			projectIsolatedCleanupFailure(cleanupFailure);
			try {
				syncCanonicalResults();
				await exportRemainingIsolated?.(interrupted ? "interrupted" : results.every((result) => result.exitCode === 0 && !result.error) ? "success" : "failure");
				projectCanonicalResults();
				if (ownsIsolatedGitRuntime) await cleanupIsolatedGitRuntime(isolatedGitRuntime);
				if (fs.existsSync(isolatedGitRuntime.root)) throw new Error(`Isolated Git cleanup was not proven; recover isolated worktrees at ${isolatedGitRuntime.root}`);
			} catch (exportError) {
				cleanupFailureProjected = true;
				isolatedGitRuntime.markExportFailed();
				const recovery = `Isolated Git recovery finalization failed; recover worktree at ${isolatedGitRuntime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				statusPayload.error = statusPayload.error ? `${statusPayload.error}\n${recovery}` : recovery;
				worktreeExecutionError = worktreeExecutionError ? `${worktreeExecutionError}\n${recovery}` : recovery;
				summary = summary ? `${summary}\n\n${recovery}` : recovery;
				const isolatedIndexes = new Set(isolatedGitRuntime.worktrees.map((worktree) => worktree.index));
				// Cleanup failure invalidates even already-complete isolated children.
				// Project the failure before the outer fallback serializes status/result,
				// and emit failed child events instead of leaving complete events behind.
				for (const result of results) {
					if (!isolatedIndexes.has(result.flatIndex ?? -1)) continue;
					result.success = false;
					delete result.interrupted;
					delete result.cancelled;
					result.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
					result.error = result.error ? `${result.error}\n${recovery}` : recovery;
				}
				for (const pending of pendingTerminalPublications.values()) {
					pending.result.success = false;
					delete pending.result.interrupted;
					delete pending.result.cancelled;
					pending.result.exitCode = pending.result.exitCode === 0 ? 1 : (pending.result.exitCode ?? 1);
					pending.result.error = pending.result.error ? `${pending.result.error}\n${recovery}` : recovery;
				}
				for (const index of isolatedIndexes) {
					const step = statusPayload.steps[index];
					if (!step) continue;
					step.status = "failed";
					step.success = false;
					delete step.interrupted;
					delete step.cancelled;
					step.exitCode = step.exitCode === 0 ? 1 : (step.exitCode ?? 1);
					step.error = step.error ? `${step.error}\n${recovery}` : recovery;
					if (statusPayload.teardownUnproven !== true && step.teardownUnproven !== true) appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.failed", ts: Date.now(), runId: id, stepIndex: index, agent: step.agent, exitCode: step.exitCode, durationMs: step.durationMs }));
				}
				console.error(recovery);
			}
		}
		if (cleanupFailureProjected) {
			// Cleanup rejection changes terminal truth after child callbacks may have
			// already marked nodes complete. Rebuild the graph from the failed status
			// and canonical flat-index results before the status write so graph,
			// status, events, and result projections cannot disagree.
			const indexedResults = Array.from({ length: statusPayload.steps.length }, (_, index) => results.find((result) => result.flatIndex === index));
			const existingGraph = statusPayload.workflowGraph;
			const dynamicChildren: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>> = {};
			const dynamicGroupStatuses: Record<number, { status: any; error?: string }> = {};
			for (const node of existingGraph?.nodes ?? []) {
				if (node.kind !== "dynamic-parallel-group" || node.stepIndex === undefined) continue;
				dynamicChildren[node.stepIndex] = (node.children ?? []).flatMap((child) => child.flatIndex === undefined || !child.itemKey ? [] : [{ agent: child.agent, label: child.label, flatIndex: child.flatIndex, itemKey: child.itemKey, outputName: child.outputName, structured: child.structured, error: child.error }]);
				if ((node.children ?? []).length === 0) dynamicGroupStatuses[node.stepIndex] = { status: node.status, error: node.error };
			}
			statusPayload.workflowGraph = buildWorkflowGraphSnapshot({
				runId: id,
				mode: statusPayload.mode,
				steps: config.steps as any,
				results: indexedResults,
				stepStatuses: statusPayload.steps,
				dynamicChildren,
				dynamicGroupStatuses,
				currentFlatIndex: statusPayload.currentStep,
			});
		}
		const recoveryTeardownUnproven = statusPayload.teardownUnproven === true
			|| statusPayload.steps.some((step) => step.teardownUnproven === true)
			|| results.some((result) => result.teardownUnproven === true)
			|| isolatedGitRuntime?.hookTeardownFailed === true
			|| isolatedGitRuntime?.exportFenceFailed === true;
		if (recoveryTeardownUnproven) {
			statusPayload.teardownUnproven = true;
			statusPayload.state = "running";
		}
		if (statusPayloadReady) {
			try { writeAtomicJson(statusPath, statusPayload); } catch (statusError) { console.error(`Failed to persist rejected async status: ${statusError}`); }
		}
		throw error;
	} finally {
		// Recovery export and cleanup intentionally do not run from finally.
		// This block only tears down process-local timers/signal handlers.
		if (activityTimer) {
			clearInterval(activityTimer);
			activityTimer = undefined;
		}
		if (ownerLivenessTimer) {
			clearInterval(ownerLivenessTimer);
			ownerLivenessTimer = undefined;
		}
		if (interruptHandlerRegistered && interruptRunner) {
			process.off(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
			interruptHandlerRegistered = false;
		}
	}
}

export function writeRejectedRunnerTerminal(config: SubagentRunConfig, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const terminalError = `Async subagent execution rejected: ${message}`;
	const statusPath = path.join(config.asyncDir, "status.json");
	const now = Date.now();
	let status: Record<string, any> = {};
	try {
		status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, any>;
	} catch {
		status = {
			runId: config.id,
			mode: config.resultMode ?? (config.steps.length > 1 ? "chain" : "single"),
			cwd: config.cwd,
			...(config.nestedRoute ? { nestedRoute: config.nestedRoute, nestedRouteRequired: true as const } : {}),
			...(config.nestedSelf ? { nestedSelf: config.nestedSelf } : {}),
			steps: config.steps.flatMap((step) => isParallelGroup(step) ? step.parallel.map((child) => ({ agent: child.agent, status: "failed" })) : isDynamicRunnerGroup(step) ? [{ agent: `expand:${step.parallel.agent}`, status: "failed" }] : [{ agent: step.agent, status: "failed" }]),
		};
	}
	let existing: Record<string, any> | undefined;
	try { existing = JSON.parse(fs.readFileSync(config.resultPath, "utf-8")) as Record<string, any>; } catch { /* result not written yet */ }
	const statusSteps = Array.isArray(status.steps) ? status.steps : [];
	const existingResults = Array.isArray(existing?.results) ? existing.results : [];
	const teardownUnproven = status.teardownUnproven === true
		|| statusSteps.some((step: Record<string, any>) => step.teardownUnproven === true)
		|| existing?.teardownUnproven === true
		|| existingResults.some((child: Record<string, any>) => child.teardownUnproven === true);
	fs.mkdirSync(config.asyncDir, { recursive: true });
	if (config.nestedRoute) { status.nestedRoute = config.nestedRoute; status.nestedRouteRequired = true; }
	if (config.nestedSelf) status.nestedSelf = config.nestedSelf;
	status.teardownUnproven = teardownUnproven ? true : undefined;
	status.state = teardownUnproven ? "running" : "failed";
	status.error = status.error ? `${status.error}\n${terminalError}` : terminalError;
	status.worktreeExecutionError = status.worktreeExecutionError ?? terminalError;
	status.endedAt = status.endedAt ?? now;
	status.lastUpdate = now;
	// A cleanup throw can arrive after isolated children were already marked
	// complete. Those projections are not durable truth once the runtime root is
	// retained: force every affected status slot failed before the outer fallback
	// writes its terminal receipt, avoiding a complete-child/failed-run split.
	const forceAllChildrenFailed = /isolated Git (?:cleanup|recovery finalization)/u.test(message)
		|| /isolated Git (?:cleanup|recovery finalization)/u.test(String(status.error ?? ""));
	for (const step of statusSteps) {
		if (!teardownUnproven && (forceAllChildrenFailed || step.status === "running" || step.status === "pending")) {
			step.status = "failed";
			step.success = false;
			step.exitCode = step.exitCode ?? 1;
			step.error = step.error ? `${step.error}\n${terminalError}` : terminalError;
			step.endedAt = step.endedAt ?? now;
		}
	}
	// Rejected-run fallback still needs the same graph projection as the normal
	// terminal path. Rebuild from failed status slots before either status or
	// result is written so graph/status/results agree.
	const indexedResults = statusSteps.map((step: Record<string, any>, index: number) => ({
		flatIndex: step.flatIndex ?? index,
		agent: step.agent ?? `step-${index + 1}`,
		success: !teardownUnproven && step.success === true && step.status !== "failed",
		exitCode: step.exitCode ?? 1,
		error: step.error ?? terminalError,
		...(step.teardownUnproven === true ? { teardownUnproven: true } : {}),
	}));
	const dynamicChildren: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>> = {};
	const dynamicGroupStatuses: Record<number, { status: any; error?: string }> = {};
	for (const node of (status.workflowGraph?.nodes ?? [])) {
		if (node.kind !== "dynamic-parallel-group" || node.stepIndex === undefined) continue;
		dynamicChildren[node.stepIndex] = (node.children ?? []).flatMap((child) => child.flatIndex === undefined || !child.itemKey ? [] : [{ agent: child.agent, label: child.label, flatIndex: child.flatIndex, itemKey: child.itemKey, outputName: child.outputName, structured: child.structured, error: child.error }]);
		if ((node.children ?? []).length === 0) dynamicGroupStatuses[node.stepIndex] = { status: node.status, error: node.error };
	}
	status.workflowGraph = buildWorkflowGraphSnapshot({
		runId: config.id,
		mode: status.mode,
		steps: config.steps as any,
		results: indexedResults as any,
		stepStatuses: status.steps as any,
		dynamicChildren,
		dynamicGroupStatuses,
		currentFlatIndex: status.currentStep,
	});
	try { writeAtomicJson(statusPath, status); } catch (writeError) { console.error(`Failed to persist rejected async status: ${writeError}`); }

	const results = existingResults.length > 0
		? existingResults
		: statusSteps.map((step: Record<string, any>, index: number) => ({
			flatIndex: step.flatIndex ?? index,
			agent: step.agent ?? `step-${index + 1}`,
			output: "",
			error: step.error ?? terminalError,
			success: false,
			exitCode: step.exitCode ?? 1,
			...(step.gitBundle ? { gitBundle: step.gitBundle } : {}),
			...(step.teardownUnproven === true ? { teardownUnproven: true } : {}),
		}));
	if (forceAllChildrenFailed) {
		for (const child of results) {
			child.success = false;
			child.exitCode = child.exitCode === 0 ? 1 : (child.exitCode ?? 1);
			child.error = child.error ? `${child.error}\n${terminalError}` : terminalError;
		}
	}
	const result = {
		...(existing ?? {}),
		id: config.id,
		agent: existing?.agent ?? (results.length === 1 ? results[0]?.agent : `chain:${results.map((item: any) => item.agent).join("->")}`),
		mode: config.resultMode ?? existing?.mode ?? (results.length > 1 ? "chain" : "single"),
		success: false,
		state: teardownUnproven ? "running" : "failed",
		summary: existing?.summary ? `${existing.summary}\n\n${terminalError}` : terminalError,
		results,
		workflowGraph: status.workflowGraph,
		exitCode: 1,
		timestamp: now,
		durationMs: typeof status.startedAt === "number" ? Math.max(0, now - status.startedAt) : 0,
		cwd: config.cwd,
		asyncDir: config.asyncDir,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		...(config.controlIntercomTarget ? { intercomTarget: config.controlIntercomTarget } : {}),
		...(config.nestedRoute ? { nestedRoute: config.nestedRoute, nestedRouteRequired: true as const } : {}),
		...(config.nestedSelf ? { nestedSelf: config.nestedSelf } : {}),
		worktreeExecutionError: status.worktreeExecutionError,
		...(teardownUnproven ? { teardownUnproven: true } : {}),
	};
	try { writeAtomicJson(config.resultPath, result); } catch (writeError) { console.error(`Failed to persist rejected async result: ${writeError}`); }
	// A teardown fence remains actionable. Do not publish a terminal event that
	// would let nested cleanup/export treat this rejection as proof of shutdown.
	if (teardownUnproven) return;
	try {
		appendJsonl(path.join(config.asyncDir, "events.jsonl"), JSON.stringify({
			type: "subagent.run.completed",
			ts: now,
			runId: config.id,
			status: "failed",
			recovery: true,
			durationMs: result.durationMs,
		}));
	} catch (eventError) {
		console.error(`Failed to append rejected async completion event for '${config.id}':`, eventError);
	}
}

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	try {
		await runSubagentCore(config);
	} catch (error) {
			writeRejectedRunnerTerminal(config, error);
		console.error("Subagent runner error:", error);
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = JSON.parse(configJson) as SubagentRunConfig;
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		runSubagent(config).catch((runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		});
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			const config = JSON.parse(input) as SubagentRunConfig;
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}

}
