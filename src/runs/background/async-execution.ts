/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { hasExplicitSandboxOptOut, normalizeSandboxTransport, resolveSandboxTransport, worktreeOptOutIsAuthorized } from "../../sandbox/config.ts";
import type { ResolvedSandboxConfig, SandboxRunConfig, SandboxSettingsDefaults, SandboxTransport } from "../../sandbox/types.ts";
import { hasSandboxWritableAgent, inferSandboxCwdWritable, sandboxDynamicFanoutUnsupportedMessage, sandboxParallelWorktreeRequiredMessage } from "../../sandbox/write-inference.ts";
import { injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { resolveSavedOutputPath, shouldPersistSavedOutput } from "../../shared/output-paths.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import { getPiSpawnEntrypointOverrideForTests, resolveInstalledPiPackageRoot, resolveNodeRuntime, resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveFastModeStatus } from "../../shared/fast-mode.ts";
import { resolveCandidateLaunchThinking } from "../../shared/model-info.ts";
import { readProcessStartToken } from "./pid-identity.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import type { ScopedGitEndpointDescriptor } from "../../sandbox/scoped-git-endpoint.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import {
	type AcceptanceInput,
	type ArtifactConfig,
	type AsyncStatus,
	type Details,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SandboxIntercomBridge,
	type SubagentRunMode,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { formatAsyncRunnerIdentity } from "./pid-identity.ts";
import { isChildProcessGroupGone, processControlUnsupported, signalChildProcessGroup, type ChildProcessIdentity } from "../../shared/post-exit-stdio-guard.ts";
import { sanitizeAuthorityEnvironment, SUBAGENT_SCOPED_GIT_ENDPOINT_ENV } from "../shared/pi-args.ts";
import { scopedGitDescriptorMounts } from "../../sandbox/scoped-git-endpoint.ts";

const require = createRequire(import.meta.url);
const hostPiPackageRoot = resolvePiPackageRoot();
const childPiPackageRoot = resolveInstalledPiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => hostPiPackageRoot
			? createRequire(path.join(hostPiPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => hostPiPackageRoot ? path.join(hostPiPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

const jitiCliPath = resolveJitiCliPath();

function resolveAsyncRunnerRuntime(): string | undefined {
	// Standalone Pi exposes its own executable as process.execPath. It cannot run
	// arbitrary Jiti scripts, so detached helpers share the child-launcher's
	// external Node resolution instead of treating the host Pi binary as Node.
	if (!fs.existsSync(process.execPath)) return undefined;
	return resolveNodeRuntime();
}

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
}

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	resultMode?: Exclude<SubagentRunMode, "single">;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	/** Explicit authenticated ancestry restored by a routed launch. */
	nestedSelf?: NonNullable<AsyncStatus["nestedSelf"]>;
	acceptance?: AcceptanceInput;
	sandbox?: SandboxTransport;
	sandboxSettings?: SandboxSettingsDefaults;
	sandboxRun?: SandboxRunConfig;
	sandboxIntercomBridge?: SandboxIntercomBridge;
	/** Minimal owner-scoped endpoint inherited by a detached nested run. */
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	modelOverride?: string;
	fastMode?: boolean;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	/** Explicit authenticated ancestry restored by async revival. */
	nestedSelf?: NonNullable<AsyncStatus["nestedSelf"]>;
	acceptance?: AcceptanceInput;
	sandbox?: SandboxTransport;
	sandboxSettings?: SandboxSettingsDefaults;
	sandboxRun?: SandboxRunConfig;
	/** Direct parent authority may narrow an isolated child to read-only. */
	worktree?: boolean;
	sandboxIntercomBridge?: SandboxIntercomBridge;
	/** Minimal owner-scoped endpoint inherited by a detached nested run. */
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.",
	].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined && resolveAsyncRunnerRuntime() !== undefined;
}

/** Write launch authority without exposing a partial or permissive config. */
function writePrivateRunnerConfig(cfgPath: string, cfg: object): void {
	const temporary = `${cfgPath}.${process.pid}.${Date.now()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(cfg), "utf8");
		fs.fsyncSync(fd);
		fs.fchmodSync(fd, 0o600);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, cfgPath);
		fs.chmodSync(cfgPath, 0o600);
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
		try { fs.unlinkSync(temporary); } catch {}
		throw error;
	}
}

/**
 * Spawn the async runner process
 */
function spawnRunner(cfg: object, suffix: string, cwd: string): { pid?: number; error?: string; runnerIdentity?: string; runnerStartToken?: string; runnerUid?: number } {
	const processControlError = processControlUnsupported();
	if (processControlError) return { error: processControlError };
	if (!jitiCliPath) {
		return { error: "upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed" };
	}
	const runtimePath = resolveAsyncRunnerRuntime();
	if (!runtimePath) {
		return { error: "a Node runtime for detached TypeScript execution could not be found; install Node or add it to PATH" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	writePrivateRunnerConfig(cfgPath, cfg);
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	const removeConfigIfPresent = () => {
		try { fs.unlinkSync(cfgPath); } catch {}
	};
	const retainOrReapOwnedRunner = (identity: ChildProcessIdentity | undefined): void => {
		// A live detached handle is ownership proof only until it exits. Never
		// signal a reused PID after reaping; if identity is unavailable, retain the
		// config as actionable evidence for reconciliation.
		if (proc.exitCode != null || proc.signalCode != null) return;
		const strictIdentity = Boolean(identity?.startToken && identity.pgid === proc.pid);
		let signalled = strictIdentity ? signalChildProcessGroup(proc, "SIGTERM", { identity }) : false;
		if (!signalled) {
			// Missing or strict-invalid /proc identity is recoverable only through
			// the still-live ChildProcess handle created by detached spawn. Never
			// turn that proof into a bare PID/PGID signal, and never retry after the
			// handle has been reaped; the launch config remains evidence then.
			try { signalled = proc.exitCode == null && proc.signalCode == null && proc.kill("SIGTERM"); } catch { signalled = false; }
		}
		if (!signalled) return;
		const deadline = Date.now() + 3_000;
		const reap = () => {
			if (proc.exitCode == null && proc.signalCode == null && Date.now() < deadline) return;
			if (proc.exitCode != null || proc.signalCode != null) {
				if (isChildProcessGroupGone(proc)) removeConfigIfPresent();
			}
		};
		proc.once("close", reap);
		const timer = setInterval(() => {
			reap();
			if (Date.now() >= deadline || proc.exitCode != null || proc.signalCode != null) clearInterval(timer);
		}, 50);
		timer.unref?.();
	};
	const proc = spawn(runtimePath, [jitiCliPath, runner, cfgPath], {
		cwd,
		env: sanitizeAuthorityEnvironment(),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.on("error", (error) => {
		// Once a PID has been published, never delete the launch evidence merely
		// because identity capture or status publication failed: the detached
		// runner may still be alive and an unknown PID is not a safe signal target.
		console.error(`[pi-subagents] async spawn failed: ${error.message}${proc.pid ? `; launch config retained at ${cfgPath}` : ""}`);
	});
	if (typeof proc.pid !== "number") {
		removeConfigIfPresent();
		return { error: `async runner did not produce a pid for cwd: ${cwd}` };
	}
	let startToken: string | undefined;
	let pgid: number | undefined;
	let uid: number | undefined;
	if (process.platform === "linux") {
		const deadline = Date.now() + 250;
		while ((!startToken || pgid !== proc.pid || uid === undefined) && Date.now() < deadline) {
			try {
				const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, "utf8");
				const closeParen = stat.lastIndexOf(")");
				const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
				startToken = fields[19] || undefined;
				pgid = Number(fields[2]);
				uid = fs.statSync(`/proc/${proc.pid}`).uid;
			} catch { /* retry spawn publication race */ }
			if (!startToken || pgid !== proc.pid || uid === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
		if (!startToken || pgid !== proc.pid || uid === undefined) {
			retainOrReapOwnedRunner(startToken && uid !== undefined ? { pid: proc.pid, startToken, pgid, uid } : undefined);
			return { error: `async runner private process-group identity could not be captured safely; launch config retained at ${cfgPath} and active runner teardown was not proven` };
		}
	} else {
		removeConfigIfPresent();
		return { error: "async runner identity cannot be verified safely on this platform" };
	}
	const config = cfg as { id?: string; asyncDir?: string; resultMode?: string; steps?: unknown[]; parallelGroups?: unknown; workflowGraph?: unknown; sessionDir?: string; artifactsDir?: string };
	const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	const expectedArgv = [runtimePath, jitiCliPath, runnerPath, cfgPath];
	const runnerIdentity = formatAsyncRunnerIdentity(runnerPath, cfgPath, config.id ?? suffix, startToken, uid, expectedArgv);
	if (config.asyncDir && config.id) {
		try {
			const statusPath = path.join(config.asyncDir, "status.json");
			let existing: Record<string, unknown> = {};
			try { existing = JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>; } catch { /* runner has not written its full status yet */ }
			const configuredSteps = (config.steps ?? []).flatMap((step: any, index) => Array.isArray(step?.parallel)
				? step.parallel.map((child: any, childIndex: number) => ({ agent: child.agent, model: child.model, thinking: child.thinking, fastMode: child.fastModeCandidates?.[0] ?? child.fastMode, status: "running", flatIndex: child.flatIndex ?? childIndex }))
				: step?.expand && step?.parallel ? [{ agent: `expand:${step.parallel.agent}`, model: step.parallel.model, thinking: step.parallel.thinking, fastMode: step.parallel.fastModeCandidates?.[0] ?? step.parallel.fastMode, label: step.parallel.label, outputName: step.collect?.as, status: "running", flatIndex: index }]
				: [{ agent: step?.agent ?? `step-${index + 1}`, model: step?.model, thinking: step?.thinking, fastMode: step?.fastModeCandidates?.[0] ?? step?.fastMode, status: "running", flatIndex: step?.flatIndex ?? index }]);
			let configuredFlatIndex = 0;
			const configuredParallelGroups = (config.steps ?? []).flatMap((step: any, stepIndex: number) => {
				if (Array.isArray(step?.parallel)) { const group = { start: configuredFlatIndex, count: step.parallel.length, stepIndex }; configuredFlatIndex += step.parallel.length; return [group]; }
				if (step?.expand && step?.parallel) { const group = { start: configuredFlatIndex, count: 1, stepIndex }; configuredFlatIndex++; return [group]; }
				configuredFlatIndex++;
				return [];
			});
			writeAtomicJson(statusPath, {
				...existing,
				runId: config.id,
				mode: existing.mode ?? config.resultMode ?? "single",
				state: existing.state ?? "running",
				pid: proc.pid,
				runnerIdentity,
				runnerStartToken: startToken,
				runnerUid: uid,
				startedAt: existing.startedAt ?? Date.now(),
				lastUpdate: Date.now(),
				...(existing.steps ? {} : { steps: configuredSteps }),
				...(config.parallelGroups ?? configuredParallelGroups.length ? { parallelGroups: config.parallelGroups ?? configuredParallelGroups } : {}),
				...(config.workflowGraph ? { workflowGraph: config.workflowGraph } : {}),
				...(config.sessionDir ? { sessionDir: config.sessionDir } : {}),
				...(config.artifactsDir ? { artifactsDir: config.artifactsDir } : {}),
			});
		} catch (error) {
			retainOrReapOwnedRunner({ pid: proc.pid, startToken, pgid: proc.pid, uid });
			return { error: `async runner identity could not be persisted safely: ${error instanceof Error ? error.message : String(error)}; launch config retained at ${cfgPath} while runner ownership is re-established` };
		}
	}
	proc.unref();
	return { pid: proc.pid, runnerIdentity, runnerStartToken: startToken, runnerUid: uid };
}

function attachScopedRunnerIdentity(details: Details, identity: { pid?: number; runnerStartToken?: string; runnerUid?: number } | undefined): Details {
	if (identity?.pid && identity.runnerStartToken && identity.runnerUid !== undefined) {
		Object.defineProperties(details, {
			__scopedRunnerPid: { value: identity.pid, enumerable: false },
			__scopedRunnerStartToken: { value: identity.runnerStartToken, enumerable: false },
			__scopedRunnerUid: { value: identity.runnerUid, enumerable: false },
		});
	}
	return details;
}

function validateInheritedScopedEndpoint(
	descriptor: ScopedGitEndpointDescriptor | undefined,
	inheritedNestedRoute: NestedRouteInfo | undefined,
): string | undefined {
	if (!descriptor && inheritedNestedRoute && process.env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV]) {
		return "nested async execution requires the live scoped Git endpoint descriptor";
	}
	if (!descriptor) return undefined;
	try {
		const mounts = scopedGitDescriptorMounts(descriptor);
		const fixedMount = mounts.find((mount) => mount.target === "/run/pi-scoped-git");
		if (!fixedMount) return "nested async scoped Git endpoint mount is unavailable";
		// Validate the fixed subtree and its control socket before creating the
		// async directory or any output/session artifacts. Host metadata is used
		// only to check the owner socket and is never serialized to the child.
		const endpointRoot = fixedMount.source;
		if (!fs.existsSync(endpointRoot) || !fs.existsSync(path.join(endpointRoot, "endpoint"))) return "nested async scoped Git endpoint socket is unavailable";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
		nestedSelf,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const hasSandboxResolutionInputs = params.sandboxSettings !== undefined || params.sandboxRun !== undefined;
	const sharedSandbox: SandboxTransport | undefined = hasSandboxResolutionInputs
		? resolveSandboxTransport({ settings: params.sandboxSettings, run: params.sandboxRun })
		: Object.hasOwn(params, "sandbox") ? normalizeSandboxTransport(params.sandbox) : undefined;
	const resolveStepSandbox = (agent: AgentConfig): SandboxTransport | undefined => {
		if (hasSandboxResolutionInputs) return resolveSandboxTransport({ settings: params.sandboxSettings, agent, run: params.sandboxRun });
		if (!Object.hasOwn(params, "sandbox")) return resolveSandboxTransport({ agent });
		const supplied = normalizeSandboxTransport(params.sandbox);
		return supplied === null ? null : resolveSandboxTransport({ agent, run: supplied });
	};
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: chain });

	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const s = chain[stepIndex]!;
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: resultMode, results: [] },
				};
			}
		}
		if (isParallelStep(s)) {
			const stepAgentConfigs = s.parallel
				.map((task) => agents.find((agent) => agent.name === task.agent))
				.filter((agent): agent is AgentConfig => Boolean(agent));
			const explicitWorktreeOptOut = Object.hasOwn(s, "worktree") && s.worktree === false;
			const worktreeOptOutAllowed = explicitWorktreeOptOut
				&& worktreeOptOutIsAuthorized(params.sandboxSettings)
				&& stepAgentConfigs.every((agent) => agent.canOptOutOfWorktree === true);
			if (explicitWorktreeOptOut && !worktreeOptOutAllowed) {
				return formatAsyncStartError(resultMode, "Worktree opt-out denied: worktree:false requires trusted user-global sandbox.allowWorktreeOptOut=true and every target agent must set canOptOutOfWorktree=true.");
			}
			const stepSandboxes = stepAgentConfigs.map((agent) => {
				const resolved = resolveStepSandbox(agent);
				return worktreeOptOutAllowed && resolved?.gitMode === "isolated" ? { ...resolved, gitMode: "read-only" as const } : resolved;
			});
			const isolatedGitRequested = stepSandboxes.some((sandboxConfig) => sandboxConfig?.gitMode === "isolated");
			if (isolatedGitRequested && s.worktree) {
				return formatAsyncStartError(resultMode, `isolated Git cannot be combined with parent-managed worktree mode on chain step ${stepIndex + 1}`);
			}
			if (isolatedGitRequested && stepAgentConfigs.some((agent, index) =>
				stepSandboxes[index]?.gitMode !== "isolated"
					&& inferSandboxCwdWritable({ agentName: agent.name, tools: agent.tools, sandbox: stepSandboxes[index] }),
			)) {
				return formatAsyncStartError(resultMode, `isolated Git parallel step ${stepIndex + 1} cannot include a non-isolated write-capable task`);
			}
			const sandboxWriteInputs = stepAgentConfigs.map((agent, index) => ({ agentName: agent.name, tools: agent.tools, sandbox: stepSandboxes[index] }));
			if (!s.worktree && !isolatedGitRequested && hasSandboxWritableAgent({ agents: sandboxWriteInputs })
				&& !worktreeOptOutAllowed) {
				return formatAsyncStartError(resultMode, sandboxParallelWorktreeRequiredMessage(`Parallel sandboxed chain step ${stepIndex + 1}`));
			}
		}
		if (isDynamicParallelStep(s)) {
			const agent = agents.find((candidate) => candidate.name === s.parallel.agent);
			const resolvedDynamicSandbox = agent ? resolveStepSandbox(agent) : undefined;
			const explicitDynamicWorktreeOptOut = s.worktree === false;
			const dynamicWorktreeOptOutAllowed = explicitDynamicWorktreeOptOut
				&& worktreeOptOutIsAuthorized(params.sandboxSettings)
				&& agent?.canOptOutOfWorktree === true;
			if (explicitDynamicWorktreeOptOut && !dynamicWorktreeOptOutAllowed) {
				return formatAsyncStartError(resultMode, "Worktree opt-out denied: worktree:false requires trusted user-global sandbox.allowWorktreeOptOut=true and every target agent must set canOptOutOfWorktree=true.");
			}
			const dynamicSandbox = dynamicWorktreeOptOutAllowed && resolvedDynamicSandbox?.gitMode === "isolated"
				? { ...resolvedDynamicSandbox, gitMode: "read-only" as const }
				: resolvedDynamicSandbox;
			if (agent && dynamicSandbox?.gitMode !== "isolated" && hasSandboxWritableAgent({ agents: [{ agentName: agent.name, tools: agent.tools, sandbox: dynamicSandbox }] }) && !dynamicWorktreeOptOutAllowed) {
				return formatAsyncStartError(resultMode, sandboxDynamicFanoutUnsupportedMessage(`Dynamic sandboxed chain step ${stepIndex + 1}`));
			}
		}
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const explicitNestedRoute = Object.prototype.hasOwnProperty.call(params, "nestedRoute") && nestedRoute !== undefined;
	const effectiveNestedRoute = nestedRoute ?? inheritedNestedRoute;
	const effectiveNestedSelf = nestedSelf ?? (!explicitNestedRoute && inheritedNestedRoute && nestedAddress ? {
		parentRunId: nestedAddress.parentRunId,
		parentStepIndex: nestedAddress.parentStepIndex,
		depth: nestedAddress.depth,
		path: nestedAddress.path,
	} : undefined);
	const authorityRoute = explicitNestedRoute && !effectiveNestedSelf ? undefined : inheritedNestedRoute;
	const effectiveScopedGitEndpoint = explicitNestedRoute && !effectiveNestedSelf && inheritedNestedRoute ? undefined : params.scopedGitEndpoint;
	const endpointValidationError = validateInheritedScopedEndpoint(effectiveScopedGitEndpoint, authorityRoute);
	if (endpointValidationError) return formatAsyncStartError(resultMode, endpointValidationError);
	const asyncDir = effectiveNestedRoute && effectiveNestedSelf
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", effectiveNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
			...(s.fastMode !== undefined ? { fastMode: s.fastMode } : {}),
		};
	};
	const buildSeqStep = (
		s: SequentialStep,
		sessionFile?: string,
		behaviorCwd?: string,
		progressPrecreated = false,
		resolvedBehavior?: ResolvedStepBehavior,
		outputIndex?: number,
		sandboxOverride?: ResolvedSandboxConfig,
	) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepSandbox = sandboxOverride !== undefined ? sandboxOverride : resolveStepSandbox(a);
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, runnerCwd, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd);
		const savedOutputPath = shouldPersistSavedOutput({
			output: behavior.output,
			outputMode: behavior.outputMode,
			tools: a.tools,
		})
			? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: instructionCwd, agent: s.agent, runId: id, index: outputIndex })
			: undefined;
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath ?? savedOutputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const instructionOutputPath = outputPath ?? (behavior.outputMode === "file-only" ? savedOutputPath : undefined);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`, instructionOutputPath);

		const modelCandidates = buildModelCandidates(behavior.model ?? a.model, a.fallbackModels, availableModels, ctx.currentModelProvider, a.thinking);
		const fastModeCandidates = modelCandidates.map((candidate) => resolveFastModeStatus(behavior.fastMode, candidate, availableModels, ctx.currentModelProvider));
		const model = modelCandidates[0];
		return {
			agent: s.agent,
			source: a.source,
			task,
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			fastMode: behavior.fastMode,
			fastModeCandidates,
			thinking: resolveCandidateLaunchThinking(model, a.thinking),
			modelCandidates,
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			savedOutputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			sandbox: stepSandbox,
			hostGitDiagnostic: (stepSandbox === null || stepSandbox === undefined) && hasExplicitSandboxOptOut({ settings: params.sandboxSettings, agent: a, run: params.sandboxRun }),
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				task: s.task,
				mode: resultMode,
				async: true,
				dynamic: false,
				agentAcceptanceSelfReview: a.acceptanceSelfReview,
				agentAcceptanceMaxFinalizationTurns: a.acceptanceMaxFinalizationTurns,
			}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	let steps: RunnerStep[];
	try {
		steps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree) writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				const stepAgentConfigs = s.parallel.map((task) => agents.find((agent) => agent.name === task.agent)!);
				const worktreeOptOutAllowed = s.worktree === false
					&& worktreeOptOutIsAuthorized(params.sandboxSettings)
					&& stepAgentConfigs.every((agent) => agent.canOptOutOfWorktree === true);
				const stepSandboxes = stepAgentConfigs.map((agent) => {
					const resolved = resolveStepSandbox(agent);
					return worktreeOptOutAllowed && resolved?.gitMode === "isolated" ? { ...resolved, gitMode: "read-only" as const } : resolved;
				});
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex);
							} catch {
								behaviorCwd = undefined;
							}
						}
						return buildSeqStep(t, nextSessionFile(), behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex], stepIndex * 1000 + taskIndex, stepSandboxes[taskIndex]);
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
					...(worktreeOptOutAllowed ? { worktreeOptOutAuthorized: true } : {}),
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				const resolvedDynamicSandbox = resolveStepSandbox(agent);
				const dynamicWorktreeOptOutAllowed = s.worktree === false
					&& worktreeOptOutIsAuthorized(params.sandboxSettings)
					&& agent.canOptOutOfWorktree === true;
				const dynamicSandbox = dynamicWorktreeOptOutAllowed && resolvedDynamicSandbox?.gitMode === "isolated"
					? { ...resolvedDynamicSandbox, gitMode: "read-only" as const }
					: resolvedDynamicSandbox;
				return {
					expand: s.expand,
					parallel: buildSeqStep(s.parallel as SequentialStep, undefined, undefined, progressPrecreated, behavior, stepIndex, dynamicSandbox),
					collect: s.collect,
					concurrency: s.concurrency,
					worktree: s.worktree,
					...(dynamicWorktreeOptOutAllowed ? { worktreeOptOutAuthorized: true } : {}),
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
				};
			}
			return buildSeqStep(s as SequentialStep, nextSessionFile(), undefined, false, undefined, stepIndex);
		});
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	const scopedGitRunEndpoint: ScopedGitEndpointDescriptor | undefined = effectiveScopedGitEndpoint;
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: ReturnType<typeof spawnRunner> = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: effectiveNestedRoute && effectiveNestedSelf ? nestedResultsPath(effectiveNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot: childPiPackageRoot,
				piEntrypointOverride: getPiSpawnEntrypointOverrideForTests(),
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				workflowGraph,
				scopedGitEndpoint: scopedGitRunEndpoint,
				sandbox: sharedSandbox,
				progressPaths: progressInstructionCreated ? [path.join(runnerCwd, "progress.md")] : undefined,
				sandboxIntercomBridge: params.sandboxIntercomBridge,
				...(readProcessStartToken(process.pid) ? { ownerStartToken: readProcessStartToken(process.pid) } : {}),
				nestedRoute: effectiveNestedRoute,
				nestedSelf: effectiveNestedSelf,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}
	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: isDynamicParallelStep(firstStep)
				? [firstStep.parallel.agent]
			: [(firstStep as SequentialStep).agent];
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else if (isDynamicParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
				flatAgents.push(step.parallel.agent);
				flatStepStart++;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		if (effectiveNestedRoute && effectiveNestedSelf) {
			const now = Date.now();
			try {
				writeNestedEvent(effectiveNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: effectiveNestedSelf.parentRunId,
					parentStepIndex: effectiveNestedSelf.parentStepIndex,
					child: {
						id,
						parentRunId: effectiveNestedSelf.parentRunId,
						parentStepIndex: effectiveNestedSelf.parentStepIndex,
						depth: effectiveNestedSelf.depth,
						path: effectiveNestedSelf.path,
						asyncDir,
						cwd: runnerCwd,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTargets?.[0],
						intercomTarget: childIntercomTargets?.[0],
						ownerState: "live",
						mode: resultMode,
						state: "running",
						agent: firstAgents[0],
						agents: flatAgents,
						chainStepCount: chain.length,
						parallelGroups,
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			...(spawnResult.runnerIdentity ? { runnerIdentity: spawnResult.runnerIdentity } : {}),
			...(spawnResult.runnerStartToken ? { runnerStartToken: spawnResult.runnerStartToken } : {}),
			...(spawnResult.runnerUid !== undefined ? { runnerUid: spawnResult.runnerUid } : {}),
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: isDynamicParallelStep(firstStep)
					? firstStep.parallel.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			),
			chainStepCount: chain.length,
			parallelGroups,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			nestedRoute: effectiveNestedRoute,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`) }],
		details: attachScopedRunnerIdentity({ mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph }, spawnResult),
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
		nestedSelf,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const explicitNestedRoute = Object.prototype.hasOwnProperty.call(params, "nestedRoute") && nestedRoute !== undefined;
	const effectiveNestedRoute = nestedRoute ?? inheritedNestedRoute;
	const effectiveNestedSelf = nestedSelf ?? (!explicitNestedRoute && inheritedNestedRoute && nestedAddress ? {
		parentRunId: nestedAddress.parentRunId,
		parentStepIndex: nestedAddress.parentStepIndex,
		depth: nestedAddress.depth,
		path: nestedAddress.path,
	} : undefined);
	const authorityRoute = explicitNestedRoute && !effectiveNestedSelf ? undefined : inheritedNestedRoute;
	const scopedGitRunEndpoint: ScopedGitEndpointDescriptor | undefined = explicitNestedRoute && !effectiveNestedSelf && inheritedNestedRoute ? undefined : params.scopedGitEndpoint;
	const hasSandboxResolutionInputs = params.sandboxSettings !== undefined || params.sandboxRun !== undefined;
	let sandbox: SandboxTransport | undefined;
	if (hasSandboxResolutionInputs) sandbox = resolveSandboxTransport({ settings: params.sandboxSettings, agent: agentConfig, run: params.sandboxRun });
	else if (!Object.hasOwn(params, "sandbox")) sandbox = resolveSandboxTransport({ agent: agentConfig });
	else {
		const supplied = normalizeSandboxTransport(params.sandbox);
		sandbox = supplied === null ? null : resolveSandboxTransport({ agent: agentConfig, run: supplied });
	}
	if (params.worktree === false && !scopedGitRunEndpoint && sandbox?.gitMode === "isolated"
		&& worktreeOptOutIsAuthorized(params.sandboxSettings)
		&& agentConfig.canOptOutOfWorktree === true) {
		sandbox = { ...sandbox, gitMode: "read-only" };
	}
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const endpointValidationError = validateInheritedScopedEndpoint(scopedGitRunEndpoint, authorityRoute);
	if (endpointValidationError) return formatAsyncStartError("single", endpointValidationError);
	const asyncDir = effectiveNestedRoute && effectiveNestedSelf
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", effectiveNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const savedOutputPath = shouldPersistSavedOutput({
		output: effectiveOutput,
		outputMode,
		tools: agentConfig.tools,
	})
		? resolveSavedOutputPath({ runtimeCwd: ctx.cwd, requestedCwd: runnerCwd, agent, runId: id, index: 0 })
		: undefined;
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath ?? savedOutputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const instructionOutputPath = outputPath ?? (outputMode === "file-only" ? savedOutputPath : undefined);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, instructionOutputPath);
	const modelCandidates = buildModelCandidates(
		params.modelOverride ?? agentConfig.model,
		agentConfig.fallbackModels,
		availableModels,
		ctx.currentModelProvider,
		agentConfig.thinking,
	);
	const model = modelCandidates[0];
	const fastModeCandidates = modelCandidates.map((candidate) => resolveFastModeStatus(params.fastMode ?? agentConfig.fastMode, candidate, availableModels, ctx.currentModelProvider));
	let spawnResult: ReturnType<typeof spawnRunner> = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						agent,
						source: agentConfig.source,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model,
						fastMode: params.fastMode ?? agentConfig.fastMode ?? false,
						fastModeCandidates,
						thinking: resolveCandidateLaunchThinking(model, agentConfig.thinking),
						modelCandidates,
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						mcpDirectTools: agentConfig.mcpDirectTools,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						savedOutputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						sandbox,
						hostGitDiagnostic: (sandbox === null || sandbox === undefined) && hasExplicitSandboxOptOut({ settings: params.sandboxSettings, agent: agentConfig, run: params.sandboxRun }),
						effectiveAcceptance: resolveEffectiveAcceptance({
							explicit: params.acceptance,
							agentName: agent,
							task,
							mode: "single",
							async: true,
							agentAcceptanceSelfReview: agentConfig.acceptanceSelfReview,
							agentAcceptanceMaxFinalizationTurns: agentConfig.acceptanceMaxFinalizationTurns,
						}),
					},
				],
				resultPath: effectiveNestedRoute && effectiveNestedSelf ? nestedResultsPath(effectiveNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot: childPiPackageRoot,
				piEntrypointOverride: getPiSpawnEntrypointOverrideForTests(),
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
				sandbox,
				sandboxIntercomBridge: params.sandboxIntercomBridge,
				scopedGitEndpoint: scopedGitRunEndpoint,
				...(readProcessStartToken(process.pid) ? { ownerStartToken: readProcessStartToken(process.pid) } : {}),
				nestedRoute: effectiveNestedRoute,
				nestedSelf: effectiveNestedSelf,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		if (effectiveNestedRoute && effectiveNestedSelf) {
			const now = Date.now();
			try {
				writeNestedEvent(effectiveNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: effectiveNestedSelf.parentRunId,
					parentStepIndex: effectiveNestedSelf.parentStepIndex,
					child: {
						id,
						parentRunId: effectiveNestedSelf.parentRunId,
						parentStepIndex: effectiveNestedSelf.parentStepIndex,
						depth: effectiveNestedSelf.depth,
						path: effectiveNestedSelf.path,
						asyncDir,
						cwd: runnerCwd,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			...(spawnResult.runnerIdentity ? { runnerIdentity: spawnResult.runnerIdentity } : {}),
			...(spawnResult.runnerStartToken ? { runnerStartToken: spawnResult.runnerStartToken } : {}),
			...(spawnResult.runnerUid !== undefined ? { runnerUid: spawnResult.runnerUid } : {}),
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
			nestedRoute: effectiveNestedRoute,
			...(effectiveNestedSelf ? { nestedSelf: effectiveNestedSelf } : {}),
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
		details: attachScopedRunnerIdentity({ mode: "single", runId: id, results: [], asyncId: id, asyncDir }, spawnResult),
	};
}
