import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, afterEach } from "node:test";
import { shutdownOwnedAsyncJobs, ASYNC_INTERRUPT_SIGNAL } from "../../src/runs/background/session-shutdown-cascade.ts";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { TEMP_ROOT_DIR, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { createNestedRoute, readNestedControlRequests, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState, AsyncJobState, NestedRunSummary, NestedRouteInfo } from "../../src/shared/types.ts";

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

describe("session-shutdown cascade", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs) {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
		}
		tempDirs.length = 0;
	});

	function tmpDir(prefix: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	it("sends interrupt signal to each tracked async job pid", () => {
		const state = createState();
		const job: AsyncJobState = {
			asyncId: "job-1",
			asyncDir: "/tmp/test-async",
			status: "running",
			pid: 12345,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		state.asyncJobs.set("job-1", job);

		const killCalls: Array<{ pid: number; signal: string | number }> = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid, signal) => { killCalls.push({ pid, signal: signal ?? 0 }); return true; },
		});

		assert.equal(killCalls.length, 1);
		assert.equal(killCalls[0]!.pid, 12345);
		assert.equal(killCalls[0]!.signal, ASYNC_INTERRUPT_SIGNAL);
	});

	it("skips jobs without a pid", () => {
		const state = createState();
		const job: AsyncJobState = {
			asyncId: "job-no-pid",
			asyncDir: "/tmp/test-async",
			status: "queued",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		state.asyncJobs.set("job-no-pid", job);

		const killCalls: Array<{ pid: number }> = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid) => { killCalls.push({ pid }); return true; },
		});

		assert.equal(killCalls.length, 0);
	});

	it("continues if kill throws (process already dead)", () => {
		const state = createState();
		state.asyncJobs.set("j1", {
			asyncId: "j1", asyncDir: "/tmp/a", status: "running", pid: 100,
			startedAt: Date.now(), updatedAt: Date.now(),
		});
		state.asyncJobs.set("j2", {
			asyncId: "j2", asyncDir: "/tmp/b", status: "running", pid: 200,
			startedAt: Date.now(), updatedAt: Date.now(),
		});

		const killCalls: number[] = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid) => {
				killCalls.push(pid);
				if (pid === 100) throw new Error("ESRCH");
				return true;
			},
		});

		assert.deepEqual(killCalls, [100, 200]);
	});

	it("cascades interrupt to nested descendants when nestedRoute is present", () => {
		const rootRunId = "root-run-1";

		// Create a proper nested route via createNestedRoute
		const nestedRoute = createNestedRoute(rootRunId);
		// Track for cleanup
		const routeRoot = path.dirname(nestedRoute.eventSink);
		tempDirs.push(routeRoot);

		// Write a nested started event using the writeNestedEvent helper
		const childRunId = "child-1";
		// asyncDir must be under TEMP_ROOT_DIR/nested-subagent-runs/{rootRunId}/{childRunId}
		// so that resolveNestedAsyncDir returns it
		const childAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, childRunId);
		fs.mkdirSync(childAsyncDir, { recursive: true });
		fs.writeFileSync(path.join(childAsyncDir, "status.json"), JSON.stringify({
			runId: childRunId,
			mode: "single",
			state: "running",
			pid: 55555,
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			steps: [{ agent: "child-agent", status: "running", startedAt: Date.now() }],
		}), "utf-8");
		// Cleanup the nested async dir too
		tempDirs.push(childAsyncDir);

		// Emit nested started event
		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.started",
			ts: Date.now(),
			parentRunId: rootRunId,
			parentStepIndex: 0,
			child: {
				id: childRunId,
				parentRunId: rootRunId,
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: rootRunId, stepIndex: 0 }],
				asyncDir: childAsyncDir,
				pid: 55555,
				ownerState: "live",
				mode: "single",
				state: "running",
				agent: "child-agent",
				agents: ["child-agent"],
				chainStepCount: 1,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
			},
		});

		const state = createState();
		state.asyncJobs.set("parent-job", {
			asyncId: "parent-job",
			asyncDir: "/tmp/parent-async",
			status: "running",
			pid: 11111,
			nestedRoute,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const killCalls: Array<{ pid: number; signal: string | number }> = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid, signal) => { killCalls.push({ pid, signal: signal ?? 0 }); return true; },
			readStatus: (asyncDir: string) => {
				if (asyncDir === childAsyncDir) {
					return {
						runId: childRunId,
						mode: "single",
						state: "running",
						pid: 55555,
						startedAt: Date.now(),
					} as any;
				}
				return null;
			},
		});

		// Should have sent interrupt to both the parent PID and the nested child PID.
		const parentKill = killCalls.find((c) => c.pid === 11111);
		const childKill = killCalls.find((c) => c.pid === 55555);
		assert.ok(parentKill, "should interrupt parent job pid");
		assert.ok(childKill, "should interrupt nested child pid");
	});

	it("interrupts direct job pid even when no nested route is present", () => {
		const state = createState();
		state.asyncJobs.set("simple-job", {
			asyncId: "simple-job",
			asyncDir: "/tmp/simple",
			status: "running",
			pid: 77777,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const killCalls: number[] = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid) => { killCalls.push(pid); return true; },
		});

		assert.deepEqual(killCalls, [77777]);
	});

	it("sends nested control request for foreground-only nested descendants", () => {
		const rootRunId = "root-fg-nested";
		const nestedRoute = createNestedRoute(rootRunId);
		const routeRoot = path.dirname(nestedRoute.eventSink);
		tempDirs.push(routeRoot);

		// Write a nested started event for a foreground descendant (no asyncDir, no pid).
		const childRunId = "fg-child-1";
		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.started",
			ts: Date.now(),
			parentRunId: rootRunId,
			parentStepIndex: 0,
			child: {
				id: childRunId,
				parentRunId: rootRunId,
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: rootRunId, stepIndex: 0 }],
				ownerState: "live",
				mode: "single",
				state: "running",
				agent: "fg-child-agent",
				agents: ["fg-child-agent"],
				chainStepCount: 1,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
			},
		});

		const state = createState();
		state.asyncJobs.set("parent-job", {
			asyncId: "parent-job",
			asyncDir: "/tmp/parent-async",
			status: "running",
			pid: 99999,
			nestedRoute,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const killCalls: Array<{ pid: number; signal: string | number }> = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid, signal) => { killCalls.push({ pid, signal: signal ?? 0 }); return true; },
			readStatus: () => null,
		});

		// Should have interrupted the parent PID.
		assert.ok(killCalls.some((c) => c.pid === 99999), "should interrupt parent job pid");

		// Should have written a nested control request for the foreground child.
		const requests = readNestedControlRequests(nestedRoute);
		assert.ok(requests.length >= 1, "should write at least one nested control request");
		const interruptReq = requests.find((r) => r.targetRunId === childRunId && r.action === "interrupt");
		assert.ok(interruptReq, "should write an interrupt control request for the foreground nested child");

		// Should also have written a pause completion event for the child.
		const eventsDir = nestedRoute.eventSink;
		const eventFiles = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
		assert.ok(eventFiles.length >= 1, "should write at least one event file");
		const eventsContent = eventFiles.map((f) => fs.readFileSync(path.join(eventsDir, f), "utf-8")).join("\n");
		assert.ok(eventsContent.includes("subagent.nested.completed"), "should write pause completion event");
		assert.ok(eventsContent.includes("paused"), "should mark nested run as paused");
	});

	it("handles multiple jobs, each with different pids", () => {
		const state = createState();
		for (let i = 0; i < 5; i++) {
			state.asyncJobs.set(`job-${i}`, {
				asyncId: `job-${i}`,
				asyncDir: `/tmp/j${i}`,
				status: "running",
				pid: 10000 + i,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		}

		const killCalls: number[] = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid) => { killCalls.push(pid); return true; },
		});

		assert.equal(killCalls.length, 5);
		for (let i = 0; i < 5; i++) {
			assert.ok(killCalls.includes(10000 + i), `should interrupt pid ${10000 + i}`);
		}
	});

	for (const terminalStatus of ["complete", "failed", "paused"] as const) {
		it(`skips terminal ${terminalStatus} job — does not signal pid`, () => {
			const state = createState();
			state.asyncJobs.set("terminal-job", {
				asyncId: "terminal-job",
				asyncDir: "/tmp/terminal",
				status: terminalStatus,
				pid: 99999,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
			// Also add a live job to prove non-terminal jobs are still signaled.
			state.asyncJobs.set("live-job", {
				asyncId: "live-job",
				asyncDir: "/tmp/live",
				status: "running",
				pid: 11111,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});

			const killCalls: number[] = [];
			shutdownOwnedAsyncJobs(state, {
				kill: (pid) => { killCalls.push(pid); return true; },
			});

			assert.equal(killCalls.length, 1, "should only signal the live job");
			assert.deepEqual(killCalls, [11111]);
		});
	}

	it("terminal job with nestedRoute — skips parent PID but still cascades to live nested descendants", () => {
		const rootRunId = "root-terminal-nested";
		const nestedRoute = createNestedRoute(rootRunId);
		const routeRoot = path.dirname(nestedRoute.eventSink);
		tempDirs.push(routeRoot);

		const childRunId = "terminal-nested-child";
		const childAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, childRunId);
		fs.mkdirSync(childAsyncDir, { recursive: true });
		fs.writeFileSync(path.join(childAsyncDir, "status.json"), JSON.stringify({
			runId: childRunId,
			mode: "single",
			state: "running",
			pid: 55555,
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			steps: [{ agent: "child-agent", status: "running", startedAt: Date.now() }],
		}), "utf-8");
		tempDirs.push(childAsyncDir);

		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.started",
			ts: Date.now(),
			parentRunId: rootRunId,
			parentStepIndex: 0,
			child: {
				id: childRunId,
				parentRunId: rootRunId,
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: rootRunId, stepIndex: 0 }],
				asyncDir: childAsyncDir,
				pid: 55555,
				ownerState: "live",
				mode: "single",
				state: "running",
				agent: "child-agent",
				agents: ["child-agent"],
				chainStepCount: 1,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
			},
		});

		const state = createState();
		state.asyncJobs.set("terminal-parent", {
			asyncId: "terminal-parent",
			asyncDir: "/tmp/terminal-parent",
			status: "complete",
			pid: 88888,
			nestedRoute,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const killCalls: Array<{ pid: number; signal: string | number }> = [];
		shutdownOwnedAsyncJobs(state, {
			kill: (pid, signal) => { killCalls.push({ pid, signal: signal ?? 0 }); return true; },
			readStatus: () => ({ runId: childRunId, mode: "single", state: "running", pid: 55555 } as any),
		});

		// Terminal parent PID should NOT be signaled (process already exited).
		assert.ok(!killCalls.some((c) => c.pid === 88888), "should not signal terminal parent PID");
		// But live nested descendant PID SHOULD be signaled.
		assert.ok(killCalls.some((c) => c.pid === 55555), "should signal live nested descendant PID");
		// Nested control request should be written for the live nested descendant.
		const requests = readNestedControlRequests(nestedRoute);
		const interruptReq = requests.find((r) => r.targetRunId === childRunId && r.action === "interrupt");
		assert.ok(interruptReq, "should write nested control request for live nested descendant");
	});
});

