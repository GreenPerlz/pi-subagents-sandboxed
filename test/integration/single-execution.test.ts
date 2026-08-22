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
import { spawnSync } from "node:child_process";
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
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT } from "../../src/shared/types.ts";
import { createNestedRoute, NESTED_EVENTS_DIR, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { createScopedGitEndpoint } from "../../src/sandbox/scoped-git-endpoint.ts";import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_PATH_ENV,
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
	thinking?: string;
	fastMode?: { requested: boolean; eligible: boolean | "unknown"; active: boolean | "unknown"; model?: string };
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
	gitBundle?: { path: string; checksum: string; base: string; head: string; commitSummary: string };
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
	let nestedRoutesBefore: Set<string>;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		nestedRoutesBefore = fs.existsSync(NESTED_EVENTS_DIR) ? new Set(fs.readdirSync(NESTED_EVENTS_DIR)) : new Set();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
		if (fs.existsSync(NESTED_EVENTS_DIR)) {
			for (const entry of fs.readdirSync(NESTED_EVENTS_DIR)) if (!nestedRoutesBefore.has(entry)) fs.rmSync(path.join(NESTED_EVENTS_DIR, entry), { recursive: true, force: true });
		}
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

	async function waitForCallArgs(timeoutMs = 5_000): Promise<string[]> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			try {
				return readCallArgs();
			} catch (error) {
				if (Date.now() > deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	}

	function installFakeBwrap(): { recordDir: string; restore: () => void } {
		const rootDir = fs.mkdtempSync(path.join(tempDir, "fake-bwrap-"));
		const binDir = path.join(rootDir, "bin");
		const recordDir = path.join(rootDir, "records");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(recordDir, { recursive: true });
		const scriptPath = path.join(binDir, "fake-bwrap.mjs");
		fs.writeFileSync(scriptPath, `
import { spawn } from "node:child_process";
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
const child = spawn(args[separator + 1], args.slice(separator + 2), {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
child.on("error", (error) => {
  console.error(error.message);
  process.exit(99);
});
child.on("close", (status) => process.exit(status ?? 0));
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
			nestedFenceTimeoutMs?: number;
			teardownHooks?: Record<string, unknown>;
		} = {},
	) {
		const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null };
		const baseExecutor = createSubagentExecutor!({
			pi: { events: overrides.events ?? createEventBus(), getSessionName: overrides.getSessionName ?? (() => undefined) },
			state,
			config: overrides.config ?? {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
			nestedFenceTimeoutMs: overrides.nestedFenceTimeoutMs,
			teardownHooks: overrides.teardownHooks,
		});
		return {
			...baseExecutor,
			state,
			execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: ((r: unknown) => void) | undefined, ctx: unknown) =>
				baseExecutor.execute(id, {
					...params,
					...(!params.sandbox && !agents.some((agent) => agent.sandbox) && agents.every((agent) => !agent.canBeChangedByAgent || agent.canBeChangedByAgent.includes("*") || agent.canBeChangedByAgent.includes("sandbox.provider"))
						? { sandbox: { provider: "none" } } : {}),
				}, signal, onUpdate as never, ctx as never),
		};
	}

	function removeNestedRoutesForRun(runId: string | undefined): void {
		if (!runId || !fs.existsSync(NESTED_EVENTS_DIR)) return;
		for (const entry of fs.readdirSync(NESTED_EVENTS_DIR)) {
			const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
			try {
				const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, "route.json"), "utf8")) as { rootRunId?: unknown };
				if (metadata.rootRunId === runId) fs.rmSync(routeRoot, { recursive: true, force: true });
			} catch { /* Ignore unrelated or concurrently incomplete durable routes. */ }
		}
	}

	function makeLifecycleRepo(name: string): string {
		const repo = path.join(tempDir, name);
		fs.mkdirSync(repo, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Lifecycle Parent"], ["config", "user.email", "lifecycle@example.invalid"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		return repo;
	}

	function canonicalFastModeCtx() {
		const base = makeMinimalCtx(tempDir);
		return {
			...base,
			modelRegistry: {
				getAvailable: () => [{ provider: "openai", id: "gpt-5.5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
			},
		};
	}

	function readFastModeEnvs(): string[] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map((name) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { env?: { PI_SUBAGENT_FAST_MODE?: string | null } }).env?.PI_SUBAGENT_FAST_MODE ?? "null");
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

	it("allows implementation runs to return validation-only output without forced mutation", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "completed");
		assert.deepEqual(controlEvents, []);
		assert.deepEqual(result.controlEvents ?? [], []);
	});

	it("allows future-tense implementation summaries without forced mutation", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
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

	it("allows bash-enabled agents to complete without forced mutation", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"] }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Run cold start test after patch", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 0);
		assert.equal(withoutOptOut.progress.status, "completed");

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

	it("evaluates acceptance once when agent self-review defaults off", async () => {
		mockPi.onCall({ output: acceptanceReport() });
		const agents = [makeAgent("worker", { acceptanceSelfReview: false })];

		const result = await runSync(tempDir, agents, "worker", "Create a one-pass acceptance report", {
			runId: "guard-acceptance-one-pass",
			acceptance: { criteria: ["Create the report"], maxFinalizationTurns: 3 },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.acceptance?.status, "checked");
		assert.equal(result.acceptance?.finalization, undefined);
		assert.equal(mockPi.callCount(), 1);
	});

	it("preserves provider-qualified model routing across acceptance finalization", async () => {
		mockPi.onCall({ output: acceptanceReport() });
		mockPi.onCall({ output: acceptanceReport() });
		const agents = [makeAgent("worker", { model: "openrouter/openai/gpt-4o" })];

		const result = await runSync(tempDir, agents, "worker", "Create a routed acceptance report", {
			runId: "guard-acceptance-openrouter-model",
			acceptance: { criteria: ["Create the report"], selfReview: true, maxFinalizationTurns: 1 },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(mockPi.callCount(), 2);
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		for (const callFile of callFiles) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
			const args = payload.args ?? [];
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "openrouter/openai/gpt-4o");
		}
	});

	it("propagates fast mode through every foreground acceptance-finalization request", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_FAST_MODE"] });
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_FAST_MODE"] });
		const agents = [makeAgent("worker", { model: "openai/gpt-5.5", fastMode: true })];
		const result = await runSync(tempDir, agents, "worker", "Create a priority acceptance report", {
			runId: "fast-mode-acceptance-finalization",
			acceptance: { criteria: ["Create the report"], selfReview: true, maxFinalizationTurns: 1 },
			availableModels: [{ provider: "openai", id: "gpt-5.5", fullId: "openai/gpt-5.5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.fastMode, { requested: true, eligible: true, active: "unknown", model: "openai/gpt-5.5" });
		const callFiles = fs.readdirSync(mockPi.dir).filter((file) => file.startsWith("call-") && file.endsWith(".json"));
		assert.equal(callFiles.length, 2);
		for (const callFile of callFiles) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { env?: { PI_SUBAGENT_FAST_MODE?: string | null } };
			assert.equal(payload.env?.PI_SUBAGENT_FAST_MODE, "1");
		}
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

	it("rejects denied acceptance overrides before spawning a child", async () => {
		const executor = makeExecutor([makeAgent("worker", { canBeChangedByAgent: [] })]);
		const result = await executor.execute(
			"denied-acceptance-override",
			{ agent: "worker", task: "Implement the fix", acceptance: { criteria: ["Fix it"], selfReview: true } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /acceptance\.criteria, acceptance\.selfReview/);
		assert.match(result.content[0]?.text ?? "", /remove the denied overrides or recommend an agent-definition change to the user/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects denied parallel, chain, dynamic, and async overrides before spawning", async () => {
		const executor = makeExecutor([
			makeAgent("one", { canBeChangedByAgent: ["outputSchema"] }),
			makeAgent("two", { canBeChangedByAgent: ["sandbox.provider"] }),
		]);
		const cases = [
			{
				name: "parallel",
				params: { tasks: [{ agent: "two", task: "Review", model: "provider/model" }] },
			},
			{
				name: "chain",
				params: { chain: [{ agent: "two", task: "Review", model: "provider/model" }] },
			},
			{
				name: "dynamic",
				params: {
					chain: [
						{ agent: "one", task: "List items", as: "items", outputSchema: { type: "object" } },
						{
							expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
							parallel: { agent: "two", task: "Review {item}", model: "provider/model" },
							collect: { as: "results" },
						},
					],
				},
			},
			{
				name: "async",
				params: { agent: "two", task: "Review", model: "provider/model", async: true },
			},
			{
				name: "worktree",
				params: { tasks: [{ agent: "two", task: "Review" }], worktree: true },
			},
		] as const;

		for (const testCase of cases) {
			const result = await executor.execute(
				`denied-${testCase.name}-override`,
				testCase.params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(result.isError, true, testCase.name);
			assert.match(result.content[0]?.text ?? "", new RegExp(`denied ${testCase.name === "worktree" ? "worktree" : "model"}`), testCase.name);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("routes fast mode through public static-chain and dynamic launch boundaries", async () => {
		const worker = makeAgent("worker", { model: "openai/gpt-5.5", fastMode: true });
		const scout = makeAgent("scout");
		const executor = makeExecutor([scout, worker]);
		mockPi.onCall({ output: "static chain done" });
		const staticResult = await executor.execute(
			"fast-static-chain",
			{ chain: [{ agent: "worker", task: "Do the priority work" }] },
			new AbortController().signal,
			undefined,
			canonicalFastModeCtx(),
		);
		assert.equal(staticResult.isError, undefined);
		assert.equal(staticResult.details.results[0]?.fastMode?.eligible, true);

		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ name: "a" }] } });
		mockPi.onCall({ output: "dynamic review done" });
		const dynamicResult = await executor.execute(
			"fast-dynamic-chain",
			{
				chain: [
					{ agent: "scout", task: "List targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, maxItems: 1 },
						parallel: { agent: "worker", task: "Review {item}" },
						collect: { as: "reviews" },
					},
				],
			},
			new AbortController().signal,
			undefined,
			canonicalFastModeCtx(),
		);
		assert.equal(dynamicResult.isError, undefined);
		assert.equal(dynamicResult.details.results.some((result) => result.fastMode?.eligible === true), true);
		assert.deepEqual(readFastModeEnvs(), ["1", "0", "1"]);
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

	it("evaluates fast mode independently for supported and unsupported fallback candidates", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "priority candidate failed" }],
					model: "openai/gpt-5.5",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ jsonl: [events.assistantMessage("Recovered normally", "anthropic/claude-sonnet-4")] });
		const agents = [makeAgent("echo", { model: "openai/gpt-5.5", fallbackModels: ["anthropic/claude-sonnet-4"], fastMode: true })];
		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-fast-mode",
			availableModels: [
				{ provider: "openai", id: "gpt-5.5", fullId: "openai/gpt-5.5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
			],
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.fastMode?.model, "anthropic/claude-sonnet-4");
		assert.equal(result.fastMode?.eligible, false);
		const callFiles = fs.readdirSync(mockPi.dir).filter((file) => file.startsWith("call-") && file.endsWith(".json"));
		assert.equal(callFiles.length, 2);
		const callEnvs = callFiles.map((file) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, file), "utf-8")) as { env?: { PI_SUBAGENT_FAST_MODE?: string | null } }).env?.PI_SUBAGENT_FAST_MODE);
		assert.deepEqual(callEnvs.sort(), ["0", "1"]);
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

	it("passes explicit thinking off even when the model has no suffix", async () => {
		mockPi.onCall({ output: "thinking disabled" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			thinking: "off",
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "explicit-thinking-off",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), [
			"--model",
			"openai/gpt-5-mini",
			"--thinking",
			"off",
		]);
	});

	it("passes configured thinking when the agent inherits its model", async () => {
		mockPi.onCall({ output: "inherited model thinking" });
		const agents = [makeAgent("echo", { thinking: "high" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "inherited-model-thinking",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		assert.equal(args.includes("--model"), false);
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);
	});

	it("keeps unsupported max thinking off the actual fallback child args", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary quota hit" }],
					model: "openai/gpt-5.6-sol",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "fallback succeeded", model: "anthropic/claude-sonnet-4" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5.6-sol",
			fallbackModels: ["anthropic/claude-sonnet-4"],
			thinking: "max",
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "max-thinking-unsupported-fallback",
			availableModels: [
				{ provider: "openai", id: "gpt-5.6-sol", fullId: "openai/gpt-5.6-sol", reasoning: true, thinkingLevelMap: { max: "max" } },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4", reasoning: true },
			],
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5.6-sol:max", "anthropic/claude-sonnet-4"]);
		assert.equal(result.thinking, undefined);
		const fallbackArgs = readCallArgs();
		assert.deepEqual(fallbackArgs.slice(fallbackArgs.indexOf("--model"), fallbackArgs.indexOf("--model") + 2), ["--model", "anthropic/claude-sonnet-4"]);
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
			{ agent: "echo", task: "Task", sandbox: { provider: "none" } },
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

	it("rejects isolated cwd escapes before runSync output, session, skill, and artifact side effects", { skip: !runSync ? "execution module unavailable" : undefined }, async () => {
		const outside = path.join(os.tmpdir(), `pi-subagent-cwd-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const alias = path.join(tempDir, "outside-alias");
		const marker = path.join(tempDir, "cwd-escape-marker");
		const nested = path.join(tempDir, "nested");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, ".keep"), "nested\\n");
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\\n");
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Cwd Test"], ["config", "user.email", "cwd@example.invalid"], ["add", "."], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", tempDir, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const endpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-gates-endpoint-"));
		const owner = createScopedGitEndpoint({ runtimeRoot: endpointRoot, worktree: tempDir, cwd: tempDir, rights: "writer" });
		const sessionDir = path.join(tempDir, "cwd-escape-session");
		const artifactsDir = path.join(tempDir, "cwd-escape-artifacts");
		const sideEffectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-gates-side-effects-"));
		const nestedAlias = path.join(tempDir, "nested-alias");
		fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, alias, "dir");
		fs.symlinkSync(nested, nestedAlias, "dir");
		const fakeBwrap = installFakeBwrap();
		const isolatedSandbox = { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", extraWritableMounts: [mockPi.dir] };
		try {
			const cases = [
				{ name: "equal", cwd: tempDir, allowed: true },
				{ name: "real descendant", cwd: nested, allowed: true },
				{ name: "ancestor", cwd: path.join(tempDir, ".."), allowed: false },
				{ name: "sibling", cwd: path.join(path.dirname(tempDir), "sibling"), allowed: false },
				{ name: "dotdot escape", cwd: path.join(tempDir, "nested", "..", ".."), allowed: false },
				{ name: "symlink alias escape", cwd: alias, allowed: false },
				{ name: "symlink alias descendant", cwd: nestedAlias, allowed: true },
			] as const;
			for (const testCase of cases) {
				const caseMarker = path.join(sideEffectRoot, `${testCase.name.replace(/\\s+/gu, "-")}-marker`);
				const caseSession = path.join(sideEffectRoot, `${testCase.name.replace(/\\s+/gu, "-")}-session`);
				const caseArtifacts = path.join(sideEffectRoot, `${testCase.name.replace(/\\s+/gu, "-")}-artifacts`);
				if (testCase.allowed) mockPi.onCall({ output: "allowed" });
				let result: RunSyncResult | undefined;
				if (testCase.allowed) {
					result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "allowed cwd", { cwd: testCase.cwd, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer", outputPath: caseMarker, sessionDir: caseSession, artifactsDir: caseArtifacts, sandbox: isolatedSandbox, exportIsolatedGitBundle: false });
				} else {
					assert.throws(() => owner.reserveChild({ cwd: testCase.cwd, rights: "read-only" }), /widens|escapes/);
					await assert.rejects(
						() => runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "rejected cwd", { cwd: testCase.cwd, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer", outputPath: caseMarker, sessionDir: caseSession, artifactsDir: caseArtifacts, sandbox: isolatedSandbox, exportIsolatedGitBundle: false }),
						/widens|escapes/,
					);
				}
				if (testCase.allowed) {
					assert.equal((result as RunSyncResult).exitCode, 0, `${testCase.name}: ${JSON.stringify(result)}`);
					assert.equal(mockPi.callCount(), cases.filter((candidate) => candidate.allowed && cases.indexOf(candidate) <= cases.indexOf(testCase)).length, testCase.name);
				} else {
					assert.equal(result, undefined, testCase.name);
					assert.equal(fs.existsSync(caseMarker), false, `${testCase.name}: output marker`);
					assert.equal(fs.existsSync(caseSession), false, `${testCase.name}: session directory`);
					assert.equal(fs.existsSync(caseArtifacts), false, `${testCase.name}: artifacts/discovery directory`);
				}
			}
			assert.equal(mockPi.callCount(), cases.filter((candidate) => candidate.allowed).length);
			const invalidDescriptorMarker = path.join(sideEffectRoot, "invalid-descriptor-marker");
			const invalidDescriptorSession = path.join(sideEffectRoot, "invalid-descriptor-session");
			const invalidDescriptorArtifacts = path.join(sideEffectRoot, "invalid-descriptor-artifacts");
			await assert.rejects(
				() => runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "rejected descriptor", { cwd: tempDir, isolatedGitEndpoint: { relativeSubtree: ".." }, isolatedGitRights: "writer", outputPath: invalidDescriptorMarker, sessionDir: invalidDescriptorSession, artifactsDir: invalidDescriptorArtifacts, sandbox: isolatedSandbox, exportIsolatedGitBundle: false }),
				/escapes/,
			);
			assert.equal(fs.existsSync(invalidDescriptorMarker), false);
			assert.equal(fs.existsSync(invalidDescriptorSession), false);
			assert.equal(fs.existsSync(invalidDescriptorArtifacts), false);
			const executor = makeExecutor([makeAgent("fixture.pkg.review", { tools: ["read"] })]);
			const parallel = await executor.execute("cwd-top-level-parallel", {
				tasks: [{ agent: "fixture.pkg.review", task: "must not spawn", cwd: path.join(tempDir, "..") }],
				cwd: tempDir,
				sandbox: isolatedSandbox,
				isolatedGitEndpoint: owner.descriptor,
				isolatedGitRights: "writer",
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(parallel.isError, true, "top-level foreground parallel must reject an unauthorized task cwd");
			assert.match(parallel.content[0]?.text ?? "", /cwd authorization failed closed|widens|escapes|setup failed/i);
			assert.equal(mockPi.callCount(), cases.filter((candidate) => candidate.allowed).length, "top-level parallel must not spawn");
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(sessionDir), false);
			assert.equal(fs.existsSync(artifactsDir), false);
		} finally {
			fakeBwrap.restore();
			await owner.close();
			fs.rmSync(alias, { force: true });
			fs.rmSync(nestedAlias, { force: true });
			fs.rmSync(outside, { recursive: true, force: true });
			fs.rmSync(sideEffectRoot, { recursive: true, force: true });
			fs.rmSync(endpointRoot, { recursive: true, force: true });
		}
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
			const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5.5", fastMode: true })]);
			const result = await executor.execute(
				"single-sandbox-closed-runtime",
				{ agent: "echo", task: "Smoke test sandboxed child launch using pi-json auth. Reply exactly: SUBAGENT_SANDBOXED_PI_JSON_OK", sandbox: { provider: "bubblewrap", auth: "pi-json" } },
				new AbortController().signal,
				undefined,
				canonicalFastModeCtx(),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /SUBAGENT_SANDBOXED_PI_JSON_OK/);
			assert.equal(result.details.results[0]?.sandbox?.fallbackOccurred, false);
			assert.equal(result.details.results[0]?.sandbox?.auth, "pi-json");
			assert.equal(result.details.results[0]?.fastMode?.eligible, true);
			assert.deepEqual(readFastModeEnvs(), ["1"]);
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

	it("does not expose intercom tools for non-async foreground sandbox runs even with active bridge", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
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
			events.assistantMessage("foreground sandbox child done"),
		]);
		try {
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read", "contact_supervisor"] })]);
			const result = await executor.execute(
				"single-active-bridge-sandbox",
				{ agent: "bridge", task: "Do work", sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /foreground sandbox child done/);
			assert.equal(result.details?.results?.[0]?.detached, undefined, "non-async foreground run should not detach");
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			assert.ok(piArgs.includes("--no-extensions"), "closed sandbox should keep ambient extension discovery disabled");
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read"], "non-async foreground run should strip contact_supervisor and avoid bridge tool injection");
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.equal(extensionArgs.includes(intercomExtensionDir), false, "non-async foreground run should not pass pi-intercom as an explicit extension");
			assertNotMounted(bwrapArgs, intercomExtensionDir);
			assertNotMounted(bwrapArgs, intercomStateDir);
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
			const executor = makeExecutor([makeAgent("quiet", { tools: ["read"] })], { config: { intercomBridge: { mode: "off" } } });
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

	it("keeps intercom bridge tools when clarify sends a single run to background", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-clarify-single-agent-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mockPi.onCall({ output: "clarify background single ok" });
		try {
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read"] })]);
			const result = await executor.execute(
				"single-clarify-background-bridge",
				{ agent: "bridge", task: "Use supervisor bridge", clarify: true },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					hasUI: true,
					ui: {
						custom: async () => ({
							confirmed: true,
							templates: ["Use supervisor bridge"],
							behaviorOverrides: [undefined],
							runInBackground: true,
						}),
					},
				},
			);

			assert.equal(result.isError, undefined);
			assert.ok(result.details?.asyncId, "clarify background single run should start async execution");
			const piArgs = await waitForCallArgs();
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read,intercom,contact_supervisor"]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps intercom bridge tools when clarify sends a chain run to background", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-clarify-chain-agent-"));
		const intercomExtensionDir = path.join(agentDir, "extensions", "pi-intercom");
		fs.mkdirSync(intercomExtensionDir, { recursive: true });
		fs.writeFileSync(path.join(intercomExtensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf-8");
		fs.writeFileSync(path.join(intercomExtensionDir, "extension.ts"), "export default function register() {}\n", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mockPi.onCall({ output: "clarify background chain ok" });
		try {
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read"] })]);
			const result = await executor.execute(
				"chain-clarify-background-bridge",
				{ chain: [{ agent: "bridge", task: "Use supervisor bridge" }], clarify: true },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					hasUI: true,
					ui: {
						custom: async () => ({
							confirmed: true,
							templates: ["Use supervisor bridge"],
							behaviorOverrides: [undefined],
							runInBackground: true,
						}),
					},
				},
			);

			assert.equal(result.isError, undefined);
			assert.ok(result.details?.asyncId, "clarify background chain run should start async execution");
			const piArgs = await waitForCallArgs();
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read,intercom,contact_supervisor"]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not expose intercom tools for non-async agent-level sandboxed chain steps", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
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
			const executor = makeExecutor([makeAgent("bridge", { tools: ["read", "contact_supervisor"], sandbox: { provider: "bubblewrap" } })]);
			const result = await executor.execute(
				"chain-agent-level-bridge-sandbox",
				{ chain: [{ agent: "bridge", task: "Do chain work" }], clarify: false },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Chain completed/);
			const bwrapArgs = readFakeBwrapArgs(fakeBwrap.recordDir);
			const separatorIndex = bwrapArgs.indexOf("--");
			assert.notEqual(separatorIndex, -1, "bubblewrap invocation should contain command separator");
			const piArgs = bwrapArgs.slice(separatorIndex + 3);
			const extensionArgs = piArgs.filter((arg, index) => piArgs[index - 1] === "--extension");
			assert.equal(extensionArgs.includes(intercomExtensionDir), false, "non-async foreground chain should not pass pi-intercom as an explicit extension");
			assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools"), piArgs.indexOf("--tools") + 2), ["--tools", "read"], "non-async foreground chain should strip contact_supervisor and avoid bridge tool injection");
			assertNotMounted(bwrapArgs, intercomExtensionDir);
			assertNotMounted(bwrapArgs, intercomStateDir);
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
			const executor = makeExecutor([makeAgent("limited", { tools: ["read"], extensions: [otherExtension] })]);
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
			const executor = makeExecutor([makeAgent("writer", { tools: ["read", "edit"] }), makeAgent("shell", { tools: ["bash"] })]);
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

	it("persists a foreground isolated rejection with its recovery bundle and grouped receipt", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-rejection-projection-repo");
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-rejection-agent-"));
		const extensionDir = path.join(agentDir, "extensions", "pi-intercom");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf8");
		fs.writeFileSync(path.join(extensionDir, "extension.ts"), "export default function register() {}\n", "utf8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const bus = createEventBus();
		const runtimePrefix = "pi-isolated-git-isolated-foreground-rejection-";
		const beforeRuntimes = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix)));
		let grouped: any;
		let runtimesAtPublication: string[] | undefined;
		bus.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
			grouped = payload;
			runtimesAtPublication = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix) && !beforeRuntimes.has(entry));
			const bundlePath = (payload as any)?.children?.[0]?.gitBundle?.path;
			assert.ok(bundlePath && fs.existsSync(bundlePath), "publication observer must receive a readable bundle");
		});
		try {
			mockPi.onCall({
				output: "child output before artifact rejection",
				blockArtifactOutput: true,
				commands: ["printf 'recovered rejection\\n' > rejected.txt"],
			});
			const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })], { events: bus, getSessionName: () => "foreground-parent" });
			let blockedOutput = false;
			const result = await executor.execute("isolated-foreground-rejection", {
				agent: "worker",
				task: "Write then trigger the foreground rejection",
				sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] },
			}, new AbortController().signal, (update: any) => {
				const outputPath = update.details?.results?.[0]?.artifactPaths?.outputPath;
				if (blockedOutput || typeof outputPath !== "string") return;
				blockedOutput = true;
				fs.rmSync(outputPath, { force: true });
				fs.mkdirSync(outputPath, { recursive: true });
			}, makeMinimalCtx(repo));
			const child = result.details.results[0] as any;
			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Foreground execution rejected/);
			assert.match(child?.error ?? "", /Foreground execution rejected/);
			assert.ok(child?.gitBundle?.path && fs.existsSync(child.gitBundle.path), "rejection bundle must be readable");
			assert.equal(child?.gitBundle?.terminationState, "execution-rejected");
			assert.ok(child?.gitBundle?.recovery, "dirty rejection must retain recovery metadata");
			const persisted = [...executor.state.foregroundRuns.values()].at(-1);
			assert.equal(persisted?.children.length, 1);
			assert.match(persisted?.children[0]?.error ?? "", /Foreground execution rejected/);
			assert.ok(persisted?.children[0]?.gitBundle?.path);
			assert.equal(grouped?.children?.length, 1);
			assert.match(grouped?.children?.[0]?.summary ?? "", /Foreground execution rejected/);
			assert.ok(grouped?.children?.[0]?.gitBundle?.path);
			assert.deepEqual(runtimesAtPublication, [], "runtime root and endpoint owners must be gone before grouped publication");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("preserves a foreground isolated rejection when bundle packaging fails", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-rejection-packaging-failure-repo");
		const blockedArtifacts = path.join(tempDir, "subagent-artifacts");
		fs.writeFileSync(blockedArtifacts, "not a directory", "utf8");
		const parentSessionFile = path.join(tempDir, "parent-session.jsonl");
		const ctx = { ...makeMinimalCtx(repo), sessionManager: { getSessionId: () => "session-123", getSessionFile: () => parentSessionFile } };
		mockPi.onCall({ output: "child output before packaging failure", commands: ["printf 'packaging recovery\\n' > rejected.txt"] });
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		let blockedOutput = false;
		const result = await executor.execute("isolated-foreground-packaging-failure", {
			agent: "worker",
			task: "Write then fail foreground bundle packaging",
			sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] },
		}, new AbortController().signal, (update: any) => {
			const outputPath = update.details?.results?.[0]?.artifactPaths?.outputPath;
			if (blockedOutput || typeof outputPath !== "string") return;
			blockedOutput = true;
			const artifactsDir = path.dirname(outputPath);
			fs.rmSync(artifactsDir, { recursive: true, force: true });
			fs.writeFileSync(artifactsDir, "not a directory", "utf8");
		}, ctx);
		const child = result.details.results[0] as any;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0]?.text ?? "", /Foreground execution rejected/);
		assert.match(child?.error ?? "", /Foreground execution rejected/);
		assert.match(child?.error ?? "", /bundle export failed|recover worktree/i);
		assert.equal(child?.gitBundle, undefined);
		const persisted = [...executor.state.foregroundRuns.values()].at(-1);
		assert.match(persisted?.children[0]?.error ?? "", /recover worktree/i);
	});

	it("runs a positive foreground isolated Git execution through the executor and preserves the parent", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = path.join(tempDir, "isolated-executor-repo");
		fs.mkdirSync(repo, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Executor Parent"], ["config", "user.email", "executor@example.invalid"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const before = spawnSync("git", ["-C", repo, "status", "--porcelain=v1"], { encoding: "utf8" }).stdout;
		mockPi.onCall({
			output: "isolated executor complete",
			commands: ["printf 'child\\n' > child.txt && git add child.txt && git commit -m 'isolated executor commit'"],
		});
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		const result = await executor.execute(
			"isolated-foreground-executor",
			{ agent: "worker", task: "Commit the isolated child change", sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(repo),
		);
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /isolated executor complete/);
		const child = result.details.results[0];
		assert.equal(child?.gitBundle?.base, spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
		assert.ok(child?.gitBundle?.path && fs.existsSync(child.gitBundle.path));
		assert.equal(spawnSync("git", ["-C", repo, "status", "--porcelain=v1"], { encoding: "utf8" }).stdout, before);
	});

	it("detached isolated parallel and chain terminal result is durably persisted and cleaned", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = path.join(tempDir, "isolated-detached-lifecycle-repo");
		fs.mkdirSync(repo, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Lifecycle Parent"], ["config", "user.email", "lifecycle@example.invalid"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const beforeRuntimes = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-")));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-detached-intercom-agent-"));
		const extensionDir = path.join(agentDir, "extensions", "pi-intercom");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./extension.ts"] } }), "utf8");
		fs.writeFileSync(path.join(extensionDir, "extension.ts"), "export default function register() {}\n", "utf8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const isolatedSandbox = { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] };
		const runModes: Array<{ label: string; params: Record<string, unknown> }> = [
			{ label: "parallel", params: { tasks: [{ agent: "worker", task: "Detach and commit first sibling" }, { agent: "worker", task: "Finish second sibling" }], sandbox: isolatedSandbox } },
			{ label: "chain", params: { chain: [{ parallel: [{ agent: "worker", task: "Detach and commit first chain sibling" }, { agent: "worker", task: "Finish second chain sibling" }] }], clarify: false, sandbox: isolatedSandbox } },
		];
		try {
			for (const { label, params } of runModes) {
			mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "handoff" })] }, { delay: 500, jsonl: [events.assistantMessage(`${label} detached terminal`)] }], commands: ["printf 'detached\n' > detached.txt && git add detached.txt && git commit -m detached"] });
			mockPi.onCall({ output: `${label} sibling terminal`, commands: ["printf 'sibling\n' > sibling.txt && git add sibling.txt && git commit -m sibling"] });
			const bus = createEventBus();
			const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash", "contact_supervisor"], systemPrompt: "Intercom orchestration channel: test" })], { events: bus });
			let detachSent = false;
			let detachedChildIndex: number | undefined;
			let terminalUpdate: any;
			let groupedIntercom: any;
			bus.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => { groupedIntercom = payload; });
			const result = await executor.execute(`isolated-detached-${label}`, params, new AbortController().signal, (update: any) => {
				if (detachedChildIndex === undefined) {
					const activeProgress = update.details?.progress?.find((entry: any) => entry.currentTool === "contact_supervisor");
					if (Number.isInteger(activeProgress?.index)) detachedChildIndex = activeProgress.index;
					const detachedResultIndex = update.details?.results?.findIndex((child: any) => child.detached === true && /Detach and commit first/.test(child.task ?? ""));
					if (detachedChildIndex === undefined && typeof detachedResultIndex === "number" && detachedResultIndex >= 0) detachedChildIndex = detachedResultIndex;
				}
				const terminalIndex = update.details?.results?.findIndex((child: any) => child.finalOutput === `${label} detached terminal` && child.detached !== true && child.gitBundle?.path);
				if (typeof terminalIndex === "number" && terminalIndex >= 0 && detachedChildIndex === undefined) detachedChildIndex = terminalIndex;
				if (detachedChildIndex !== undefined && update.details?.results?.[detachedChildIndex]?.finalOutput === `${label} detached terminal` && update.details.results[detachedChildIndex]?.detached !== true) terminalUpdate = update;
				if (detachSent || !update.details?.progress?.some((entry: any) => entry.currentTool === "contact_supervisor")) return;
				detachSent = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: `isolated-${label}` });
			}, makeMinimalCtx(repo));
			assert.equal(detachSent, true, `${label} must use production detach`);
			assert.ok(detachedChildIndex !== undefined, `${label} must identify the detached child by index`);
			assert.equal(result.details.results[detachedChildIndex!]?.detached, true, `${label} immediate result must retain detached status for the detached child`);
			const deadline = Date.now() + 8_000;
			let persisted: any;
			while (Date.now() < deadline) {
				persisted = [...executor.state.foregroundRuns.values()].at(-1);
				if (terminalUpdate && persisted?.children.some((child: any) => child.index === detachedChildIndex && child.gitBundle?.path && child.exitCode === 0)) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.ok(terminalUpdate, `${label} should project eventual terminal update for detached child ${detachedChildIndex}`);
			const terminalChild = terminalUpdate.details.results[detachedChildIndex!] as any;
			assert.equal(terminalChild?.finalOutput, `${label} detached terminal`);
			assert.ok(terminalChild?.gitBundle?.path && fs.existsSync(terminalChild.gitBundle.path), `${label} terminal update must retain the exact detached bundle`);
			assert.ok(["success", "execution-rejected"].includes(terminalChild?.gitBundle?.terminationState), `${label} terminal bundle must retain termination state`);
			assert.ok(groupedIntercom, `${label} must publish grouped terminal intercom`);
			const groupedChild = groupedIntercom.children?.find((child: any) => child.index === detachedChildIndex);
			assert.equal(groupedChild?.gitBundle?.path, terminalChild.gitBundle.path, `${label} grouped intercom must retain the exact bundle`);
			assert.match(groupedIntercom.message ?? "", new RegExp(`Git bundle: ${String(terminalChild.gitBundle.path).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
			const persistedDetached = persisted?.children.find((child: any) => child.index === detachedChildIndex && child.finalOutput === `${label} detached terminal`);
			assert.ok(persistedDetached?.gitBundle?.path && fs.existsSync(persistedDetached.gitBundle.path), `${label} detached child bundle must be durably remembered at its original index`);
			assert.notEqual(persistedDetached?.detached, true, `${label} persisted detached child must be corrected at its original index`);
			let afterRuntimes: string[] = [];
			while (Date.now() < deadline) {
				afterRuntimes = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-") && !beforeRuntimes.has(entry));
				if (afterRuntimes.length === 0) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.deepEqual(afterRuntimes, [], `${label} isolated runtime must be cleaned after sibling export`);
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("retains endpoint recovery when foreground cleanup is unproven", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const modes = [
			{ name: "top-level parallel", params: { tasks: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] } },
			{ name: "parallel chain", params: { chain: [{ parallel: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] }], clarify: false } },
			{ name: "sequential chain", params: { chain: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }], clarify: false } },
		] as const;
		for (const mode of modes) {
			const repo = makeLifecycleRepo(`release-failure-${mode.name.replace(/\\W+/gu, "-")}`);
			const endpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-failure-endpoint-"));
			const owner = createScopedGitEndpoint({ runtimeRoot: endpointRoot, worktree: repo, cwd: repo, rights: "writer" });
			let nestedRunId: string | undefined;
			const bus = createEventBus();
			const publications: unknown[] = [];
			bus.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => publications.push(payload));
			let detachSent = false;
			const updates: any[] = [];
			mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "endpoint cleanup" })] }, { delay: 300, jsonl: [events.assistantMessage("terminal output")] }] });
			try {
				const releaseAttempts: unknown[] = [];
				const executor = makeExecutor([makeAgent("fixture.pkg.work", { tools: ["read", "edit", "bash", "contact_supervisor"], systemPrompt: "Intercom orchestration channel: test" })], {
					events: bus,
					teardownHooks: {
						waitForNestedDescendantsToStop: async () => ({ observed: false, stopped: true }),
					},
				});
				const result = await executor.execute(`release-failure-${mode.name}`, { ...mode.params, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer", sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, (update: any) => {
					updates.push(update);
					const progress = update.details?.progress?.some((entry: any) => entry.currentTool === "contact_supervisor");
					if (progress && !detachSent) {
						detachSent = true;
						bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: `release-failure-${mode.name}` });
					}
				}, makeMinimalCtx(repo));
				nestedRunId = result.details.runId;
				assert.equal(detachSent, true, `${mode.name}: production detach must start the terminal path`);
				const releaseDeadline = Date.now() + 4_000;
				while (releaseAttempts.length === 0 && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(releaseAttempts.length, 0, `${mode.name}: endpoint cleanup has no bearer release hook`);
				const teardownDeadline = Date.now() + 4_000;
				while (!updates.some((update) => update.details?.results?.some((child: any) => child.teardownUnproven === true)) && Date.now() < teardownDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(result.details.results[0]?.detached, true, `${mode.name}: retain detached acknowledgement`);
				assert.match(result.content[0]?.text ?? "", /Recover retained isolated worktree evidence through the owning parent run/, `${mode.name}: retain actionable recovery guidance without exposing host paths`);
				assert.equal(fs.existsSync(owner.scope.endpointRoot), true, `${mode.name}: endpoint owner remains available for recovery`);
				assert.equal(publications.length, 0, `${mode.name}: suppress terminal publication while endpoint cleanup is unproven`);
				assert.equal(updates.some((update) => update.details?.results?.some((child: any) => child.teardownUnproven === true)), true, `${mode.name}: unproven endpoint cleanup projects actionable teardownUnproven state`);
				assert.equal(fs.existsSync(owner.scope.endpointRoot), true, `${mode.name}: retain endpoint root for recovery`);
			} finally {
				await owner.close();
				removeNestedRoutesForRun(nestedRunId);
				fs.rmSync(endpointRoot, { recursive: true, force: true });
			}
		}
	});

	it("suppresses terminal publication when the descendant fence is unproven", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const modes = [
			{ name: "top-level parallel", params: { tasks: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] } },
			{ name: "parallel chain", params: { chain: [{ parallel: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] }], clarify: false } },
			{ name: "sequential chain", params: { chain: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }], clarify: false } },
		] as const;
		for (const mode of modes) {
			const repo = makeLifecycleRepo(`fence-failure-${mode.name.replace(/\\W+/gu, "-")}`);
			const endpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fence-failure-endpoint-"));
			const owner = createScopedGitEndpoint({ runtimeRoot: endpointRoot, worktree: repo, cwd: repo, rights: "writer" });
			const bus = createEventBus();
			const publications: unknown[] = [];
			bus.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => publications.push(payload));
			const releaseAttempts: unknown[] = [];
			let nestedRunId: string | undefined;
			let detachSent = false;
			const updates: any[] = [];
			mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "endpoint fence" })] }, { delay: 300, jsonl: [events.assistantMessage("terminal output")] }] });
			try {
				const executor = makeExecutor([makeAgent("fixture.pkg.work", { tools: ["read", "edit", "bash", "contact_supervisor"], systemPrompt: "Intercom orchestration channel: test" })], {
					events: bus,
					teardownHooks: {
						waitForNestedDescendantsToStop: async () => ({ observed: true, stopped: false }),

					},
				});
				const result = await executor.execute(`fence-failure-${mode.name}`, { ...mode.params, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer", sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, (update: any) => {
					updates.push(update);
					if (detachSent || !update.details?.progress?.some((entry: any) => entry.currentTool === "contact_supervisor")) return;
					detachSent = true;
					bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: `fence-failure-${mode.name}` });
				}, makeMinimalCtx(repo));
				nestedRunId = result.details.runId;
				assert.equal(detachSent, true, `${mode.name}: production detach must start the terminal path`);
				const teardownDeadline = Date.now() + 4_000;
				while (!updates.some((update) => update.details?.results?.some((child: any) => child.teardownUnproven === true)) && Date.now() < teardownDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(result.details.results[0]?.detached, true, `${mode.name}: retain detached acknowledgement`);
				assert.match(result.content[0]?.text ?? "", /Recover retained isolated worktree evidence through the owning parent run/, `${mode.name}: retain actionable recovery guidance without exposing host paths`);
				assert.equal(releaseAttempts.length, 0, `${mode.name}: unproven fence must not attempt release`);
				assert.equal(publications.length, 0, `${mode.name}: suppress terminal intercom publication`);
				assert.equal(updates.some((update) => update.details?.results?.some((child: any) => child.detached !== true && child.finalOutput === "terminal output")), false, `${mode.name}: suppress detached terminal callback projection`);
				assert.equal(updates.some((update) => update.details?.results?.some((child: any) => child.teardownUnproven === true)), true, `${mode.name}: project actionable teardownUnproven state`);
				assert.equal(fs.existsSync(owner.scope.endpointRoot), true, `${mode.name}: retain endpoint root for recovery`);
			} finally {
				await owner.close();
				removeNestedRoutesForRun(nestedRunId);
				fs.rmSync(endpointRoot, { recursive: true, force: true });
			}
		}
	});

	it("publishes exactly one terminal callback after a proven endpoint fence", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const modes = [
			{ name: "top-level parallel", params: { tasks: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] } },
			{ name: "parallel chain", params: { chain: [{ parallel: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }] }], clarify: false } },
			{ name: "sequential chain", params: { chain: [{ agent: "fixture.pkg.work", task: "Modify files and commit after handoff" }], clarify: false } },
		] as const;
		for (const mode of modes) {
			const repo = makeLifecycleRepo(`fence-success-${mode.name.replace(/\\W+/gu, "-")}`);
			const endpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fence-success-endpoint-"));
			const owner = createScopedGitEndpoint({ runtimeRoot: endpointRoot, worktree: repo, cwd: repo, rights: "writer" });
			const bus = createEventBus();
			let detachSent = false;
			let terminalUpdates = 0;
			mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "endpoint fence" })] }, { delay: 300, jsonl: [events.assistantMessage("terminal output")] }] });
			try {
				const executor = makeExecutor([makeAgent("fixture.pkg.work", { tools: ["read", "edit", "bash", "contact_supervisor"], systemPrompt: "Intercom orchestration channel: test" })], {
					events: bus,
					teardownHooks: {
						waitForNestedDescendantsToStop: async () => ({ observed: true, stopped: true }),
					},
				});
				const result = await executor.execute(`fence-success-${mode.name}`, { ...mode.params, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer", sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, (update: any) => {
					if (update.details?.results?.some((child: any) => child.detached !== true && child.finalOutput === "terminal output")) terminalUpdates++;
					if (detachSent || !update.details?.progress?.some((entry: any) => entry.currentTool === "contact_supervisor")) return;
					detachSent = true;
					bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: `fence-success-${mode.name}` });
				}, makeMinimalCtx(repo));
				const deadline = Date.now() + 4_000;
				while (terminalUpdates === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(detachSent, true, `${mode.name}: production detach must start the terminal path`);
				assert.equal(fs.existsSync(owner.scope.endpointRoot), true, `${mode.name}: endpoint remains live through publication`);
				assert.equal(terminalUpdates, 1, `${mode.name}: terminal callback must publish exactly once after endpoint cleanup`);
				assert.equal(result.details.results[0]?.detached, true, `${mode.name}: immediate result retains detached acknowledgement`);
				assert.equal(fs.existsSync(owner.scope.endpointRoot), true, `${mode.name}: endpoint remains live until publication completes`);
				assert.equal(/cleanup failed after export|bundle export failed/i.test(result.content[0]?.text ?? ""), false, `${mode.name}: successful endpoint cleanup must not add diagnostics`);
			} finally {
				await owner.close();
				fs.rmSync(endpointRoot, { recursive: true, force: true });
			}
		}
	});

	it("completed isolated sibling bundle is retained when another sibling rejects", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-sibling-rejection-repo");
		mockPi.onCall({ output: "completed isolated sibling", commands: ["printf 'completed sibling\\n' > completed.txt && git add completed.txt && git commit -m 'completed sibling'"] });
		mockPi.onCall({ output: "rejected isolated sibling", commands: ["printf 'rejected sibling\\n' > rejected.txt"] });
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		let rejectionArtifactBlocked = false;
		const result = await executor.execute("isolated-sibling-rejection", { tasks: [{ agent: "worker", task: "Complete sibling" }, { agent: "worker", task: "Reject sibling" }], sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, (update: any) => {
			const outputPath = update.details?.results?.find((candidate: any) => candidate?.artifactPaths?.outputPath?.includes("_1_output.md"))?.artifactPaths?.outputPath;
			if (rejectionArtifactBlocked || typeof outputPath !== "string") return;
			rejectionArtifactBlocked = true;
			fs.rmSync(outputPath, { force: true });
			fs.mkdirSync(outputPath, { recursive: true });
		}, makeMinimalCtx(repo));
		const children = result.details.results as any[];
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0]?.text ?? "", /Parallel execution failed unexpectedly/);
		const completed = children.find((child) => child.task === "Complete sibling");
		const rejected = children.find((child) => child.task === "Reject sibling");
		assert.ok(completed?.gitBundle?.path && fs.existsSync(completed.gitBundle.path), "completed sibling bundle must survive callback rejection");
		assert.equal(completed?.gitBundle?.terminationState, "success");
		assert.equal(rejected?.exitCode, 1);
		assert.match(rejected?.error ?? "", /Parallel execution failed unexpectedly/);
		const persisted = [...executor.state.foregroundRuns.values()].at(-1);
		assert.ok(persisted?.children.find((child: any) => child.index === 0)?.gitBundle?.path, "completed sibling bundle must persist in status projection");
		assert.match(persisted?.children.find((child: any) => child.index === 1)?.error ?? "", /Parallel execution failed unexpectedly/);
	});

	it("isolated stop-fence refusal preserves the recovery worktree and terminal error", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = path.join(tempDir, "isolated-fence-refusal-repo");
		fs.mkdirSync(repo, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Fence Parent"], ["config", "user.email", "fence@example.invalid"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const runId = `isolated-fence-refusal-${Date.now().toString(36)}`;
		const route = createNestedRoute(runId);
		const envKeys = [SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_RUN_ID_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV, SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, SUBAGENT_PARENT_CHILD_INDEX_ENV, SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_PATH_ENV];
		const previousEnv = new Map<string, string | undefined>();
		for (const key of envKeys) previousEnv.set(key, process.env[key]);
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = runId;
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = runId;
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId, stepIndex: 0 }]);
		let runtimePrefix = "";
		try {
			mockPi.onCall({ delay: 1500, output: "fence refusal terminal", commands: ["printf 'fence\\n' > fence.txt && git add fence.txt && git commit -m 'fence refusal'"] });
			const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })], { nestedFenceTimeoutMs: 25 });
			let seeded = false;
			const result = await executor.execute(runId, { agent: "worker", task: "Commit the isolated fence refusal change", sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, (update: any) => {
				const inputPath = update.details?.results?.[0]?.artifactPaths?.inputPath;
				const childRunId = typeof inputPath === "string" ? path.basename(inputPath).split("_")[0] : undefined;
				if (seeded || !childRunId) return;
				seeded = true;
				runtimePrefix = `pi-isolated-git-${childRunId}-`;
				writeNestedEvent(route, {
					type: "subagent.nested.started",
					ts: Date.now(),
					parentRunId: childRunId,
					parentStepIndex: 0,
					child: { id: "live-descendant", parentRunId: childRunId, parentStepIndex: 0, depth: 1, path: [{ runId: childRunId, stepIndex: 0 }], state: "running", mode: "single", agent: "nested" },
				});
			}, makeMinimalCtx(repo));
			assert.equal(seeded, true, "production progress must expose the run before the child closes");
			const child = result.details.results[0];
			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(child?.error ?? "", /export fence timed out|recover isolated worktree/i);
			assert.equal(child?.gitBundle, undefined, "fence refusal must not claim an exported bundle");
			const preserved = fs.readdirSync(os.tmpdir()).filter((entry) => runtimePrefix !== "" && entry.startsWith(runtimePrefix));
			assert.ok(preserved.length > 0, "fence refusal must preserve the isolated runtime for recovery");
			const runtimeRoot = path.join(os.tmpdir(), preserved[0]!);
			// Fence refusal retains the runtime but never creates detached authority artifacts.
			assert.equal(fs.existsSync(path.join(runtimeRoot, "authority")), false);
			const recoveryWorktree = path.join(runtimeRoot, "worktrees", "0");
			const recoveryProbe = spawnSync("git", ["-C", recoveryWorktree, "status", "--porcelain=v1"], { encoding: "utf8" });
			assert.equal(recoveryProbe.status, 0, recoveryProbe.stderr);
			assert.equal(fs.existsSync(path.join(recoveryWorktree, "fence.txt")), true, "preserved worktree must remain safely recoverable");
		} finally {
			for (const entry of fs.readdirSync(os.tmpdir()).filter((candidate) => runtimePrefix !== "" && candidate.startsWith(runtimePrefix))) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("timeout bundle/recovery projection preserves timeout state and recovery metadata", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-timeout-projection-repo");
		mockPi.onCall({ output: "timed out while committing", stderr: "operation timed out", exitCode: 1, commands: ["printf 'timeout recovery\\n' > timeout.txt"] });
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		const result = await executor.execute("isolated-timeout-projection", { agent: "worker", task: "Commit the timed-out isolated change", sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] } }, new AbortController().signal, undefined, makeMinimalCtx(repo));
		const child = result.details.results[0] as any;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(child?.error ?? "", /timed out/i);
		assert.equal(child?.gitBundle?.terminationState, "timeout");
		assert.ok(child?.gitBundle?.path && fs.existsSync(child.gitBundle.path));
		assert.ok(child?.gitBundle?.recovery, "timeout bundle should retain recovery metadata for dirty state");
	});

	it("cancellation projection exports cancelled isolated result and recovery", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-cancellation-projection-repo");
		const runtimePrefixBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-")));
		mockPi.onCall({ delay: 2000, output: "cancelled after child work", commands: ["printf 'cancelled recovery\\n' > cancelled.txt"] });
		const controller = new AbortController();
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		const pending = executor.execute("isolated-cancellation-projection", { agent: "worker", task: "Commit the cancelled isolated change", sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] } }, controller.signal, undefined, makeMinimalCtx(repo));
		const startedDeadline = Date.now() + 5_000;
		while (mockPi.callCount() < 1 && Date.now() < startedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mockPi.callCount(), 1, "cancellation begins only after the child has created its dirty worktree state");
		controller.abort();
		const result = await pending;
		const child = result.details.results[0] as any;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.equal(child?.gitBundle?.terminationState, "cancelled");
		assert.ok(child?.gitBundle?.path && fs.existsSync(child.gitBundle.path));
		assert.ok(child?.gitBundle?.recovery, "cancellation must retain a recovery id for dirty state");
		assert.match(child?.gitBundle?.portableMetadata ?? "", /"terminationState":"cancelled"/);
		const persisted = [...executor.state.foregroundRuns.values()].at(-1);
		assert.equal(persisted?.children[0]?.status, "cancelled");
		assert.equal(persisted?.children[0]?.gitBundle?.recovery, child?.gitBundle?.recovery);
		assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-") && !runtimePrefixBefore.has(entry)), [], "cancelled terminal export must clean the runtime");
	});

	it("interrupted endpoint cleanup preserves dirty foreground recovery", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = makeLifecycleRepo("isolated-interrupted-acceptance-repo");
		const runId = "isolated-interrupted-acceptance";
		const endpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interrupted-acceptance-endpoint-"));
		const owner = createScopedGitEndpoint({ runtimeRoot: endpointRoot, worktree: repo, cwd: repo, rights: "writer" });
		const interrupt = new AbortController();
		try {
			mockPi.onCall({ output: acceptanceReport(), commands: [] });
			mockPi.onCall({ delay: 2000, output: acceptanceReport(), commands: [] });
			const dirtyFinalizationPath = path.join(repo, "dirty-finalization.txt");
			fs.writeFileSync(dirtyFinalizationPath, "recoverable dirty state\\n");
			const pending = runSync!(repo, [makeAgent("worker", { tools: ["read", "bash"] })], "worker", "Commit the isolated acceptance change", {
				runId,
				isolatedGitEndpoint: owner.descriptor,
				isolatedGitRights: "writer",
				isolatedGitBundleDir: path.join(tempDir, "interrupted-acceptance-artifacts"),
				isolatedGitCommitRequired: true,
				sandbox: { provider: "bubblewrap", gitMode: "isolated", bashWrite: true, extraWritableMounts: [mockPi.dir] },
				acceptance: { criteria: ["Commit the isolated acceptance change"], selfReview: true, maxFinalizationTurns: 1 },
				interruptSignal: interrupt.signal,
			});
			interrupt.abort();
			const result = await pending;
			assert.equal(result.interrupted, true, JSON.stringify(result));
			assert.equal(fs.existsSync(dirtyFinalizationPath), true, "dirty endpoint worktree remains recoverable");
		} finally {
			await owner.close();
			assert.equal(fs.existsSync(endpointRoot), false, "interrupted endpoint cleanup must remove the owner root");
		}
	});

	it("defaults an unconfigured writer to read-only Git metadata through the executor", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repo = path.join(tempDir, "default-read-only-repo");
		fs.mkdirSync(repo, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Executor Parent"], ["config", "user.email", "executor@example.invalid"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		mockPi.onCall({ commands: ["git config --local sandbox.mutation blocked"] });
		const executor = makeExecutor([makeAgent("worker", { tools: ["read", "bash"] })]);
		const result = await executor.execute(
			"default-read-only-git",
			{ agent: "worker", task: "Attempt a Git metadata change", sandbox: { extraWritableMounts: [mockPi.dir] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(repo),
		);
		assert.equal(result.isError, true);
		assert.equal(spawnSync("git", ["-C", repo, "config", "--local", "--get", "sandbox.mutation"], { encoding: "utf8" }).status, 1);
	});

	it("fails closed when isolated Git is configured without a runtime-managed worktree handle", async () => {
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Need isolated Git", {
			sandbox: { provider: "bubblewrap", gitMode: "isolated" },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /runtime-managed isolated worktree handle/);
		assert.equal(mockPi.callCount(), 0);
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

	it("auto-saves file-only mode without an explicit output path before spawning", async () => {
		mockPi.onCall({ output: "implicit saved output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 0);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.savedOutputPath ?? "", /\/tmp\//);
		assert.equal(fs.readFileSync(result.savedOutputPath!, "utf-8").includes("implicit saved output"), true);
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

	it("keeps omitted inline output in memory without a repo-local report", async () => {
		mockPi.onCall({ output: "inline review output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "inline-no-save",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "inline review output");
		assert.equal(result.savedOutputPath, undefined);
		assert.equal(fs.existsSync(path.join(tempDir, "tmp")), false);
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

	it("executor run override tightens an inherited nested max depth", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const executor = makeExecutor([makeAgent("echo", { canBeChangedByAgent: ["maxSubagentDepth", "sandbox.provider"] })]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";

		try {
			const response = await executor.execute(
				"nested-depth-override",
				{ agent: "echo", task: "Task", maxSubagentDepth: 2 },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const result = response.details.results[0]!;
			assert.equal(response.isError, undefined);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "2",
				PI_SUBAGENT_MAX_DEPTH: "2",
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

	it("detached nested route stays running until terminal callback and then publishes terminal truth", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousEnv = new Map<string, string | undefined>();
		const envKeys = [SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_RUN_ID_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV, SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, SUBAGENT_PARENT_CHILD_INDEX_ENV, SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_PATH_ENV];
		const modes: Array<{ label: string; params: Record<string, unknown> }> = [
			{ label: "foreground single", params: { agent: "bridge", task: "Task" } },
			{ label: "top-level parallel", params: { tasks: [{ agent: "bridge", task: "Task" }] } },
			{ label: "sequential chain", params: { chain: [{ agent: "bridge", task: "Task" }], clarify: false } },
			{ label: "parallel chain", params: { chain: [{ parallel: [{ agent: "bridge", task: "Task" }] }], clarify: false } },
		];
		try {
			for (const key of envKeys) previousEnv.set(key, process.env[key]);
			for (const { label, params } of modes) {
				const route = createNestedRoute(`detached-route-${label.replaceAll(/[^a-z]+/gi, "-")}`);
				process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
				process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
				process.env[SUBAGENT_PARENT_RUN_ID_ENV] = route.rootRunId;
				process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
				process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
				process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
				process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
				process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: route.rootRunId, stepIndex: 0 }]);
				mockPi.onCall({
					steps: [
						{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "handoff" })] },
						{ delay: 1000, jsonl: [events.assistantMessage(`${label} terminal output`)] },
					],
				});
				const bus = createEventBus();
				const executor = makeExecutor([makeAgent("bridge", { tools: ["contact_supervisor"], systemPrompt: "Intercom orchestration channel: test" })], { events: bus });
				let detached = false;
				const run = executor.execute(`detached-route-${label}`, params, new AbortController().signal, (update: any) => {
					if (detached || !update.details?.progress?.some((entry: any) => entry.currentTool === "contact_supervisor")) return;
					detached = true;
					bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: `route-${label}` });
				}, makeMinimalCtx(tempDir));
				const immediate = await run;
				assert.equal(detached, true, `${label} should acknowledge detach`);
				const immediateState = projectNestedEvents(route).children.find((child) => child.parentRunId === route.rootRunId)?.state;
				assert.ok(immediateState === "running" || immediateState === "paused", `${label} detached acknowledgement must remain non-terminal, got ${immediateState}`);
				assert.equal(immediateState === "complete", false, `${label} stop fence must not observe terminal while child is live`);
				const deadline = Date.now() + 5_000;
				let terminalState: string | undefined;
				while (Date.now() < deadline) {
					terminalState = projectNestedEvents(route).children.find((child) => child.parentRunId === route.rootRunId)?.state;
					if (terminalState === "complete" || terminalState === "failed" || terminalState === "paused") break;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				assert.equal(terminalState, "complete", `${label} should publish terminal callback truth`);
				const terminalChild = projectNestedEvents(route).children.find((child) => child.parentRunId === route.rootRunId);
				assert.equal(terminalChild?.path?.[0]?.runId, route.rootRunId, `${label} terminal event must retain route identity`);
				assert.match(terminalChild?.summary ?? "", new RegExp(`${label} terminal output`));
				assert.match(JSON.stringify(immediate.details), /detached/i);
				fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			}
		} finally {
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
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
			let terminalResult: any;
			let resolveTerminal!: (result: any) => void;
			const terminal = new Promise<any>((resolve) => { resolveTerminal = resolve; });
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onDetachedTerminal: (result) => { terminalResult = result; resolveTerminal(result); },
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
			terminalResult = await terminal;
			assert.equal(terminalResult.exitCode, 0);
			assert.equal(terminalResult.detached, undefined);
			assert.match(terminalResult.finalOutput ?? "", /received pong/);
		});
	}

	it("keeps the detached foreground process-group guard armed until a leaking grandchild is gone", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, async () => {
		const eventBus = createEventBus();
		const pidFile = path.join(tempDir, `detached-grandchild-${Date.now()}-${process.pid}.pid`);
		let detachEmitted = false;
		let resolveTerminal!: (result: any) => void;
		const terminal = new Promise<any>((resolve) => { resolveTerminal = resolve; });
		mockPi.onCall({
			commands: [`sleep 30 & echo $! > ${JSON.stringify(pidFile)}`],
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 100, jsonl: [events.assistantMessage("grandchild guard terminal")] },
			],
		});
		try {
			const immediate = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
				runId: "detached-grandchild-guard",
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onDetachedTerminal: (result) => resolveTerminal(result),
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					if (!progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detached-grandchild-guard" });
				},
			});
			assert.equal(immediate.detached, true);
			assert.equal(immediate.finalOutput, "Detached for intercom coordination.");
			const grandchildDeadline = Date.now() + 2_000;
			while (!fs.existsSync(pidFile) && Date.now() < grandchildDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
			const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
			assert.ok(grandchildPid > 0, "detached child must create a stdio-retaining grandchild");
			const terminalResult = await terminal;
			assert.equal(terminalResult.detached, undefined);
			assert.match(terminalResult.finalOutput ?? "", /grandchild guard terminal/);
			const deadDeadline = Date.now() + 2_000;
			while (Date.now() < deadDeadline) {
				const state = spawnSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], { encoding: "utf8" }).stdout.trim();
				if (!state || state.startsWith("Z")) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const remainingState = spawnSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], { encoding: "utf8" }).stdout.trim();
			assert.ok(!remainingState || remainingState.startsWith("Z"), `grandchild ${grandchildPid} survived detached process-group cleanup: ${remainingState}`);
		} finally {
			try {
				const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
				if (grandchildPid > 0) process.kill(grandchildPid, "SIGKILL");
			} catch {}
			fs.rmSync(pidFile, { force: true });
		}
	});

	it("projects a detached child failure through the terminal callback", async () => {
		const eventBus = createEventBus();
		let accepted = false;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			accepted = (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 50, jsonl: [events.assistantMessage("failed after handoff")] },
			],
			exitCode: 1,
			stderr: "child failed after handoff",
		});
		let detachEmitted = false;
		let terminalResult: any;
		let resolveTerminal!: (result: any) => void;
		const terminal = new Promise<any>((resolve) => { resolveTerminal = resolve; });
		const detached = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "detached-failure",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onDetachedTerminal: (result) => { terminalResult = result; resolveTerminal(result); },
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detached-failure" });
			},
		});

		assert.equal(detached.detached, true);
		assert.equal(accepted, true);
		terminalResult = await terminal;
		assert.equal(terminalResult.detached, undefined);
		assert.equal(terminalResult.exitCode, 1);
		assert.match(terminalResult.error ?? "", /child failed after handoff/);
		assert.equal(terminalResult.progress?.status, "failed");
	});

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
