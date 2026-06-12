import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function textContent(result: ReturnType<typeof inspectSubagentStatus>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("async run status inspection", () => {
	it("repairs stale running status and reports diagnosis plus result path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				sessionFile,
				steps: [{ agent: "scout", status: "running", startedAt: 100, sessionFile }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-stale" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 200,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Diagnosis: Async runner process 12345 exited or disappeared/);
			assert.match(text, new RegExp(`Result: ${path.join(resultsDir, "run-stale.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Step 1: scout failed, error: Async runner process 12345 exited or disappeared/);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-stale", message: "\.\.\." \}\)/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.results[0].sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows parallel mode and aggregate progress for top-level async parallel runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-parallel-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-parallel");
			fs.mkdirSync(asyncDir, { recursive: true });
			const runOutputPath = path.join(asyncDir, "combined-output.log");
			const firstStepOutputPath = path.join(asyncDir, "output-0.log");
			const secondStepOutputPath = path.join(asyncDir, "output-1.log");
			fs.writeFileSync(firstStepOutputPath, "reviewer one", "utf-8");
			fs.writeFileSync(secondStepOutputPath, "reviewer two", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-parallel",
				mode: "parallel",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				outputFile: runOutputPath,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "reviewer", status: "running", startedAt: 100, model: "openai-codex/gpt-5.5:high" },
					{ agent: "reviewer", status: "running", startedAt: 100, model: "anthropic/claude-haiku-4-5", thinking: "low" },
					{ agent: "reviewer", status: "pending" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-parallel" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Mode: parallel/);
			assert.match(text, /Progress: 2 agents running · 0\/3 done/);
			assert.match(text, new RegExp(`Output: ${runOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Agent 1\/3: reviewer running \(gpt-5\.5 · thinking high\)/);
			assert.match(text, /Agent 2\/3: reviewer running \(claude-haiku-4-5 · thinking low\)/);
			assert.match(text, /Agent 3\/3: reviewer pending/);
			assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
			assert.match(text, new RegExp(`  Output: ${firstStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, new RegExp(`  Output: ${secondStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.doesNotMatch(text, /Step 1: reviewer/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows acceptance finalization turn counts in detailed async status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-acceptance-finalization-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-acceptance");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-acceptance",
				mode: "single",
				state: "failed",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{
					agent: "worker",
					status: "failed",
					acceptance: {
						status: "rejected",
						finalization: {
							mode: "self-review-loop",
							status: "failed",
							maxTurns: 2,
							turns: [
								{ turn: 1, status: "rejected", prompt: "", rawOutput: "", runtimeChecks: [], verifyRuns: [] },
								{ turn: 2, status: "rejected", prompt: "", rawOutput: "", runtimeChecks: [], verifyRuns: [] },
							],
						},
					},
				}],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-acceptance" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Step 1: worker failed, acceptance: rejected, finalization: failed after 2\/2 turns/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows nested runs under owning steps with exact status hints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-root-"));
		const route = createNestedRoute("run-nested-root");
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-nested-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-root",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-status-child",
					parentRunId: "run-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-root", stepIndex: 0, agent: "orchestrator" }],
					state: "running",
					agent: "reviewer",
					currentTool: "read",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-nested-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Step 1: orchestrator running/);
			assert.match(text, /↳ reviewer \[nested-status-child\] running \| tool read/);
			assert.match(text, /Status: subagent\(\{ action: "status", id: "nested-status-child" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("repairs stale nested async descendants before rendering root status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-nested-"));
		const route = createNestedRoute("run-stale-nested-root");
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "run-stale-nested-root", "nested-stale");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stale-nested-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stale-nested-root",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 300,
				steps: [{ agent: "orchestrator", status: "complete", startedAt: 100 }],
			}, null, 2), "utf-8");
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId: "nested-stale",
				mode: "single",
				state: "running",
				pid: 54321,
				startedAt: 150,
				lastUpdate: 150,
				steps: [{ agent: "reviewer", status: "running", startedAt: 150 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-stale-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-stale",
					parentRunId: "run-stale-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-stale-nested-root", stepIndex: 0 }],
					asyncDir: nestedAsyncDir,
					pid: 54321,
					state: "running",
					agent: "reviewer",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-stale-nested-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /↳ reviewer \[nested-stale\] failed/);
			assert.match(text, /1\. reviewer failed \| error: Async runner process 54321 exited or disappeared/);
			assert.ok(fs.existsSync(path.join(resultsDir, "nested", "run-stale-nested-root", "nested-stale.json")));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("shows a warning when nested projection fails for detailed status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-warning-"));
		const route = createNestedRoute("run-nested-warning");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-nested-warning");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-warning",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-nested-warning" }, { asyncDirRoot: asyncRoot, resultsDir });

			assert.equal(result.isError, undefined);
			assert.match(textContent(result), /Warning: Nested status unavailable:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("shows a warning when nested projection fails for active status lists", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-list-warning-"));
		const route = createNestedRoute("run-nested-list-warning");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-nested-list-warning");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-list-warning",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, { asyncDirRoot: asyncRoot, resultsDir, kill: () => true, now: () => 200 });

			assert.equal(result.isError, undefined);
			assert.match(textContent(result), /Warning: Nested status unavailable:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("resolves exact nested run ids from the nested registry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-exact-"));
		const route = createNestedRoute("run-nested-exact-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-exact-root",
				parentStepIndex: 0,
				child: {
					id: "nested-exact-child",
					parentRunId: "run-nested-exact-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-exact-root", stepIndex: 0, agent: "orchestrator" }],
					state: "running",
					mode: "single",
					agent: "validator",
					steps: [{ agent: "leaf", status: "running", currentTool: "grep" }],
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "nested-exact-child" }, {
				asyncDirRoot: path.join(root, "runs"),
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Nested run: nested-exact-child/);
			assert.match(text, /Root: run-nested-exact-root/);
			assert.match(text, /Agent: validator/);
			assert.match(text, /1\. leaf running/);
			assert.match(text, /Root status: subagent\(\{ action: "status", id: "run-nested-exact-root" \}\)/);
			assert.match(text, /Interrupt: subagent\(\{ action: "interrupt", id: "nested-exact-child" \}\)/);
			assert.match(text, /Resume: subagent\(\{ action: "resume", id: "nested-exact-child", message: "\.\.\." \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("shows indexed revive guidance for completed multi-child async runs with child sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-multi-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-multi");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-multi",
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-multi" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.match(text, /Revive child: subagent\(\{ action: "resume", id: "run-multi", index: 0, message: "\.\.\." \}\)/);
			assert.doesNotMatch(text, /unsupported for multi-child/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses original child indexes when result metadata contains invalid children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-original-index-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "b.jsonl");
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-index.json"), JSON.stringify({
				id: "run-result-index",
				success: false,
				state: "failed",
				results: [
					{ output: "missing agent", sessionFile: path.join(root, "a.jsonl") },
					{ agent: "b", success: false, sessionFile },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-index" }, { asyncDirRoot: asyncRoot, resultsDir });

			const text = textContent(result);
			assert.match(text, /Revive child: subagent\(\{ action: "resume", id: "run-result-index", index: 1, message: "\.\.\." \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("labels chain parallel group children with logical step and agent numbers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-chain-parallel-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete", startedAt: 100 },
					{ agent: "reviewer", status: "running", startedAt: 100 },
					{ agent: "auditor", status: "pending" },
					{ agent: "writer", status: "pending" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-chain" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Step 1\/3: scout complete/);
			assert.match(text, /Step 2\/3 Agent 1\/2: reviewer running/);
			assert.match(text, /Step 2\/3 Agent 2\/2: auditor pending/);
			assert.match(text, /Step 3\/3: writer pending/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows expected intercom target for still-running async steps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-intercom-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-live");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-live" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Step 1: scout running/);
			assert.match(text, /Intercom target: subagent-scout-run-live-1 \(if registered\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous async run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			fs.mkdirSync(path.join(asyncRoot, "run-aa"), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, "run-ab"), { recursive: true });

			const result = inspectSubagentStatus({ id: "run-a" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /Ambiguous subagent run id prefix 'run-a' matched: async:run-aa, async:run-ab/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like async run ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paths-"));
		try {
			const result = inspectSubagentStatus({ id: "../run" }, {
				asyncDirRoot: path.join(root, "runs"),
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /id must be a non-empty safe id token/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise revive for result fallback with only a top-level session file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-no-child-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-session-only"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-session-only.json"), JSON.stringify({
				id: "run-session-only",
				success: false,
				state: "failed",
				sessionFile,
				summary: "missing child metadata",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-session-only" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Resume: unavailable/);
			assert.doesNotMatch(text, /Revive:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to an existing result when async dir has no status file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-only"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-only.json"), JSON.stringify({
				id: "run-result-only",
				agent: "worker",
				success: false,
				state: "failed",
				sessionFile,
				summary: "result survived missing status",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-only" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Result: /);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-result-only", message: "\.\.\." \}\)/);
			assert.match(text, /result survived missing status/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("async run header model/thinking display (issue #53)", () => {
	function asyncHeaderLine(text: string): string {
		return text.split("\n").find((line) => line.startsWith("- ")) ?? "";
	}

	it("shows model and thinking in run header when steps have them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-model-header-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-model-header");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-model-header",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 100, model: "openai/gpt-4o", thinking: "high" }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const header = asyncHeaderLine(textContent(result));
			assert.match(header, /run-model-header \| running/);
			assert.match(header, /gpt-4o · thinking high/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers current step model over first step model in run header", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-model-current-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-model-current");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-model-current",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 1,
				steps: [
					{ agent: "researcher", status: "complete", model: "gpt-4" },
					{ agent: "worker", status: "running", model: "claude-sonnet", thinking: "high" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const header = asyncHeaderLine(textContent(result));
			assert.match(header, /claude-sonnet · thinking high/);
			assert.doesNotMatch(header, /gpt-4/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not smear current-step thinking onto a fallback model from another step", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-model-no-smear-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-model-no-smear");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-model-no-smear",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 1,
				steps: [
					{ agent: "researcher", status: "complete", model: "gpt-4" },
					{ agent: "worker", status: "running", thinking: "high" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const header = asyncHeaderLine(textContent(result));
			assert.match(header, /gpt-4/);
			assert.doesNotMatch(header, /thinking high/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back gracefully when no steps have model/thinking", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-no-model-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-no-model");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-no-model",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const header = asyncHeaderLine(textContent(result));
			assert.match(header, /run-no-model \| running/);
			assert.doesNotMatch(header, /undefined/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("nested text status model/thinking display (issue #53)", () => {
	it("shows model and thinking in nested child rows", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-model-"));
		const route = createNestedRoute("run-nested-model-root");
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-nested-model-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-model-root",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-model-root",
				parentStepIndex: 0,
				child: {
					id: "nested-model-child",
					parentRunId: "run-nested-model-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-model-root", stepIndex: 0, agent: "orchestrator" }],
					state: "running",
					agent: "reviewer",
					model: "claude-sonnet",
					thinking: "high",
					currentTool: "read",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-nested-model-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /↳ reviewer \[nested-model-child\] running.*claude-sonnet · thinking high/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("shows model and thinking in nested step rows", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-step-model-"));
		const route = createNestedRoute("run-nested-step-model-root");
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-nested-step-model-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-step-model-root",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-step-model-root",
				parentStepIndex: 0,
				child: {
					id: "nested-step-model-child",
					parentRunId: "run-nested-step-model-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-step-model-root", stepIndex: 0 }],
					state: "running",
					mode: "single",
					agent: "reviewer",
					model: "anthropic/claude-sonnet",
					thinking: "medium",
					steps: [{ agent: "leaf", status: "running", model: "anthropic/claude-sonnet", thinking: "medium" }],
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-nested-step-model-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			// Nested step should show model/thinking
			assert.match(text, /1\. leaf running.*claude-sonnet · thinking medium/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("backward compat: nested rows without model/thinking still render", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-no-model-"));
		const route = createNestedRoute("run-nested-no-model-root");
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-nested-no-model-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-no-model-root",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-no-model-root",
				parentStepIndex: 0,
				child: {
					id: "nested-no-model-child",
					parentRunId: "run-nested-no-model-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-no-model-root", stepIndex: 0 }],
					state: "running",
					agent: "worker",
					currentTool: "bash",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-nested-no-model-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			// Should render without undefined or model/thinking artifacts
			assert.doesNotMatch(text, /undefined/);
			assert.match(text, /↳ worker \[nested-no-model-child\] running \| tool bash/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});
});

describe("default status listing includes orphaned paused/failed runs (issue #37)", () => {
	it("shows paused and failed runs alongside active runs in the default listing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-orphaned-listing-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");

			// Active running run
			const activeDir = path.join(asyncRoot, "run-active");
			fs.mkdirSync(activeDir, { recursive: true });
			fs.writeFileSync(path.join(activeDir, "status.json"), JSON.stringify({
				runId: "run-active",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}), "utf-8");

			// Paused orphaned run (post-shutdown)
			const pausedDir = path.join(asyncRoot, "run-paused-orphan");
			fs.mkdirSync(pausedDir, { recursive: true });
			fs.writeFileSync(path.join(pausedDir, "status.json"), JSON.stringify({
				runId: "run-paused-orphan",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 300,
				endedAt: 300,
				steps: [{ agent: "scout", status: "complete" }],
			}), "utf-8");

			// Failed orphaned run
			const failedDir = path.join(asyncRoot, "run-failed-orphan");
			fs.mkdirSync(failedDir, { recursive: true });
			fs.writeFileSync(path.join(failedDir, "status.json"), JSON.stringify({
				runId: "run-failed-orphan",
				mode: "single",
				state: "failed",
				startedAt: 100,
				lastUpdate: 400,
				endedAt: 400,
				steps: [{ agent: "reviewer", status: "failed", error: "interrupted" }],
			}), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			// Active runs should be listed
			assert.match(text, /run-active/);
			assert.match(text, /Active async runs/);
			// Orphaned runs should also be listed in a separate section
			assert.match(text, /Recently stopped\/orphaned runs/);
			assert.match(text, /run-paused-orphan/);
			assert.match(text, /run-failed-orphan/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("omits orphaned section when no paused/failed runs exist", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-no-orphan-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");

			const activeDir = path.join(asyncRoot, "run-active-only");
			fs.mkdirSync(activeDir, { recursive: true });
			fs.writeFileSync(path.join(activeDir, "status.json"), JSON.stringify({
				runId: "run-active-only",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /run-active-only/);
			assert.doesNotMatch(text, /Recently stopped\/orphaned runs/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows orphaned section even when no active runs exist", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-orphan-only-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");

			const pausedDir = path.join(asyncRoot, "run-paused-only");
			fs.mkdirSync(pausedDir, { recursive: true });
			fs.writeFileSync(path.join(pausedDir, "status.json"), JSON.stringify({
				runId: "run-paused-only",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 300,
				endedAt: 300,
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Recently stopped\/orphaned runs/);
			assert.match(text, /run-paused-only/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not trigger reconciliation side effects when listing orphaned paused/failed runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-orphan-no-reconcile-"));
		const route = createNestedRoute("run-orphan-no-reconcile");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");

			// Create a paused run with a stale nested descendant.
			const asyncDir = path.join(asyncRoot, "run-orphan-no-reconcile");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-orphan-no-reconcile",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 300,
				endedAt: 300,
				steps: [{ agent: "orchestrator", status: "complete" }],
			}), "utf-8");

			// Write a nested event for a descendant still marked as running.
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-orphan-no-reconcile",
				parentStepIndex: 0,
				child: {
					id: "nested-orphan-child",
					parentRunId: "run-orphan-no-reconcile",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-orphan-no-reconcile", stepIndex: 0 }],
					state: "running",
					agent: "reviewer",
					lastUpdate: 150,
				},
			});

			// Record file state before listing.
			const beforeDirEntries = new Set(fs.readdirSync(asyncDir));

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Recently stopped\/orphaned runs/);
			assert.match(text, /run-orphan-no-reconcile/);

			// No reconciliation side effects: async dir should not have new files.
			const afterDirEntries = new Set(fs.readdirSync(asyncDir));
			assert.deepEqual(afterDirEntries, beforeDirEntries, "listing orphaned runs should not write new files into the async dir");

			// No nested result files should have been written.
			const nestedResultsDir = path.join(resultsDir, "nested", "run-orphan-no-reconcile");
			assert.ok(!fs.existsSync(nestedResultsDir), "listing orphaned runs should not create nested result files");

			// Nested route directory itself should remain unchanged (no spurious registry.json).
			const routeDir = path.dirname(path.resolve(route.eventSink));
			const routeDirEntries = new Set(fs.readdirSync(routeDir));
			assert.ok(!routeDirEntries.has("registry.json"), "listing orphaned runs should not write registry.json into the nested route directory");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});
});

describe("owner-dead root run nested descendant reconciliation (issue #37 blocker 1)", () => {
	it("reconciles nested descendants before state filter when owner is dead", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-owner-dead-nested-"));
		const route = createNestedRoute("run-owner-dead-nested");
		const routeRootDir = path.dirname(route.eventSink);
		const nestedDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "run-owner-dead-nested", "nested-child-owner-dead");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-owner-dead-nested");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(nestedDir, { recursive: true });

			// Root run is running, ownerPid is dead, runner pid is alive.
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-owner-dead-nested",
				mode: "single",
				state: "running",
				pid: 11111,
				ownerPid: 999,
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}), "utf-8");

			// Nested descendant is still running, also with the dead owner.
			fs.writeFileSync(path.join(nestedDir, "status.json"), JSON.stringify({
				runId: "nested-child-owner-dead",
				mode: "single",
				state: "running",
				pid: 44444,
				ownerPid: 999,
				startedAt: 150,
				lastUpdate: 150,
				steps: [{ agent: "worker", status: "running", startedAt: 150 }],
			}), "utf-8");

			writeNestedEvent(route, {
				type: "subagent.nested.started",
				ts: 150,
				parentRunId: "run-owner-dead-nested",
				parentStepIndex: 0,
				child: {
					id: "nested-child-owner-dead",
					parentRunId: "run-owner-dead-nested",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-owner-dead-nested", stepIndex: 0 }],
					asyncDir: nestedDir,
					pid: 44444,
					state: "running",
					agent: "worker",
					startedAt: 150,
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			// Root was reconciled to failed (owner dead), so it appears in orphaned section.
			assert.match(text, /run-owner-dead-nested/);
			assert.match(text, /Recently stopped\/orphaned runs/);
			// Nested descendant must have been reconciled during the active pass
			// (before state filter), so it shows as failed even though registry.json
			// never existed before the listing.
			assert.match(text, /nested-child-owner-dead.*failed/);
			// The nested registry should have been materialized as a side effect of
			// the active-pass nested reconciliation.
			assert.ok(fs.existsSync(path.join(routeRootDir, "registry.json")), "registry.json should be materialized during active-pass reconciliation");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(routeRootDir, { recursive: true, force: true });
			fs.rmSync(nestedDir, { recursive: true, force: true });
		}
	});

	it("shows nested descendant final state in default no-id listing when registry.json was never materialized", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-owner-dead-default-listing-"));
		const route = createNestedRoute("run-owner-dead-default");
		const routeRootDir = path.dirname(route.eventSink);
		const nestedDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "run-owner-dead-default", "nested-child-default");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-owner-dead-default");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(nestedDir, { recursive: true });

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-owner-dead-default",
				mode: "single",
				state: "running",
				pid: 22222,
				ownerPid: 999,
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}), "utf-8");

			fs.writeFileSync(path.join(nestedDir, "status.json"), JSON.stringify({
				runId: "nested-child-default",
				mode: "single",
				state: "running",
				pid: 55555,
				ownerPid: 999,
				startedAt: 150,
				lastUpdate: 150,
				steps: [{ agent: "worker", status: "running", startedAt: 150 }],
			}), "utf-8");

			writeNestedEvent(route, {
				type: "subagent.nested.started",
				ts: 150,
				parentRunId: "run-owner-dead-default",
				parentStepIndex: 0,
				child: {
					id: "nested-child-default",
					parentRunId: "run-owner-dead-default",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-owner-dead-default", stepIndex: 0 }],
					asyncDir: nestedDir,
					pid: 55555,
					state: "running",
					agent: "worker",
					startedAt: 150,
					lastUpdate: 150,
				},
			});

			// Default status listing (no id).
			const result = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			// Root should be in the orphaned section.
			assert.match(text, /Recently stopped\/orphaned runs/);
			assert.match(text, /run-owner-dead-default/);
			// The nested descendant must show as failed in the listing, not lost.
			assert.match(text, /nested-child-default.*failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(routeRootDir, { recursive: true, force: true });
			fs.rmSync(nestedDir, { recursive: true, force: true });
		}
	});
});
