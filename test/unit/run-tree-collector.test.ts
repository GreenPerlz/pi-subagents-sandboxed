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

function makePersistedRoots(): { root: string; asyncDirRoot: string; resultsDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-tree-"));
	const asyncDirRoot = path.join(root, "async");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(asyncDirRoot, { recursive: true });
	fs.mkdirSync(resultsDir, { recursive: true });
	return { root, asyncDirRoot, resultsDir };
}

function writePersistedAsyncStatus(asyncDirRoot: string, id: string, status: Record<string, unknown>): string {
	const asyncDir = path.join(asyncDirRoot, id);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
	return asyncDir;
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
			children: [{ agent: "worker", index: 0, status: "completed", sessionFile: "/tmp/worker.jsonl" }],
		});
		const runs = collectRunTree(state);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]!.id, "fg-done");
		assert.strictEqual(runs[0]!.state, "complete");
		assert.strictEqual(runs[0]!.source, "foreground");
		assert.strictEqual(runs[0]!.mode, "single");
		assert.deepStrictEqual(runs[0]!.agents, ["worker"]);
		assert.strictEqual(runs[0]!.steps.length, 1);
		assert.strictEqual(runs[0]!.steps[0]!.agent, "worker");
		assert.strictEqual(runs[0]!.steps[0]!.state, "complete");
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

	it("ranks running, queued, failed, and paused before complete", () => {
		const state = baseState();
		addAsyncJob(state, {
			asyncId: "complete-1",
			asyncDir: "/tmp/c1",
			status: "complete",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 200,
		});
		addAsyncJob(state, {
			asyncId: "paused-1",
			asyncDir: "/tmp/p1",
			status: "paused",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 200,
		});
		addAsyncJob(state, {
			asyncId: "failed-1",
			asyncDir: "/tmp/f1",
			status: "failed",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 200,
		});
		addAsyncJob(state, {
			asyncId: "queued-1",
			asyncDir: "/tmp/q1",
			status: "queued",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 200,
		});
		addAsyncJob(state, {
			asyncId: "running-1",
			asyncDir: "/tmp/r1",
			status: "running",
			mode: "single",
			agents: ["a"],
			startedAt: 100,
			updatedAt: 200,
		});
		const runs = collectRunTree(state);
		const ids = runs.map((r) => r.id);
		assert.ok(ids.indexOf("running-1") < ids.indexOf("queued-1"), "running before queued");
		assert.ok(ids.indexOf("queued-1") < ids.indexOf("failed-1"), "queued before failed");
		assert.ok(ids.indexOf("queued-1") < ids.indexOf("paused-1"), "queued before paused");
		assert.ok(ids.indexOf("failed-1") < ids.indexOf("complete-1"), "failed before complete");
		assert.ok(ids.indexOf("paused-1") < ids.indexOf("complete-1"), "paused before complete");
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
});
