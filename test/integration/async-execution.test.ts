/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string };
}

interface SandboxDiagnosticsPayload {
	provider?: string;
	profile?: string;
	network?: string;
	auth?: string;
	fallbackMode?: string;
	fallbackOccurred?: boolean;
	diagnostics?: Array<{ level?: string; message?: string }>;
}

interface AsyncResultPayload {
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	summary?: string;
	worktreeExecutionError?: string;
	results: Array<{ output?: string; success?: boolean; error?: string; model?: string; attemptedModels?: string[]; modelAttempts?: Array<{ success?: boolean; error?: string }>; structuredOutput?: unknown; intercomTarget?: string; acceptance?: { status?: string; childReport?: unknown }; sandbox?: SandboxDiagnosticsPayload }>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
	workflowGraph?: { nodes?: Array<{ kind?: string; label?: string; phase?: string; status?: string; error?: string; outputName?: string; structured?: boolean; children?: Array<{ label?: string; outputName?: string; itemKey?: string; status?: string; error?: string }> }> };
}

interface AsyncStatusPayload {
	sessionId?: string;
	activityState?: string;
	error?: string;
	worktreeExecutionError?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	totalTokens?: { total: number };
	parallelGroups?: Array<{ start: number; count: number; stepIndex: number }>;
	steps?: Array<{
		label?: string;
		phase?: string;
		outputName?: string;
		structured?: boolean;
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		acceptance?: { status?: string };
		sandbox?: SandboxDiagnosticsPayload;
	}>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(asyncMod && utils && typesMod);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const readStatus = utils?.readStatus;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
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

async function waitForAsyncResultFile(id: string, timeoutMs = 15_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

function createWatcherState(currentSessionId: string | null, baseCwd = process.cwd()): SubagentState {
	return {
		baseCwd,
		currentSessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
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

function installFakeBwrap(rootDir: string): { recordDir: string; restore: () => void } {
	const binDir = path.join(rootDir, "fake-bwrap-bin");
	const recordDir = path.join(rootDir, "fake-bwrap-records");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(recordDir, { recursive: true });
	const scriptPath = path.join(binDir, "fake-bwrap.mjs");
	fs.writeFileSync(scriptPath, `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const recordDir = process.env.FAKE_BWRAP_RECORD_DIR;
if (!recordDir) process.exit(97);
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(path.join(recordDir, \`call-\${Date.now()}-\${process.pid}.json\`), JSON.stringify({ args, cwd: process.cwd() }), "utf-8");
const separator = args.indexOf("--");
if (separator === -1 || !args[separator + 1]) process.exit(98);
const child = spawnSync(args[separator + 1], args.slice(separator + 2), { stdio: "inherit", env: process.env, cwd: process.cwd() });
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

function readLastFakeBwrapArgs(recordDir: string): string[] {
	const callFile = fs.readdirSync(recordDir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded fake bwrap call");
	const payload = JSON.parse(fs.readFileSync(path.join(recordDir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded bwrap args");
	return payload.args;
}

function readAllFakeBwrapArgs(recordDir: string): string[][] {
	const callFiles = fs.readdirSync(recordDir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	return callFiles.map((callFile) => {
		const payload = JSON.parse(fs.readFileSync(path.join(recordDir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded bwrap args");
		return payload.args;
	});
}

function assertBind(args: string[], source: string): void {
	assert.deepEqual(args.slice(args.indexOf(source) - 1, args.indexOf(source) + 2), ["--bind", source, source]);
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
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
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const commonParams = {
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /end your turn now/);
		await waitForAsyncResultFile(singleId, 10_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /Pi will deliver the completion/);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do chained work" }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("sandboxed async single preserves status inspection and mounts child paths", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap(tempDir);
		try {
			mockPi.onCall({ output: "sandboxed async done" });
			const artifactConfig = {
				enabled: true,
				includeInput: true,
				includeOutput: true,
				includeJsonl: true,
				includeMetadata: true,
				cleanupDays: 7,
			};
			const id = `async-sandbox-single-${Date.now().toString(36)}`;
			const sessionRoot = path.join(tempDir, "subagent-sessions");
			const outputPath = path.join(tempDir, "outputs", "async-sandbox.md");
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do sandboxed async work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-sandbox" },
				artifactConfig,
				artifactsDir: path.join(tempDir, "artifacts"),
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
				output: outputPath,
				sandbox: { provider: "bubblewrap", profile: "host-toolchain", network: "host" },
			});
			assert.equal(result.isError, undefined);
			assert.equal(result.details.asyncId, id);
			const statusDeadline = Date.now() + 10_000;
			let status = readStatus(path.join(ASYNC_DIR, id)) as (AsyncStatusPayload & { runId?: string }) | null;
			while ((!status?.steps?.[0]?.sandbox) && Date.now() < statusDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = readStatus(path.join(ASYNC_DIR, id)) as (AsyncStatusPayload & { runId?: string }) | null;
			}
			assert.equal(status?.runId, id);
			assert.ok(status?.state === "running" || status?.state === "complete" || status?.state === "failed");
			assert.equal(status?.steps?.[0]?.sandbox?.provider, "bubblewrap");
			assert.equal(status?.steps?.[0]?.sandbox?.profile, "host-toolchain");
			assert.equal(status?.steps?.[0]?.sandbox?.network, "host");
			assert.equal(status?.steps?.[0]?.sandbox?.auth, "pi-json");
			assert.equal(status?.steps?.[0]?.sandbox?.fallbackMode, "fail");
			assert.equal(status?.steps?.[0]?.sandbox?.fallbackOccurred, false);
			assert.ok(Array.isArray(status?.steps?.[0]?.sandbox?.mounts));

			const bwrapArgs = readLastFakeBwrapArgs(fakeBwrap.recordDir);
			const asyncSessionDir = path.join(sessionRoot, `async-${id}`);
			assert.deepEqual(bwrapArgs.slice(bwrapArgs.indexOf(asyncSessionDir) - 1, bwrapArgs.indexOf(asyncSessionDir) + 2), ["--bind", asyncSessionDir, asyncSessionDir]);
			assert.deepEqual(bwrapArgs.slice(bwrapArgs.indexOf(path.dirname(outputPath)) - 1, bwrapArgs.indexOf(path.dirname(outputPath)) + 2), ["--bind", path.dirname(outputPath), path.dirname(outputPath)]);
			assert.ok(bwrapArgs.includes(path.join(tempDir, "artifacts")), "expected artifacts dir mount");
			assert.ok(!bwrapArgs.includes(sessionRoot), "should not mount broad session root");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("sandboxed async parallel and chain children preserve detached status and mounted paths", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap(tempDir);
		try {
			const artifactConfig = { enabled: true, includeInput: true, includeOutput: true, includeJsonl: true, includeMetadata: true, cleanupDays: 7 };
			const sessionRoot = path.join(tempDir, "async-sessions");
			const artifactsDir = path.join(tempDir, "async-artifacts");

			mockPi.onCall({ output: "async parallel a" });
			mockPi.onCall({ output: "async parallel b" });
			const parallelId = `async-sandbox-parallel-${Date.now().toString(36)}`;
			const parallelResult = executeAsyncChain(parallelId, {
				chain: [{ parallel: [{ agent: "worker", task: "Do A", output: "parallel-a.md", progress: true }, { agent: "reviewer", task: "Do B" }] }],
				resultMode: "parallel",
				agents: [makeAgent("worker", { tools: ["read", "bash"] }), makeAgent("reviewer", { tools: ["read", "bash"] })],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel" },
				artifactConfig,
				artifactsDir,
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
				sandbox: { provider: "bubblewrap", profile: "host-toolchain", network: "host" },
			});
			assert.equal(parallelResult.isError, undefined);
			const parallelDeadline = Date.now() + 10_000;
			let parallelStatus = readStatus(path.join(ASYNC_DIR, parallelId));
			while ((!parallelStatus?.steps?.length) && Date.now() < parallelDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				parallelStatus = readStatus(path.join(ASYNC_DIR, parallelId));
			}
			assert.ok(parallelStatus?.state === "running" || parallelStatus?.state === "complete" || parallelStatus?.state === "failed");

			mockPi.onCall({ output: "async chain done" });
			const chainId = `async-sandbox-chain-${Date.now().toString(36)}`;
			const chainResult = executeAsyncChain(chainId, {
				chain: [{ agent: "worker", task: "Do chained work", progress: true }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-chain" },
				artifactConfig,
				artifactsDir,
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
				sandbox: { provider: "bubblewrap", profile: "host-toolchain", network: "host" },
			});
			assert.equal(chainResult.isError, undefined);
			const chainDeadline = Date.now() + 10_000;
			let chainStatus = readStatus(path.join(ASYNC_DIR, chainId));
			while ((!chainStatus?.steps?.length) && Date.now() < chainDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				chainStatus = readStatus(path.join(ASYNC_DIR, chainId));
			}
			assert.ok(chainStatus?.state === "running" || chainStatus?.state === "complete" || chainStatus?.state === "failed");

			const allBwrapArgs = readAllFakeBwrapArgs(fakeBwrap.recordDir);
			assert.ok(allBwrapArgs.length >= 3, "expected bwrap to wrap parallel and chain children");
			const parallelSessionPrefix = path.join(sessionRoot, `async-${parallelId}`);
			assert.ok(allBwrapArgs.some((args) => args.some((arg) => arg.startsWith(`${parallelSessionPrefix}${path.sep}`))), "parallel child session dir should be mounted");
			assert.ok(allBwrapArgs.some((args) => args.includes(path.join(sessionRoot, `async-${chainId}`))), "chain child session dir should be mounted");
			for (const args of allBwrapArgs) assertBind(args, artifactsDir);
		} finally {
			fakeBwrap.restore();
		}
	});

	it("runs async sandboxed read-only dynamic fanout", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap(tempDir);
		try {
			mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
			mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
			mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
			const id = `async-sandbox-dynamic-readonly-${Date.now().toString(36)}`;
			const sessionRoot = path.join(tempDir, "async-dynamic-sessions");
			const result = executeAsyncChain(id, {
				chain: [
					{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: {
							agent: "reader",
							task: "Read {target.path}",
							label: "Read {target.path}",
							outputSchema: { type: "object" },
						},
						collect: { as: "reviews" },
					},
				],
				agents: [makeAgent("producer", { tools: ["read"] }), makeAgent("reader", { tools: ["read"] })],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-readonly" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
				sandbox: { provider: "bubblewrap", profile: "host-toolchain", network: "host" },
			});
			assert.equal(result.isError, undefined);

			const dynamicDeadline = Date.now() + 10_000;
			let allBwrapArgs = readAllFakeBwrapArgs(fakeBwrap.recordDir);
			while (allBwrapArgs.length === 0 && Date.now() < dynamicDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				allBwrapArgs = readAllFakeBwrapArgs(fakeBwrap.recordDir);
			}
			assert.ok(allBwrapArgs.length >= 1, "expected producer and/or dynamic read-only children to run under bwrap");
			for (const args of allBwrapArgs) {
				assert.deepEqual(args.slice(args.indexOf(tempDir) - 1, args.indexOf(tempDir) + 2), ["--ro-bind", tempDir, tempDir]);
			}
		} finally {
			fakeBwrap.restore();
		}
	});

	it("rejects async sandboxed writable parallel and dynamic fanout without worktree isolation", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const artifactConfig = { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 };

		const parallelResult = executeAsyncChain(`async-sandbox-agent-bash-${Date.now().toString(36)}`, {
			chain: [{ parallel: [{ agent: "shell", task: "Shell write" }] }],
			agents: [makeAgent("shell", { tools: ["bash"], sandbox: { bashWrite: true } })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-agent-bash" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			sandbox: { provider: "bubblewrap" },
		});
		assert.equal(parallelResult.isError, true);
		assert.match(parallelResult.content[0]?.text ?? "", /require worktree: true/);

		const dynamicResult = executeAsyncChain(`async-sandbox-dynamic-writer-${Date.now().toString(36)}`, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "file", key: "/path", maxItems: 4 },
					parallel: { agent: "writer", task: "Edit {file.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("writer", { tools: ["write"] })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-writer" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			sandbox: { provider: "bubblewrap" },
		});
		assert.equal(dynamicResult.isError, true);
		assert.match(dynamicResult.content[0]?.text ?? "", /dynamic fanout does not support worktree: true/i);
	});

	it("top-level async parallel conversion preserves output, reads, and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});

		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"], progress: true }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.sessionId, "session-123");
			assert.equal(payload.results[0]?.acceptance?.status, "not-required");
			assert.equal(status.sessionId, "session-123");
			assert.equal(status.steps?.[0]?.acceptance?.status, "not-required");
		const outputPath = path.join(tempDir, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const args = readLastMockPiArgs(mockPi);
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(taskArg.includes("[Saved output:"), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("async single lets explicit acceptance own completion for report-only output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const report = [
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [
					{ id: "criterion-1", status: "satisfied", evidence: "file exists with exact content" },
					{ id: "criterion-2", status: "satisfied", evidence: "verification command passed" },
				],
				changedFiles: ["async-guard-acceptance.txt"],
				commandsRun: [{ command: "test file content", result: "passed", summary: "passed" }],
				residualRisks: [],
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: report });
		mockPi.onCall({ output: report });
		const id = `async-acceptance-guard-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Create async-guard-acceptance.txt with accepted criteria",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance-guard" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			sessionFile: path.join(tempDir, "async-acceptance-guard-session.jsonl"),
			acceptance: {
				criteria: ["Create async-guard-acceptance.txt with accepted criteria", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		assert.equal(result.success, true);
		assert.equal(result.results[0]?.error, undefined);
		assert.equal(result.results[0]?.output, "");
		assert.equal(result.results[0]?.acceptance?.status, "checked");
		assert.equal(result.results[0]?.acceptance?.finalization?.status, "completed");
		assert.equal(mockPi.callCount(), 2);
	});

	it("async single preserves provider-qualified model routing across acceptance finalization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const report = [
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "report created" }],
				residualRisks: [],
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: report });
		mockPi.onCall({ output: report });
		const id = `async-acceptance-openrouter-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Create a routed acceptance report",
			agentConfig: makeAgent("worker", { model: "openrouter/openai/gpt-4o" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance-openrouter" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			sessionFile: path.join(tempDir, "async-acceptance-openrouter-session.jsonl"),
			acceptance: { criteria: ["Create the report"], selfReview: true, maxFinalizationTurns: 1 },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		assert.equal(result.success, true);
		assert.equal(mockPi.callCount(), 2);
		for (const index of [0, 1]) {
			const args = readMockPiArgs(mockPi, index);
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "openrouter/openai/gpt-4o");
		}
	});

	it("async single preserves successful acceptance when finalization turn exits nonzero with valid output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const report = [
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [
					{ id: "criterion-1", status: "satisfied", evidence: "file exists with exact content" },
					{ id: "criterion-2", status: "satisfied", evidence: "verification command passed" },
				],
				changedFiles: ["async-guard-acceptance.txt"],
				commandsRun: [{ command: "test file content", result: "passed", summary: "passed" }],
				residualRisks: [],
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: report });
		mockPi.onCall({ output: report, exitCode: 1 });
		const id = `async-acceptance-nonzero-exit-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Create async-guard-acceptance.txt with accepted criteria",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance-nonzero" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			sessionFile: path.join(tempDir, "async-acceptance-nonzero-exit-session.jsonl"),
			acceptance: {
				criteria: ["Create async-guard-acceptance.txt with accepted criteria", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		assert.equal(result.success, true);
		assert.equal(result.results[0]?.error, undefined);
		assert.equal(result.results[0]?.acceptance?.status, "checked");
		assert.equal((result.results[0]?.acceptance as Record<string, unknown>)?.finalization?.status, "completed");
		assert.equal(mockPi.callCount(), 2);
	});

	it("async single still fails acceptance when finalization turn has an explicit provider error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const report = [
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [
					{ id: "criterion-1", status: "satisfied", evidence: "file exists with exact content" },
					{ id: "criterion-2", status: "satisfied", evidence: "verification command passed" },
				],
				changedFiles: ["async-guard-acceptance.txt"],
				commandsRun: [{ command: "test file content", result: "passed", summary: "passed" }],
				residualRisks: [],
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: report });
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
		const id = `async-acceptance-explicit-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Create async-guard-acceptance.txt with accepted criteria",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance-explicit-error" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			sessionFile: path.join(tempDir, "async-acceptance-explicit-error-session.jsonl"),
			acceptance: {
				criteria: ["Create async-guard-acceptance.txt with accepted criteria", "Verify the file content"],
				maxFinalizationTurns: 3,
			},
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		assert.equal(result.success, false);
		assert.ok(result.results[0]?.error);
		assert.equal((result.results[0]?.acceptance as Record<string, unknown>)?.finalization?.status, "failed");
	});

	it("async single rejects explicit reviewed acceptance without a reviewer result", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			sessionFile: path.join(tempDir, "async-acceptance-session.jsonl"),
			acceptance: { criteria: ["Patch bug"], review: { agent: "reviewer", required: true } },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(result.success, false);
		assert.equal(result.results[0]?.acceptance?.status, "rejected");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.finalization?.status, "completed");
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "needs-parent-decision");
		assert.equal(status.steps?.[0]?.acceptance?.status, "rejected");
		assert.equal(status.steps?.[0]?.acceptance?.finalization?.status, "completed");
	});

	it("async executor run override tightens an inherited nested max depth", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { canBeChangedByAgent: ["maxSubagentDepth"] })] }),
		});
		const previousDepth = process.env.PI_SUBAGENT_DEPTH;
		const previousMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";

		try {
			const response = await executor.execute(
				"async-nested-depth-override",
				{ agent: "worker", task: "Report depth", maxSubagentDepth: 2, async: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const asyncId = response.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");
			const resultPath = await waitForAsyncResultFile(asyncId, 10_000);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.deepEqual(JSON.parse(result.results[0]?.output ?? "{}"), {
				PI_SUBAGENT_DEPTH: "2",
				PI_SUBAGENT_MAX_DEPTH: "2",
			});
		} finally {
			if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = previousDepth;
			if (previousMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = previousMaxDepth;
		}
	});

	it("top-level async chain suppresses progress for {task} review-only tasks", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-chain-read-only-progress",
			{
				chain: [{ agent: "reviewer" }],
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async chains reject malformed named output references before spawning", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ output: "structured prose", structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("async dynamic fanout recomputes later child intercom targets by final flat index", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INTERCOM_SESSION_NAME"] });
		const id = `async-dynamic-targets-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-targets" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-orchestrator-test",
			childIntercomTarget: (agent: string, index: number) => `subagent-${agent}-${id}-${index + 1}`,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const expectedConsumerTarget = `subagent-consumer-${id}-4`;
		assert.equal(payload.success, true);
		assert.equal(payload.results[3]?.intercomTarget, expectedConsumerTarget);
		assert.deepEqual(JSON.parse(payload.results[3]?.output ?? "{}"), { PI_SUBAGENT_INTERCOM_SESSION_NAME: expectedConsumerTarget });
	});

	it("async dynamic pre-spawn failures persist failed graph status and error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-prespawn-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload & { workflowGraph?: AsyncResultPayload["workflowGraph"]; error?: string };
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /exceeding maxItems 1/);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.workflowGraph?.nodes?.[1]?.status, "failed");
	});

	it("async dynamic collect schema failures persist failed graph status and details", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-collect-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: "object" } },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-collect-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(payload.results.at(-1)?.structuredOutput), "failed collect result should preserve ordered collection details");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /Collected output validation failed/);
	});

	it("top-level async worktree parallel resolves reads and output against the worktree cwd", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-");
		try {
			mockPi.onCall({ output: "Worktree report" });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"async-parallel-worktree-fields",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "report.md", reads: ["input.md"] }],
					async: true,
					clarify: false,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			const asyncId = result.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");
			const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			const asyncDir = result.details?.asyncDir;
			const deadline = Date.now() + 30_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					const statusPath = asyncDir ? path.join(asyncDir, "status.json") : undefined;
					const eventsPath = asyncDir ? path.join(asyncDir, "events.jsonl") : undefined;
					const status = statusPath && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf-8") : "(missing status.json)";
					const events = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "(missing events.jsonl)";
					assert.fail(`Timed out waiting for async result file: ${resultPath}\nStatus: ${status}\nEvents: ${events}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const worktreeCwd = path.join(os.tmpdir(), `pi-worktree-${asyncId}-s0-0`);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded mock pi call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const taskArg = args.at(-1) ?? "";
			assert.ok(taskArg.includes(`[Read from: ${path.join(worktreeCwd, "input.md")}]`));
			assert.equal(taskArg.includes("[Saved output:"), false);
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("captures failed async worktree child changes before cleanup", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-failure-");
		try {
			mockPi.onCall({
				output: "Async worker failed after writing",
				exitCode: 1,
				stderr: "async worker failed",
				writeFiles: [{ path: "async-captured.txt", content: "captured before async failure\n" }],
			});
			const id = `async-worktree-failure-${Date.now().toString(36)}`;
			const result = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "worker", task: "Write then fail" }], worktree: true }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: createEventBus() }, cwd: repoDir, currentSessionId: null },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});
			assert.ok(!result.isError);
			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.equal(payload.state, "failed");
			assert.match(payload.summary ?? "", /Full patches:/);
			const asyncDir = path.join(ASYNC_DIR, id);
			const patchPath = path.join(asyncDir, "worktree-diffs", "step-0", "task-0-worker.patch");
			assert.ok(fs.existsSync(patchPath), `expected captured patch at ${patchPath}`);
			assert.match(fs.readFileSync(patchPath, "utf-8"), /async-captured\.txt/);
			const apply = spawnSync("git", ["-C", repoDir, "apply", "--check", patchPath], { encoding: "utf-8" });
			assert.equal(apply.status, 0, `failed async child patch should apply cleanly: ${apply.stderr}`);
			const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
			assert.equal((worktreeList.stdout.match(/^worktree /gm) ?? []).length, 1, "temporary async worktree should be cleaned after capture");
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("serializes successful async children when outer lifecycle event aggregation rejects", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-lifecycle-");
		const watcherResultsDir = createTempDir("pi-subagent-async-watcher-");
		let preservedWorktree: string | undefined;
		const id = `async-worktree-lifecycle-${Date.now().toString(36)}`;
		const previousEventsPath = process.env.MOCK_PI_RUNNER_EVENTS_PATH;
		process.env.MOCK_PI_RUNNER_EVENTS_PATH = path.join(ASYNC_DIR, id, "events.jsonl");
		try {
			mockPi.onCall({
				output: "Async worker completed before lifecycle rejection",
				keepAliveAfterFinalMessageMs: 100,
				writeFiles: [{ path: "async-rejected.txt", content: "recover async edit\n" }],
				blockRunnerEventsAfterChild: true,
			});
			const result = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "worker", task: "Write then reject lifecycle event aggregation" }], worktree: true }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: createEventBus() }, cwd: repoDir, currentSessionId: null },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				controlIntercomTarget: "subagent-chat-main",
				maxSubagentDepth: 2,
			});
			assert.ok(!result.isError);
			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, false);
			assert.equal(payload.state, "failed");
			assert.equal(payload.exitCode, 1);
			assert.equal(payload.results.length, 1);
			assert.equal(payload.results[0]?.success, true, "successful child result must survive the outer lifecycle catch");
			assert.equal(payload.results[0]?.output, "Async worker completed before lifecycle rejection");
			assert.ok(payload.worktreeExecutionError);
			assert.match(payload.worktreeExecutionError, /^Parallel lifecycle failed unexpectedly:/);
			assert.match(payload.worktreeExecutionError, /Recoverable worktree path/i);
			assert.equal(status.state, "failed");
			assert.equal(status.worktreeExecutionError, payload.worktreeExecutionError);
			assert.match(status.error ?? "", /^Parallel lifecycle failed unexpectedly:/);
			assert.equal(status.steps?.[0]?.status, "failed");
			assert.match(payload.summary ?? "", /Async worker completed before lifecycle rejection/);
			assert.match(payload.summary ?? "", /Parallel lifecycle failed unexpectedly:/);

			const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
			preservedWorktree = [...worktreeList.stdout.matchAll(/^worktree (.+)$/gm)]
				.map((match) => match[1])
				.find((candidate) => candidate && path.resolve(candidate) !== path.resolve(repoDir));
			assert.ok(preservedWorktree, "outer lifecycle rejection must preserve the edited worktree");
			assert.equal(fs.readFileSync(path.join(preservedWorktree!, "async-rejected.txt"), "utf-8"), "recover async edit\n");

			const watcherEvents = createEventBus();
			const intercomEvents: unknown[] = [];
			const completionEvents: unknown[] = [];
			watcherEvents.on("subagent:result-intercom", (data) => {
				intercomEvents.push(data);
				const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => watcherEvents.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			});
			watcherEvents.on("subagent:async-complete", (data) => completionEvents.push(data));
			const watcherResultPath = path.join(watcherResultsDir, `${id}.json`);
			fs.copyFileSync(resultPath, watcherResultPath);
			const watcher = createResultWatcher({ events: watcherEvents }, createWatcherState(null, repoDir), watcherResultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				const deadline = Date.now() + 5_000;
				while (completionEvents.length === 0) {
					if (Date.now() > deadline) assert.fail("timed out waiting for watcher completion");
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			} finally {
				watcher.stopResultWatcher();
			}
			const intercomPayload = intercomEvents[0] as { status?: string; worktreeExecutionError?: string; message?: string; children?: Array<{ status?: string }> } | undefined;
			assert.equal(intercomPayload?.status, "failed");
			assert.notEqual(intercomPayload?.status, "complete");
			assert.equal(intercomPayload?.worktreeExecutionError, payload.worktreeExecutionError);
			assert.equal(intercomPayload?.children?.[0]?.status, "failed");
			assert.match(intercomPayload?.message ?? "", /Execution error:/);
			assert.match(intercomPayload?.message ?? "", /Recoverable worktree path/i);
			const completion = completionEvents[0] as { state?: string; results?: Array<{ status?: string }> } | undefined;
			assert.equal(completion?.state, "failed");
			assert.notEqual(completion?.state, "complete");
			assert.equal(completion?.results?.[0]?.status, "failed");
			assert.equal(fs.existsSync(watcherResultPath), false);
		} finally {
			if (preservedWorktree) {
				spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", preservedWorktree], { encoding: "utf-8" });
			}
			fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
			if (previousEventsPath === undefined) delete process.env.MOCK_PI_RUNNER_EVENTS_PATH;
			else process.env.MOCK_PI_RUNNER_EVENTS_PATH = previousEventsPath;
			removeTempDir(watcherResultsDir);
			removeTempDir(repoDir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background status omits unsupported max thinking before the child starts", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done", delay: 1_000 });
		const id = `async-unsupported-max-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "anthropic/claude-sonnet-4", thinking: "max" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4", reasoning: true }],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.state === "running") break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(status?.steps?.[0]?.model, "anthropic/claude-sonnet-4");
		assert.equal(status?.steps?.[0]?.thinking, undefined);
		await waitForAsyncResultFile(id);
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ jsonl: [events.assistantMessage("Recovered asynchronously", "anthropic/claude-sonnet-4:low")] });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs expose the runtime model in live status even without a configured model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "sleep 1" })] },
				{ delay: 300, jsonl: [events.assistantMessage("still working", "runtime/gpt-4o")] },
				{ delay: 1200, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "(no output)"), events.assistantMessage("done", "runtime/gpt-4o")] },
			],
		});
		const id = `async-live-runtime-model-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Show the runtime model while still running",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let liveStatus: AsyncStatusPayload | undefined;
		while (Date.now() < liveDeadline) {
			const statusPath = path.join(asyncDir, "status.json");
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.state === "running" && status.steps?.[0]?.model === "runtime/gpt-4o") {
					liveStatus = status;
					break;
				}
			}
			assert.equal(fs.existsSync(resultPath), false, "run finished before live runtime model reached status.json");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(liveStatus, "expected status.json to expose the runtime model before the run completed");
		assert.equal(liveStatus?.steps?.[0]?.currentTool, "bash");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
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
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background omitted output stays inline without a repo-local report", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline output" });
		const id = `async-inline-no-save-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /async inline output/);
		assert.equal(payload.results[0]?.output, "async inline output");
		assert.equal(fs.existsSync(path.join(tempDir, "tmp")), false);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(String(payload.results[0].error ?? ""), "");

	});

	it("background bash-enabled non-implementation agents succeed without forced mutation", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("Done asynchronously", "github-copilot/gpt-5-mini")] });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("uses an external JavaScript runtime when Pi is a standalone executable", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const standalonePiPath = path.join(tempDir, "pi");
		const standaloneMarkerPath = path.join(tempDir, "standalone-pi-invoked");
		fs.writeFileSync(
			standalonePiPath,
			`#!/bin/sh\nprintf invoked > "${standaloneMarkerPath}"\nexit 88\n`,
			"utf-8",
		);
		fs.chmodSync(standalonePiPath, 0o755);

		const originalExecPath = process.execPath;
		process.execPath = standalonePiPath;
		try {
			mockPi.onCall({ output: "standalone host async done" });
			const id = `async-standalone-host-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 2_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(fs.existsSync(standaloneMarkerPath), false, "standalone Pi executable must not host the Jiti runner");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("returns a tool error when the async runner runtime is unavailable", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "missing-node");
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /Node runtime for detached TypeScript execution could not be found/);
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs keep mutating-failure needs_attention without resumed activity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ delay: 5_000, jsonl: [events.assistantMessage("I am still here.")] },
			],
		});

		const id = `async-tool-failure-attention-sticks-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let sawNeedsAttention = false;

		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					sawNeedsAttention = true;
					break;
				}
			}
			if (fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed mutating-failure needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(sawNeedsAttention, "expected status.json to expose mutating-failure needs_attention before the idle timer tick");
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		assert.equal(fs.existsSync(resultPath), false, "expected run to still be running before resumed activity");
		const statusAfterIdleTimer = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(statusAfterIdleTimer.state, "running");
		assert.equal(statusAfterIdleTimer.activityState, "needs_attention");
		assert.equal(statusAfterIdleTimer.steps?.[0]?.activityState, "needs_attention");

		const resultDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > resultDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs latch mutating-failure attention after idle needs_attention overlap", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" })] },
				{ delay: 3_500 },
				{ jsonl: [events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ delay: 5_000, jsonl: [events.assistantMessage("I am still here.")] },
			],
		});

		const id = `async-tool-failure-idle-overlap-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 1_500,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const outputPath = path.join(asyncDir, "output-0.log");
		const failureCount = (): number => fs.existsSync(outputPath)
			? (fs.readFileSync(outputPath, "utf-8").match(/No exact match found/g) ?? []).length
			: 0;
		const deadline = Date.now() + 12_000;
		let sawIdleNeedsAttentionBeforeEscalation = false;

		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (failureCount() < 3 && status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					sawIdleNeedsAttentionBeforeEscalation = true;
					break;
				}
			}
			if (fs.existsSync(resultPath)) {
				assert.fail("run completed before idle needs_attention overlapped mutating-failure escalation");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(sawIdleNeedsAttentionBeforeEscalation, "expected idle needs_attention before the third mutating failure");

		while (Date.now() < deadline && failureCount() < 3) {
			if (fs.existsSync(resultPath)) {
				assert.fail("run completed before the third mutating failure was observed");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(failureCount(), 3, "expected the third mutating failure to reach the attention threshold");

		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(fs.existsSync(resultPath), false, "expected run to still be running before resumed activity");
		const statusAfterIdleTimer = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(statusAfterIdleTimer.state, "running");
		assert.equal(statusAfterIdleTimer.activityState, "needs_attention");
		assert.equal(statusAfterIdleTimer.steps?.[0]?.activityState, "needs_attention");

		const resultDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > resultDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs clear needs_attention after resumed activity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ delay: 500 },
				{ jsonl: [events.toolStart("read", { path: "src/a.ts" }), events.toolEnd("read"), events.toolResult("read", "export const a = 1;")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("Done")] },
			],
		});

		const id = `async-clear-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let sawNeedsAttention = false;
		let statusAfterRecovery: AsyncStatusPayload | undefined;

		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (!sawNeedsAttention && status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					sawNeedsAttention = true;
				}
				if (sawNeedsAttention && status.activityState !== "needs_attention" && status.steps?.[0]?.activityState !== "needs_attention" && status.state === "running" && !fs.existsSync(resultPath)) {
					statusAfterRecovery = status;
					break;
				}
			}
			if (fs.existsSync(resultPath)) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(sawNeedsAttention, "expected status.json to expose needs_attention before recovery");
		assert.ok(statusAfterRecovery, "expected status.json to clear needs_attention while the run is still running");
		assert.equal(statusAfterRecovery.activityState, undefined);
		assert.equal(statusAfterRecovery.steps?.[0]?.activityState, undefined);
		assert.equal(statusAfterRecovery.state, "running");

		const resultDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > resultDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("parallel async run clears top-level needs_attention when stale child resumes", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/a.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found", true)] },
				{ delay: 500 },
				{ jsonl: [events.toolStart("read", { path: "src/a.ts" }), events.toolEnd("read"), events.toolResult("read", "export const a = 1;")] },
				{ delay: 3_000, jsonl: [events.assistantMessage("Done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("read", { path: "src/b.ts" }), events.toolEnd("read"), events.toolResult("read", "export const b = 2;")] },
				{ delay: 4_000, jsonl: [events.assistantMessage("Done")] },
			],
		});

		const id = `async-parallel-clear-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "editor", task: "Edit" }, { agent: "reviewer", task: "Review" }] }],
			agents: [makeAgent("editor"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 15_000;
		let sawNeedsAttention = false;
		let statusAfterRecovery: AsyncStatusPayload | undefined;

		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (!sawNeedsAttention) {
					if (status.activityState === "needs_attention" && status.steps?.some((s) => s.activityState === "needs_attention")) {
						sawNeedsAttention = true;
					}
				} else {
					if (status.activityState !== "needs_attention" && !status.steps?.some((s) => s.activityState === "needs_attention") && status.state === "running" && !fs.existsSync(resultPath)) {
						statusAfterRecovery = status;
						break;
					}
				}
			}
			if (fs.existsSync(resultPath)) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(sawNeedsAttention, "expected at least one step to reach needs_attention");
		assert.ok(statusAfterRecovery, "expected top-level activityState to clear while the run is still running");
		assert.equal(statusAfterRecovery.activityState, undefined);
		assert.equal(statusAfterRecovery.state, "running");

		const resultDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > resultDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs do not emit idle needs_attention while a nested child is running", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 1_200, jsonl: [events.assistantMessage("Done after nested child")] },
			],
		});

		const id = `async-nested-active-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const route = createNestedRoute(id);
		const nestedStartedAt = Date.now();
		const nestedTimer = setTimeout(() => {
			writeNestedEvent(route, {
				type: "subagent.nested.started",
				ts: Date.now(),
				parentRunId: id,
				parentStepIndex: 0,
				child: {
					id: "nested-reviewer",
					parentRunId: id,
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: id, stepIndex: 0 }],
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
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Wait for nested reviewer",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
				nestedRoute: route,
				controlConfig: {
					enabled: true,
					needsAttentionAfterMs: 300,
					activeNoticeAfterTurns: 999_999,
					activeNoticeAfterMs: 999_999,
					activeNoticeAfterTokens: 999_999,
					failedToolAttemptsBeforeAttention: 999_999,
					notifyOn: ["active_long_running", "needs_attention"],
					notifyChannels: ["event", "async", "intercom"],
				},
			});

			const statusPath = path.join(asyncDir, "status.json");
			const eventsPath = path.join(asyncDir, "events.jsonl");
			const deadline = Date.now() + 12_000;
			let observedRunningWithoutIdle = false;

			while (Date.now() < deadline) {
				if (fs.existsSync(statusPath)) {
					const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
					if (status.state === "running" && !fs.existsSync(resultPath) && status.activityState !== "needs_attention" && status.steps?.[0]?.activityState !== "needs_attention") {
						observedRunningWithoutIdle = true;
					}
				}
				if (fs.existsSync(resultPath)) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			assert.ok(observedRunningWithoutIdle, "expected running async status without idle needs_attention while nested child was live");
			const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
			assert.doesNotMatch(eventText, /"type":"needs_attention"/);
		} finally {
			clearTimeout(nestedTimer);
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("background runs clear idle needs_attention after resumed activity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "src/a.ts" })] },
				{ delay: 2_500 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "export const a = 1;")] },
				{ delay: 2_500, jsonl: [events.assistantMessage("Done")] },
			],
		});

		const id = `async-idle-recovery-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Read and summarize",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 1_500,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 999_999,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 12_000;
		let sawNeedsAttention = false;
		let statusAfterRecovery: AsyncStatusPayload | undefined;

		while (Date.now() < deadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (!sawNeedsAttention && status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					sawNeedsAttention = true;
				}
				if (sawNeedsAttention && status.activityState !== "needs_attention" && status.steps?.[0]?.activityState !== "needs_attention" && status.state === "running" && !fs.existsSync(resultPath)) {
					statusAfterRecovery = status;
					break;
				}
			}
			if (fs.existsSync(resultPath)) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(sawNeedsAttention, "expected status.json to expose idle needs_attention before recovery");
		assert.ok(statusAfterRecovery, "expected status.json to clear idle needs_attention while the run is still running");
		assert.equal(statusAfterRecovery.activityState, undefined);
		assert.equal(statusAfterRecovery.steps?.[0]?.activityState, undefined);
		assert.equal(statusAfterRecovery.state, "running");

		const resultDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > resultDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("journals streaming updates without repeated accumulated snapshots", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repeatedSnapshot = "x".repeat(128 * 1024);
		const partialMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: repeatedSnapshot } }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "mock/test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		mockPi.onCall({
			jsonl: [
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 0,
						delta: "x",
						partial: partialMessage,
					},
					message: partialMessage,
				},
				{
					type: "tool_execution_update",
					toolCallId: "call-1",
					toolName: "bash",
					args: { command: repeatedSnapshot },
					partialResult: { content: [{ type: "text", text: repeatedSnapshot }], details: {} },
				},
				events.assistantMessage("Done"),
			],
		});

		const id = `async-compact-events-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Journal compact child events",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id);
		const journal = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const messageUpdate = journal.find((event) => event.type === "message_update") as {
			assistantMessageEvent?: Record<string, unknown>;
		} | undefined;
		assert.ok(messageUpdate?.assistantMessageEvent);
		assert.equal(messageUpdate.assistantMessageEvent.delta, "x");
		assert.equal("partial" in messageUpdate.assistantMessageEvent, false);
		assert.equal("message" in messageUpdate, false);

		const toolUpdate = journal.find((event) => event.type === "tool_execution_update");
		assert.equal(toolUpdate?.toolCallId, "call-1");
		assert.equal(toolUpdate?.toolName, "bash");
		assert.equal(toolUpdate && "args" in toolUpdate, false);
		assert.equal(toolUpdate && "partialResult" in toolUpdate, false);
		assert.ok(fs.statSync(path.join(asyncDir, "events.jsonl")).size < repeatedSnapshot.length);
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
