/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../src/shared/types.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
}

interface ArtifactPaths {
	outputPath: string;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	finalOutput?: string;
	interrupted?: boolean;
	detached?: boolean;
	detachedReason?: string;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
	sandbox?: {
		provider?: string;
		profile?: string;
		network?: string;
		auth?: string;
		fallbackMode?: string;
		fallbackOccurred?: boolean;
		diagnostics?: Array<{ level?: string; message?: string }>;
	};
	acceptance?: {
		status?: string;
		finalization?: {
			status?: string;
			maxTurns?: number;
			turns?: Array<{ turn?: number; status?: string; failureMessage?: string }>;
		};
	};
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details: { results: RunSyncResult[] } }>;
	};
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function acceptanceReport(): string {
	return formatAcceptanceReport([
		{ id: "criterion-1", status: "satisfied", evidence: "file exists with exact content" },
		{ id: "criterion-2", status: "satisfied", evidence: "verification command passed" },
	]);
}

function formatAcceptanceReport(criteriaSatisfied: Array<{ id: string; status: "satisfied" | "not-satisfied" | "not-applicable"; evidence: string }>): string {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied,
			changedFiles: ["guard-acceptance.txt"],
			commandsRun: [{ command: "test file content", result: "passed", summary: "passed" }],
			residualRisks: [],
		}),
		"```",
	].join("\n");
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function readCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	function installFakeBwrap(): { recordDir: string; restore: () => void } {
		const rootDir = fs.mkdtempSync(path.join(tempDir, "fake-bwrap-"));
		const binDir = path.join(rootDir, "bin");
		const recordDir = path.join(rootDir, "records");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(recordDir, { recursive: true });
		const scriptPath = path.join(binDir, "fake-bwrap.mjs");
		fs.writeFileSync(scriptPath, `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const recordDir = process.env.FAKE_BWRAP_RECORD_DIR;
if (!recordDir) {
  console.error("FAKE_BWRAP_RECORD_DIR is required");
  process.exit(97);
}
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(
  path.join(recordDir, \`call-\${Date.now()}-\${process.pid}.json\`),
  JSON.stringify({ args, cwd: process.cwd() }),
  "utf-8",
);
const separator = args.indexOf("--");
if (separator === -1 || !args[separator + 1]) {
  console.error("fake bwrap expected -- followed by a command");
  process.exit(98);
}
const child = spawnSync(args[separator + 1], args.slice(separator + 2), {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
if (child.error) {
  console.error(child.error.message);
  process.exit(99);
}
process.exit(child.status ?? 0);
`, "utf-8");
		const bwrapPath = path.join(binDir, "bwrap");
		fs.writeFileSync(bwrapPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf-8");
		fs.chmodSync(bwrapPath, 0o755);
		const previousPath = process.env.PATH;
		const previousRecordDir = process.env.FAKE_BWRAP_RECORD_DIR;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.FAKE_BWRAP_RECORD_DIR = recordDir;
		return {
			recordDir,
			restore() {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousRecordDir === undefined) delete process.env.FAKE_BWRAP_RECORD_DIR;
				else process.env.FAKE_BWRAP_RECORD_DIR = previousRecordDir;
			},
		};
	}

	function installFakeBwrapWithJsonl(jsonl: unknown[]): { recordDir: string; restore: () => void } {
		const rootDir = fs.mkdtempSync(path.join(tempDir, "fake-bwrap-jsonl-"));
		const binDir = path.join(rootDir, "bin");
		const recordDir = path.join(rootDir, "records");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(recordDir, { recursive: true });
		const scriptPath = path.join(binDir, "fake-bwrap-jsonl.mjs");
		fs.writeFileSync(scriptPath, `
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const recordDir = process.env.FAKE_BWRAP_RECORD_DIR;
if (!recordDir) {
  console.error("FAKE_BWRAP_RECORD_DIR is required");
  process.exit(97);
}
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(
  path.join(recordDir, \`call-\${Date.now()}-\${process.pid}.json\`),
  JSON.stringify({ args, cwd: process.cwd() }),
  "utf-8",
);
const jsonl = ${JSON.stringify(jsonl)};
for (const event of jsonl) console.log(JSON.stringify(event));
process.exit(0);
`, "utf-8");
		const bwrapPath = path.join(binDir, "bwrap");
		fs.writeFileSync(bwrapPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf-8");
		fs.chmodSync(bwrapPath, 0o755);
		const previousPath = process.env.PATH;
		const previousRecordDir = process.env.FAKE_BWRAP_RECORD_DIR;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.FAKE_BWRAP_RECORD_DIR = recordDir;
		return {
			recordDir,
			restore() {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousRecordDir === undefined) delete process.env.FAKE_BWRAP_RECORD_DIR;
				else process.env.FAKE_BWRAP_RECORD_DIR = previousRecordDir;
			},
		};
	}

	function installFailingFakeBwrap(stderr: string, exitCode: number): { recordDir: string; restore: () => void } {
		const rootDir = fs.mkdtempSync(path.join(tempDir, "fake-bwrap-"));
		const binDir = path.join(rootDir, "bin");
		const recordDir = path.join(rootDir, "records");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(recordDir, { recursive: true });
		const scriptPath = path.join(binDir, "fake-bwrap.mjs");
		fs.writeFileSync(scriptPath, `
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const recordDir = process.env.FAKE_BWRAP_RECORD_DIR;
if (!recordDir) {
  console.error("FAKE_BWRAP_RECORD_DIR is required");
  process.exit(97);
}
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(
  path.join(recordDir, \`call-\${Date.now()}-\${process.pid}.json\`),
  JSON.stringify({ args, cwd: process.cwd() }),
  "utf-8",
);
console.error("${stderr.replace(/"/g, '\\"').trim()}");
process.exit(${exitCode});
`, "utf-8");
		const bwrapPath = path.join(binDir, "bwrap");
		fs.writeFileSync(bwrapPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf-8");
		fs.chmodSync(bwrapPath, 0o755);
		const previousPath = process.env.PATH;
		const previousRecordDir = process.env.FAKE_BWRAP_RECORD_DIR;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.FAKE_BWRAP_RECORD_DIR = recordDir;
		return {
			recordDir,
			restore() {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousRecordDir === undefined) delete process.env.FAKE_BWRAP_RECORD_DIR;
				else process.env.FAKE_BWRAP_RECORD_DIR = previousRecordDir;
			},
		};
	}

	function readFakeBwrapArgs(recordDir: string): string[] {
		const callFile = fs.readdirSync(recordDir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded fake bwrap call");
		const payload = JSON.parse(fs.readFileSync(path.join(recordDir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded bwrap args");
		return payload.args;
	}

	function assertMountMode(args: string[], source: string, mode: "ro" | "rw"): void {
		const expectedFlag = mode === "rw" ? "--bind" : "--ro-bind";
		assert.ok(
			args.some((arg, index) => arg === expectedFlag && args[index + 1] === source && args[index + 2] === source),
			`expected ${source} to be mounted ${mode}`,
		);
	}

	function assertNotMounted(args: string[], source: string): void {
		assert.equal(
			args.some((arg, index) => (arg === "--bind" || arg === "--ro-bind") && args[index + 1] === source),
			false,
			`expected ${source} not to be mounted`,
		);
	}

	function makeExecutor(
		agents = [makeAgent("echo")],
		overrides: {
			config?: Record<string, unknown>;
			getSessionName?: () => string | undefined;
			events?: ReturnType<typeof createEventBus>;
		} = {},
	) {
		return createSubagentExecutor!({
			pi: { events: overrides.events ?? createEventBus(), getSessionName: overrides.getSessionName ?? (() => undefined) },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: overrides.config ?? {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled agents conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Run cold start test after patch", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Run cold start test after patch", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("lets explicit acceptance own completion for report-only output", async () => {
		mockPi.onCall({ output: acceptanceReport() });
		mockPi.onCall({ output: acceptanceReport() });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Create guard-acceptance.txt with verified content", {
			runId: "guard-acceptance-explicit",
			acceptance: {
				criteria: ["Create guard-acceptance.txt with verified content", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.acceptance?.status, "checked");
		assert.equal(result.acceptance?.finalization?.status, "completed");
		assert.equal(mockPi.callCount(), 2);
	});

	it("stops acceptance finalization at max turns when self-review never satisfies criteria", async () => {
		mockPi.onCall({ output: "```acceptance-report\n{bad-json\n```" });
		mockPi.onCall({ output: formatAcceptanceReport([{ id: "criterion-1", status: "not-satisfied", evidence: "still missing after first self-review" }]) });
		mockPi.onCall({ output: formatAcceptanceReport([{ id: "criterion-1", status: "not-satisfied", evidence: "still missing after second self-review" }]) });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Create guard-acceptance.txt with verified content", {
			runId: "guard-acceptance-max-finalization",
			acceptance: {
				criteria: ["Create guard-acceptance.txt with verified content"],
				maxFinalizationTurns: 2,
			},
		});

		assert.equal(mockPi.callCount(), 3);
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Acceptance rejected/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.finalization?.status, "failed");
		assert.equal(result.acceptance?.finalization?.maxTurns, 2);
		assert.equal(result.acceptance?.finalization?.turns?.length, 2);
		assert.deepEqual(result.acceptance?.finalization?.turns?.map((turn) => turn.turn), [1, 2]);
		assert.deepEqual(result.acceptance?.finalization?.turns?.map((turn) => turn.status), ["rejected", "rejected"]);
	});

	it("preserves successful acceptance when finalization turn exits nonzero with valid output", async () => {
		mockPi.onCall({ output: acceptanceReport() });
		mockPi.onCall({ output: acceptanceReport(), exitCode: 1 });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Create guard-acceptance.txt with verified content", {
			runId: "guard-acceptance-nonzero-exit-valid-output",
			acceptance: {
				criteria: ["Create guard-acceptance.txt with verified content", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.acceptance?.status, "checked");
		assert.equal(result.acceptance?.finalization?.status, "completed");
		assert.equal(mockPi.callCount(), 2);
	});

	it("still fails acceptance when finalization turn has an explicit provider error", async () => {
		mockPi.onCall({ output: acceptanceReport() });
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "error",
					errorMessage: "provider rate limit exceeded",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			}],
			exitCode: 1,
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Create guard-acceptance.txt with verified content", {
			runId: "guard-acceptance-explicit-error",
			acceptance: {
				criteria: ["Create guard-acceptance.txt with verified content", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider rate limit exceeded/);
		assert.equal(result.acceptance?.finalization?.status, "failed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("does not emit idle needs_attention while a sync nested child is running", async () => {
		mockPi.onCall({
			steps: [
				{ delay: 600, jsonl: [events.assistantMessage("Done after nested child") ] },
			],
		});
		const route = createNestedRoute("run-nested-active");
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const nestedStartedAt = Date.now();
		const nestedTimer = setTimeout(() => {
			writeNestedEvent(route, {
				type: "subagent.nested.started",
				ts: Date.now(),
				parentRunId: "run-nested-active",
				parentStepIndex: 0,
				child: {
					id: "nested-reviewer",
					parentRunId: "run-nested-active",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-active", stepIndex: 0 }],
					mode: "single",
					state: "running",
					agent: "reviewer",
					agents: ["reviewer"],
					startedAt: nestedStartedAt,
					lastUpdate: Date.now(),
				},
			});
		}, 100);

		try {
			const result = await runSync(tempDir, agents, "worker", "Wait for nested reviewer", {
				runId: "run-nested-active",
				index: 0,
				nestedRoute: route,
				controlConfig: {
					enabled: true,
					needsAttentionAfterMs: 200,
					activeNoticeAfterTurns: 999_999,
					activeNoticeAfterMs: 999_999,
					activeNoticeAfterTokens: 999_999,
					failedToolAttemptsBeforeAttention: 999_999,
					notifyOn: ["active_long_running", "needs_attention"],
				},
				onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
			});

			assert.equal(result.exitCode, 0);
			assert.equal(controlEvents.find((event) => event.reason === "idle" || event.reason === undefined), undefined);
			assert.equal(result.controlEvents?.find((event) => event.reason === "idle" || event.reason === undefined), undefined);
			assert.notEqual(result.progress.activityState, "needs_attention");
		} finally {
			clearTimeout(nestedTimer);
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses runtime child model metadata when it matches the configured agent model", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("Done", "anthropic/claude-sonnet-4")] });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("Done", "openai/gpt-4o")] });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("Done", "github-copilot/gpt-5-mini")] });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("retries with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ jsonl: [events.assistantMessage("Recovered on fallback", "anthropic/claude-sonnet-4")] });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ jsonl: [events.assistantMessage("Recovered on fallback", "anthropic/claude-sonnet-4")] });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127")],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("updates foregroundControl currentModel from runtime child result during live single run", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })] },
				{ delay: 100, jsonl: [events.assistantMessage("first", "runtime/gpt-4o"), events.assistantMessage("second", "runtime/gpt-4o")] },
			],
		});
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo", { model: "configured/gpt-4o-mini" })] }),
		});
		const currentControl = () => [...state.foregroundControls.values()][0];
		const liveModels: (string | undefined)[] = [];
		const executePromise = executor.execute(
			"single-runtime-model",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			() => {
				liveModels.push(currentControl()?.currentModel);
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(currentControl()?.currentModel, "configured/gpt-4o-mini", "foregroundControl should start with the configured fallback model");
		await executePromise;

		assert.ok(liveModels.includes("runtime/gpt-4o"), "live updates should replace the configured fallback with the runtime model");
		assert.equal(liveModels.at(-1), "runtime/gpt-4o");
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);
	});

	it("wraps a fresh single subagent run with bubblewrap and preserves child pi args", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const normalizeVolatileArgs = (args: string[]) => {
			const normalized = [...args];
			for (const flag of ["--system-prompt", "--append-system-prompt"]) {
				const index = normalized.indexOf(flag);
				if (index !== -1 && normalized[index + 1]) normalized[index + 1] = "<prompt-file>";
			}
			return normalized.filter((arg) => arg !== "--no-prompt-templates" && arg !== "--no-themes");
		};
		const extensionDir = path.join(tempDir, "absolute-extension-parent");
		fs.mkdirSync(extensionDir, { recursive: true });
		const absoluteExtensionPath = path.join(extensionDir, "custom-extension.ts");
		fs.writeFileSync(absoluteExtensionPath, "export default {};\n", "utf-8");
		const secretName = "PI_SUBAGENT_TEST_FAKE_SECRET";
		const secretValue = "issue-4-secret-must-not-enter-bwrap-argv";
		const previousSecret = process.env[secretName];
		process.env[secretName] = secretValue;
		const fakeBwrap = installFakeBwrap();
		try {
			const sessionDir = path.join(tempDir, "sessions");
			const agent = makeAgent("echo", {
				model: "mock/sandbox-model",
				tools: ["read", "bash"],
				extensions: [absoluteExtensionPath],
			});
			const executor = makeExecutor([agent]);
			mockPi.onCall({ output: "plain ok" });
			const plainResult = await executor.execute(
				"single-unsandboxed",
				{ agent: "echo", task: "Keep the same task", sessionDir },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(plainResult.isError, undefined);
			assert.equal(fs.readdirSync(fakeBwrap.recordDir).filter((name) => name.endsWith(".json")).length, 0, "unsandboxed run should not call bwrap");
			const plainPiArgs = readCallArgs();
			mockPi.reset();

			mockPi.onCall({ echoEnv: [secretName] });
			const result = await executor.execute(
				"single-bubblewrap",
				{
					agent: "echo",
					task: "Keep the same task",
					sandbox: { provider: "bubblewrap", auth: "env" },
					sessionDir,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const sandboxDetails = result.details.results[0]?.sandbox;
			assert.equal(sandboxDetails?.provider, "bubblewrap");
			assert.equal(sandboxDetails?.profile, "host-toolchain");
			assert.equal(sandboxDetails?.network, "host");
			assert.equal(sandboxDetails?.auth, "env");
			assert.equal(sandboxDetails?.fallbackMode, "fail");
			assert.equal(sandboxDetails?.fallbackOccurred, false);
			assert.ok(sandboxDetails?.mounts?.some((mount) => mount.mode === "ro" && mount.path === "/usr"), "sandbox details should include redacted mount info");
			assert.match(result.content[0]?.text ?? "", new RegExp(`"${secretName}":"${secretValue}"`));
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			assert.equal(bwrapArgs.includes(secretName), false, "bubblewrap argv should not include inherited env var names");
			assert.equal(bwrapArgs.includes(secretValue), false, "bubblewrap argv should not include inherited env var values");
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			assert.equal(bwrapArgs[separatorIndex + 1], process.execPath);
			assert.ok(bwrapArgs[separatorIndex + 2]?.endsWith(".mjs"), "sandboxed child should exec via node script");
			const wrappedPiArgs = bwrapArgs.slice(separatorIndex + 3);
			const piArgs = readCallArgs();
			assert.deepEqual(piArgs, wrappedPiArgs, "fake bubblewrap should exec pi with the same args it wrapped");
			assert.deepEqual(normalizeVolatileArgs(piArgs), normalizeVolatileArgs(plainPiArgs), "sandboxing should preserve child pi argument configuration");
			assert.deepEqual(piArgs.slice(0, 3), ["--mode", "json", "-p"]);
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--model"), piArgs.indexOf("--model") + 2), ["--model", "mock/sandbox-model"]);
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read,bash"]);
			assert.ok(piArgs.includes("--no-extensions"), "sandboxed child should disable extension discovery");
			assert.ok(piArgs.includes("--no-prompt-templates"), "sandboxed child should disable prompt template discovery");
			assert.ok(piArgs.includes("--no-themes"), "sandboxed child should disable theme discovery");
			assert.ok(piArgs.includes("Task: Keep the same task"), "child should receive the original task text");
			assert.ok(piArgs.includes("--session"), "fresh child session should still be configured");
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			const customExtensionArgs = extensionArgs.filter((arg) => !arg.includes("subagent-prompt-runtime") && !arg.includes("fanout-child"));
			const extensionParents = [...new Set(customExtensionArgs.filter((arg) => path.isAbsolute(arg)).map((arg) => path.dirname(arg)))];
			assert.ok(extensionParents.includes(extensionDir), "custom absolute extension should be passed to pi");
			for (const extPath of customExtensionArgs.filter((arg) => path.isAbsolute(arg))) {
				const isMounted = bwrapArgs.some((arg, index) => {
					if (arg !== "--ro-bind") return false;
					const source = bwrapArgs[index + 1];
					return source === extPath || source === path.dirname(extPath);
				});
				assert.ok(isMounted, `bubblewrap should read-only mount extension ${extPath} or its parent`);
			}
		} finally {
			fakeBwrap.restore();
			if (previousSecret === undefined) delete process.env[secretName];
			else process.env[secretName] = previousSecret;
		}
	});

	it("loads project-local package extensions explicitly in sandbox project-local discovery", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const packageRoot = path.join(tempDir, ".pi", "npm", "node_modules", "local-pi-ext");
		const localExtensionPath = path.join(packageRoot, "extension.ts");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: "local-pi-ext", version: "1.0.0", pi: { extensions: ["./extension.ts"] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(localExtensionPath, "export default function register() {}\n", "utf-8");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:local-pi-ext"] }, null, 2),
			"utf-8",
		);

		const userAgentDir = path.join(tempDir, "agent-home");
		const userPackageRoot = path.join(userAgentDir, "npm", "node_modules", "local-pi-ext");
		fs.mkdirSync(userPackageRoot, { recursive: true });
		fs.writeFileSync(
			path.join(userPackageRoot, "package.json"),
			JSON.stringify({ name: "local-pi-ext", version: "9.9.9", pi: { extensions: ["./global-extension.ts"] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(path.join(userPackageRoot, "global-extension.ts"), "export default function register() {}\n", "utf-8");
		fs.writeFileSync(path.join(userAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:local-pi-ext"] }, null, 2), "utf-8");

		const explicitExtensionPath = path.join(tempDir, "explicit-extension.ts");
		fs.writeFileSync(explicitExtensionPath, "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = userAgentDir;
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("echo", { extensions: [explicitExtensionPath] })]);
			const result = await executor.execute(
				"single-sandbox-project-local-package-discovery",
				{ agent: "echo", task: "Use project-local extension", sandbox: { provider: "bubblewrap", packageDiscovery: "project-local" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			const resultText = result.content[0]?.text ?? "";
			assert.doesNotMatch(resultText, /Failed to load extension/, "project-local and explicit extensions should load successfully before any provider/auth failure");
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			assert.ok(piArgs.includes("--no-extensions"), "project-local mode should keep ambient extension discovery disabled");
			assert.ok(piArgs.includes("--no-prompt-templates"), "project-local mode should keep prompt-template discovery disabled");
			assert.ok(piArgs.includes("--no-themes"), "project-local mode should keep theme discovery disabled");
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(localExtensionPath), "project-local package extension should be passed explicitly");
			assert.equal(extensionArgs.includes(path.join(userPackageRoot, "global-extension.ts")), false, "user/global package with same name should not be loaded");
			assert.ok(extensionArgs.indexOf(explicitExtensionPath) > extensionArgs.indexOf(localExtensionPath), "explicit agent extensions should remain after package extensions for clear precedence");
			assertMountMode(bwrapArgs, packageRoot, "ro");
			assertNotMounted(bwrapArgs, userPackageRoot);
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("adds closed-runtime flags and mounts auth.json but not settings.json for pi-json sandboxed children", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "SUBAGENT_SANDBOXED_PI_JSON_OK" });
		const agentDir = path.join(tempDir, "agent-home");
		fs.mkdirSync(agentDir, { recursive: true });
		const authPath = path.join(agentDir, "auth.json");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(authPath, JSON.stringify({ provider: "test", apiKey: "redacted" }), "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:ambient-package-that-would-need-npm-root"] }), "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("echo")]);
			const result = await executor.execute(
				"single-sandbox-closed-runtime",
				{ agent: "echo", task: "Smoke test sandboxed child launch using pi-json auth. Reply exactly: SUBAGENT_SANDBOXED_PI_JSON_OK", sandbox: { provider: "bubblewrap", auth: "pi-json" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /SUBAGENT_SANDBOXED_PI_JSON_OK/);
			assert.equal(result.details.results[0]?.sandbox?.fallbackOccurred, false);
			assert.equal(result.details.results[0]?.sandbox?.auth, "pi-json");
			const piArgs = readCallArgs();
			assert.ok(piArgs.includes("--no-extensions"), "sandboxed child should disable extension discovery");
			assert.ok(piArgs.includes("--no-prompt-templates"), "sandboxed child should disable prompt template discovery");
			assert.ok(piArgs.includes("--no-themes"), "sandboxed child should disable theme discovery");
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))), "sandboxed child should still load prompt runtime extension");
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			assertMountMode(bwrapArgs, authPath, "ro");
			assertNotMounted(bwrapArgs, settingsPath);
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("auto-loads pi-intercom for active intercom bridge in closed sandbox without manual extensions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-active-agent-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		const intercomStateDir = path.join(agentDir, "intercom");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:some-ambient-package"] }), "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const fakeBwrap = installFakeBwrapWithJsonl([
			events.toolStart("contact_supervisor", { reason: "progress_update", message: "UPDATE: sandboxed child started" }),
			events.toolEnd("contact_supervisor"),
			events.toolStart("contact_supervisor", { reason: "need_decision", message: "Approve continuing?" }),
			events.toolEnd("contact_supervisor"),
			events.assistantMessage("continued after supervisor reply"),
		]);
		const seenSupervisorReasons: string[] = [];
		try {
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read"], completionGuard: false })]);
			const result = await executor.execute(
				"single-active-bridge-sandbox",
				{ agent: "bridge", task: "Use supervisor bridge", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				(update) => {
					const argPreview = update.details?.progress?.[0]?.currentToolArgs ?? "";
					const reason = argPreview.match(/reason[=:]\s*['\"]?([a-z_]+)/)?.[1];
					if (reason) seenSupervisorReasons.push(reason);
				},
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /continued after supervisor reply/);
			assert.ok(seenSupervisorReasons.includes("progress_update"), "progress_update contact_supervisor call should flow through child progress events");
			assert.ok(seenSupervisorReasons.includes("need_decision"), "need_decision contact_supervisor call should flow through child progress events before child continues");
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			assert.ok(piArgs.includes("--no-extensions"), "closed sandbox should keep ambient extension discovery disabled");
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read,intercom,contact_supervisor"]);
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(intercomExtensionDir), "active bridge should pass pi-intercom as an explicit extension");
			assertMountMode(bwrapArgs, intercomExtensionDir, "ro");
			assertMountMode(bwrapArgs, intercomStateDir, "rw");
			assertNotMounted(bwrapArgs, settingsPath);
			assertNotMounted(bwrapArgs, agentDir);
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not load or mount pi-intercom for inactive bridge sandbox runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-inactive-agent-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		const intercomStateDir = path.join(agentDir, "intercom");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const fakeBwrap = installFakeBwrapWithJsonl([events.assistantMessage("inactive bridge ok")]);
		try {
			const executor = makeExecutor([makeAgent("quiet", { tools: ["read"], completionGuard: false })], { config: { intercomBridge: { mode: "off" } } });
			const result = await executor.execute(
				"single-inactive-bridge-sandbox",
				{ agent: "quiet", task: "Do not use intercom", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /inactive bridge ok/);
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			assert.ok(piArgs.includes("--no-extensions"), "sandboxing alone should not re-enable ambient extension discovery");
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read"]);
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.equal(extensionArgs.includes(intercomExtensionDir), false, "inactive bridge should not pass pi-intercom as an explicit extension");
			assertNotMounted(bwrapArgs, intercomExtensionDir);
			assertNotMounted(bwrapArgs, intercomStateDir);
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("auto-loads pi-intercom for agent-level sandboxed chain steps", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-agent-sandbox-chain-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		const intercomStateDir = path.join(agentDir, "intercom");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const fakeBwrap = installFakeBwrapWithJsonl([events.assistantMessage("agent sandbox chain ok")]);
		try {
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read"], completionGuard: false, sandbox: { provider: "bubblewrap" } })]);
			const result = await executor.execute(
				"chain-agent-level-bridge-sandbox",
				{ chain: [{ agent: "bridge", task: "Use supervisor bridge" }], clarify: false },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(intercomExtensionDir), "agent-level sandboxed chain step should pass pi-intercom as an explicit extension");
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read,intercom,contact_supervisor"]);
			assertMountMode(bwrapArgs, intercomExtensionDir, "ro");
			assertMountMode(bwrapArgs, intercomStateDir, "rw");
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("honors explicit extension allowlists that exclude pi-intercom in sandboxed active bridge runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-excluded-agent-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		const intercomStateDir = path.join(agentDir, "intercom");
		const otherExtension = path.join(agentDir, "extensions", "other.ts");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		fs.writeFileSync(otherExtension, "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const fakeBwrap = installFakeBwrapWithJsonl([events.assistantMessage("extension allowlist ok")]);
		try {
			const executor = makeExecutor([makeAgent("limited", { tools: ["read"], extensions: [otherExtension], completionGuard: false })]);
			const result = await executor.execute(
				"single-active-bridge-extension-allowlist",
				{ agent: "limited", task: "Do not load bridge extension", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /extension allowlist ok/);
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read"]);
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(otherExtension), "explicit non-intercom extension should still load");
			assert.equal(extensionArgs.includes(intercomExtensionDir), false, "excluded bridge should not pass pi-intercom as an explicit extension");
			assertNotMounted(bwrapArgs, intercomExtensionDir);
			assertNotMounted(bwrapArgs, intercomStateDir);
		} finally {
			fakeBwrap.restore();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("mounts single sandboxed bash-only agents read-only by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "read only ok" });
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("reader", { tools: ["read", "bash"] })]);
			const result = await executor.execute(
				"single-readonly-sandbox",
				{ agent: "reader", task: "Inspect only", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assertMountMode(readFakeBwrapArgs(fakeBwrap.recordDir), tempDir, "ro");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("mounts single sandboxed agents with omitted tools writable", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default tools ok" });
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("default-tools")]);
			const result = await executor.execute(
				"single-omitted-tools-sandbox",
				{ agent: "default-tools", task: "Use default tools", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assertMountMode(readFakeBwrapArgs(fakeBwrap.recordDir), tempDir, "rw");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("mounts single sandboxed edit/write agents writable and lets sandboxBashWrite opt bash into writes", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "write ok" });
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("writer", { tools: ["read", "edit"], completionGuard: false }), makeAgent("shell", { tools: ["bash"] })]);
			const writerResult = await executor.execute(
				"single-writable-sandbox",
				{ agent: "writer", task: "Edit", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(writerResult.isError, undefined);
			assertMountMode(readFakeBwrapArgs(fakeBwrap.recordDir), tempDir, "rw");

			const shellResult = await executor.execute(
				"single-bash-write-sandbox",
				{ agent: "shell", task: "Shell write", sandbox: { provider: "bubblewrap", bashWrite: true } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(shellResult.isError, undefined);
			assertMountMode(readFakeBwrapArgs(fakeBwrap.recordDir), tempDir, "rw");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("reports sandbox setup failures as foreground subagent errors", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousPath = process.env.PATH;
		process.env.PATH = path.join(path.dirname(mockPi.dir), "bin");
		try {
			mockPi.onCall({ output: "should not run" });
			const executor = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"single-bubblewrap-unavailable",
				{ agent: "echo", task: "Need sandbox", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Sandbox setup failed: Bubblewrap sandbox requested but bwrap is unavailable/);
			assert.match(result.content[0]?.text ?? "", /README.*Sandboxed subagents/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("surfaces fallback-none sandbox diagnostics in foreground details", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousPath = process.env.PATH;
		process.env.PATH = path.join(path.dirname(mockPi.dir), "bin");
		try {
			mockPi.onCall({ output: "fallback ok" });
			const executor = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"single-bubblewrap-fallback-none",
				{ agent: "echo", task: "Fallback allowed", sandbox: { provider: "bubblewrap", fallback: "none" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.content[0]?.text, "fallback ok");
			assert.equal(mockPi.callCount(), 1);
			const sandboxDetails = result.details.results[0]?.sandbox;
			assert.equal(sandboxDetails?.provider, "bubblewrap");
			assert.equal(sandboxDetails?.profile, "host-toolchain");
			assert.equal(sandboxDetails?.network, "host");
			assert.equal(sandboxDetails?.auth, "pi-json");
			assert.equal(sandboxDetails?.fallbackMode, "none");
			assert.equal(sandboxDetails?.fallbackOccurred, true);
			assert.match(sandboxDetails?.diagnostics?.[0]?.message ?? "", /running without sandbox/);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("honors explicit extraReadOnlyMounts and extraWritableMounts in foreground sandbox args", async () => {
		mockPi.onCall({ output: "extra mounts ok" });
		const fakeBwrap = installFakeBwrap();
		try {
			const readOnlyDir = path.join(tempDir, "toolchain");
			const writableDir = path.join(tempDir, "cache");
			fs.mkdirSync(readOnlyDir, { recursive: true });
			fs.mkdirSync(writableDir, { recursive: true });
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				sandbox: {
					provider: "bubblewrap",
					extraReadOnlyMounts: [readOnlyDir],
					extraWritableMounts: [writableDir],
				},
			});

			assert.equal(result.exitCode, 0);
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			assertMountMode(bwrapArgs, readOnlyDir, "ro");
			assertMountMode(bwrapArgs, writableDir, "rw");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("uses wrapped sandbox mounts for foreground failure diagnostics", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const fakeBwrap = installFailingFakeBwrap("bwrap: execvp git: No such file or directory\n", 1);
		try {
			mockPi.onCall({ output: "should not run" });
			const executor = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"single-sandbox-diagnostics-mounts",
				{ agent: "echo", task: "Need sandbox", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.equal(mockPi.callCount(), 0);
			const sandboxDetails = result.details.results[0]?.sandbox;
			assert.ok(sandboxDetails, "expected sandbox details");
			const diagnostic = sandboxDetails?.diagnostics?.[0];
			assert.ok(diagnostic, "expected sandbox failure diagnostic");
			assert.match(diagnostic.message, /covered by a read-only sandbox mount/);
			assert.doesNotMatch(diagnostic.message, /not mounted in the sandbox/);
		} finally {
			fakeBwrap.restore();
		}
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("executor auto-saves file-only output for read-only agents without an explicit output path", async () => {
		mockPi.onCall({ output: "review findings\nwith evidence" });
		const executor = makeExecutor([makeAgent("reviewer", { tools: ["read", "bash"] })]);

		const response = await executor.execute(
			"review-file-only-auto",
			{ agent: "reviewer", task: "Review", outputMode: "file-only" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const result = response.details.results[0]!;

		assert.equal(response.isError, undefined);
		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.ok(result.savedOutputPath);
		assert.match(result.savedOutputPath ?? "", new RegExp(`${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tmp/`));
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.doesNotMatch(result.finalOutput ?? "", /review findings/);
		const saved = fs.readFileSync(result.savedOutputPath!, "utf-8");
		assert.match(saved, /# Saved subagent output/);
		assert.match(saved, /review findings/);
	});

	it("executor keeps the working output file and also writes a per-run saved-output artifact for relative outputs", async () => {
		mockPi.onCall({ output: "# Research\n\nSaved body" });
		const executor = makeExecutor([makeAgent("researcher", { tools: ["read"], output: "research.md" })]);

		const response = await executor.execute(
			"relative-output-history",
			{ agent: "researcher", task: "Research" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const result = response.details.results[0]!;

		assert.equal(response.isError, undefined);
		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(path.join(tempDir, "research.md"), "utf-8"), "# Research\n\nSaved body");
		assert.ok(result.savedOutputPath);
		assert.notEqual(result.savedOutputPath, path.join(tempDir, "research.md"));
		assert.match(result.savedOutputPath ?? "", /\/tmp\//);
		const saved = fs.readFileSync(result.savedOutputPath!, "utf-8");
		assert.match(saved, /# Saved subagent output/);
		assert.match(saved, /# Research/);
	});

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes fanout routing env only when builtin subagent is declared", async () => {
		const envKeys = [
			SUBAGENT_FANOUT_CHILD_ENV,
			SUBAGENT_PARENT_EVENT_SINK_ENV,
			SUBAGENT_PARENT_CONTROL_INBOX_ENV,
			SUBAGENT_PARENT_RUN_ID_ENV,
			SUBAGENT_PARENT_CHILD_INDEX_ENV,
		];
		const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		try {
			process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events.jsonl";
			process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
			process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
			process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "7";

			mockPi.onCall({ echoEnv: envKeys });
			const fanoutAgents = [makeAgent("delegator", { tools: ["read", "subagent"] })];
			const fanout = await runSync(tempDir, fanoutAgents, "delegator", "Task", { runId: "fanout-run", index: 2 });
			assert.equal(fanout.exitCode, 0);
			assert.deepEqual(JSON.parse(fanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "1",
				PI_SUBAGENT_PARENT_EVENT_SINK: "/tmp/inherited/events.jsonl",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "/tmp/inherited/control",
				PI_SUBAGENT_PARENT_RUN_ID: "fanout-run",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "2",
			});

			mockPi.onCall({ echoEnv: envKeys });
			const nonFanoutAgents = [makeAgent("worker", { tools: ["read"] })];
			const nonFanout = await runSync(tempDir, nonFanoutAgents, "worker", "Task", { runId: "non-fanout-run" });
			assert.equal(nonFanout.exitCode, 0);
			assert.deepEqual(JSON.parse(nonFanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "0",
				PI_SUBAGENT_PARENT_EVENT_SINK: "",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "",
				PI_SUBAGENT_PARENT_RUN_ID: "",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "",
			});
		} finally {
			for (const key of envKeys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});

	it("passes supervisor metadata through to child execution", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
			intercomSessionName: "subagent-echo-78f659a3-3",
			orchestratorIntercomTarget: "subagent-chat-parent",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-echo-78f659a3-3",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_RUN_ID: "78f659a3",
			PI_SUBAGENT_CHILD_AGENT: "echo",
			PI_SUBAGENT_CHILD_INDEX: "2",
		});
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`detaches cleanly on ${toolName} handoff without aborting the child process`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const result = await runPromise;

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, true);
			assert.equal(result.detachedReason, "intercom coordination");
			assert.equal(result.finalOutput, "Detached for intercom coordination.");
			assert.equal(result.progress?.status, "detached");
			assert.equal(accepted, true);
		});
	}

	it("lets an active intercom child accept detach when another child is listening", async () => {
		const eventBus = createEventBus();
		let firstDetachResponse: boolean | undefined;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			if ((payload as { requestId?: unknown }).requestId !== "parallel-request") return;
			firstDetachResponse ??= (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({ delay: 500, output: "quiet child done" });
		const agents = makeAgentConfigs(["quiet", "intercom"]);

		const quietRun = runSync(tempDir, agents, "quiet", "Quiet task", {
			runId: "quiet-listener",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});
		for (let attempt = 0; attempt < 50 && mockPi.callCount() < 1; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mockPi.callCount(), 1);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 500, jsonl: [events.assistantMessage("after intercom")] },
			],
		});

		let detachEmitted = false;
		const intercomRun = runSync(tempDir, agents, "intercom", "Intercom task", {
			runId: "active-intercom",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				const sawIntercom = Array.isArray(progress) && progress.some((p) => p?.currentTool === "intercom");
				if (!sawIntercom) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-request" });
			},
		});

		const [quietResult, intercomResult] = await Promise.all([quietRun, intercomRun]);

		assert.equal(quietResult.exitCode, 0);
		assert.equal(quietResult.detached, undefined);
		assert.equal(intercomResult.exitCode, 0);
		assert.equal(intercomResult.detached, true);
		assert.equal(firstDetachResponse, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
