import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { ackNestedControlRequest, claimNestedControlRequest, readNestedControlResult, readNestedControlRequests, resolveNestedRouteFromEnv, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { shutdownOwnedAsyncJobs, type ShutdownCascadeDeps } from "../runs/background/session-shutdown-cascade.ts";
import {
	ASYNC_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	 type Details,
	 type SubagentState,
} from "../shared/types.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

export function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	let processing = false;
	const pendingResults = new Map<string, Parameters<typeof writeNestedControlResult>[1]>();
	const processQueue = async (): Promise<void> => {
		if (processing) return;
		processing = true;
		try {
			for (;;) {
				const request = readNestedControlRequests(route)[0];
				if (!request) break;
				let result = pendingResults.get(request.requestId);
				if (!result) {
					const claim = claimNestedControlRequest(route, request.requestId);
					if (claim === "completed") {
						// A previous process durably published the result but died before
						// acknowledgement. Recover that exact result; never re-run control.
						result = readNestedControlResult(route, request.requestId);
						if (!result) throw new Error(`Durable result for completed request '${request.requestId}' is unavailable.`);
					} else if (claim === "claimed") {
						result = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: false, message: "Control request has an ambiguous prior side-effect; refusing replay." };
					} else {
						let ok = false;
						let message = "Control request failed.";
						try {
							const control = state.foregroundControls.get(request.targetRunId);
							if (!control) {
								message = `Nested run ${request.targetRunId} is not active in this fanout child.`;
							} else if (request.action === "interrupt") {
								ok = control.interrupt?.() === true;
								message = ok
									? `Interrupt requested for nested run ${request.targetRunId}.`
									: `Nested run ${request.targetRunId} has no active child step to interrupt.`;
							} else if (!request.message?.trim()) {
								message = "Nested resume requires message.";
							} else if (!control.currentAgent) {
								message = `Nested run ${request.targetRunId} has no active child message route.`;
							} else {
								const index = control.currentIndex ?? 0;
								const target = resolveSubagentIntercomTarget(request.targetRunId, control.currentAgent, index);
								ok = await deliverSubagentIntercomMessageEvent(
									pi.events,
									target,
									`Follow-up for nested run ${request.targetRunId} (${control.currentAgent}):\n\n${request.message.trim()}`,
									500,
									{ source: "nested-resume", runId: request.targetRunId, agent: control.currentAgent, index },
								);
								message = ok
									? `Delivered follow-up to live nested run ${request.targetRunId}.`
									: `Nested child intercom target is not registered: ${target}`;
							}
						} catch (error) {
							message = error instanceof Error ? error.message : String(error);
						}
						result = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
					}
				}
				try {
					writeNestedControlResult(route, result);
				} catch (error) {
					pendingResults.set(request.requestId, result);
					console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
					return;
				}
				try {
					ackNestedControlRequest(route, request.requestId, request.filePath);
				} catch (error) {
					pendingResults.set(request.requestId, result);
					throw error;
				}
				pendingResults.delete(request.requestId);
				// Legacy request files are retained as immutable evidence.
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		} finally {
			processing = false;
		}
	};
	const timer = setInterval(() => { void processQueue(); }, 200);
	void processQueue();
	timer.unref?.();
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI, internalDeps: Pick<ShutdownCascadeDeps, "isExpectedAsyncRunnerPid"> = {}): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const config = loadConfig();
	const state = createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Explicit agent-specific overrides are deny-by-default and must be listed by each target agent's canBeChangedByAgent policy; denied paths fail before child spawn.",
			"For goal-style requests such as /goal, goal, active goal, or work until evidence says done, use explicit acceptance on the delegated run: criteria for the target, evidence/verify for proof, stopRules for constraints, selfReview only to override the target agent default, and maxFinalizationTurns for the bounded loop.",
			"Allowed management/control actions: list, get, status, interrupt, resume, doctor.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		parameters: SubagentParams,
		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as SubagentParamsLike, signal, onUpdate, ctx);
		},
	};

	const { handleStarted, handleComplete } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
	];

	const nestedControlTimer = startNestedControlInboxListener(pi, state);

	if (typeof pi.on === "function") {
		pi.on("session_shutdown", () => {
			shutdownOwnedAsyncJobs(state, internalDeps);
			for (const unsubscribe of eventUnsubscribes) {
				try { unsubscribe(); } catch { /* best effort */ }
			}
			if (nestedControlTimer) clearInterval(nestedControlTimer);
			state.asyncJobs.clear();
		});
	}

	pi.registerTool(tool);
}
