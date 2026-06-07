/**
 * Unit tests for run-tree collection and flattening logic
 * covering empty state, foreground runs, async runs, nested children
 * under chain/parallel steps, and sort ordering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { collectRunTree, type OverlayRun } from "../../src/tui/run-tree-collector.ts";
import { resolveSessionPath } from "../../src/tui/session-reader.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState, AsyncJobState, NestedRunSummary } from "../../src/shared/types.ts";

function baseState(overrides: Partial<SubagentState> = {}): SubagentState {
	return {
		baseCwd: "/tmp/test",
		currentSessionId: "test-session",
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
		...overrides,
	};
}

function addAsyncJob(state: SubagentState, job: Partial<AsyncJobState> & { asyncId: string; asyncDir: string }): void {
	const full: AsyncJobState = {
		status: "running",
		asyncId: job.asyncId,
		asyncDir: job.asyncDir,
		startedAt: job.startedAt ?? 1000,
		updatedAt: job.updatedAt ?? 2000,
		...job,
	};
	state.asyncJobs.set(job.asyncId, full);
}

function addForegroundControl(
	state: SubagentState,
	id: string,
	overrides: Partial<SubagentState["foregroundControls"] extends Map<string, infer V> ? V : never> = {},
): void {
	state.foregroundControls.set(id, {
		runId: id,
		mode: "single",
		startedAt: 1000,
		updatedAt: 2000,
		...overrides,
	});
}

function makeNestedChild(overrides: Partial<NestedRunSummary> = {}): NestedRunSummary {
	return {
		id: "nested-1",
		parentRunId: "run-1",
		depth: 1,
		path: [{ runId: "run-1" }],
		state: "running",
		agent: "worker",
		...overrides,
	};
}

function addForegroundRun(
	state: SubagentState,
	id: string,
	overrides: Partial<SubagentState["foregroundRuns"] extends Map<string, infer V> ? V : never> = {},
): void {
	state.foregroundRuns!.set(id, {
		runId: id,
		mode: "single",
		cwd: "/tmp",
		startedAt: 1000,
		updatedAt: 2000,
		children: [{ agent: "worker", index: 0, status: "completed" }],
		...overrides,
	});
}

function makePersistedRoots(): { root: string; asyncDirRoot: string; foregroundDirRoot: string; resultsDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-tree-"));
	const asyncDirRoot = path.join(root, "async");
	const foregroundDirRoot = path.join(root, "foreground");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(asyncDirRoot, { recursive: true });
	fs.mkdirSync(foregroundDirRoot, { recursive: true });
	fs.mkdirSync(resultsDir, { recursive: true });
	return { root, asyncDirRoot, foregroundDirRoot, resultsDir };
}

function writePersistedAsyncStatus(asyncDirRoot: string, id: string, status: Record<string, unknown>): string {
	const asyncDir = path.join(asyncDirRoot, id);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
	return asyncDir;
}

function writePersistedForegroundStatus(foregroundDirRoot: string, id: string, status: Record<string, unknown>): string {
	const foregroundDir = path.join(foregroundDirRoot, id);
	fs.mkdirSync(foregroundDir, { recursive: true });
	fs.writeFileSync(path.join(foregroundDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
	return foregroundDir;
}

function writePersistedResult(resultsDir: string, id: string, result: Record<string, unknown>): string {
	const resultPath = path.join(resultsDir, `${id}.json`);
	fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8");
	return resultPath;
}

describe("collectRunTree", () => {
	it("returns empty array when no runs exist", () => {
		const state = baseState();
		const runs = collectRunTree(state);
		assert.deepStrictEqual(runs, []);
	});

	it("collects a foreground single run", () => {
		const state = baseState();
		addForegroundControl(state, "fg-1", {
			currentAgent: "worker",
			mode: "single",
			currentTool: "read",
			currentModel: "review-model",
			tokens: 1200,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-1");
		assert.strictEqual(runs[0]!.state, "running");
		assert.strictEqual(runs[0]!.source, "foreground");
		assert.strictEqual(runs[0]!.mode, "single");
		assert.ok(runs[0]!.agents.includes("worker"));
		assert.strictEqual(runs[0]!.currentTool, "read");
		assert.strictEqual(runs[0]!.model, "review-model");
		assert.deepStrictEqual(runs[0]!.tokens, { input: 0, output: 1200, total: 1200 });
		// Should have a synthesized step
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
		assert.strictEqual(runs[0]!.steps[0]!.currentTool, "read");
		assert.strictEqual(runs[0]!.steps[0]!.model, "review-model");
		assert.deepStrictEqual(runs[0]!.steps[0]!.tokens, { input: 0, output: 1200, total: 1200 });
	});

	it("shows runtime-resolved model on live foreground single run when agent has no configured model", () => {
		const state = baseState();
		addForegroundControl(state, "fg-runtime-model", {
			currentAgent: "echo",
			mode: "single",
			currentModel: "runtime/gpt-4o",
			tokens: 1500,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.model, "runtime/gpt-4o");
		assert.deepStrictEqual(runs[0]!.tokens, { input: 0, output: 1500, total: 1500 });
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.model, "runtime/gpt-4o");
	});

	it("shows runtime-resolved model on live foreground chain run", () => {
		const state = baseState();
		addForegroundControl(state, "fg-chain-runtime", {
			currentAgent: "worker",
			mode: "chain",
			currentIndex: 1,
			currentModel: "runtime/claude-sonnet",
			tokens: 2000,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.model, "runtime/claude-sonnet");
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.model, "runtime/claude-sonnet");
	});

	it("shows runtime-resolved model on live foreground parallel run", () => {
		const state = baseState();
		addForegroundControl(state, "fg-parallel-runtime", {
			currentAgent: "reviewer",
			mode: "parallel",
			currentIndex: 0,
			currentModel: "runtime/gpt-4o-mini",
			tokens: 800,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.model, "runtime/gpt-4o-mini");
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.model, "runtime/gpt-4o-mini");
	});

	it("propagates nested child sessionFile and asyncDir to live foreground run", () => {
		const state = baseState();
		addForegroundControl(state, "fg-live", {
			currentAgent: "worker",
			mode: "single",
			nestedChildren: [makeNestedChild({ id: "nested-1", parentRunId: "fg-live", agent: "worker", sessionFile: "/tmp/nested/session.jsonl", asyncDir: "/tmp/nested" })],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.sessionFile, "/tmp/nested/session.jsonl");
		assert.strictEqual(runs[0]!.asyncDir, "/tmp/nested");
	});

	it("propagates foregroundControl sessionFile to synthesized step and run", () => {
		const state = baseState();
		addForegroundControl(state, "fg-session", {
			currentAgent: "worker",
			mode: "single",
			currentTool: "read",
			sessionFile: "/tmp/fg-session/run-0/session.jsonl",
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.sessionFile, "/tmp/fg-session/run-0/session.jsonl");
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.sessionFile, "/tmp/fg-session/run-0/session.jsonl");
	});

	it("does not duplicate a single active foreground worker in the run tree", () => {
		const state = baseState();
		addForegroundControl(state, "fg-single", {
			currentAgent: "worker",
			mode: "single",
			currentTool: "read",
			sessionFile: "/tmp/fg-single/run-0/session.jsonl",
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-single");
		assert.deepStrictEqual(runs[0]!.agents, ["worker"]);
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
	});

	it("attaches nested foreground children to a synthesized current step", () => {
		const state = baseState();
		addForegroundControl(state, "fg-nested", {
			currentAgent: "worker",
			mode: "single",
			currentIndex: 0,
			nestedChildren: [makeNestedChild({ id: "nested-fg", parentRunId: "fg-nested", parentStepIndex: 0, agent: "reviewer" })],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs[0]!.steps[0]!.children.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.id, "nested-fg");
	});

	it("refreshes foreground nested children from the nested event route", () => {
		const route = createNestedRoute("fg-route");
		const child = makeNestedChild({ id: "nested-live", parentRunId: "fg-route", parentStepIndex: 0, agent: "reviewer" });
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1234,
			parentRunId: "fg-route",
			parentStepIndex: 0,
			child,
		});
		const state = baseState();
		addForegroundControl(state, "fg-route", {
			currentAgent: "worker",
			mode: "single",
			currentIndex: 0,
			nestedRoute: route,
		});

		const runs = collectRunTree(state);

		assert.strictEqual(runs[0]!.steps[0]!.children.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.id, "nested-live");
	});

	it("collects an async background run", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-1",
			asyncDir: "/tmp/async-1",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [{ agent: "reviewer", status: "running", index: 0 }],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "async-1");
		assert.strictEqual(runs[0]!.source, "async");
		assert.strictEqual(runs[0]!.agents[0], "reviewer");
		assert.strictEqual(runs[0]!.asyncDir, "/tmp/async-1");
	});

	it("sorts running before completed", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "done-1",
			asyncDir: "/tmp/done",
			status: "complete",
			mode: "single",
			agents: ["reviewer"],
			startedAt: 500,
			updatedAt: 600,
		});
		addAsyncJob(state, {
			asyncId: "run-1",
			asyncDir: "/tmp/run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			startedAt: 1000,
			updatedAt: 2000,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs[0]!.id, "run-1");
		assert.strictEqual(runs[0]!.state, "running");
		assert.strictEqual(runs[1]!.id, "done-1");
		assert.strictEqual(runs[1]!.state, "complete");
	});

	it("includes nested children under a chain step", () => {
		const nested = makeNestedChild({
			id: "nested-worker-1",
			parentRunId: "async-chain",
			parentStepIndex: 0,
			state: "running",
			agent: "worker",
			currentTool: "bash",
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-chain",
			asyncDir: "/tmp/chain",
			status: "running",
			mode: "chain",
			agents: ["researcher", "worker"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "researcher", status: "complete", index: 0, durationMs: 500, children: [] },
				{ agent: "worker", status: "running", index: 1, currentTool: "bash", children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		const run = runs[0]!;
		assert.strictEqual(run.steps.length, 2);
		// Step 1 (worker) should have nested children
		const workerStep = run.steps[1]!;
		assert.strictEqual(workerStep.agent, "worker");
		assert.strictEqual(workerStep.children.length, 1);
		assert.strictEqual(workerStep.children[0]!.agent, "worker");
		assert.strictEqual(workerStep.children[0]!.currentTool, "bash");
	});

	it("includes nested children under a parallel step", () => {
		const nested1 = makeNestedChild({
			id: "nested-1",
			parentRunId: "async-par",
			parentStepIndex: 0,
			state: "running",
			agent: "child-a",
		});
		const nested2 = makeNestedChild({
			id: "nested-2",
			parentRunId: "async-par",
			parentStepIndex: 1,
			state: "complete",
			agent: "child-b",
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-par",
			asyncDir: "/tmp/par",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "reviewer"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "reviewer", status: "running", index: 0, children: [nested1] },
				{ agent: "reviewer", status: "complete", index: 1, durationMs: 800, children: [nested2] },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.steps.length, 2);
		assert.strictEqual(runs[0]!.steps[0]!.children.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.agent, "child-a");
		assert.strictEqual(runs[0]!.steps[1]!.children.length, 1);
		assert.strictEqual(runs[0]!.steps[1]!.children[0]!.agent, "child-b");
	});

	it("includes deeply nested children (3 levels)", () => {
		const deepNested = makeNestedChild({
			id: "deep-1",
			parentRunId: "nested-1",
			depth: 2,
			path: [{ runId: "run-1" }, { runId: "nested-1" }],
			state: "running",
			agent: "deep-worker",
			currentTool: "edit",
		});
		const nested = makeNestedChild({
			id: "nested-1",
			parentRunId: "async-1",
			depth: 1,
			path: [{ runId: "async-1" }],
			state: "running",
			agent: "worker",
			children: [deepNested],
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-1",
			asyncDir: "/tmp/a1",
			status: "running",
			mode: "single",
			agents: ["worker"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "worker", status: "running", index: 0, children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		const step = runs[0]!.steps[0]!;
		assert.strictEqual(step.children.length, 1);
		assert.strictEqual(step.children[0]!.agent, "worker");
		assert.strictEqual(step.children[0]!.children.length, 1);
		assert.strictEqual(step.children[0]!.children[0]!.agent, "deep-worker");
		assert.strictEqual(step.children[0]!.children[0]!.currentTool, "edit");
	});

	it("maps nested run model and tokens to overlay rows", () => {
		const nested = makeNestedChild({
			id: "nested-model",
			parentRunId: "async-1",
			depth: 1,
			path: [{ runId: "async-1" }],
			state: "running",
			agent: "reviewer",
			model: "claude-sonnet",
			totalTokens: { input: 1000, output: 500, total: 1500 },
			steps: [
				{ agent: "reviewer", status: "running", model: "claude-sonnet", totalTokens: { input: 1000, output: 500, total: 1500 } },
			],
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-1",
			asyncDir: "/tmp/a1",
			status: "running",
			mode: "single",
			agents: ["worker"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "worker", status: "complete", index: 0, durationMs: 500 },
				{ agent: "worker", status: "running", index: 1, children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		const workerStep = runs[0]!.steps[1]!;
		assert.strictEqual(workerStep.children.length, 1);
		const nestedRow = workerStep.children[0]!;
		assert.strictEqual(nestedRow.model, "claude-sonnet");
		assert.deepStrictEqual(nestedRow.tokens, { input: 1000, output: 500, total: 1500 });
		assert.strictEqual(nestedRow.steps?.length, 1);
		assert.strictEqual(nestedRow.steps![0]!.model, "claude-sonnet");
		assert.deepStrictEqual(nestedRow.steps![0]!.tokens, { input: 1000, output: 500, total: 1500 });
	});

	it("maps async state strings to overlay states", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "paused-1",
			asyncDir: "/tmp/p",
			status: "paused",
			mode: "single",
			agents: ["worker"],
		});
		addAsyncJob(state, {
			asyncId: "failed-1",
			asyncDir: "/tmp/f",
			status: "failed",
			mode: "single",
			agents: ["worker"],
		});
		const runs = collectRunTree(state);
		const states = runs.map((r) => r.state);
		assert.ok(states.includes("failed"), "should include failed");
		assert.ok(states.includes("paused"), "should include paused");
	});

	it("collects a finished foreground run from foregroundRuns", () => {
		const state = baseState();
		addForegroundRun(state, "fg-done", {
			mode: "single",
			children: [{ agent: "worker", index: 0, status: "completed", sessionFile: "/tmp/worker.jsonl", model: "done-model", totalTokens: { input: 10, output: 5, total: 15 } }],
			nestedChildren: [makeNestedChild({ id: "nested-done", parentRunId: "fg-done", parentStepIndex: 0, state: "complete", agent: "reviewer", model: "review-model", totalTokens: { input: 4, output: 3, total: 7 } })],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-done");
		assert.strictEqual(runs[0]!.state, "complete");
		assert.strictEqual(runs[0]!.source, "foreground");
		assert.strictEqual(runs[0]!.mode, "single");
		assert.deepStrictEqual(runs[0]!.agents, ["worker"]);
		assert.strictEqual(runs[0]!.model, "done-model");
		assert.deepStrictEqual(runs[0]!.tokens, { input: 10, output: 5, total: 15 });
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
		assert.strictEqual(runs[0]!.steps[0]!.state, "complete");
		assert.strictEqual(runs[0]!.steps[0]!.model, "done-model");
		assert.deepStrictEqual(runs[0]!.steps[0]!.tokens, { input: 10, output: 5, total: 15 });
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.id, "nested-done");
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.model, "review-model");
		assert.strictEqual(runs[0]!.sessionFile, "/tmp/worker.jsonl");
	});

	it("computes elapsed for finished foreground runs when startedAt is present", () => {
		const state = baseState();
		addForegroundRun(state, "fg-elapsed", {
			startedAt: 1000,
			updatedAt: 5500,
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		const runs = collectRunTree(state, 6000);
		assert.strictEqual(runs[0]!.elapsed, "4.5s");
	});

	it("deduplicates live foregroundControls against finished foregroundRuns", () => {
		const state = baseState();
		addForegroundControl(state, "fg-live", {
			currentAgent: "worker",
			mode: "single",
			startedAt: 1000,
			updatedAt: 2000,
		});
		addForegroundRun(state, "fg-live", {
			mode: "single",
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-live");
		assert.strictEqual(runs[0]!.state, "running");
	});

	it("hydrates interrupted persisted foreground runs after parent session resume", () => {
		const { root, foregroundDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			writePersistedForegroundStatus(foregroundDirRoot, "fg-interrupted", {
				runId: "fg-interrupted",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "running",
				startedAt: 1000,
				updatedAt: 2000,
				currentAgent: "file-reader-demo",
				currentIndex: 0,
				children: [{ agent: "file-reader-demo", index: 0, status: "running", sessionFile: "/tmp/fg/session.jsonl" }],
			});

			const runs = collectRunTree(state, 5000, { foregroundDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "fg-interrupted");
			assert.strictEqual(runs[0]!.source, "foreground");
			assert.strictEqual(runs[0]!.state, "paused");
			assert.deepStrictEqual(runs[0]!.agents, ["file-reader-demo"]);
			assert.strictEqual(runs[0]!.steps[0]!.state, "paused");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates completed persisted foreground runs after parent session resume", () => {
		const { root, foregroundDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			writePersistedForegroundStatus(foregroundDirRoot, "fg-complete", {
				runId: "fg-complete",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				updatedAt: 2000,
				children: [{ agent: "worker", index: 0, status: "completed", sessionFile: "/tmp/fg-complete/session.jsonl" }],
			});

			const runs = collectRunTree(state, 5000, { foregroundDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "fg-complete");
			assert.strictEqual(runs[0]!.source, "foreground");
			assert.strictEqual(runs[0]!.state, "complete");
			assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
			assert.strictEqual(runs[0]!.steps[0]!.state, "complete");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves persisted foreground session files for detail view resolution", () => {
		const { root, foregroundDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			const sessionFile = path.join(root, "sessions", "fg-session.jsonl");
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(sessionFile, "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n", "utf-8");
			writePersistedForegroundStatus(foregroundDirRoot, "fg-session", {
				runId: "fg-session",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				updatedAt: 2000,
				children: [{ agent: "worker", index: 0, status: "completed", sessionFile }],
			});

			const runs = collectRunTree(state, 5000, { foregroundDirRoot, resultsDir });
			assert.strictEqual(runs[0]!.sessionFile, sessionFile);
			assert.strictEqual(runs[0]!.steps[0]!.sessionFile, sessionFile);
			assert.strictEqual(resolveSessionPath(runs[0]!, "session"), sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows finished foreground runs with failed state when any child failed", () => {
		const state = baseState();
		addForegroundRun(state, "fg-fail", {
			mode: "chain",
			children: [
				{ agent: "researcher", index: 0, status: "completed" },
				{ agent: "worker", index: 1, status: "failed" },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.state, "failed");
		assert.strictEqual(runs[0]!.steps[0]!.state, "complete");
		assert.strictEqual(runs[0]!.steps[1]!.state, "failed");
	});

	it("shows finished foreground runs with paused state when any child paused", () => {
		const state = baseState();
		addForegroundRun(state, "fg-pause", {
			mode: "parallel",
			children: [
				{ agent: "worker-a", index: 0, status: "completed" },
				{ agent: "worker-b", index: 1, status: "paused" },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.state, "paused");
	});

	it("sorts live foreground before finished foreground and async", () => {
		const state = baseState();
		addForegroundRun(state, "fg-done", {
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		addAsyncJob(state, {
			asyncId: "async-done",
			asyncDir: "/tmp/done",
			status: "complete",
			mode: "single",
			agents: ["reviewer"],
			startedAt: 500,
			updatedAt: 600,
		});
		addForegroundControl(state, "fg-live", {
			currentAgent: "live-agent",
			mode: "single",
			startedAt: 1000,
			updatedAt: 2000,
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 3);
		assert.strictEqual(runs[0]!.id, "fg-live");
		assert.strictEqual(runs[0]!.state, "running");
		assert.strictEqual(runs[1]!.id, "fg-done");
		assert.strictEqual(runs[1]!.state, "complete");
		assert.strictEqual(runs[2]!.id, "async-done");
		assert.strictEqual(runs[2]!.state, "complete");
	});

	it("propagates child artifactPath into finished foreground run and steps", () => {
		const state = baseState();
		addForegroundRun(state, "fg-artifacts", {
			mode: "chain",
			children: [
				{ agent: "worker-a", index: 0, status: "completed", artifactPath: "/tmp/a/output.log" },
				{ agent: "worker-b", index: 1, status: "completed", artifactPath: "/tmp/b/output.log" },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-artifacts");
		assert.strictEqual(runs[0]!.artifactPath, "/tmp/a/output.log");
		assert.strictEqual(runs[0]!.steps[0]!.artifactPath, "/tmp/a/output.log");
		assert.strictEqual(runs[0]!.steps[1]!.artifactPath, "/tmp/b/output.log");
	});

	it("falls back to artifactPath for detail pane when session file is missing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fg-artifact-"));
		const artifactFile = path.join(dir, "output.log");
		fs.writeFileSync(artifactFile, "log line\n", "utf-8");
		try {
			const run: OverlayRun = {
				id: "fg-fallback",
				label: "single: worker",
				state: "complete",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				sessionFile: "/nonexistent/session.jsonl",
				artifactPath: artifactFile,
				steps: [],
			};
			const resolved = resolveSessionPath(run);
			assert.strictEqual(resolved, artifactFile);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sorts finished runs newest-first by updatedAt within the same rank", () => {
		const state = baseState();
		addForegroundRun(state, "fg-oldest", {
			updatedAt: 1000,
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		addForegroundRun(state, "fg-newer", {
			updatedAt: 3000,
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		addForegroundRun(state, "fg-newest", {
			updatedAt: 5000,
			children: [{ agent: "worker", index: 0, status: "completed" }],
		});
		const runs = collectRunTree(state);
		assert.deepStrictEqual(runs.map((r) => r.id), ["fg-newest", "fg-newer", "fg-oldest"]);
	});

	it("sorts runs by start time latest first regardless of state", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "complete-1",
			asyncDir: "/tmp/c1",
			status: "complete",
			mode: "single",
			agents: ["a"],
			startedAt: 500,
			updatedAt: 600,
		});
		addAsyncJob(state, {
			asyncId: "paused-1",
			asyncDir: "/tmp/p1",
			status: "paused",
			mode: "single",
			agents: ["a"],
			startedAt: 400,
			updatedAt: 600,
		});
		addAsyncJob(state, {
			asyncId: "failed-1",
			asyncDir: "/tmp/f1",
			status: "failed",
			mode: "single",
			agents: ["a"],
			startedAt: 300,
			updatedAt: 600,
		});
		addAsyncJob(state, {
			asyncId: "queued-1",
			asyncDir: "/tmp/q1",
			status: "queued",
			mode: "single",
			agents: ["a"],
			startedAt: 200,
			updatedAt: 600,
		});
		addAsyncJob(state, {
			asyncId: "running-1",
			asyncDir: "/tmp/r1",
			status: "running",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 600,
		});
		const runs = collectRunTree(state);
		assert.deepStrictEqual(runs.map((r) => r.id), ["complete-1", "paused-1", "failed-1", "queued-1", "running-1"]);
	});

	it("loads persisted completed async runs after in-memory cleanup and merges result paths", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			const asyncDir = writePersistedAsyncStatus(asyncDirRoot, "persisted-complete", {
				runId: "persisted-complete",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				endedAt: 4000,
				lastUpdate: 4000,
				outputFile: "output-0.log",
				steps: [{ agent: "worker", status: "complete", durationMs: 3000 }],
			});
			const sessionFile = path.join(asyncDir, "child-session.jsonl");
			const artifactPath = path.join(asyncDir, "child-output.md");
			const logPath = path.join(asyncDir, "output-0.log");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			fs.writeFileSync(artifactPath, "done\n", "utf-8");
			fs.writeFileSync(logPath, "log\n", "utf-8");
			writePersistedResult(resultsDir, "persisted-complete", {
				id: "persisted-complete",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				asyncDir,
				results: [{ agent: "worker", success: true, sessionFile, artifactPaths: { outputPath: artifactPath } }],
			});

			const runs = collectRunTree(state, 5000, { asyncDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "persisted-complete");
			assert.strictEqual(runs[0]!.state, "complete");
			assert.strictEqual(runs[0]!.sessionFile, sessionFile);
			assert.strictEqual(runs[0]!.logPath, logPath);
			assert.strictEqual(runs[0]!.artifactPath, artifactPath);
			assert.strictEqual(runs[0]!.asyncDir, asyncDir);
			assert.strictEqual(runs[0]!.steps[0]!.artifactPath, artifactPath);
			assert.strictEqual(runs[0]!.steps[0]!.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries persisted async step sessionFile from status into collected rows", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			const asyncDir = writePersistedAsyncStatus(asyncDirRoot, "persisted-step-session", {
				runId: "persisted-step-session",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "complete", sessionFile: path.join(root, "worker-session.jsonl") }],
			});
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");

			const runs = collectRunTree(state, 3000, { asyncDirRoot, resultsDir });

			assert.strictEqual(runs[0]!.id, "persisted-step-session");
			assert.strictEqual(runs[0]!.asyncDir, asyncDir);
			assert.strictEqual(runs[0]!.steps[0]!.sessionFile, sessionFile);
			assert.strictEqual(runs[0]!.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates completed persisted async nested children from nested route events", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		const state = baseState();
		const route = createNestedRoute("persisted-nested-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: 4500,
				parentRunId: "persisted-parent",
				parentStepIndex: 0,
				child: makeNestedChild({
					id: "nested-reviewer",
					parentRunId: "persisted-parent",
					parentStepIndex: 0,
					state: "complete",
					agent: "reviewer",
					sessionFile: "/tmp/nested-reviewer/session.jsonl",
				}),
			});
			writePersistedAsyncStatus(asyncDirRoot, "persisted-parent", {
				runId: "persisted-parent",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				endedAt: 5000,
				lastUpdate: 5000,
				nestedRoute: route,
				steps: [{ agent: "ralph-orchestrator", status: "complete", durationMs: 4000 }],
			});

			const runs = collectRunTree(state, 6000, { asyncDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "persisted-parent");
			assert.strictEqual(runs[0]!.state, "complete");
			assert.strictEqual(runs[0]!.steps[0]!.children.length, 1);
			assert.strictEqual(runs[0]!.steps[0]!.children[0]!.id, "nested-reviewer");
			assert.strictEqual(runs[0]!.steps[0]!.children[0]!.state, "complete");
			assert.strictEqual(runs[0]!.steps[0]!.children[0]!.sessionFile, "/tmp/nested-reviewer/session.jsonl");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("hydrates queued async runs from disk after parent session resume", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			const asyncDir = writePersistedAsyncStatus(asyncDirRoot, "persisted-queued", {
				runId: "persisted-queued",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "queued",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "pending" }],
			});

			const runs = collectRunTree(state, 5000, { asyncDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "persisted-queued");
			assert.strictEqual(runs[0]!.state, "queued");
			assert.strictEqual(runs[0]!.asyncDir, asyncDir);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates interrupted running async runs from disk after parent session resume", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			const asyncDir = writePersistedAsyncStatus(asyncDirRoot, "persisted-interrupted", {
				runId: "persisted-interrupted",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "running",
				pid: 999999,
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "running" }],
			});
			// Mock kill so the PID is always considered dead (ESRCH)
			const mockKill = (_pid: number, _signal?: NodeJS.Signals | 0) => {
				const err = new Error("No such process") as NodeJS.ErrnoException;
				err.code = "ESRCH";
				throw err;
			};

			const runs = collectRunTree(state, 5000, { asyncDirRoot, resultsDir, kill: mockKill });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "persisted-interrupted");
			// Reconciliation should mark the dead run as failed
			assert.strictEqual(runs[0]!.state, "failed");
			assert.strictEqual(runs[0]!.asyncDir, asyncDir);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates live async jobs against persisted running status on disk", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState();
			addAsyncJob(state, {
				asyncId: "live-and-persisted",
				asyncDir: "/tmp/does-not-matter",
				status: "running",
				mode: "single",
				agents: ["worker"],
				startedAt: 1000,
				updatedAt: 2000,
			});
			writePersistedAsyncStatus(asyncDirRoot, "live-and-persisted", {
				runId: "live-and-persisted",
				sessionId: "test-session",
				cwd: "/tmp/test",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "running" }],
			});

			const runs = collectRunTree(state, 5000, { asyncDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "live-and-persisted");
			assert.strictEqual(runs[0]!.state, "running");
			// Should come from in-memory asyncJobs, not disk
			assert.strictEqual(runs[0]!.asyncDir, "/tmp/does-not-matter");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scopes persisted async runs to the current session with cwd fallback", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState({ baseCwd: "/tmp/test", currentSessionId: "session-a" });
			writePersistedAsyncStatus(asyncDirRoot, "same-session", {
				runId: "same-session",
				sessionId: "session-a",
				cwd: "/tmp/other",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "complete" }],
			});
			writePersistedAsyncStatus(asyncDirRoot, "cwd-fallback", {
				runId: "cwd-fallback",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2100,
				steps: [{ agent: "worker", status: "complete" }],
			});
			writePersistedAsyncStatus(asyncDirRoot, "other-session", {
				runId: "other-session",
				sessionId: "session-b",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2200,
				steps: [{ agent: "worker", status: "complete" }],
			});
			writePersistedAsyncStatus(asyncDirRoot, "other-cwd", {
				runId: "other-cwd",
				cwd: "/tmp/not-this-project",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2300,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const ids = collectRunTree(state, 5000, { asyncDirRoot, resultsDir }).map((run) => run.id);
			assert.deepStrictEqual(ids, ["cwd-fallback", "same-session"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to persisted async result files when status directories are gone", () => {
		const { root, asyncDirRoot, resultsDir } = makePersistedRoots();
		try {
			const state = baseState({ baseCwd: "/tmp/test", currentSessionId: "session-a" });
			const asyncDir = path.join(asyncDirRoot, "result-only");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(asyncDir, "session.jsonl");
			const artifactPath = path.join(asyncDir, "output.md");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			fs.writeFileSync(artifactPath, "done\n", "utf-8");
			writePersistedResult(resultsDir, "result-only", {
				id: "result-only",
				sessionId: "session-a",
				cwd: "/tmp/test",
				mode: "single",
				state: "complete",
				asyncDir,
				results: [{ agent: "worker", success: true, sessionFile, artifactPaths: { outputPath: artifactPath } }],
			});

			const runs = collectRunTree(state, 5000, { asyncDirRoot, resultsDir });
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0]!.id, "result-only");
			assert.strictEqual(runs[0]!.sessionFile, sessionFile);
			assert.strictEqual(runs[0]!.artifactPath, artifactPath);
			assert.strictEqual(runs[0]!.asyncDir, asyncDir);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps pending step status to queued in overlay", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-pending",
			asyncDir: "/tmp/pending",
			status: "running",
			mode: "chain",
			agents: ["researcher", "worker"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "researcher", status: "complete", index: 0, durationMs: 500 },
				{ agent: "worker", status: "pending", index: 1 },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs[0]!.steps[1]!.state, "queued");
	});

	it("derives queued run state when chain has pending steps", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-mixed",
			asyncDir: "/tmp/mixed",
			status: "complete",
			mode: "chain",
			agents: ["a", "b"],
			startedAt: 1000,
			updatedAt: 2000,
			steps: [
				{ agent: "a", status: "complete", index: 0 },
				{ agent: "b", status: "pending", index: 1 },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs[0]!.state, "queued");
	});

	it("resolves finished foreground run with pending children as queued", () => {
		const state = baseState();
		addForegroundRun(state, "fg-pending", {
			mode: "chain",
			children: [
				{ agent: "a", index: 0, status: "completed" },
				{ agent: "b", index: 1, status: "pending" },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs[0]!.state, "queued");
		assert.strictEqual(runs[0]!.steps[0]!.state, "complete");
		assert.strictEqual(runs[0]!.steps[1]!.state, "queued");
	});

	it("derives nested run state from its steps, not stale stored state", () => {
		const nested = makeNestedChild({
			id: "nested-chain",
			parentRunId: "async-parent",
			state: "complete",
			mode: "chain",
			steps: [
				{ agent: "a", status: "complete" },
				{ agent: "b", status: "pending" },
			],
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-parent",
			asyncDir: "/tmp/parent",
			status: "complete",
			mode: "single",
			agents: ["parent"],
			steps: [
				{ agent: "parent", status: "complete", index: 0, children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		// Top header should not be complete because nested child has a pending step
		assert.strictEqual(runs[0]!.state, "queued");
		// Nested row should not be complete
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.state, "queued");
	});

	it("derives nested run state from its descendants, not stale stored state", () => {
		const deepChild = makeNestedChild({
			id: "deep-child",
			parentRunId: "nested-chain",
			state: "running",
			agent: "deep",
		});
		const nested = makeNestedChild({
			id: "nested-chain",
			parentRunId: "async-parent",
			state: "complete",
			mode: "chain",
			children: [deepChild],
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-parent",
			asyncDir: "/tmp/parent",
			status: "complete",
			mode: "single",
			agents: ["parent"],
			steps: [
				{ agent: "parent", status: "complete", index: 0, children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		// Top header should not be complete because nested child has a running descendant
		assert.strictEqual(runs[0]!.state, "running");
		// Nested row should not be complete
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.state, "running");
	});

	it("derives nested run state from step children, not stale stored state", () => {
		const stepChild = makeNestedChild({
			id: "step-child",
			parentRunId: "nested-chain",
			state: "running",
			agent: "step-child",
		});
		const nested = makeNestedChild({
			id: "nested-chain",
			parentRunId: "async-parent",
			state: "complete",
			mode: "chain",
			steps: [
				{ agent: "a", status: "complete", children: [stepChild] },
			],
		});
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "async-parent",
			asyncDir: "/tmp/parent",
			status: "complete",
			mode: "single",
			agents: ["parent"],
			steps: [
				{ agent: "parent", status: "complete", index: 0, children: [nested] },
			],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.state, "running");
		assert.strictEqual(runs[0]!.steps[0]!.children[0]!.state, "running");
	});
});
