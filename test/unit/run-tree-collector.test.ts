/**
 * Unit tests for run-tree collection and flattening logic
 * covering empty state, foreground runs, async runs, nested children
 * under chain/parallel steps, and sort ordering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectRunTree, type OverlayRun } from "../../src/tui/run-tree-collector.ts";
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
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-1");
		assert.strictEqual(runs[0]!.state, "running");
		assert.strictEqual(runs[0]!.source, "foreground");
		assert.strictEqual(runs[0]!.mode, "single");
		assert.ok(runs[0]!.agents.includes("worker"));
		// Should have a synthesized step
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
		assert.strictEqual(runs[0]!.steps[0]!.currentTool, "read");
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
		assert.strictEqual(runs[0]!.artifactPath, "/tmp/async-1");
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
});
