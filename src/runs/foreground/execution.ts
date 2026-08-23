/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import { resolveProjectLocalPiPackageResources } from "../../agents/pi-packages.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import {
	type AcceptanceFinalizationTurn,
	type AcceptanceLedger,
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type ResolvedAcceptanceConfig,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	TEMP_ARTIFACTS_DIR,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { getPiSpawnCommand, getPiSpawnEntrypointOverrideForTests } from "../shared/pi-spawn.ts";
import { createSandboxProvider } from "../../sandbox/provider.ts";
import { cancelScopedGitChildDescriptor, delegateScopedGitWriterDescriptor, exportIsolatedGitBundle, isInheritedIsolatedGitRuntime, mapIsolatedGitCwd, readScopedGitProcessIdentity, reserveScopedGitChildDescriptor, scopedGitDescriptorMounts, validateScopedGitChildDescriptor, waitForScopedGitChildRelease, waitForScopedGitProcessGone, type ScopedGitEndpointDescriptor } from "../../sandbox/isolated-git.ts";
import { resolveGitMode } from "../../sandbox/config.ts";
import { diagnoseSandboxFailure, sandboxResultDetails } from "../../sandbox/diagnostics.ts";
import type { SpawnableInvocation } from "../../sandbox/types.ts";
import { buildSubagentSandboxMounts } from "../../sandbox/mount-policy.ts";
import { inferSandboxCwdWritable } from "../../sandbox/write-inference.ts";
import { resolveSavedOutputPath, shouldPersistSavedOutput } from "../../shared/output-paths.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, isChildProcessGroupGone, processControlUnsupported, signalChildProcessGroup } from "../../shared/post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { resolveCandidateLaunchThinking, resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveFastModeStatus, shouldRequestFastMode } from "../../shared/fast-mode.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { appendSavedOutputSystemPrompt, captureSingleOutputSnapshot, formatSavedOutputReference, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import { writeSavedOutput } from "../../shared/output-paths.ts";
import { hasLiveNestedDescendantsForParent, projectNestedEvents, waitForNestedDescendantsToStop } from "../shared/nested-events.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
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
	resolveEffectiveAcceptance,
	shouldRunAcceptanceFinalization,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
		savedOutputAnnounced: result.savedOutputAnnounced,
	};
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		fastModeStatus?: import("../../shared/fast-mode.ts").FastModeStatus;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	// Authenticate the exact runtime-issued capability before resolving any
	// caller-controlled cwd/package/resource path. This gate deliberately comes
	// before mapIsolatedGitCwd, package discovery, and mount assembly.
	if (options.isolatedGit) {
		if (!options.isolatedGitCapability) throw new Error("isolated Git execution requires an explicit runtime-issued capability");
		options.isolatedGit.runtime.assertCapability(options.isolatedGitCapability, options.isolatedGit);
		options.isolatedGit.runtime.authorizeRequestedCwd(options.isolatedGitCapability, options.cwd ?? runtimeCwd);
	}
	// Model candidates already carry a thinking suffix only when that specific
	// model supports it. Keep the candidate authoritative across fallbacks.
	const modelArg = model;
	const requestedCwd = options.cwd ?? runtimeCwd;
	const childCwd = options.isolatedGit ? mapIsolatedGitCwd(options.isolatedGit, requestedCwd) : requestedCwd;
	let scopedGitEndpoint = options.isolatedGit && options.isolatedGitCapability
		? options.isolatedGit.runtime.getScopedGitEndpointDescriptor(options.isolatedGitCapability)
		: options.isolatedGitEndpoint;
	const reservedOwner = scopedGitEndpoint as (ScopedGitEndpointDescriptor & { __scopedGitReservationOwner?: ScopedGitEndpointDescriptor; __scopedGitReservationBound?: boolean }) | undefined;
	const scopedGitOwnerEndpoint = reservedOwner?.__scopedGitReservationOwner ?? scopedGitEndpoint;
	const preReserved = reservedOwner?.__scopedGitReservationBound === true;
	if (scopedGitEndpoint && !options.isolatedGit && !preReserved) {
		const requestedScopedCwd = options.cwd ? path.resolve(options.cwd) : undefined;
		const reservationDeadline = Date.now() + 15_000;
		while (true) {
			try {
					scopedGitEndpoint = await reserveScopedGitChildDescriptor(scopedGitEndpoint, { cwd: requestedScopedCwd, rights: options.isolatedGitRights ?? "writer" });
				break;
			} catch (error) {
				if (!/already delegated|already held/i.test(error instanceof Error ? error.message : String(error)) || Date.now() >= reservationDeadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
	}
	if (preReserved && scopedGitOwnerEndpoint && options.isolatedGitEndpoint !== scopedGitOwnerEndpoint) {
		// The first attempt consumed a runSync preflight reservation. Subsequent
		// acceptance/fallback attempts must reserve a fresh child from its owner.
		options.isolatedGitEndpoint = scopedGitOwnerEndpoint;
	}
	// A writable reservation is cancelled only when spawn/setup fails before the
	// foreground process can be bound. Once bind succeeds, every failure path is
	// fail-closed until exact process-group disappearance is proven by the owner.
	const scopedGitWriterReserved = Boolean(scopedGitEndpoint && options.isolatedGitEndpoint && !options.isolatedGit && options.isolatedGitRights !== "read-only");
	let scopedGitWriterBound = false;
	const cancelUnboundScopedWriter = async () => {
		if (!scopedGitWriterReserved || scopedGitWriterBound || !scopedGitEndpoint) return;
		if (!scopedGitOwnerEndpoint) return;
		try { await cancelScopedGitChildDescriptor(scopedGitOwnerEndpoint, scopedGitEndpoint); } catch { /* owner remains fail-closed if cancellation cannot be proven */ }
	};
	const projectLocalPackageResources = options.sandbox?.packageDiscovery === "project-local"
		// Package discovery belongs to the requested parent repository context;
		// the private worktree contains only assigned Git content and may not carry
		// the parent's package installation.
		? resolveProjectLocalPiPackageResources(requestedCwd)
		: undefined;
	const closedSandboxRuntime = Boolean(options.sandbox && options.sandbox.packageDiscovery !== "ambient");
	const effectiveSavedOutputPath = options.savedOutputPath
		?? (options.runId && shouldPersistSavedOutput({ output: options.outputPath, outputMode: options.outputMode })
			? resolveSavedOutputPath({ runtimeCwd, requestedCwd: options.cwd, agent: agent.name, runId: options.runId, index: options.index })
			: undefined);
	const effectiveSystemPrompt = appendSavedOutputSystemPrompt(shared.systemPrompt, {
		outputPath: options.outputPath,
		savedOutputPath: effectiveSavedOutputPath,
	});
	const sandboxIntercomBridgeApplies = effectiveSystemPrompt.includes(INTERCOM_BRIDGE_MARKER);
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		fastMode: shouldRequestFastMode(shared.fastModeStatus),
		thinking: resolveCandidateLaunchThinking(model, agent.thinking),
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		packageExtensions: projectLocalPackageResources?.extensions,
		systemPrompt: effectiveSystemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: childCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		// Foreground nested launches carry only the scoped endpoint descriptor.
		scopedGitEndpoint,
		structuredOutput: options.structuredOutput,
		sandbox: closedSandboxRuntime,
		sandboxIntercomExtensionDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? options.sandboxIntercomBridge?.extensionDir : undefined,
		sandboxIntercomStateDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? options.sandboxIntercomBridge?.stateDir : undefined,
	});

	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		thinking: resolveCandidateLaunchThinking(modelArg, agent.thinking),
		fastMode: shared.fastModeStatus,
		// An authorized provider:none launch is intentionally visible in the
		// result. Never let a host-Git checkout look like an isolated run.
		...(options.hostGitDiagnostic === true && !options.sandbox ? {
			sandbox: {
				provider: "none",
				gitMode: "read-only",
				profile: "host",
				network: "host",
				auth: "none",
				fallbackMode: "none",
				fallbackOccurred: false,
				diagnostics: [{ level: "warning" as const, message: "NO ISOLATION: this child is using the host checkout and host Git metadata. Changes are not protected by a managed isolated worktree." }],
			},
		} : {}),
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	let observedMutationAttempt = false;
	let spawnSpec: SpawnableInvocation;
	let effectiveSandboxMounts: ReturnType<typeof buildSubagentSandboxMounts> = [];
	try {
		const piSpawnSpec = getPiSpawnCommand(args, {
			preferNodeCli: true,
			entrypointOverride: getPiSpawnEntrypointOverrideForTests(),
		});
		const piInvocation: SpawnableInvocation = {
			command: piSpawnSpec.command,
			args: piSpawnSpec.args,
			cwd: childCwd,
			env: spawnEnv,
		};
		if (options.sandbox && resolveGitMode(options.sandbox) === "isolated" && !options.isolatedGit && !options.isolatedGitEndpoint) {
			throw new Error("isolated Git requires a runtime-managed isolated worktree handle; refusing ordinary checkout execution");
		}
		if (options.isolatedGit) {
			// Authenticate capability identity before any caller-controlled resource
			// path is handed to mount-policy construction. The runtime handoff was
			// also serialized into the child environment above, so this is the final
			// in-process fail-closed gate for direct runSync callers.
			if (!options.isolatedGitCapability) {
				throw new Error("isolated Git execution requires an explicit runtime-issued capability");
			}
			if (!options.sandbox || options.sandbox.provider !== "bubblewrap" || resolveGitMode(options.sandbox) !== "isolated") {
				throw new Error("isolated Git requires the Bubblewrap sandbox and an explicit isolated Git mode");
			}
			result.sandbox = sandboxResultDetails(options.sandbox);
			effectiveSandboxMounts = buildSubagentSandboxMounts({
				cwd: childCwd,
				includeCwd: false,
				tempDir,
				sessionDir: options.sessionDir,
				sessionFile: options.sessionFile,
				artifactsDir: options.artifactsDir,
				jsonlPath: shared.jsonlPath,
				outputPath: options.outputPath,
				progressPaths: options.progressPaths,
				structuredOutput: options.structuredOutput,
				piArgs: args,
				spawnCommand: piSpawnSpec.command,
				spawnArgs: piSpawnSpec.args,
				authMode: options.sandbox.auth,
				packageRoots: projectLocalPackageResources?.packageRoots,
				extraReadOnlyMounts: options.sandbox.extraReadOnlyMounts,
				extraWritableMounts: options.sandbox.extraWritableMounts,
				protectedGitPaths: options.isolatedGit.runtime.getProtectedMountPaths(options.isolatedGit),
				intercomStateDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? options.sandboxIntercomBridge?.stateDir : undefined,
				nestedRoute: options.nestedRoute,
			});
			const wrapped = options.isolatedGit.runtime.wrapInvocation(options.isolatedGitCapability, piInvocation, effectiveSandboxMounts, options.sandbox);
			spawnSpec = {
				command: wrapped.command,
				args: wrapped.args,
				cwd: wrapped.cwd ?? childCwd,
				env: wrapped.env ?? spawnEnv,
			};
		} else if (options.isolatedGitEndpoint) {
			if (!options.sandbox || options.sandbox.provider !== "bubblewrap" || resolveGitMode(options.sandbox) !== "isolated") throw new Error("scoped Git endpoint requires Bubblewrap isolated mode");
			result.sandbox = sandboxResultDetails(options.sandbox);
			effectiveSandboxMounts = buildSubagentSandboxMounts({
				cwd: childCwd,
				includeCwd: true,
				cwdMode: options.isolatedGitRights === "writer" ? "rw" : "ro",
				tempDir,
				sessionDir: options.sessionDir,
				sessionFile: options.sessionFile,
				artifactsDir: options.artifactsDir,
				jsonlPath: shared.jsonlPath,
				outputPath: options.outputPath,
				progressPaths: options.progressPaths,
				structuredOutput: options.structuredOutput,
				piArgs: args,
				spawnCommand: piSpawnSpec.command,
				spawnArgs: piSpawnSpec.args,
				authMode: options.sandbox.auth,
				packageRoots: projectLocalPackageResources?.packageRoots,
				extraReadOnlyMounts: options.sandbox.extraReadOnlyMounts,
				extraWritableMounts: options.sandbox.extraWritableMounts,
				intercomStateDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? options.sandboxIntercomBridge?.stateDir : undefined,
				nestedRoute: options.nestedRoute,
			});
			const provider = createSandboxProvider(options.sandbox);
			const wrapped = provider.wrapInvocation({ config: options.sandbox, invocation: piInvocation, mounts: [...effectiveSandboxMounts, ...scopedGitDescriptorMounts(scopedGitEndpoint!)] });
			spawnSpec = { command: wrapped.invocation.command, args: wrapped.invocation.args, cwd: wrapped.invocation.cwd ?? childCwd, env: wrapped.invocation.env ?? spawnEnv };
		} else if (options.sandbox) {
			result.sandbox = sandboxResultDetails(options.sandbox);
			const provider = createSandboxProvider(options.sandbox);
			const cwdMode = inferSandboxCwdWritable({
				agentName: agent.name,
				tools: agent.tools,
				sandbox: options.sandbox,
			}) ? "rw" : "ro";
			const sandboxInvocation: SpawnableInvocation = {
				command: piSpawnSpec.command,
				args: piSpawnSpec.args,
				cwd: childCwd,
			};
			effectiveSandboxMounts = buildSubagentSandboxMounts({
				cwd: childCwd,
				cwdMode,
				gitMode: options.sandbox.gitMode,
				tempDir,
				sessionDir: options.sessionDir,
				sessionFile: options.sessionFile,
				artifactsDir: options.artifactsDir,
				jsonlPath: shared.jsonlPath,
				outputPath: options.outputPath,
				progressPaths: options.progressPaths,
				structuredOutput: options.structuredOutput,
				piArgs: args,
				spawnCommand: piSpawnSpec.command,
				spawnArgs: piSpawnSpec.args,
				authMode: options.sandbox.auth,
				packageRoots: projectLocalPackageResources?.packageRoots,
				extraReadOnlyMounts: options.sandbox.extraReadOnlyMounts,
				extraWritableMounts: options.sandbox.extraWritableMounts,
				intercomStateDir: closedSandboxRuntime && sandboxIntercomBridgeApplies ? options.sandboxIntercomBridge?.stateDir : undefined,
				nestedRoute: options.nestedRoute,
			});
			const wrapped = provider.wrapInvocation({
				config: options.sandbox,
				invocation: sandboxInvocation,
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
			result.sandbox = sandboxResultDetails(options.sandbox, wrapped);
			const diagnosticMessages = wrapped.diagnostics
				.filter((diagnostic) => diagnostic.level !== "info")
				.map((diagnostic) => diagnostic.message);
			appendRecentOutput(progress, diagnosticMessages);
			spawnSpec = {
				command: wrapped.invocation.command,
				args: wrapped.invocation.args,
				cwd: wrapped.invocation.cwd ?? childCwd,
				env: wrapped.invocation.env ?? spawnEnv,
			};
		} else {
			spawnSpec = piInvocation;
		}
	} catch (error) {
		await cancelUnboundScopedWriter();
		cleanupTempDir(tempDir);
		const message = error instanceof Error ? error.message : String(error);
		if (options.sandbox) result.sandbox = sandboxResultDetails(options.sandbox);
		result.exitCode = 1;
		result.error = `Sandbox setup failed: ${message}`;
		progress.status = "failed";
		progress.error = result.error;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = { toolCount: 0, tokens: 0, durationMs: progress.durationMs };
		return result;
	}

	let detachedTerminalPromise: Promise<void> | undefined;
	const exitCode = await new Promise<number>((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: spawnSpec.cwd ?? childCwd,
				env: spawnSpec.env ?? spawnEnv,
				stdio: ["ignore", "pipe", "pipe"],
				// Keep the child tree in a private process group so interrupts do not
				// leave shells or tool workers behind.
				detached: process.platform === "linux",
				windowsHide: true,
			});
		} catch (error) {
			void cancelUnboundScopedWriter();
			cleanupTempDir(tempDir);
			result.exitCode = 1;
			result.error = error instanceof Error ? error.message : String(error);
			progress.status = "failed";
			progress.error = result.error;
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = { toolCount: 0, tokens: 0, durationMs: progress.durationMs };
			resolve(1);
			return;
		}
		// A nested writer is bound only after the child process identity is
		// independently proven. The foreground result is held until both binding
		// and exact reservation release are observable; a fast child cannot win
		// the close/bind race.
		let scopedGitBindingReady = !scopedGitWriterReserved;
		let pendingScopedTerminalClose: { code: number | null; signal?: NodeJS.Signals } | undefined;
		if (scopedGitWriterReserved && scopedGitEndpoint) {
			void (async () => {
				let identity;
				let previousIdentityKey: string | undefined;
				for (let attempt = 0; attempt < 150 && !identity; attempt += 1) {
					const current = readScopedGitProcessIdentity(proc.pid!);
					const currentKey = current && `${current.startToken}:${current.ppid}:${current.pgid}:${current.argv.join("\\0")}`;
					if (current && currentKey === previousIdentityKey) identity = current;
					previousIdentityKey = currentKey;
					if (!identity) await new Promise((resolve) => setTimeout(resolve, 2));
				}
				try {
					if (!identity) throw new Error("exact child identity was not observed before process exit");
					await delegateScopedGitWriterDescriptor(scopedGitEndpoint, identity);
					scopedGitWriterBound = true;
					await waitForScopedGitProcessGone(identity);
					if (scopedGitOwnerEndpoint) await waitForScopedGitChildRelease(scopedGitOwnerEndpoint, scopedGitEndpoint);
				} catch (error) {
					// A missed identity, reuse, or release proof is fail-closed. Cancel
					// only an unbound reservation; bound reservations remain recoverable.
					const detail = error instanceof Error ? error.message : String(error);
					result.error = `Scoped Git writer teardown was not proven: ${detail}`;
					result.exitCode = 1;
					if (options.isolatedGitEndpoint && !options.isolatedGit) {
						result.teardownUnproven = true;
						result.error += "; recover retained isolated worktree evidence through the owning parent run";
					}
					if (!scopedGitWriterBound) await cancelUnboundScopedWriter();
				} finally {
					scopedGitBindingReady = true;
					if (pendingScopedTerminalClose) {
						const pending = pendingScopedTerminalClose;
						pendingScopedTerminalClose = undefined;
						queueMicrotask(() => proc.emit("close", pending.code, pending.signal));
					}
				}
			})();
		}
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		let detachedTerminalNotified = false;
		let intercomStarted = false;
		let assistantError: string | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;

		const notifyDetachedTerminal = () => {
			if (!detached || detachedTerminalNotified) return;
			detachedTerminalNotified = true;
			detachedTerminalPromise = Promise.resolve(options.onDetachedTerminal?.(result)).catch((error) => {
				// A terminal projection/export failure is part of the child result, not
				// an ignorable detached callback failure. Keep the runtime recoverable
				// and make the original caller-visible terminal error durable.
				const message = `Detached terminal projection failed: ${error instanceof Error ? error.message : String(error)}`;
				result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
				result.error = result.error ? `${result.error}\n${message}` : message;
				progress.status = "failed";
				progress.error = result.error;
				result.progress = progress;
				options.onUpdate?.({
					content: [{ type: "text", text: result.error }],
					details: { mode: "single", results: [snapshotResult(result, snapshotProgress(progress))], progress: [snapshotProgress(progress)] },
				});
			});
		};

		const resolveAcknowledgement = (code: number) => {
			if (settled) return;
			// A detached acknowledgement settles the caller-facing promise, but it
			// deliberately does not tear down the child streams or post-exit guard.
			settled = true;
			resolve(code);
		};

		const detachForIntercom = () => {
			detached = true;
			// The acknowledgement resolves the foreground request immediately, but
			// the child remains attached to its stdio listeners until close. This is
			// what lets the terminal callback receive the actual output/exit/error.
			result.detached = true;
			result.detachedReason = "intercom coordination";
			progress.status = "detached";
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = {
				toolCount: progress.toolCount,
				tokens: progress.tokens,
				durationMs: progress.durationMs,
			};
			options.onDetachedStarted?.(result);
			resolveAcknowledgement(-2);
		};

		// If the child emits a terminal assistant stop but never exits,
		// give it a short grace period to flush naturally, then clean it up.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let abortKillTimer: NodeJS.Timeout | undefined;
		let interruptTermTimer: NodeJS.Timeout | undefined;
		let interruptKillTimer: NodeJS.Timeout | undefined;
		let interruptKillExecuted = false;
		let mandatoryKillExecuted = false;
		let terminalCloseHandled = false;
		let pendingTerminalClose: { code: number | null; signal?: NodeJS.Signals } | undefined;
		let teardownReady = process.platform !== "linux";
		let teardownFailureReason: string | undefined;
		const releaseTeardown = () => {
			teardownReady = true;
			if (!pendingTerminalClose || terminalCloseHandled) return;
			const pending = pendingTerminalClose;
			pendingTerminalClose = undefined;
			queueMicrotask(() => proc.emit("close", pending.code, pending.signal));
		};
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
			if (abortKillTimer) {
				clearTimeout(abortKillTimer);
				abortKillTimer = undefined;
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
		const startFinalDrain = () => {
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (processClosed) return;
				const termSent = signalChildProcessGroup(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !assistantError) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (isChildProcessGroupGone(proc)) return;
					mandatoryKillExecuted = true;
					forcedTerminationSignal = signalChildProcessGroup(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed || !intercomStarted) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			detachForIntercom();
		});

		let resourcesCleaned = false;
		const cleanupResources = () => {
			if (resourcesCleaned) return;
			resourcesCleaned = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
		};

		const finish = (code: number) => {
			if (settled) return;
			resolveAcknowledgement(code);
			cleanupResources();
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		let activeLongRunningNotified = false;
		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		const mutatingFailures = createMutatingFailureState();
		let mutatingFailureAttentionActive = false;
		const mutatingFailureWindowMs = 5 * 60_000;
		const currentToolDurationMs = (now: number) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
		const hasLiveNestedActivity = (): boolean => {
			if (!options.nestedRoute) return false;
			try {
				const registry = projectNestedEvents(options.nestedRoute);
				return hasLiveNestedDescendantsForParent(registry.children, options.runId, options.index ?? 0);
			} catch {
				return false;
			}
		};
		const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
			if (!controlConfig.enabled) return false;
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			const event = buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				message: input.message,
				reason: input.reason ?? "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: input.currentTool ?? progress.currentTool,
				currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
				currentPath: input.currentPath ?? progress.currentPath,
				recentFailureSummary: input.recentFailureSummary,
			});
			emitControlEvent(event);
			return previous !== "needs_attention";
		};
		const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
			if (!controlConfig.enabled || activeLongRunningNotified || progress.activityState === "needs_attention") return false;
			activeLongRunningNotified = true;
			const previous = progress.activityState;
			progress.activityState = "active_long_running";
			emitControlEvent(buildControlEvent({
				type: "active_long_running",
				from: previous,
				to: "active_long_running",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				message: `${agent.name} is still active but long-running`,
				reason,
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: progress.currentTool,
				currentToolDurationMs: currentToolDurationMs(now),
				currentPath: progress.currentPath,
				elapsedMs: now - startTime,
			}));
			return true;
		};
		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				// When a foreground parent is waiting on a sync nested subagent,
				// treat it as active rather than idle (issue #47).
				if (hasLiveNestedActivity()) {
					if (progress.activityState === "needs_attention" && !mutatingFailureAttentionActive) {
						progress.activityState = undefined;
						return true;
					}
					return false;
				}
				return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: startTime,
				now,
				turns: result.usage.turns,
				tokens: progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		};


		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			const controlEvents = drainPendingControlEvents();
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents,
				},
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			emitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
					? evt.args as Record<string, unknown>
					: {};
				if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {
					intercomStarted = true;
				}
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				const mutates = isMutatingTool(evt.toolName, toolArgs);
				observedMutationAttempt = observedMutationAttempt || mutates;
				pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates, startedAt: now };
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (evt.message.model) result.model = evt.message.model;
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					if (stopReason === "stop" && !hasToolCall) {
						if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						startFinalDrain();
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages.push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
				appendRecentOutput(progress, resultText.split("\n").slice(-10));
				const toolSnapshot = pendingToolResult;
				pendingToolResult = undefined;
				if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
					recordMutatingFailure(mutatingFailures, {
						tool: toolSnapshot.tool,
						path: toolSnapshot.path,
						error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
						ts: now,
					}, mutatingFailureWindowMs);
					if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
						mutatingFailureAttentionActive = true;
						emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							currentTool: toolSnapshot.tool,
							currentPath: toolSnapshot.path,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					}
				} else if (toolSnapshot?.mutates) {
					resetMutatingFailureState(mutatingFailures);
					mutatingFailureAttentionActive = false;
				}
				fireUpdate();
			}
		};

		if (controlConfig.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled || detached) return;
				const now = Date.now();
				if (updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		let stderrBuf = "";

		const clearStdioGuard = attachPostExitStdioGuard(proc, {
			idleMs: 2000,
			// Detached terminal publication is bounded independently from the
			// wrapper's close event; three seconds matches the child escalation
			// deadline while retaining identity-checked TERM -> KILL teardown.
			hardMs: 3000,
			killProcessGroupOnCutoff: process.platform === "linux",
			onHardCutoff: () => { mandatoryKillExecuted = true; },
			onTeardownComplete: releaseTeardown,
			onTeardownFailure: (reason) => {
				teardownFailureReason = reason;
				result.teardownUnproven = true;
				if (options.isolatedGit) {
					// A refused/unknown group is not terminal proof. Fence the isolated
					// runtime before synthetic close can unlock export or cleanup.
					options.isolatedGit.runtime.markExportFenceFailed();
					const recovery = `Teardown failed before isolated Git cleanup could be proven; recover isolated worktree at ${options.isolatedGit.runtime.root}`;
					result.error = result.error ? `${result.error}\n${recovery}` : recovery;
					result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
				}
				releaseTeardown();
			},
		});
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			childExited = true;
			// Preserve owed interrupt/final-drain escalation; wrapper exit is not
			// proof that the detached process group has disappeared.
			if (!interruptedByControl && !finalDrainTimer && !finalHardKillTimer) clearFinalDrainTimers();
		});
		const attachFailureDiagnostics = (message?: string): void => {
			if (!result.sandbox || !options.sandbox) return;
			const diagnostics = diagnoseSandboxFailure({
				stderr: stderrBuf,
				error: message,
				mounts: effectiveSandboxMounts,
				cwd: childCwd,
			});
			if (diagnostics.length === 0) return;
			result.sandbox = {
				...result.sandbox,
				diagnostics: [...(result.sandbox.diagnostics ?? []), ...diagnostics],
			};
		};

		proc.on("close", (code, signal) => {
			if (terminalCloseHandled) return;
			if (!scopedGitBindingReady) {
				pendingScopedTerminalClose ??= { code, signal: signal ?? undefined };
				return;
			}
			if (!teardownReady) {
				pendingTerminalClose ??= { code, signal: signal ?? undefined };
				return;
			}
			terminalCloseHandled = true;
			clearFinalDrainTimers();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (detached) {
				// Unlike the immediate acknowledgement path, this is the durable
				// terminal projection. Drain the final buffered event and preserve the
				// real process outcome before notifying the owning orchestrator.
				if (buf.trim()) processLine(buf);
				if (teardownFailureReason) result.error = result.error ? `${result.error}\nTeardown failed: ${teardownFailureReason}` : `Teardown failed: ${teardownFailureReason}`;
				if (!result.error && assistantError) result.error = assistantError;
				const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
				if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
					result.error = stderrBuf.trim();
				}
				const finalCode = teardownFailureReason ? 1 : forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
				if (finalCode === 0 && !result.error) {
					const errInfo = detectSubagentError(result.messages);
					if (errInfo.hasError) {
						result.error = errInfo.details
							? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
							: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
					}
				}
			result.exitCode = result.error ? (finalCode === 0 ? 1 : finalCode) : finalCode;
			if ((result.exitCode !== 0 || result.error) && options.sandbox) attachFailureDiagnostics(result.error);
				result.detached = undefined;
				result.detachedReason = undefined;
				result.finalOutput = getFinalOutput(result.messages) || (result.error ? "" : result.finalOutput);
				progress.status = result.exitCode === 0 ? "completed" : "failed";
				progress.error = result.error;
				progress.durationMs = Date.now() - startTime;
				result.progressSummary = {
					toolCount: progress.toolCount,
					tokens: progress.tokens,
					durationMs: progress.durationMs,
				};
				processClosed = true;
				cleanupResources();
				notifyDetachedTerminal();
				return;
			}
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (teardownFailureReason) result.error = result.error ? `${result.error}\nTeardown failed: ${teardownFailureReason}` : `Teardown failed: ${teardownFailureReason}`;
			if (!result.error && assistantError) result.error = assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
				result.error = stderrBuf.trim();
			}
			const finalCode = teardownFailureReason ? 1 : forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			if ((finalCode !== 0 || result.error) && options.sandbox) {
				attachFailureDiagnostics(result.error);
			}
			finish(finalCode);
		});
		proc.on("error", (error) => {
			void cancelUnboundScopedWriter();
			if (terminalCloseHandled) return;
			if (!teardownReady) {
				pendingTerminalClose ??= { code: 1, signal: undefined };
				return;
			}
			terminalCloseHandled = true;
			clearFinalDrainTimers();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			attachFailureDiagnostics(result.error);
			if (detached) {
				result.detached = undefined;
				result.detachedReason = undefined;
				result.exitCode = 1;
				progress.status = "failed";
				progress.error = result.error;
				processClosed = true;
				cleanupResources();
				notifyDetachedTerminal();
				return;
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || detached) return;
				if (options.allowIntercomDetach && intercomStarted && !detached) {
					detachForIntercom();
					return;
				}
				const termSent = signalChildProcessGroup(proc, "SIGTERM");
				if (!termSent) return;
				abortKillTimer = setTimeout(() => {
					abortKillTimer = undefined;
					if (isChildProcessGroupGone(proc)) return;
					mandatoryKillExecuted = true;
					signalChildProcessGroup(proc, "SIGKILL");
				}, 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (processClosed || detached || settled) return;
				interruptedByControl = true;
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				signalChildProcessGroup(proc, "SIGINT");
				interruptTermTimer = setTimeout(() => {
					interruptTermTimer = undefined;
					if (processClosed) return;
					const termSent = signalChildProcessGroup(proc, "SIGTERM");
					if (!termSent) return;
					interruptKillTimer = setTimeout(() => {
						interruptKillTimer = undefined;
						if (processClosed) return;
						interruptKillExecuted = true;
						mandatoryKillExecuted = true;
						signalChildProcessGroup(proc, "SIGKILL");
					}, 3000);
				}, 1000);
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}
	});
	result.exitCode = exitCode;
	if (detachedTerminalPromise) await detachedTerminalPromise;
	if (interruptedByControl && !result.teardownUnproven) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.detached) {
		result.exitCode = 0;
		result.finalOutput = "Detached for intercom coordination.";
		return result;
	}

	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const acceptanceOutput = getFinalOutput(result.messages);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if ((options.outputPath || effectiveSavedOutputPath) && result.exitCode === 0) {
		const announceSavedOutput = Boolean(options.outputPath) || options.outputMode === "file-only";
		const resolvedOutput = options.outputPath
			? resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot)
			: { fullOutput };
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		let savedOutputPath = options.outputMode === "file-only" ? resolvedOutput.savedPath : undefined;
		let savedOutputContent = fullOutput;
		let outputSaveError = resolvedOutput.saveError;
		if (effectiveSavedOutputPath) {
			try {
				const saved = writeSavedOutput({
					targetPath: effectiveSavedOutputPath,
					agent: agent.name,
					runId: options.runId,
					index: options.index,
					content: fullOutput,
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
			savedOutputContent = fullOutput;
		}
		result.savedOutputPath = savedOutputPath;
		result.savedOutputAnnounced = announceSavedOutput;
		result.outputSaveError = outputSaveError;
		if (savedOutputPath) {
			result.outputReference = formatSavedOutputReference(savedOutputPath, savedOutputContent);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: allControlEvents.length ? allControlEvents : undefined,
			},
		});
	}
	return result;
}

