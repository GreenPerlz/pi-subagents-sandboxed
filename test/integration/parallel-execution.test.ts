/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
	events,
} from "../support/helpers.ts";
import { FOREGROUND_DIR } from "../../src/shared/types.ts";
import { foregroundStatusPath, writePersistedForegroundStatus } from "../../src/runs/foreground/foreground-status.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
		assert.deepEqual(results, [2, 4, 6, 8, 10]);
	});

	it("preserves order regardless of completion time", async () => {
		const items = [80, 10, 40]; // delays in ms
		const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
			await new Promise((r) => setTimeout(r, ms));
			return i;
		});
		assert.deepEqual(results, [0, 1, 2], "results should be in original order");
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
	});

	it("handles empty array", async () => {
		const results = await mapConcurrent([], 4, async (item: unknown) => item);
		assert.deepEqual(results, []);
	});

	it("propagates errors", async () => {
		await assert.rejects(
			() =>
				mapConcurrent([1, 2, 3], 2, async (item: number) => {
					if (item === 2) throw new Error("boom");
					return item;
				}),
			/boom/,
		);
	});

	it("stops assigning queued work after the first rejection while started callbacks settle", async () => {
		const started: number[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const task = async (item: number): Promise<number> => {
			started.push(item);
			if (item === 1) {
				await firstDone;
				throw new Error("first rejection");
			}
			if (item === 2) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return item;
			}
			return item;
		};
		const pending = mapConcurrent([1, 2, 3, 4], 2, task);
		await new Promise((resolve) => setTimeout(resolve, 5));
		releaseFirst!();
		await assert.rejects(pending, /first rejection/);
		assert.deepEqual(started, [1, 2], "queued callbacks must not start after rejection");
	});
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe("parallel agent execution", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
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

	function makeExecutor(agents = [makeAgent("echo")], artifactsDir = tempDir) {
		const baseExecutor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: artifactsDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
		return {
			...baseExecutor,
			execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: ((r: unknown) => void) | undefined, ctx: unknown) =>
				baseExecutor.execute(id, {
					...params,
					...(!params.sandbox && !agents.some((agent) => agent.sandbox) ? { sandbox: { provider: "none" } } : {}),
				}, signal, onUpdate as never, ctx as never),
		};
	}

	function readLastCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function initGitRepo(repoDir: string): void {
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init"], ["config", "user.email", "tests@example.com"], ["config", "user.name", "Parallel Tests"]]) {
			const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(result.status, 0, result.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
		for (const args of [["add", "-A"], ["commit", "-m", "initial"]]) {
			const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(result.status, 0, result.stderr);
		}
	}

	function cleanupGitWorktrees(repoDir: string): void {
		const listing = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
		for (const match of listing.stdout.matchAll(/^worktree (.+)$/gm)) {
			const worktreePath = match[1];
			if (!worktreePath || path.resolve(worktreePath) === path.resolve(repoDir)) continue;
			spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], { encoding: "utf-8" });
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
if (child.error) process.exit(99);
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

	function readFakeBwrapCalls(recordDir: string): string[][] {
		const callFiles = fs.readdirSync(recordDir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).sort();
		assert.ok(callFiles.length > 0, "expected recorded fake bwrap calls");
		return callFiles.map((callFile) => {
			const payload = JSON.parse(fs.readFileSync(path.join(recordDir, callFile), "utf-8")) as { args?: string[] };
			assert.ok(Array.isArray(payload.args), "expected recorded bwrap args");
			return payload.args;
		});
	}

	function readLastFakeBwrapArgs(recordDir: string): string[] {
		return readFakeBwrapCalls(recordDir).at(-1)!;
	}

	function assertMountMode(args: string[], source: string, mode: "ro" | "rw"): void {
		const expectedFlag = mode === "rw" ? "--bind" : "--ro-bind";
		assert.ok(
			args.some((arg, index) => arg === expectedFlag && args[index + 1] === source && args[index + 2] === source),
			`expected ${source} to be mounted ${mode}`,
		);
	}

	function assertBind(args: string[], source: string): void {
		assertMountMode(args, source, "rw");
	}

	function initGitRepo(repo: string): void {
		fs.mkdirSync(repo, { recursive: true });
		fs.writeFileSync(path.join(repo, "README.md"), "test repo\n", "utf-8");
		const run = (args: string[]) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
			assert.equal(result.status, 0, result.stderr || result.stdout);
		};
		run(["init"]);
		run(["config", "user.email", "test@example.com"]);
		run(["config", "user.name", "Test User"]);
		run(["add", "README.md"]);
		run(["commit", "-m", "init"]);
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("updates foregroundControl currentModel from runtime child result during live parallel run", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })] },
				{ delay: 100, jsonl: [events.assistantMessage("task output", "runtime/gpt-4o-mini")] },
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
			discoverAgents: () => ({ agents: [makeAgent("echo", { model: "configured/gpt-4o" })] }),
		});
		const currentControl = () => [...state.foregroundControls.values()][0];
		const liveModels: (string | undefined)[] = [];
		const executePromise = executor.execute(
			"parallel-runtime-model",
			{ tasks: [{ agent: "echo", task: "Task" }], sandbox: { provider: "none" } },
			new AbortController().signal,
			() => {
				liveModels.push(currentControl()?.currentModel);
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(currentControl()?.currentModel, "configured/gpt-4o", "foregroundControl should start with the configured fallback model");
		await executePromise;

		assert.ok(liveModels.includes("runtime/gpt-4o-mini"), "live updates should replace the configured fallback with the runtime model");
		assert.equal(liveModels.at(-1), "runtime/gpt-4o-mini");
	});

	it("replaces initial running persistence on isolated parallel setup failure", { skip: !createSubagentExecutor || process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status !== 0 ? "Linux Bubblewrap and public executor are required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "isolated-setup-failure-repo");
		initGitRepo(repoDir);
		const hookPath = path.join(tempDir, "failing-setup-hook.mjs");
		fs.writeFileSync(hookPath, [
			"import fs from 'node:fs';",
			"const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
			"fs.writeFileSync(input.worktreePath + '/setup-partial.txt', 'partial\\n');",
			"if (input.index === 0) process.exit(23);",
			"process.stdout.write(JSON.stringify({ syntheticPaths: [] }));",
		].join("\n"), "utf8");
		fs.chmodSync(hookPath, 0o755);
		const runId = "parallel-isolated-setup-persistence";
		writePersistedForegroundStatus(FOREGROUND_DIR, {
			runId,
			cwd: repoDir,
			mode: "parallel",
			state: "running",
			updatedAt: Date.now(),
			children: [{ agent: "isolated", index: 0, status: "running" }, { agent: "isolated", index: 1, status: "running" }],
		});
		const agents = [makeAgent("isolated", { tools: ["read", "bash"], sandbox: { provider: "bubblewrap", gitMode: "isolated" } })];
		const state = { baseCwd: repoDir, currentSessionId: "session-persistence", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null };
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { worktreeSetupHook: hookPath },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
		const ctx = makeMinimalCtx(repoDir);
		ctx.sessionManager.getSessionId = () => "session-persistence";
		ctx.sessionManager.getSessionFile = () => path.join(tempDir, "parent-session.jsonl");
		const result = await executor.execute(runId, {
			tasks: [{ agent: "isolated", task: "setup failure one" }, { agent: "isolated", task: "setup failure two" }],
			clarify: false,
			sandbox: { provider: "bubblewrap", gitMode: "isolated" },
		}, new AbortController().signal, undefined, ctx);
		assert.equal(result.isError, true, result.content[0]?.text);
		const persistedRunId = [...state.foregroundRuns.keys()][0] as string;
		assert.ok(persistedRunId, "terminal setup failure should be remembered under its resolved run id");
		const persisted = JSON.parse(fs.readFileSync(foregroundStatusPath(FOREGROUND_DIR, persistedRunId), "utf8"));
		assert.notEqual(persisted.state, "running", `${result.content[0]?.text ?? "no result text"} ${JSON.stringify(result.details)}`);
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.children.length, 2);
		assert.ok(persisted.children.every((child: { status: string }) => child.status === "failed"));
		assert.ok(persisted.children.some((child: { gitBundle?: { path?: string }; error?: string }) => child.gitBundle?.path || /recover isolated runtime|runtime retained at/i.test(child.error ?? "")), `failed setup should retain an actionable recovery projection: ${JSON.stringify(persisted.children)}`);
	});

	it("preserves top-level worktrees after a post-child artifact rejection", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const repoDir = path.join(tempDir, "rejected-parallel-repo");
		initGitRepo(repoDir);
		const artifactsDir = path.join(tempDir, "subagent-artifacts");
		const previousArtifactsEnv = process.env.MOCK_PI_ARTIFACTS_DIR;
		process.env.MOCK_PI_ARTIFACTS_DIR = artifactsDir;
		mockPi.onCall({
			output: "Parallel worker edited before artifact failure",
			writeFiles: [{ path: "parallel-rejected.txt", content: "recover parallel edit\n" }],
			blockArtifactOutput: true,
		});
		try {
			const executor = makeExecutor([makeAgent("echo")], artifactsDir);
			const ctx = makeMinimalCtx(repoDir);
			ctx.sessionManager.getSessionFile = () => path.join(tempDir, "session.jsonl");
			const result = await executor.execute(
				"parallel-artifact-rejection",
				{ tasks: [{ agent: "echo", task: "Write then fail artifact persistence" }], worktree: true },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const text = result.content[0]?.text ?? "";
			assert.equal(result.isError, true, text);
			assert.match(text, /failed unexpectedly/i);
			assert.match(text, /Full patches:/);
			assert.match(text, /Recoverable worktree path/i);
			const patchPath = path.join(artifactsDir, "worktree-diffs", "task-0-echo.patch");
			assert.ok(fs.existsSync(patchPath), `expected captured patch at ${patchPath}`);
			assert.match(fs.readFileSync(patchPath, "utf-8"), /parallel-rejected\.txt/);
			const listing = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
			const worktreePath = [...listing.stdout.matchAll(/^worktree (.+)$/gm)]
				.map((match) => match[1])
				.find((candidate) => candidate && path.resolve(candidate) !== path.resolve(repoDir));
			assert.ok(worktreePath, "post-child rejection must preserve the edited worktree");
			assert.equal(fs.readFileSync(path.join(worktreePath!, "parallel-rejected.txt"), "utf-8"), "recover parallel edit\n");
		} finally {
			cleanupGitWorktrees(repoDir);
			if (previousArtifactsEnv === undefined) delete process.env.MOCK_PI_ARTIFACTS_DIR;
			else process.env.MOCK_PI_ARTIFACTS_DIR = previousArtifactsEnv;
		}
	});

	it("keeps omitted top-level parallel output inline without a repo-local report", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel inline output" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-inline-no-save",
			{ tasks: [{ agent: "echo", task: "Review" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.[0]?.finalOutput, "Parallel inline output");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
		assert.equal(fs.existsSync(path.join(tempDir, "tmp")), false);
	});

	it("top-level parallel relative outputs keep the explicit file and report tmp history paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.ok(result.details?.results?.[0]?.savedOutputPath);
		assert.notEqual(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.match(result.details?.results?.[0]?.savedOutputPath ?? "", /\/tmp\//);
	});

	it("top-level parallel read-only agents keep the explicit output file and also save per-run history in tmp", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel review report" });
		const executor = makeExecutor([makeAgent("reviewer", { tools: ["read", "bash"] })]);

		const result = await executor.execute(
			"parallel-output-history",
			{ tasks: [{ agent: "reviewer", task: "Review", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel review report");
		assert.ok(result.details?.results?.[0]?.savedOutputPath);
		assert.notEqual(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.match(result.details?.results?.[0]?.savedOutputPath ?? "", /\/tmp\//);
		assert.match(fs.readFileSync(result.details?.results?.[0]?.savedOutputPath!, "utf-8"), /# Saved subagent output/);
	});

	it("top-level parallel file-only output aggregates concise file references", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel full report\nwith details" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-file-only.md", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-file-only.md");
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Output saved to:/);
		assert.match(text, /\/tmp\//);
		assert.doesNotMatch(text, /Parallel full report/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details?.results?.[0]?.finalOutput ?? "", /Parallel full report/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.equal(fs.readFileSync(result.details?.results?.[0]?.savedOutputPath!, "utf-8"), "Parallel full report\nwith details");
	});

	it("auto-saves top-level parallel file-only output without an explicit output path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel auto-saved output" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-missing-output",
			{ tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Output saved to:/);
		assert.match(result.details?.results?.[0]?.savedOutputPath ?? "", /\/tmp\//);
		assert.equal(mockPi.callCount(), 1);
	});

	it("rejects duplicate top-level parallel output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("treats string false as disabled output in top-level parallel runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-string-false-output",
			{
				tasks: [
					{ agent: "echo", task: "Review A", output: "false" },
					{ agent: "echo", task: "Review B", output: "false" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
	});

	it("top-level parallel reads are injected once with chain-style prefix", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect`));
		assert.doesNotMatch(taskArg, /## Acceptance Contract/);
	});

	it("top-level parallel progress emits the existing progress instruction style", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work", progress: true }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.ok((args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("top-level parallel sandbox preserves child output, session, and progress mounts without worktree", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Sandboxed parallel done" });
		const fakeBwrap = installFakeBwrap();
		try {
			const sessionDir = path.join(tempDir, "subagent-sessions");
			const executor = makeExecutor([makeAgent("echo", { tools: ["read", "bash"] })]);

			const result = await executor.execute(
				"parallel-bubblewrap",
				{
					tasks: [{ agent: "echo", task: "Track work", output: "parallel-sandbox-output.md", progress: true }],
					sandbox: { provider: "bubblewrap" },
					sessionDir,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const bwrapArgs = readLastFakeBwrapArgs(fakeBwrap.recordDir);
			assertMountMode(bwrapArgs, tempDir, "rw");
			assertBind(bwrapArgs, path.join(sessionDir, "run-0"));
		} finally {
			fakeBwrap.restore();
		}
	});

	it("rejects sandboxed parallel write-capable agents unless worktree isolation is enabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("writer", { tools: ["read", "edit"] })]);

			const result = await executor.execute(
				"parallel-sandbox-writer-no-worktree",
				{ tasks: [{ agent: "writer", task: "Edit" }], sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /require worktree: true/);
			assert.equal(fs.readdirSync(fakeBwrap.recordDir).filter((name) => name.endsWith(".json")).length, 0);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fakeBwrap.restore();
		}
	});

	it("rejects mixed isolated and non-isolated parallel writers before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const isolated = makeAgent("isolated", { tools: ["read", "bash"], sandbox: { provider: "bubblewrap", gitMode: "isolated" } });
		const writer = makeAgent("writer", { tools: ["read", "write"] });
		const executor = makeExecutor([isolated, writer]);

		const result = await executor.execute(
			"parallel-mixed-isolated-writers",
			{ tasks: [{ agent: "isolated", task: "Commit A" }, { agent: "writer", task: "Commit B" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /non-isolated write-capable task/i);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects sandboxed parallel agents with omitted tools unless worktree isolation is enabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("default-tools")]);

			const result = await executor.execute(
				"parallel-sandbox-omitted-tools-no-worktree",
				{ tasks: [{ agent: "default-tools", task: "Use default tools" }], sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /require worktree: true/);
			assert.equal(fs.readdirSync(fakeBwrap.recordDir).filter((name) => name.endsWith(".json")).length, 0);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fakeBwrap.restore();
		}
	});

	it("uses agent-level sandbox bashWrite for top-level parallel guard and preserves run-level overrides", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const fakeBwrap = installFakeBwrap();
		try {
			const executor = makeExecutor([makeAgent("shell", { tools: ["bash"], sandbox: { bashWrite: true } })]);

			const rejected = await executor.execute(
				"parallel-agent-bash-write-no-worktree",
				{ tasks: [{ agent: "shell", task: "Shell write" }], sandbox: { provider: "bubblewrap" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0]?.text ?? "", /require worktree: true/);

			mockPi.onCall({ output: "read only shell" });
			const allowed = await executor.execute(
				"parallel-run-bash-write-override",
				{ tasks: [{ agent: "shell", task: "Inspect" }], sandbox: { provider: "bubblewrap", bashWrite: false } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(allowed.isError, undefined);
			assertMountMode(readLastFakeBwrapArgs(fakeBwrap.recordDir), tempDir, "ro");
		} finally {
			fakeBwrap.restore();
		}
	});

	it("mounts each sandboxed parallel writer worktree writable when worktree isolation is enabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Writable worktree done" });
		const fakeBwrap = installFakeBwrap();
		try {
			const repo = path.join(tempDir, "repo");
			initGitRepo(repo);
			const executor = makeExecutor([makeAgent("writer", { tools: ["write"] })]);

			const result = await executor.execute(
				"parallel-sandbox-writer-worktree",
				{
					tasks: [{ agent: "writer", task: "Write A" }, { agent: "writer", task: "Write B" }],
					sandbox: { provider: "bubblewrap" },
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repo),
			);

			assert.equal(result.isError, undefined);
			const calls = readFakeBwrapCalls(fakeBwrap.recordDir);
			assert.equal(calls.length, 2);
			for (const args of calls) {
				const mountedWorktree = args.find((arg, index) => args[index - 1] === "--bind" && arg.includes("pi-worktree-") && arg.startsWith(os.tmpdir()));
				assert.ok(mountedWorktree, "expected each child worktree to be mounted writable");
				assertMountMode(args, mountedWorktree, "rw");
			}
		} finally {
			fakeBwrap.restore();
		}
	});

	it("top-level parallel suppresses progress when the task is review-only", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

		await executor.execute(
			"parallel-read-only-progress",
			{ tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});
});