describe("fanout-child session_shutdown cascade (issue #37 blocker 2)", () => {
	it("calls shutdownOwnedAsyncJobs when session_shutdown fires for fanout-child extension", async () => {
		const killCalls: Array<{ pid: number; signal: string | number }> = [];
		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
			killCalls.push({ pid, signal: signal ?? 0 });
			return true;
		}) as typeof process.kill;

		const eventCallbacks: Record<string, Array<(...args: unknown[]) => void>> = {};
		const shutdownCallbacks: Array<() => void> = [];
		const pi = {
			events: {
				on(name: string, cb: (...args: unknown[]) => void) {
					(eventCallbacks[name] ??= []).push(cb);
					return () => {};
				},
				emit(name: string, ...args: unknown[]) {
					for (const cb of eventCallbacks[name] ?? []) cb(...args);
				},
			},
			on(event: string, cb: () => void) {
				if (event === "session_shutdown") shutdownCallbacks.push(cb);
			},
			registerTool() {},
		} as any;

		// We need SUBAGENT_CHILD_ENV and SUBAGENT_FANOUT_CHILD_ENV set to 1.
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		try {
			registerFanoutChildSubagentExtension(pi);

			// Inject an async job by emitting the started event.
			pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
				id: "fanout-job-1",
				asyncDir: "/tmp/fanout-async-1",
				pid: 77777,
				mode: "single",
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Trigger session_shutdown.
			assert.ok(shutdownCallbacks.length > 0, "fanout-child should register a session_shutdown handler");
			for (const cb of shutdownCallbacks) cb();

			// shutdownOwnedAsyncJobs should have sent interrupt signal to the job PID.
			assert.ok(killCalls.some((c) => c.pid === 77777), "should interrupt fanout-child async job pid on session_shutdown");
		} finally {
			process.kill = originalKill;
			delete process.env[SUBAGENT_CHILD_ENV];
			delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
		}
	});
});