async function runAcceptanceFinalizationLoop(input: {
	runtimeCwd: string;
	agent: AgentConfig;
	result: SingleResult;
	initialLedger: AcceptanceLedger;
	initialOutput: string;
	acceptance: ResolvedAcceptanceConfig;
	options: RunSyncOptions;
	systemPrompt: string;
	resolvedSkillNames?: string[];
	skillsWarning?: string;
}): Promise<AcceptanceLedger> {
	const sessionFile = input.result.sessionFile ?? input.options.sessionFile;
	const maxTurns = input.acceptance.finalization.maxTurns;
	const turns: AcceptanceFinalizationTurn[] = [];
	if (!sessionFile) {
		const message = "Acceptance finalization requires a session file for same-session continuation.";
		turns.push(createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message }));
		return buildFinalizationProcessFailureLedger({ initialLedger: input.initialLedger, turns, maxTurns, message });
	}

	const selfReviewAcceptance = acceptanceSelfReviewConfig(input.acceptance);
	let previousFailure = acceptanceFailureMessage(input.initialLedger);
	let authoritativeLedger = input.initialLedger;
	for (let turn = 1; turn <= maxTurns; turn++) {
		const prompt = formatAcceptanceFinalizationPrompt({
			acceptance: input.acceptance,
			initialOutput: input.initialOutput,
			initialLedger: input.initialLedger,
			turn,
			maxTurns,
			...(previousFailure ? { previousFailure } : {}),
		});
		const finalizationOptions: RunSyncOptions = {
			...input.options,
			sessionFile,
			outputMode: "inline",
			// Acceptance continuation remains inside the same authenticated isolated
			// checkout; never fall back to an ordinary read-only mount here.
			isolatedGit: input.options.isolatedGit,
			isolatedGitCapability: input.options.isolatedGitCapability,
			isolatedGitEndpoint: input.options.isolatedGitEndpoint,
			isolatedGitRights: input.options.isolatedGitRights,
		};
		delete finalizationOptions.sessionDir;
		delete finalizationOptions.outputPath;
		delete finalizationOptions.structuredOutput;
		delete finalizationOptions.onUpdate;
		finalizationOptions.allowIntercomDetach = false;
		// Child telemetry can report a provider-local model id (for example
		// `openai/gpt-4o`) even when the configured candidate was explicitly
		// routed through `openrouter/openai/gpt-4o`. Finalization must continue
		// with the configured/attempted candidate, not that telemetry label.
		const finalizationModel = input.result.modelAttempts?.find((attempt) => attempt.success)?.model
			?? input.result.attemptedModels?.at(-1)
			?? input.options.modelOverride
			?? input.agent.model
		// Continuation is another provider request. Reuse the successful
		// candidate's status when available; resolving from the configured
		// candidate is the fallback for older/incomplete result metadata.
		const finalizationFastModeStatus = input.result.modelAttempts?.find((attempt) => attempt.success && attempt.model === finalizationModel)?.fastMode
			?? resolveFastModeStatus(
				input.options.fastMode ?? input.agent.fastMode,
				finalizationModel,
				input.options.availableModels,
				input.options.preferredModelProvider,
			);
		const finalizationResult = await runSingleAttempt(
			input.runtimeCwd,
			input.agent,
			prompt,
			applyThinkingSuffix(finalizationModel, input.result.thinking),
			finalizationOptions,
			{
				sessionEnabled: true,
				systemPrompt: input.systemPrompt,
				resolvedSkillNames: input.resolvedSkillNames,
				skillsWarning: input.skillsWarning,
				fastModeStatus: finalizationFastModeStatus,
				attemptNotes: [],
				originalTask: prompt,
			},
		);
		// Keep the public aggregate truthful about the candidate used for both
		// the initial request and same-session continuation. Provider activation
		// remains unknown because Pi does not expose an authoritative response
		// flag through this interface.
		input.result.fastMode = finalizationResult.fastMode ?? finalizationFastModeStatus;
		sumUsage(input.result.usage, finalizationResult.usage);
		input.result.progressSummary = {
			toolCount: (input.result.progressSummary?.toolCount ?? 0) + (finalizationResult.progressSummary?.toolCount ?? 0),
			tokens: input.result.usage.input + input.result.usage.output,
			durationMs: (input.result.progressSummary?.durationMs ?? 0) + (finalizationResult.progressSummary?.durationMs ?? 0),
		};
		if (finalizationResult.controlEvents?.length) {
			input.result.controlEvents = [...(input.result.controlEvents ?? []), ...finalizationResult.controlEvents];
		}
		const rawOutput = acceptanceOutputByResult.get(finalizationResult) ?? getFinalOutput(finalizationResult.messages) ?? finalizationResult.finalOutput ?? "";
		if (finalizationResult.interrupted) {
			input.result.interrupted = true;
			input.result.exitCode = finalizationResult.exitCode;
			input.result.error = finalizationResult.error ?? "Acceptance finalization interrupted.";
			if (input.result.progress) {
				input.result.progress.status = "paused";
				input.result.progress.error = input.result.error;
			}
		}
		if (finalizationResult.error || finalizationResult.interrupted || finalizationResult.detached || (finalizationResult.exitCode !== 0 && !rawOutput.trim())) {
			const message = finalizationResult.error ?? "Acceptance finalization turn did not complete successfully.";
			turns.push(createFinalizationProcessFailureTurn({ turn, prompt, rawOutput, message }));
			return buildFinalizationProcessFailureLedger({ initialLedger: input.initialLedger, turns, maxTurns, message });
		}
		const selfReviewLedger = await evaluateAcceptance({
			acceptance: selfReviewAcceptance,
			output: rawOutput,
			cwd: input.options.cwd ?? input.runtimeCwd,
		});
		authoritativeLedger = selfReviewLedger;
		turns.push(createFinalizationTurn({ turn, prompt, rawOutput, ledger: selfReviewLedger }));
		const failure = acceptanceFailureMessage(selfReviewLedger);
		if (!failure) {
			authoritativeLedger = input.acceptance === selfReviewAcceptance
				? selfReviewLedger
				: await evaluateAcceptance({
					acceptance: input.acceptance,
					output: rawOutput,
					cwd: input.options.cwd ?? input.runtimeCwd,
				});
			return attachFinalizationToLedger({ initialLedger: input.initialLedger, authoritativeLedger, turns, status: "completed", maxTurns });
		}
		previousFailure = failure;
	}
	return attachFinalizationToLedger({ initialLedger: input.initialLedger, authoritativeLedger, turns, status: "failed", maxTurns });
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	// This gate must precede saved-output, skill, artifact, cwd, and package
	// resolution performed by runSync itself—not only the eventual spawn path.
	if (options.isolatedGit) {
		if (!options.isolatedGitCapability) throw new Error("isolated Git execution requires an explicit runtime-issued capability");
		options.isolatedGit.runtime.assertCapability(options.isolatedGitCapability, options.isolatedGit);
		// Authorize the caller's exact requested cwd before resolving saved output,
		// acceptance/session paths, skills, artifacts, or any other filesystem input.
		options.isolatedGit.runtime.authorizeRequestedCwd(options.isolatedGitCapability, options.cwd ?? runtimeCwd);
	}
	if (options.isolatedGitEndpoint) {
		const ownerEndpoint = options.isolatedGitEndpoint;
		await validateScopedGitChildDescriptor(ownerEndpoint, {
			cwd: options.cwd ? path.resolve(options.cwd) : undefined,
			rights: options.isolatedGitRights ?? "writer",
		});
		// Reserve the child scope before resolving output, skills, artifacts,
		// sessions, or package resources. The marker is non-enumerable and never
		// crosses the Pi process boundary; it prevents runSingleAttempt from
		// reserving a second scope for the first attempt.
		const reservedEndpoint = await reserveScopedGitChildDescriptor(ownerEndpoint, {
			cwd: options.cwd ? path.resolve(options.cwd) : undefined,
			rights: options.isolatedGitRights ?? "writer",
		});
		Object.defineProperties(reservedEndpoint, {
			__scopedGitReservationOwner: { value: ownerEndpoint, enumerable: false, configurable: true },
			__scopedGitReservationBound: { value: true, enumerable: false, configurable: true },
		});
		options = { ...options, isolatedGitEndpoint: reservedEndpoint };
	}
	const processControlError = processControlUnsupported();
	if (processControlError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: processControlError,
		};
	}
	const implicitSavedOutputPath = options.savedOutputPath
		?? (options.runId && shouldPersistSavedOutput({ output: options.outputPath, outputMode: options.outputMode })
			? resolveSavedOutputPath({ runtimeCwd, requestedCwd: options.cwd, agent: agentName, runId: options.runId, index: options.index })
			: undefined);
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath ?? implicitSavedOutputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
		dynamic: options.acceptanceContext?.dynamic,
		dynamicGroup: options.acceptanceContext?.dynamicGroup,
		agentAcceptanceSelfReview: agent.acceptanceSelfReview,
		agentAcceptanceMaxFinalizationTurns: agent.acceptanceMaxFinalizationTurns,
	});
	if (shouldRunAcceptanceFinalization(effectiveAcceptance) && !options.sessionFile) {
		const sessionDir = options.sessionDir ?? mkdtempSync(path.join(os.tmpdir(), "pi-subagent-finalization-"));
		options.sessionFile = path.join(sessionDir, "session.jsonl");
	}
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		agent.thinking,
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
				writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const fastModeStatus = resolveFastModeStatus(
			options.fastMode ?? agent.fastMode,
			candidate,
			options.availableModels,
			options.preferredModelProvider,
		);
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, options, {
			fastModeStatus,
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		});
		if (options.signal?.aborted && !result.interrupted) result.cancelled = true;
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: candidate ?? result.model ?? agent.model ?? "default",
			success: attemptSucceeded,
			fastMode: result.fastMode,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				fastMode: result.fastMode,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	const initialAcceptanceOutput = acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "";
	const acceptanceForInitialReport = shouldRunAcceptanceFinalization(effectiveAcceptance)
		? acceptanceSelfReviewConfig(effectiveAcceptance)
		: effectiveAcceptance;
	const initialAcceptance = await evaluateAcceptance({
		acceptance: acceptanceForInitialReport,
		output: initialAcceptanceOutput,
		cwd: options.cwd ?? runtimeCwd,
	});
	result.acceptance = initialAcceptance;
	if (shouldRunAcceptanceFinalization(effectiveAcceptance) && result.exitCode === 0 && !result.detached && !result.interrupted) {
		result.acceptance = await runAcceptanceFinalizationLoop({
			runtimeCwd,
			agent,
			result,
			initialLedger: initialAcceptance,
			initialOutput: initialAcceptanceOutput,
			acceptance: effectiveAcceptance,
			options,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			...(missingSkills.length > 0 ? { skillsWarning: `Skills not found: ${missingSkills.join(", ")}` } : {}),
		});
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.detached && !result.interrupted) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}
	// Abort is a terminal non-success gate even when the child happened to emit
	// a successful stop before the cancellation callback was observed.
	if (result.cancelled || (options.signal?.aborted && !result.interrupted)) {
		result.cancelled = true;
		if (result.exitCode === 0) result.exitCode = 1;
		result.error = result.error ?? "Subagent execution cancelled.";
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}

	const ownsIsolatedGit = options.isolatedGit ? (options.isolatedGitOwner ?? !isInheritedIsolatedGitRuntime(options.isolatedGit.runtime)) : false;
	if (options.isolatedGit && ownsIsolatedGit && options.exportIsolatedGitBundle !== false && !result.detached) {
		// Process close/stdio drain only proves the direct child stopped. Wait for
		// nested descendants to publish terminal events before packaging or cleanup.
		const nestedFence = await waitForNestedDescendantsToStop(options.nestedRoute, options.runId, options.index ?? 0, {
			timeoutMs: options.nestedFenceTimeoutMs,
		});
		if (!nestedFence.stopped) {
			result.teardownUnproven = true;
			options.isolatedGit.runtime.markExportFenceFailed();
			const recovery = `Nested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktree at ${options.isolatedGit.runtime.root}`;
			result.error = result.error ? `${result.error}\n${recovery}` : recovery;
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			if (result.progress) {
				result.progress.status = "failed";
				result.progress.error = result.error;
			}
		}
		const terminationState = result.interrupted
			? "interrupted"
			: options.signal?.aborted
				? "cancelled"
				: result.exitCode === 0 && !result.error
				? "success"
				: /timeout|timed out/i.test(result.error ?? "") ? "timeout" : "failure";
		if (nestedFence.stopped && !options.isolatedGit.runtime.exportFenceFailed) {
			let bundle: ReturnType<typeof exportIsolatedGitBundle> | undefined;
			let exportError: unknown;
			for (let attempt = 0; attempt < 2 && !bundle; attempt++) try {
				bundle = exportIsolatedGitBundle(options.isolatedGit.runtime, {
					outputDir: options.isolatedGitBundleDir ?? path.join(options.artifactsDir ?? TEMP_ARTIFACTS_DIR, "isolated-git-bundles"),
					worktree: options.isolatedGit,
					syntheticPaths: options.isolatedGit.syntheticPaths,
					terminationState,
					agent: agent.name,
					commitRequired: options.isolatedGitCommitRequired,
				});
			} catch (error) {
				exportError = error;
			}
			if (bundle) {
			result.gitBundle = {
				path: bundle.path,
				checksum: bundle.checksum,
				base: bundle.base,
				head: bundle.head,
				commitSummary: bundle.commitSummary,
				...(bundle.commits ? { commits: bundle.commits } : {}),
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
			if (bundle.incomplete && options.isolatedGitCommitRequired && !result.error) {
				result.exitCode = 1;
				result.error = "Isolated writer completed without a required authored commit; recovery bundle is incomplete.";
			}
			} else {
				options.isolatedGit.runtime.markExportFailed();
				const exportMessage = `Isolated Git bundle export failed; recover isolated worktree at ${options.isolatedGit.runtime.root}: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				result.error = result.error ? `${result.error}\n${exportMessage}` : exportMessage;
				if (result.exitCode === 0) result.exitCode = 1;
				if (result.progress) {
					result.progress.status = "failed";
					result.progress.error = result.error;
				}
			}
		}
	}

	result.thinking ??= resolveEffectiveThinking(result.model, undefined);

	return result;
}
