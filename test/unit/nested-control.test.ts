import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, projectNestedEvents, readNestedControlRequests, readNestedControlResults, writeNestedControlRequest, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus, type NestedRunSummary, type SubagentState } from "../../src/shared/types.ts";
import { createMockPi } from "../support/mock-pi.ts";

const routeRoots: string[] = [];
const fixtureSettingsDirs: string[] = [];
const savedEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	[SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
	[SUBAGENT_FANOUT_CHILD_ENV]: process.env[SUBAGENT_FANOUT_CHILD_ENV],
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
	[SUBAGENT_CHILD_AGENT_ENV]: process.env[SUBAGENT_CHILD_AGENT_ENV],
	[SUBAGENT_RUN_ID_ENV]: process.env[SUBAGENT_RUN_ID_ENV],
	PI_SUBAGENT_DEPTH: undefined,
	PI_SUBAGENT_MAX_DEPTH: undefined,
};
for (const key of ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"]) delete process.env[key];

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const dir of fixtureSettingsDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createState(): SubagentState {
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
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createExecutor(state = createState(), agents: Array<Record<string, unknown>> = [], allowMutatingManagementActions = true, events: any = { emit() {}, on() { return () => {}; } }, asyncByDefault = false, isExpectedAsyncRunnerPid?: (pid: number | undefined, runId: string, identity?: string) => boolean) {
	// These legacy control-flow fixtures intentionally exercise host-Git execution.
	// Establish the trusted user-global permission explicitly rather than relying on
	// the executor's old test-only provider:none injection.
	const fixtureSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-trusted-settings-"));
	fixtureSettingsDirs.push(fixtureSettingsDir);
	fs.writeFileSync(path.join(fixtureSettingsDir, "settings.json"), JSON.stringify({ subagents: { sandbox: { allowSandboxOptOut: true } } }), "utf-8");
	process.env.PI_CODING_AGENT_DIR = fixtureSettingsDir;
	const baseExecutor = createSubagentExecutor({
		pi: { events, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: agents.map((agent) => ({ ...agent, canBeChangedByAgent: agent.canBeChangedByAgent ?? ["sandbox.provider", "sandbox.extraWritableMounts"] })) as any }),
		allowMutatingManagementActions,
		isExpectedAsyncRunnerPid,
	});
	return {
		...baseExecutor,
		execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: ((r: unknown) => void) | undefined, ctx: unknown) =>
			baseExecutor.execute(id, {
			...params,
			sandbox: params.sandbox ?? (process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]
				? { provider: "bubblewrap", extraWritableMounts: process.env.MOCK_PI_QUEUE_DIR ? [process.env.MOCK_PI_QUEUE_DIR] : undefined }
				: { provider: "none" }),
		}, signal, onUpdate as never, ctx as never),
	};
}

function ctx(root: string, sessionFile: string | null = null) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return sessionFile; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function canonicalFastModeCtx(root: string) {
	return {
		...ctx(root),
		modelRegistry: {
			getAvailable() {
				return [{ provider: "openai", id: "gpt-5.5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }];
			},
		},
	} as any;
}

function createNestedRun(id = "nested-live", state: "running" | "complete" | "failed" | "paused" = "running", extras: Record<string, unknown> = {}) {
	const route = createNestedRoute("root-control");
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts: 100,
		parentRunId: "root-control",
		parentStepIndex: 0,
		child: { id, parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state, agent: "worker", ownerState: state === "running" ? "live" : "gone", ...extras },
	});
	return route;
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = createState();
	state.foregroundControls.set(route.rootRunId, {
		runId: route.rootRunId,
		mode: "single",
		startedAt: 1,
		updatedAt: 1,
		nestedRoute: route,
	});
	state.lastForegroundControlId = route.rootRunId;
	return state;
}

