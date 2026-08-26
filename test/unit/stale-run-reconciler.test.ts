import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { checkPidLiveness, reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { formatAsyncRunnerIdentity, readProcessStartToken } from "../../src/runs/background/pid-identity.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(123, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("marks a running async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves paused interrupted children when stale result success is false", () => {
		const root = tempRoot("pi-stale-paused-");
		try {
			const asyncDir = path.join(root, "run-paused");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-paused", mode: "single", state: "running", pid: 12345,
				startedAt: 1000, lastUpdate: 1000, currentStep: 0,
				steps: [{ agent: "worker", status: "running", interrupted: true, startedAt: 1000 }],
			});
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-paused.json"), JSON.stringify({ id: "run-paused", success: false, state: "paused", results: [{ agent: "worker", success: false, interrupted: true }] }), "utf8");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
			assert.equal(result.status?.state, "paused");
			assert.equal(result.status?.steps?.[0]?.status, "paused");
			assert.equal(result.repaired, true);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("derives mixed child failure independently of a paused aggregate", () => {
		const root = tempRoot("pi-stale-mixed-paused-");
		try {
			const asyncDir = path.join(root, "run-mixed-paused");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-mixed-paused", mode: "parallel", state: "running", pid: 12345,
				startedAt: 1000, lastUpdate: 1000,
				steps: [{ agent: "paused", status: "running" }, { agent: "failed", status: "running" }],
			});
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-mixed-paused.json"), JSON.stringify({
				id: "run-mixed-paused", success: false, state: "paused",
				results: [{ agent: "paused", success: false, interrupted: true, exitCode: 0 }, { agent: "failed", success: false, exitCode: 1, error: "boom" }],
			}), "utf8");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "paused");
			assert.equal(result.status?.steps?.[1]?.status, "failed");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("recognizes every retained isolated runtime diagnostic form", () => {
		for (const phrase of ["runtime retained at", "recover worktree at", "recover worktrees at", "recover isolated runtime at", "recover isolated worktree at", "recover isolated worktrees at"]) {
			const root = tempRoot("pi-stale-evidence-");
			try {
				const runtime = path.join(root, "retained runtime");
				fs.mkdirSync(runtime, { recursive: true });
				const asyncDir = path.join(root, "run-evidence");
				writeStatus(asyncDir, { runId: "run-evidence", mode: "single", state: "running", pid: 12345, startedAt: 1000, lastUpdate: 1000, error: `${phrase} ${runtime}: cleanup failed`, steps: [{ agent: "worker", status: "running", sandbox: { gitMode: "isolated" } }] });
				const result = reconcileAsyncRun(asyncDir, { resultsDir: path.join(root, "results"), kill: () => { throw errno("ESRCH"); }, now: () => 2000 });
				assert.equal(result.status?.state, "failed");
				assert.equal(result.status?.incomplete, undefined);
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		}
	});

	it("does not treat a missing referenced recovery path as actionable evidence", () => {
		const root = tempRoot("pi-stale-missing-evidence-");
		try {
			const asyncDir = path.join(root, "run-missing");
			writeStatus(asyncDir, { runId: "run-missing", mode: "single", state: "running", pid: 12345, startedAt: 1000, lastUpdate: 1000, error: `recover isolated runtime at ${path.join(root, "missing runtime")}: unavailable`, steps: [{ agent: "worker", status: "running", sandbox: { gitMode: "isolated" } }] });
			const resultsDir = path.join(root, "results");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); }, now: () => 2000 });
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.incomplete, true);
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-missing.json"), "utf8")).state, "failed");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("terminalizes stale isolated runs as failed with incomplete recovery evidence", () => {
		const root = tempRoot("pi-stale-isolated-incomplete-");
		try {
			const asyncDir = path.join(root, "run-isolated");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-isolated",
				mode: "parallel",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000, sandbox: { gitMode: "isolated" } }],
			});
			const result = reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); }, now: () => 2000 });
			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.incomplete, true);
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-isolated.json"), "utf8")).incomplete, true);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"), /repaired_incomplete/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs terminal status whose child projection is still running", () => {
		const root = tempRoot("pi-terminal-stale-steps-");
		try {
			const asyncDir = path.join(root, "run-terminal-stale");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, { runId: "run-terminal-stale", mode: "single", state: "failed", pid: 12345, startedAt: 1000, lastUpdate: 1000, steps: [{ agent: "worker", status: "running" }] });
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-terminal-stale.json"), JSON.stringify({ id: "run-terminal-stale", success: false, state: "failed", results: [{ agent: "worker", success: false, exitCode: 1, error: "cleanup failed" }] }), "utf8");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "failed");
			assert.equal(result.status?.steps?.[0]?.error, "cleanup failed");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("repairs teardown-unproven results to durable failed status without claiming cleanup", () => {
		const root = tempRoot("pi-terminal-teardown-unproven-");
		try {
			const asyncDir = path.join(root, "run-teardown-unproven");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, { runId: "run-teardown-unproven", mode: "single", state: "running", pid: 12345, startedAt: 1000, lastUpdate: 1000, teardownUnproven: true, steps: [{ agent: "worker", status: "running", teardownUnproven: true }] });
			fs.mkdirSync(resultsDir, { recursive: true });
			const resultPath = path.join(resultsDir, "run-teardown-unproven.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-teardown-unproven", success: false, state: "running", teardownUnproven: true, results: [{ agent: "worker", success: false, status: "paused", teardownUnproven: true }] }), "utf8");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.incomplete, true);
			assert.equal(result.status?.teardownUnproven, true);
			assert.equal(result.status?.steps?.[0]?.status, "failed");
			assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { id: "run-teardown-unproven", success: false, state: "failed", teardownUnproven: true, results: [{ agent: "worker", success: false, status: "failed", teardownUnproven: true, state: "failed", incomplete: true }], incomplete: true });
			const statusAfterFirstRepair = fs.readFileSync(path.join(asyncDir, "status.json"), "utf8");
			const second = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 3000 });
			assert.equal(second.repaired, false);
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), statusAfterFirstRepair);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000 },
					{ agent: "worker", status: "running", startedAt: 1100 },
				],
			});
			const scoutSession = path.join(root, "scout.jsonl");
			const workerSession = path.join(root, "worker.jsonl");
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, sessionFile: scoutSession, model: "fast" },
					{ agent: "worker", success: false, error: "boom", sessionFile: workerSession, model: "careful" },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.equal(result.status?.steps?.[0]?.sessionFile, scoutSession);
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
			assert.equal(result.status?.steps?.[1]?.sessionFile, workerSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps stale repair results by canonical flat index past group diagnostics", () => {
		const root = tempRoot("pi-stale-group-diagnostic-");
		try {
			const asyncDir = path.join(root, "run-group");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, { runId: "run-group", mode: "chain", state: "running", pid: 12345, startedAt: 1000, lastUpdate: 1000, steps: [{ agent: "a", status: "running", startedAt: 1000 }, { agent: "b", status: "running", startedAt: 1000 }] });
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-group.json"), JSON.stringify({ id: "run-group", success: false, state: "failed", results: [
				{ groupId: "g1", unindexed: true, agent: "group", success: false, error: "group" },
				{ flatIndex: 0, agent: "a", success: true },
				{ flatIndex: 1, agent: "b", success: false, error: "b failed" },
			] }), "utf8");
			const result = reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); }, now: () => 2000 });
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[1]?.error, "b failed");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("keeps a live runner with an exact persisted identity active", async () => {
		if (process.platform !== "linux") return;
		const root = tempRoot("pi-stale-exact-identity-");
		const runId = "run-exact-identity";
		const runnerPath = path.join(root, "runner.mjs");
		const configPath = path.join(root, `async-cfg-${runId}.json`);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(runnerPath, "setTimeout(() => {}, 30_000);\\n", "utf8");
		fs.writeFileSync(configPath, "{}", "utf8");
		const child = spawn(process.execPath, [runnerPath, configPath], { stdio: "ignore" });
		try {
			// Wait for /proc to expose the exact launcher argv before reconciling.
			await new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 2000;
				const poll = () => {
					if (readProcessStartToken(child.pid!)) return resolve();
					if (Date.now() >= deadline) return reject(new Error("runner process did not start"));
					setTimeout(poll, 5);
				};
				poll();
			});
			const identity = formatAsyncRunnerIdentity(runnerPath, configPath, runId, readProcessStartToken(child.pid!), process.getuid?.(), [process.execPath, runnerPath, configPath]);
			const asyncDir = path.join(root, runId);
			writeStatus(asyncDir, { runId, mode: "single", state: "running", pid: child.pid, runnerIdentity: identity, startedAt: 1000, lastUpdate: 2000, steps: [{ agent: "worker", status: "running" }] });
			const result = reconcileAsyncRun(asyncDir, { resultsDir: path.join(root, "results"), now: () => 2500, staleAlivePidMs: 10_000 });
			assert.equal(result.repaired, false);
			assert.equal(result.status?.state, "running");
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs a live PID when its persisted runner identity mismatches", () => {
		const root = tempRoot("pi-stale-mismatched-identity-");
		try {
			const asyncDir = path.join(root, "run-mismatch");
			writeStatus(asyncDir, { runId: "run-mismatch", mode: "single", state: "running", pid: process.pid, runnerIdentity: "runner:/wrong;config:/wrong;run:other;argv:bad;start:wrong;uid:0", startedAt: 1000, lastUpdate: 1000, steps: [{ agent: "worker", status: "running" }] });
			const result = reconcileAsyncRun(asyncDir, { resultsDir: path.join(root, "results"), kill: () => { throw new Error("must not probe mismatched identity"); }, now: () => 2000 });
			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("fails a stale run when a live pid has not updated beyond the stale threshold", () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true,
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /identity|exited|disappeared/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a live-runner record has no exact runner identity", () => {
		const root = tempRoot("pi-orphan-owner-dead-");
		try {
			const asyncDir = path.join(root, "run-orphan");
			const resultsDir = path.join(root, "results");
			const runnerPid = 99999;
			const ownerPid = 88888;
			writeStatus(asyncDir, {
				runId: "run-orphan",
				mode: "single",
				state: "running",
				pid: runnerPid,
				ownerPid,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			let killCalls: Array<{ pid: number; signal: number | string | undefined }> = [];
			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: (pid: number, signal?: NodeJS.Signals | 0) => {
					killCalls.push({ pid, signal });
					if (pid === runnerPid) return true; // runner is alive
					if (pid === ownerPid) throw errno("ESRCH"); // owner is dead
					throw errno("ESRCH");
				},
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? '', /identity|exited|disappeared/i);
			// Missing runner identity is untrusted; no PID liveness probe can rescue it.
			assert.equal(killCalls.length, 0);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.match(status.steps[0].error, /identity|exited|disappeared/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not trust a live PID when the runner identity is missing", () => {
		const root = tempRoot("pi-orphan-owner-alive-");
		try {
			const asyncDir = path.join(root, "run-alive");
			const resultsDir = path.join(root, "results");
			const runnerPid = 99999;
			const ownerPid = 88888;
			writeStatus(asyncDir, {
				runId: "run-alive",
				mode: "single",
				state: "running",
				pid: runnerPid,
				ownerPid,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true, // all pids alive
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