function setNestedRouteEnv(route: ReturnType<typeof createNestedRoute>, parentRunId = route.rootRunId) {
	process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
	process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
	process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
	process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
	process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
	process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function setRalphOrchestratorNestedEnv(route: ReturnType<typeof createNestedRoute>, runId = "ralph-run") {
	setNestedRouteEnv(route, "parent-run");
	process.env[SUBAGENT_CHILD_AGENT_ENV] = "orchestrator";
	process.env[SUBAGENT_RUN_ID_ENV] = runId;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function writeAsyncStatus(asyncDir: string, status: Partial<AsyncStatus> & Pick<AsyncStatus, "runId" | "state" | "startedAt" | "mode">): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), `${JSON.stringify(status)}\n`, "utf-8");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(predicate(), true);
}

describe("nested control routing", { concurrency: false }, () => {
	it("cascades foreground parent interrupt to live nested descendants before stopping the active child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-cascade-"));
		try {
			const route = createNestedRun("nested-live-cascade", "running");
			const state = stateWithNestedRoute(route);
			let parentInterrupted = false;
			state.foregroundControls.get(route.rootRunId)!.interrupt = () => {
				parentInterrupted = true;
				return true;
			};
			const result = await createExecutor(state).execute("interrupt", { action: "interrupt", id: route.rootRunId }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.equal(parentInterrupted, true);
			const requests = readNestedControlRequests(route);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.action, "interrupt");
			assert.equal(requests[0]?.targetRunId, "nested-live-cascade");
			const registry = projectNestedEvents(route);
			// A control request is not a terminal acknowledgement. The owner must
			// publish a paused/terminal nested event before the child can be fenced.
			assert.equal(registry.children[0]?.state, "running");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("cascades async parent interrupt to live nested descendants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-async-cascade-"));
		const originalKill = process.kill;
		const killed: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		try {
			const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-async-cascade");
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
			const route = createNestedRun("nested-async-cascade", "running", { asyncDir: nestedAsyncDir, pid: 43210 });
			const state = createState();
			const parentAsyncDir = path.join(root, "async-parent");
			writeAsyncStatus(parentAsyncDir, { runId: "parent-async", mode: "single", state: "running", startedAt: 1, pid: 12345 });
			writeAsyncStatus(nestedAsyncDir, { runId: "nested-async-cascade", mode: "single", state: "running", startedAt: 1, pid: 43210 });
			state.asyncJobs.set("parent-async", { asyncId: "parent-async", asyncDir: parentAsyncDir, status: "running", pid: 12345, startedAt: 1, updatedAt: 1, nestedRoute: route });
			process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
				killed.push({ pid, signal });
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(state, [], true, undefined, false, () => true).execute("interrupt", { action: "interrupt", id: "parent-async" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.deepEqual(killed.map((entry) => entry.pid), [43210, 12345]);
			assert.equal(readNestedControlRequests(route)[0]?.targetRunId, "nested-async-cascade");
			assert.equal(projectNestedEvents(route).children[0]?.state, "running");
		} finally {
			process.kill = originalKill;
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-async-cascade"), { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not signal nested async runs without a trusted status pid during parent interrupt cascade", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-untrusted-pid-cascade-"));
		const originalKill = process.kill;
		const killed: number[] = [];
		try {
			const route = createNestedRoute("root-control");
			routeRoots.push(path.dirname(route.eventSink));
			const missingStatusDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-missing-status");
			const noPidStatusDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-status-no-pid");
			fs.rmSync(missingStatusDir, { recursive: true, force: true });
			fs.rmSync(noPidStatusDir, { recursive: true, force: true });
			fs.mkdirSync(missingStatusDir, { recursive: true });
			writeAsyncStatus(noPidStatusDir, { runId: "nested-status-no-pid", mode: "single", state: "running", startedAt: 1 });
			const state = stateWithNestedRoute(route);
			state.foregroundControls.get(route.rootRunId)!.nestedChildren = [
				{ id: "nested-missing-status", parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state: "running", agent: "worker", asyncDir: missingStatusDir, pid: 54321 },
				{ id: "nested-status-no-pid", parentRunId: "root-control", parentStepIndex: 1, depth: 1, path: [{ runId: "root-control", stepIndex: 1 }], state: "running", agent: "worker", asyncDir: noPidStatusDir, pid: 54322 },
			] as NestedRunSummary[];
			state.foregroundControls.get(route.rootRunId)!.interrupt = () => true;
			process.kill = ((pid: number) => {
				killed.push(pid);
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(state).execute("interrupt", { action: "interrupt", id: route.rootRunId }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.deepEqual(killed, []);
			assert.deepEqual(readNestedControlRequests(route).map((request) => request.targetRunId).sort(), ["nested-missing-status", "nested-status-no-pid"]);
			assert.match(text(result), /Nested cleanup: interrupt requested for 2 live descendants/);
		} finally {
			process.kill = originalKill;
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-missing-status"), { recursive: true, force: true });
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-status-no-pid"), { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not signal nested async direct fallback without a trusted status pid", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-untrusted-pid-direct-"));
		const originalKill = process.kill;
		let killed = 0;
		try {
			const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-direct-no-pid");
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
			const route = createNestedRun("nested-direct-no-pid", "running", { asyncDir: nestedAsyncDir, pid: 54323 });
			writeAsyncStatus(nestedAsyncDir, { runId: "nested-direct-no-pid", mode: "single", state: "running", startedAt: 1 });
			process.kill = (() => {
				killed++;
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(stateWithNestedRoute(route)).execute("interrupt", { action: "interrupt", id: "nested-direct-no-pid" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.equal(killed, 0);
			assert.match(text(result), /no safe direct async interrupt fallback/i);
		} finally {
			process.kill = originalKill;
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-direct-no-pid"), { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not signal nested direct fallback when runner identity mismatches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-mismatched-pid-direct-"));
		const originalKill = process.kill;
		let killed = 0;
		try {
			const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-direct-mismatch");
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
			const route = createNestedRun("nested-direct-mismatch", "running", { asyncDir: nestedAsyncDir, pid: 54324 });
			writeAsyncStatus(nestedAsyncDir, {
				runId: "nested-direct-mismatch",
				mode: "single",
				state: "running",
				startedAt: 1,
				pid: 54324,
				runnerIdentity: "runner:/tmp/runner;config:/tmp/async-cfg-other-run.json;run:other-run",
			});
			process.kill = (() => {
				killed++;
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(stateWithNestedRoute(route)).execute("interrupt", { action: "interrupt", id: "nested-direct-mismatch" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.equal(killed, 0);
			assert.match(text(result), /no safe direct async interrupt fallback/i);
		} finally {
			process.kill = originalKill;
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-direct-mismatch"), { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates live nested descendants projected through children and step children during parent interrupt cascade", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-dedupe-cascade-"));
		const originalKill = process.kill;
		const killed: number[] = [];
		try {
			const route = createNestedRoute("root-control");
			routeRoots.push(path.dirname(route.eventSink));
			const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-duplicate");
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
			writeAsyncStatus(nestedAsyncDir, { runId: "nested-duplicate", mode: "single", state: "running", startedAt: 1, pid: 54324 });
			const duplicate: NestedRunSummary = { id: "nested-duplicate", parentRunId: "root-control", parentStepIndex: 0, depth: 2, path: [{ runId: "root-control", stepIndex: 0 }], state: "running", agent: "worker", asyncDir: nestedAsyncDir, pid: 54324 };
			const parent: NestedRunSummary = {
				id: "nested-parent-complete",
				parentRunId: "root-control",
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: "root-control", stepIndex: 0 }],
				state: "complete",
				agent: "orchestrator",
				children: [duplicate],
				steps: [{ agent: "worker", status: "running", children: [duplicate] }],
			};
			const state = stateWithNestedRoute(route);
			state.foregroundControls.get(route.rootRunId)!.nestedChildren = [parent];
			state.foregroundControls.get(route.rootRunId)!.interrupt = () => true;
			process.kill = ((pid: number) => {
				killed.push(pid);
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(state, [], true, undefined, false, () => true).execute("interrupt", { action: "interrupt", id: route.rootRunId }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.deepEqual(killed, [54324]);
			assert.deepEqual(readNestedControlRequests(route).map((request) => request.targetRunId), ["nested-duplicate"]);
			assert.match(text(result), /Nested cleanup: interrupt requested for 1 live descendant\./);
		} finally {
			process.kill = originalKill;
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", "nested-duplicate"), { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores already terminal nested descendants during parent interrupt cascade", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-cascade-"));
		const originalKill = process.kill;
		let killed = 0;
		try {
			const route = createNestedRun("nested-complete-cascade", "complete", { asyncDir: path.join(root, "nested-subagent-runs", "root-control", "nested-complete-cascade"), pid: 43211 });
			const state = stateWithNestedRoute(route);
			state.foregroundControls.get(route.rootRunId)!.interrupt = () => true;
			process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
				killed++;
				return true;
			}) as typeof process.kill;

			const result = await createExecutor(state).execute("interrupt", { action: "interrupt", id: route.rootRunId }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.equal(readNestedControlRequests(route).length, 0);
			assert.equal(killed, 0);
			assert.equal(projectNestedEvents(route).children[0]?.state, "complete");
		} finally {
			process.kill = originalKill;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("handles unreachable nested owners gracefully during parent interrupt cascade", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-unreachable-cascade-"));
		try {
			const route = createNestedRun("nested-unreachable-cascade", "running");
			fs.rmSync(route.controlInbox, { recursive: true, force: true });
			fs.writeFileSync(route.controlInbox, "not a directory", "utf-8");
			const state = stateWithNestedRoute(route);
			state.foregroundControls.get(route.rootRunId)!.interrupt = () => true;
			const result = await createExecutor(state).execute("interrupt", { action: "interrupt", id: route.rootRunId }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested cleanup warning/i);
			assert.equal(projectNestedEvents(route).children[0]?.state, "running");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps every orchestrator inline-loop child synchronous when async is only configured by default", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orchestrator-default-sync-loop-"));
		const mockPi = createMockPi();
		try {
			mockPi.install();
			mockPi.onCall({ output: "explore findings inline" });
			mockPi.onCall({ output: "review verdict inline" });
			const route = createNestedRoute("root-orchestrator-default-sync-loop");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "orchestrator-default-sync-loop-run");
			const executor = createExecutor(createState(), [
				{ name: "explore", description: "Explorer", prompt: "Explore" },
				{ name: "review", description: "Reviewer", prompt: "Review", model: "openai/gpt-5.5", fastMode: true },
			], true, { emit() {}, on() { return () => {}; } }, true);

			const explore = await executor.execute("run", { agent: "explore", task: "inspect" }, new AbortController().signal, undefined, canonicalFastModeCtx(root));
			const review = await executor.execute("run", { agent: "review", task: "review" }, new AbortController().signal, undefined, canonicalFastModeCtx(root));

			assert.equal(explore.isError, undefined);
			assert.match(text(explore), /explore findings inline/);
			assert.equal(review.isError, undefined);
			assert.match(text(review), /review verdict inline/);
			assert.equal(review.details.results[0]?.fastMode?.eligible, true);
			const calls = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).sort();
			assert.deepEqual(calls.map((name) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { env?: { PI_SUBAGENT_FAST_MODE?: string | null } }).env?.PI_SUBAGENT_FAST_MODE), ["0", "1"]);
			assert.equal(mockPi.callCount(), 2);
		} finally {
			mockPi.uninstall();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps orchestrator nested worker launches synchronous when async is only configured by default", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-default-sync-worker-"));
		try {
			git(root, ["init"]);
			git(root, ["config", "user.email", "tests@example.com"]);
			git(root, ["config", "user.name", "Nested Control Tests"]);
			fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
			git(root, ["add", "-A"]);
			git(root, ["commit", "-m", "init"]);
			const route = createNestedRoute("root-ralph-default-sync-worker");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "ralph-default-sync-worker-run");
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("foreground worker attempt reached execution"); } },
			};
			const executor = createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }], true, { emit() {}, on() { return () => {}; } }, true);

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /foreground worker attempt reached execution/);
			assert.doesNotMatch(text(result), /Async mode requires/);
			assert.doesNotMatch(text(result), /Ralph orchestrator nested worker async guard blocked/);
			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			assert.equal(registry.children[0]?.state, "failed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows top-level async worker requests", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-top-level-async-worker-"));
		try {
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("top-level async reached execution setup"); } },
			};
			const executor = createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }]);

			const result = await executor.execute("run", { agent: "worker", task: "go", async: true }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /top-level async reached execution setup/);
			assert.doesNotMatch(text(result), /Ralph orchestrator nested worker async guard blocked/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows orchestrator to launch one nested worker then a nested ralph-reviewer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-worker-reviewer-guard-"));
		try {
			git(root, ["init"]);
			git(root, ["config", "user.email", "tests@example.com"]);
			git(root, ["config", "user.name", "Nested Control Tests"]);
			fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
			git(root, ["add", "-A"]);
			git(root, ["commit", "-m", "init"]);
			const route = createNestedRoute("root-ralph-worker-reviewer");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "ralph-worker-reviewer-run");
			const state = createState();
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("worker attempt reached execution"); } },
			};
			const executor = createExecutor(state, [
				{ name: "worker", description: "Worker", prompt: "Do work" },
				{ name: "ralph-reviewer", description: "Reviewer", prompt: "Review work" },
			]);

			const worker = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);
			const reviewer = await executor.execute("run", { agent: "ralph-reviewer", task: "review", acceptance: false }, new AbortController().signal, undefined, ctx(root));

			assert.equal(worker.isError, true);
			assert.match(text(worker), /worker attempt reached execution/);
			assert.equal(reviewer.isError, true);
			assert.match(text(reviewer), /acceptance must be an object/);
			assert.doesNotMatch(text(reviewer), /Ralph orchestrator nested worker guard blocked/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows sequential orchestrator nested worker launches after the previous worker returns", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-sequential-worker-guard-"));
		const mockPi = createMockPi();
		try {
			mockPi.install();
			mockPi.onCall({ output: "first worker done" });
			mockPi.onCall({ output: "second worker done" });
			git(root, ["init"]);
			git(root, ["config", "user.email", "tests@example.com"]);
			git(root, ["config", "user.name", "Nested Control Tests"]);
			fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
			git(root, ["add", "-A"]);
			git(root, ["commit", "-m", "init"]);
			const route = createNestedRoute("root-ralph-sequential-worker");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "ralph-sequential-worker-run");
			const state = createState();
			const executor = createExecutor(state, [{ name: "worker", description: "Worker", prompt: "Do work" }]);

			const first = await executor.execute("run", { agent: "worker", task: "Summarize first step" }, new AbortController().signal, undefined, ctx(root));
			const second = await executor.execute("run", { agent: "worker", task: "Summarize follow-up step" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(first.isError, undefined);
			assert.match(text(first), /first worker done/);
			assert.equal(second.isError, undefined);
			assert.match(text(second), /second worker done/);
			assert.equal(mockPi.callCount(), 2);
		} finally {
			mockPi.uninstall();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not mark malformed orchestrator nested acceptance attempts as active workers", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-malformed-guard-"));
		try {
			git(root, ["init"]);
			git(root, ["config", "user.email", "tests@example.com"]);
			git(root, ["config", "user.name", "Nested Control Tests"]);
			fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
			git(root, ["add", "-A"]);
			git(root, ["commit", "-m", "init"]);
			const route = createNestedRoute("root-ralph-malformed");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "ralph-malformed-run");
			const executor = createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }]);

			const first = await executor.execute("run", { agent: "worker", task: "go", acceptance: false }, new AbortController().signal, undefined, ctx(root));
			const second = await executor.execute("run", { agent: "worker", task: "go", acceptance: false }, new AbortController().signal, undefined, ctx(root));

			assert.equal(first.isError, true);
			assert.match(text(first), /acceptance must be an object/);
			assert.equal(second.isError, true);
			assert.match(text(second), /acceptance must be an object/);
			assert.doesNotMatch(text(second), /Ralph orchestrator nested worker guard blocked/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not treat malformed orchestrator nested attempts with no visible target as active workers", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-unknown-target-guard-"));
		try {
			const route = createNestedRoute("root-ralph-unknown-target");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route, "ralph-unknown-target-run");
			const executor = createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }]);

			const first = await executor.execute("run", { task: "go" }, new AbortController().signal, undefined, ctx(root));
			const second = await executor.execute("run", { task: "go again" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(first.isError, true);
			assert.match(text(first), /Provide exactly one mode/);
			assert.equal(second.isError, true);
			assert.match(text(second), /Provide exactly one mode/);
			assert.doesNotMatch(text(second), /Ralph orchestrator nested worker guard blocked/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not apply the orchestrator nested guard to non-orchestrator parent subagent usage", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-non-ralph-guard-"));
		try {
			const route = createNestedRoute("root-non-ralph");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "worker-parent-run");
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
			process.env[SUBAGENT_RUN_ID_ENV] = "worker-run";
			const executor = createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }]);

			const first = await executor.execute("run", { agent: "worker", task: "go", acceptance: false }, new AbortController().signal, undefined, ctx(root));
			const second = await executor.execute("run", { agent: "worker", task: "go", acceptance: false }, new AbortController().signal, undefined, ctx(root));

			assert.equal(first.isError, true);
			assert.equal(second.isError, true);
			assert.match(text(first), /acceptance must be an object/);
			assert.match(text(second), /acceptance must be an object/);
			assert.doesNotMatch(text(second), /Ralph orchestrator nested worker guard blocked/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes interrupt to an explicit nested id through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
		try {
			const route = createNestedRun();
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested control request");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested interrupt accepted" });
			}, 50);

			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-live" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested interrupt accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders nested children in foreground status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-status-"));
		try {
			const route = createNestedRun("nested-foreground");
			const state = createState();
			state.foregroundControls.set("root-control", {
				runId: "root-control",
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				currentAgent: "orchestrator",
				currentIndex: 0,
				nestedRoute: route,
			});
			state.lastForegroundControlId = "root-control";

			const result = await createExecutor(state).execute("status", { action: "status", id: "root-control" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Run: root-control/);
			assert.match(text(result), /↳ worker \[nested-foreground\] running/);
			assert.match(text(result), /Status: subagent\(\{ action: "status", id: "nested-foreground" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scopes child-safe nested status lookup to the inherited route and child address", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-scope-"));
		try {
			const allowedRoute = createNestedRun("shared-nested");
			setNestedRouteEnv(allowedRoute, "root-control");
			const outsideRoute = createNestedRoute("root-outside");
			routeRoots.push(path.dirname(outsideRoute.eventSink));
			writeNestedEvent(outsideRoute, {
				type: "subagent.nested.updated",
				ts: 100,
				parentRunId: "root-outside",
				parentStepIndex: 0,
				child: { id: "shared-nested", parentRunId: "root-outside", parentStepIndex: 0, depth: 1, path: [{ runId: "root-outside", stepIndex: 0 }], state: "running", agent: "outside" },
			});

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status", id: "shared-nested" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Nested run: shared-nested/);
			assert.match(text(result), /Root: root-control/);
			assert.doesNotMatch(text(result), /root-outside/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires an id for child-safe status instead of listing unrelated top-level async runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-safe-status-"));
		const runId = `child-safe-unrelated-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "outside", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /requires an id/);
			assert.doesNotMatch(text(result), new RegExp(runId));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("does not let bare interrupt target hidden nested descendants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
		try {
			createNestedRun("nested-only");
			const result = await createExecutor().execute("interrupt", { action: "interrupt" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /No interrupt-capable run found/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out owner-gone nested control and ignores late results", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-timeout-"));
		try {
			const route = createNestedRun("nested-timeout");
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				if (request) writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "late success" });
			}, 1_200);
			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-timeout" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /owner is not reachable/);
			assert.doesNotMatch(text(result), /late success/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes resume for live nested runs through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
		try {
			const emitted: Array<{ name: string; payload: unknown }> = [];
			const events = { emit(name: string, payload: unknown) { emitted.push({ name, payload }); }, on() { return () => {}; } };
			const route = createNestedRun("nested-live-resume", "running", { intercomTarget: "attacker-target", leafIntercomTarget: "attacker-leaf" });
			const executor = createExecutor(stateWithNestedRoute(route), [], true, events);
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested resume request");
				assert.equal(request.action, "resume");
				assert.equal(request.message, "continue please");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested resume accepted" });
			}, 50);

			const result = await executor.execute("resume", { action: "resume", id: "nested-live-resume", message: "continue please" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested resume accepted/);
			assert.equal(emitted.some((event) => {
				const payload = event.payload as { to?: unknown };
				return payload.to === "attacker-target" || payload.to === "attacker-leaf";
			}), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates terminal nested resume session files before revive", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
		try {
			const route = createNestedRun("nested-terminal-resume", "complete", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-terminal-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /session file does not exist/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files outside trusted roots", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const attackerSessionFile = path.join(root, "outside", "session.jsonl");
			fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(attackerSessionFile, "");
			const route = createNestedRun("nested-untrusted-resume", "complete", { sessionFile: attackerSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-untrusted-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /outside trusted nested session roots/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files from sibling run directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(siblingSessionFile, "");
			const route = createNestedRun("nested-sibling-resume", "complete", { sessionFile: siblingSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-sibling-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /not under that nested run's session directory/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits a failed completed nested event when foreground execution throws after start", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-throw-"));
		try {
			const route = createNestedRoute("root-parent");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "root-parent");
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("model registry exploded"); } },
			};

			const result = await createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /model registry exploded/);
			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			assert.equal(registry.children[0]?.state, "failed");
			assert.match(registry.children[0]?.error ?? "", /model registry exploded/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the fanout child control listener alive after control inbox polling errors", async () => {
		const route = createNestedRoute("root-poll-error");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-poll-error");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.controlInbox, { recursive: true, force: true });
		fs.writeFileSync(route.controlInbox, "not a directory", "utf-8");
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes(route.controlInbox) && String(entry[0] ?? "").includes("root-poll-error")));

			fs.rmSync(route.controlInbox, { force: true });
			fs.mkdirSync(route.controlInbox, { recursive: true });
			const requestPath = writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: "poll-error-recovers",
				targetRunId: "missing-run",
				action: "interrupt",
			});

			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "poll-error-recovers" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			console.error = originalError;
		}
	});

	it("keeps fanout child control requests when result writing fails and retries after recovery", async () => {
		const route = createNestedRoute("root-result-write-fails");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-result-write-fails");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.eventSink, { recursive: true, force: true });
		fs.writeFileSync(route.eventSink, "not a directory", "utf-8");
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "result-write-fails",
			targetRunId: "missing-run",
			action: "interrupt",
		});
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes("result-write-fails") && /keeping request for retry/.test(String(entry[0] ?? ""))));
			assert.equal(fs.existsSync(requestPath), true);

			fs.rmSync(route.eventSink, { force: true });
			fs.mkdirSync(route.eventSink, { recursive: true });
			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "result-write-fails" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			console.error = originalError;
		}
	});

	it("negatively acknowledges ownerless fanout child control requests and removes them", async () => {
		const route = createNestedRoute("root-ownerless");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-ownerless");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "ownerless-request",
			targetRunId: "missing-run",
			action: "interrupt",
		});

		registerFanoutChildSubagentExtension(pi);
		await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "ownerless-request" && result.ok === false));

		assert.equal(fs.existsSync(requestPath), false);
		const result = readNestedControlResults(route).find((item) => item.requestId === "ownerless-request");
		assert.match(result?.message ?? "", /not active/);
	});
});
