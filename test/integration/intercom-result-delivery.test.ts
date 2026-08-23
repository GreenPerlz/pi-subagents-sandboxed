import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { createNestedRoute, nestedResultsPath, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_PATH_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV, SUBAGENT_PARENT_RUN_ID_ENV } from "../../src/runs/shared/pi-args.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		mode?: string;
		runId?: string;
		results?: Array<{ agent?: string; exitCode?: number; finalOutput?: string }>;
		asyncId?: string;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function createRecordingEventBus(options: { acknowledgeResults?: boolean } = {}) {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const bus = {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
			if (options.acknowledgeResults && channel === "subagent:result-intercom") {
				const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			}
		},
	};
	return bus;
}

describe("intercom result delivery cutover", { skip: !available ? "executor not importable" : undefined }, () => {
	let tempDir: string;
	let homeDir: string;
	let previousFixtureAgentDir: string | undefined;
	let previousIntercomSessionId: string | undefined;
	let previousIntercomExtensionDir: string | undefined;
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = createTempDir("pi-subagent-intercom-home-");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(homeDir);
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-result-");
		previousFixtureAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousIntercomSessionId = process.env.PI_INTERCOM_SESSION_ID;
		previousIntercomExtensionDir = process.env.PI_SUBAGENT_INTERCOM_EXTENSION_DIR;
		const fixtureAgentDir = path.join(tempDir, "fixture-user-settings");
		fs.mkdirSync(fixtureAgentDir, { recursive: true });
		fs.writeFileSync(path.join(fixtureAgentDir, "settings.json"), JSON.stringify({ subagents: { sandbox: { allowSandboxOptOut: true } } }), "utf-8");
		fs.mkdirSync(path.join(fixtureAgentDir, "intercom"), { recursive: true });
		fs.writeFileSync(path.join(fixtureAgentDir, "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
		process.env.PI_CODING_AGENT_DIR = fixtureAgentDir;
		process.env.PI_INTERCOM_SESSION_ID = "fixture-intercom-parent";
		const fixtureIntercomDir = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom");
		if (fs.existsSync(fixtureIntercomDir)) process.env.PI_SUBAGENT_INTERCOM_EXTENSION_DIR = fixtureIntercomDir;
		mockPi.reset();
	});

	afterEach(() => {
		if (previousFixtureAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousFixtureAgentDir;
		if (previousIntercomSessionId === undefined) delete process.env.PI_INTERCOM_SESSION_ID;
		else process.env.PI_INTERCOM_SESSION_ID = previousIntercomSessionId;
		if (previousIntercomExtensionDir === undefined) delete process.env.PI_SUBAGENT_INTERCOM_EXTENSION_DIR;
		else process.env.PI_SUBAGENT_INTERCOM_EXTENSION_DIR = previousIntercomExtensionDir;
		removeTempDir(tempDir);
	});

	async function readMockCallArgs(index: number): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		let callFile: string | undefined;
		while (!callFile) {
			callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()[index];
			if (callFile || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(callFile, `expected mock pi call at index ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function initGitRepo(repoDir: string): void {
		fs.mkdirSync(repoDir, { recursive: true });
		const runGit = (args: string[]) => {
			const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
		};
		runGit(["init", "-q"]);
		runGit(["config", "user.email", "test@example.com"]);
		runGit(["config", "user.name", "Test"]);
		fs.writeFileSync(path.join(repoDir, "README.txt"), "base\n", "utf-8");
		runGit(["add", "README.txt"]);
		runGit(["commit", "-qm", "base"]);
	}

	function makeExecutor(options: { bridgeMode?: "always" | "off"; agents?: ReturnType<typeof makeAgent>[]; acknowledgeResults?: boolean; sessionName?: string | null } = {}) {
		const events = createRecordingEventBus({ acknowledgeResults: options.acknowledgeResults ?? true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
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
		const baseExecutor = createSubagentExecutor!({
			pi: {
				events,
				getSessionName: () => options.sessionName === null ? undefined : options.sessionName ?? "orchestrator",
				setSessionName: () => {},
			},
			state,
			config: {
				intercomBridge: { mode: options.bridgeMode ?? "always" },
			},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
		});
		const executor = {
			...baseExecutor,
			execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: ((r: unknown) => void) | undefined, ctx: unknown) =>
				baseExecutor.execute(id, {
					...params,
					...(!params.sandbox && !(options.agents ?? []).some((agent) => agent.sandbox) ? { sandbox: { provider: "none" } } : {}),
				}, signal, onUpdate as never, ctx as never),
		};
		return { executor, events, state };
	}

	it("single foreground runs emit one grouped event and return a compact receipt", async () => {
		mockPi.onCall({ output: "Full child output from worker" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-intercom",
			{ agent: "worker", task: "Implement feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "single");
		assert.equal(payload.children?.length, 1);
		assert.equal(payload.children?.[0]?.agent, "worker");
		assert.match(payload.children?.[0]?.intercomTarget ?? "", /^subagent-worker-[a-f0-9]+-1$/);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-worker-[a-f0-9]+-1/);
		assert.match(result.content[0]?.text ?? "", /Delivered single subagent result via intercom\./);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Full child output from worker/);
		assert.equal(result.details?.results?.[0]?.finalOutput, undefined);
		assert.match(String(payload.message ?? ""), /Full child output from worker/);
	});

	it("routes unnamed parent results to pi-intercom's published broker identity", async () => {
		mockPi.onCall({ output: "Broker-routed output" });
		const previousIntercomSessionId = process.env.PI_INTERCOM_SESSION_ID;
		process.env.PI_INTERCOM_SESSION_ID = "stable-intercom-parent";
		try {
			const { executor, events } = makeExecutor({ sessionName: null });

			await executor.execute(
				"stable-intercom-target",
				{ agent: "worker", task: "Report through intercom" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { to?: string } | undefined;
			assert.equal(payload?.to, "stable-intercom-parent");
		} finally {
			if (previousIntercomSessionId === undefined) delete process.env.PI_INTERCOM_SESSION_ID;
			else process.env.PI_INTERCOM_SESSION_ID = previousIntercomSessionId;
		}
	});

	it("falls back to legacy foreground output when the bridge is inactive", async () => {
		mockPi.onCall({ output: "Legacy foreground output" });
		const { executor, events } = makeExecutor({ bridgeMode: "off" });

		const result = await executor.execute(
			"single-no-intercom",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Legacy foreground output/);
	});

	it("falls back to legacy foreground output when grouped delivery is not acknowledged", async () => {
		mockPi.onCall({ output: "Unacknowledged foreground output" });
		const { executor, events } = makeExecutor({ acknowledgeResults: false });

		const result = await executor.execute(
			"single-no-ack",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), true);
		assert.match(result.content[0]?.text ?? "", /Unacknowledged foreground output/);
	});

	it("top-level parallel runs emit one grouped event containing all children", async () => {
		mockPi.onCall({ output: "Parallel child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "parallel");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[ab]-[a-f0-9]+-[12]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-a-[a-f0-9]+-1/);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered parallel subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("delivers a live foreground isolated Git bundle through grouped intercom", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "isolated-intercom-repo");
		initGitRepo(repoDir);
		const before = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
		mockPi.onCall({
			output: "Isolated commit output",
			commands: ["printf 'isolated\\n' > isolated.txt && git add isolated.txt && git commit -m 'isolated intercom commit'"],
		});
		const { executor, events } = makeExecutor();
		const result = await executor.execute(
			"isolated-foreground-intercom",
			{
				tasks: [{ agent: "worker", task: "Commit in the isolated worktree" }],
				sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(repoDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as {
			children?: Array<{ gitBundle?: { path?: string; base?: string; head?: string } }>;
			message?: string;
		} | undefined;
		const bundle = payload?.children?.[0]?.gitBundle;
		assert.ok(bundle?.path && fs.existsSync(bundle.path), "grouped foreground delivery must carry the live isolated bundle");
		assert.equal(bundle.base, before);
		assert.notEqual(bundle.head, before);
		assert.match(payload?.message ?? "", /Git bundle:/);
		assert.equal(spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim(), before);
		assert.equal(fs.existsSync(path.join(repoDir, "isolated.txt")), false);
		const verified = spawnSync("git", ["bundle", "verify", bundle.path], { cwd: repoDir, encoding: "utf-8" });
		assert.equal(verified.status, 0, verified.stderr || verified.stdout);
	});

	it("captures a foreground worktree patch before intercom receipt and leaves it integratable after cleanup", async () => {
		const repoDir = path.join(tempDir, "repo");
		initGitRepo(repoDir);
		mockPi.onCall({
			output: "Worktree child output",
			writeFiles: [{ path: "captured.txt", content: "captured by worker\n" }],
		});
		const { executor, events } = makeExecutor();
		const ctx = makeMinimalCtx(repoDir);
		ctx.sessionManager.getSessionFile = () => path.join(tempDir, "parent.jsonl");

		const result = await executor.execute(
			"parallel-worktree-intercom",
			{ tasks: [{ agent: "worker", task: "Write the captured file" }], worktree: true },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const intercomPayload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { message?: string } | undefined;
		const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
		assert.equal(worktreeList.status, 0);
		assert.equal((worktreeList.stdout.match(/^worktree /gm) ?? []).length, 1, "temporary child worktree should be cleaned up");
		const patchDir = path.join(tempDir, "subagent-artifacts", "worktree-diffs");
		const patchFiles = fs.existsSync(patchDir) ? fs.readdirSync(patchDir).filter((file) => file.endsWith(".patch")) : [];
		assert.equal(patchFiles.length, 1, "expected one captured patch after worktree cleanup");
		const patchPath = path.join(patchDir, patchFiles[0]!);
		assert.match(fs.readFileSync(patchPath, "utf-8"), /captured\.txt/);
		assert.match(result.content[0]?.text ?? "", /Full patches:/);
		assert.match(intercomPayload?.message ?? "", /Full patches:/);

		const apply = spawnSync("git", ["-C", repoDir, "apply", "--check", patchPath], { encoding: "utf-8" });
		assert.equal(apply.status, 0, `captured patch should apply cleanly: ${apply.stderr}`);
		const applied = spawnSync("git", ["-C", repoDir, "apply", patchPath], { encoding: "utf-8" });
		assert.equal(applied.status, 0, `captured patch should remain integratable: ${applied.stderr}`);
		assert.equal(fs.readFileSync(path.join(repoDir, "captured.txt"), "utf-8"), "captured by worker\n");
	});

	it("captures a failed top-level worktree patch before intercom receipt and leaves it integratable after cleanup", async () => {
		const repoDir = path.join(tempDir, "failed-parallel-repo");
		initGitRepo(repoDir);
		mockPi.onCall({
			output: "Worker failed after writing",
			exitCode: 1,
			stderr: "worker failed",
			writeFiles: [{ path: "captured-failure.txt", content: "captured before failure\n" }],
		});
		const { executor, events } = makeExecutor();
		const result = await executor.execute(
			"failed-parallel-worktree-intercom",
			{ tasks: [{ agent: "worker", task: "Write then fail" }], worktree: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(repoDir),
		);

		const intercomPayload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { message?: string } | undefined;
		assert.equal(result.details?.results?.[0]?.exitCode, 1);
		assert.match(result.content[0]?.text ?? "", /Full patches:/);
		assert.match(intercomPayload?.message ?? "", /Full patches:/);
		const patchDir = /Full patches: (.+)/.exec(result.content[0]?.text ?? "")?.[1];
		assert.ok(patchDir, "failed result should include the captured patch directory");
		const patchPath = path.join(patchDir, "task-0-worker.patch");
		assert.match(fs.readFileSync(patchPath, "utf-8"), /captured-failure\.txt/);
		const apply = spawnSync("git", ["-C", repoDir, "apply", "--check", patchPath], { encoding: "utf-8" });
		assert.equal(apply.status, 0, `failed child patch should apply cleanly: ${apply.stderr}`);
		const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
		assert.equal((worktreeList.stdout.match(/^worktree /gm) ?? []).length, 1, "temporary child worktree should be cleaned after capture");
	});

	it("captures a failed chain worktree patch before intercom receipt and leaves it integratable after cleanup", async () => {
		const repoDir = path.join(tempDir, "failed-chain-repo");
		initGitRepo(repoDir);
		mockPi.onCall({
			output: "Chain worker failed after writing",
			exitCode: 1,
			stderr: "chain worker failed",
			writeFiles: [{ path: "captured-chain-failure.txt", content: "captured before chain failure\n" }],
		});
		const { executor, events } = makeExecutor();
		const ctx = makeMinimalCtx(repoDir);
		ctx.sessionManager.getSessionFile = () => path.join(tempDir, "failed-chain-parent.jsonl");

		const result = await executor.execute(
			"failed-chain-worktree-intercom",
			{
				chain: [{ parallel: [{ agent: "worker", task: "Write then fail in chain" }], worktree: true }],
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		const intercomPayload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { message?: string } | undefined;
		assert.equal(result.details?.results?.[0]?.exitCode, 1);
		assert.match(result.content[0]?.text ?? "", /Full patches:/);
		assert.match(intercomPayload?.message ?? "", /Full patches:/);
		const patchDir = /Full patches: (.+)/.exec(result.content[0]?.text ?? "")?.[1];
		assert.ok(patchDir, "failed chain result should include the captured patch directory");
		const patchPath = path.join(patchDir, "task-0-worker.patch");
		assert.match(fs.readFileSync(patchPath, "utf-8"), /captured-chain-failure\.txt/);
		const apply = spawnSync("git", ["-C", repoDir, "apply", "--check", patchPath], { encoding: "utf-8" });
		assert.equal(apply.status, 0, `failed chain patch should apply cleanly: ${apply.stderr}`);
		const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
		assert.equal((worktreeList.stdout.match(/^worktree /gm) ?? []).length, 1, "temporary chain worktree should be cleaned after capture");
	});

	it("captures a chain worktree patch before intercom receipt and leaves it integratable after cleanup", async () => {
		const repoDir = path.join(tempDir, "chain-repo");
		initGitRepo(repoDir);
		mockPi.onCall({
			output: "Chain worktree child output",
			writeFiles: [{ path: "captured-chain.txt", content: "captured by chain worker\n" }],
		});
		const { executor, events } = makeExecutor();
		const ctx = makeMinimalCtx(repoDir);
		ctx.sessionManager.getSessionFile = () => path.join(tempDir, "chain-parent.jsonl");

		const result = await executor.execute(
			"chain-worktree-intercom",
			{
				chain: [{ parallel: [{ agent: "worker", task: "Write the captured chain file" }], worktree: true }],
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		const intercomPayload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { message?: string } | undefined;
		const worktreeList = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
		assert.equal(worktreeList.status, 0);
		assert.equal((worktreeList.stdout.match(/^worktree /gm) ?? []).length, 1, "temporary chain worktree should be cleaned up");
		const resultText = result.content[0]?.text ?? "";
		assert.match(resultText, /Full patches:/);
		assert.match(intercomPayload?.message ?? "", /Full patches:/);
		const patchDir = /Full patches: (.+)/.exec(resultText)?.[1];
		assert.ok(patchDir, "chain result should include the captured patch directory");
		const patchPath = path.join(patchDir, "task-0-worker.patch");
		assert.match(fs.readFileSync(patchPath, "utf-8"), /captured-chain\.txt/);

		const apply = spawnSync("git", ["-C", repoDir, "apply", "--check", patchPath], { encoding: "utf-8" });
		assert.equal(apply.status, 0, `captured chain patch should apply cleanly: ${apply.stderr}`);
		const applied = spawnSync("git", ["-C", repoDir, "apply", patchPath], { encoding: "utf-8" });
		assert.equal(applied.status, 0, `captured chain patch should remain integratable: ${applied.stderr}`);
		assert.equal(fs.readFileSync(path.join(repoDir, "captured-chain.txt"), "utf-8"), "captured by chain worker\n");
	});

	it("chain runs emit one grouped event containing all executed children", async () => {
		mockPi.onCall({ output: "Chain child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")] });

		const result = await executor.execute(
			"chain-intercom",
			{
				chain: [
					{ agent: "a", task: "step-a" },
					{ parallel: [{ agent: "b", task: "step-b" }, { agent: "c", task: "step-c" }] },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "chain");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b", "c"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[abc]-[a-f0-9]+-[123]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(String(payload.message ?? ""), /3\. c — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered chain subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("detached chain runs do not emit grouped completion receipts", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;

		const result = await executor.execute(
			"chain-detached-intercom",
			{
				chain: [
					{ agent: "a", task: "ask supervisor" },
					{ agent: "b", task: "must not run" },
				],
			},
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached" });
			},
			makeMinimalCtx(tempDir),
		);

		assert.equal(detachEmitted, true);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(bus.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resume action sends a follow-up to a live async child when the target is registered", async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor();

			const result = await executor.execute(
				"resume-live",
				{ action: "resume", id: runId, message: "Can you clarify the last change?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Delivered follow-up to live async child/);
			const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { to?: string; message?: string } | undefined;
			assert.equal(payload?.to, `subagent-worker-${runId}-1`);
			assert.match(payload?.message ?? "", /Can you clarify the last change\?/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives completed multi-child async runs by index", async () => {
		mockPi.onCall({ output: "revived async child b" });
		const runId = `resume-revive-multi-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const firstSession = path.join(tempDir, "child-a.jsonl");
		const secondSession = path.join(tempDir, "child-b.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

			const result = await executor.execute(
				"resume-revive-multi",
				{ action: "resume", id: runId, index: 1, message: "What did b find?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Agent: b/);
			assert.match(result.content[0]?.text ?? "", new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			const args = await readMockCallArgs(0);
			assert.equal(args[args.indexOf("--session") + 1], secondSession);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives completed async runs with no-poll handoff guidance", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor();

			const result = await executor.execute(
				"resume-revive",
				{ action: "resume", id: runId, message: "What changed?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
			assert.match(result.content[0]?.text ?? "", /end your turn now/);
			assert.match(result.content[0]?.text ?? "", /Status if needed: subagent\(\{ action: "status"/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Follow:/);
			const revivedId = result.details?.asyncId;
			assert.ok(revivedId, "expected revived async id");
			const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("restores a top-level async root route into the revived child environment and mount", async () => {
		const runId = `top-route-resume-${Date.now().toString(36)}`;
		const route = createNestedRoute(runId);
		const ambientRoute = createNestedRoute(`ambient-${runId}`);
		const inheritedEnv = [SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV, SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, SUBAGENT_PARENT_RUN_ID_ENV, SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_PATH_ENV] as const;
		const savedEnv = new Map(inheritedEnv.map((key) => [key, process.env[key]]));
		Object.assign(process.env, {
			[SUBAGENT_PARENT_EVENT_SINK_ENV]: ambientRoute.eventSink,
			[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: ambientRoute.controlInbox,
			[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: ambientRoute.rootRunId,
			[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: ambientRoute.capabilityToken,
			[SUBAGENT_PARENT_RUN_ID_ENV]: "ambient-parent",
			[SUBAGENT_PARENT_DEPTH_ENV]: "1",
			[SUBAGENT_PARENT_PATH_ENV]: JSON.stringify([{ runId: ambientRoute.rootRunId, stepIndex: 0 }]),
		});
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "top-route-session.jsonl");
		mockPi.onCall({ output: "top route restored", commands: [
			`test \"$PI_SUBAGENT_PARENT_ROOT_RUN_ID\" = ${JSON.stringify(runId)} && test -d \"$PI_SUBAGENT_PARENT_EVENT_SINK\" && test -d \"$PI_SUBAGENT_PARENT_CONTROL_INBOX\" && test -n \"$PI_SUBAGENT_PARENT_CAPABILITY_TOKEN\"`,
		] });
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, mode: "single", state: "complete", cwd: tempDir, sessionFile, nestedRoute: route, nestedRouteRequired: true, steps: [{ agent: "worker", status: "complete", sessionFile }] }), "utf8");
			const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("worker", { tools: ["read", "subagent"] })] });
			const resumed = await executor.execute("top-route-resume", { action: "resume", id: runId, message: "Continue with descendants" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
			const revivedId = resumed.details?.asyncId;
			assert.ok(revivedId);
			const revivedResult = path.join(RESULTS_DIR, `${revivedId}.json`);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(revivedResult) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(fs.existsSync(revivedResult), true);
			const payload = JSON.parse(fs.readFileSync(revivedResult, "utf8")) as { success?: boolean; nestedRoute?: unknown; nestedSelf?: unknown };
			assert.equal(payload.success, true, JSON.stringify(payload));
			assert.deepEqual(payload.nestedRoute, route);
			assert.equal(payload.nestedSelf, undefined, "top-level revival remains a root while retaining its route");

			const missingId = `${runId}-missing`;
			const missingDir = path.join(ASYNC_DIR, missingId);
			fs.mkdirSync(missingDir, { recursive: true });
			fs.writeFileSync(path.join(missingDir, "status.json"), JSON.stringify({ runId: missingId, mode: "single", state: "complete", cwd: tempDir, sessionFile, nestedRouteRequired: true, steps: [{ agent: "worker", status: "complete", sessionFile }] }), "utf8");
			const denied = await executor.execute("top-route-missing", { action: "resume", id: missingId, message: "must not launch invisibly" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(denied.isError, true);
			assert.match(denied.content[0]?.text ?? "", /requires persisted nested route metadata/);
			fs.rmSync(missingDir, { recursive: true, force: true });
		} finally {
			for (const key of inheritedEnv) {
				const value = savedEnv.get(key);
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(path.dirname(ambientRoute.eventSink), { recursive: true, force: true });
		}
	});

	it("restores the authenticated nested route when reviving a terminal nested async run", async () => {
		mockPi.onCall({ delay: 1500, output: "revived nested answer" });
		const rootRunId = `nested-revive-root-${Date.now().toString(36)}`;
		const sourceRunId = `nested-source-${Date.now().toString(36)}`;
		const route = createNestedRoute(rootRunId);
		const sourceAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, sourceRunId);
		const sourceSession = path.join(tempDir, sourceRunId, "step-0.jsonl");
		const latestSession = path.join(tempDir, sourceRunId, "step-1.jsonl");
		const nestedSelf = { parentRunId: "parent-run", parentStepIndex: 2, depth: 2, path: [{ runId: rootRunId, stepIndex: 0 }, { runId: "parent-run", stepIndex: 2 }] };
		let mismatchRoute: ReturnType<typeof createNestedRoute> | undefined;
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(path.dirname(sourceSession), { recursive: true });
			fs.writeFileSync(sourceSession, "", "utf8");
			fs.writeFileSync(latestSession, "", "utf8");
			const sourceStatus = {
				runId: sourceRunId, mode: "chain", state: "complete", cwd: tempDir, sessionFile: latestSession,
				nestedRoute: route, nestedSelf, steps: [
					{ flatIndex: 0, agent: "worker", status: "complete", sessionFile: sourceSession },
					{ flatIndex: 1, agent: "later", status: "complete", sessionFile: latestSession },
				],
			};
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify(sourceStatus), "utf8");
			writeNestedEvent(route, { type: "subagent.nested.completed", ts: Date.now(), parentRunId: nestedSelf.parentRunId, parentStepIndex: nestedSelf.parentStepIndex, child: {
				id: sourceRunId, ...nestedSelf, asyncDir: sourceAsyncDir, cwd: tempDir, sessionFile: latestSession, state: "complete", agent: "worker", agents: ["worker", "later"], mode: "chain", chainStepCount: 2,
				steps: [{ flatIndex: 0, agent: "worker", status: "complete", sessionFile: sourceSession }, { flatIndex: 1, agent: "later", status: "complete", sessionFile: latestSession }],
				startedAt: Date.now() - 100, endedAt: Date.now(), lastUpdate: Date.now(),

			} });
			const { executor, state } = makeExecutor({ bridgeMode: "off" });
			state.asyncJobs.set(rootRunId, { id: rootRunId, nestedRoute: route } as never);
			const parentSession = path.join(tempDir, "parent-session.jsonl");
			fs.writeFileSync(parentSession, "", "utf8");
			const ctx = { ...makeMinimalCtx(tempDir), sessionManager: { getSessionId: () => "session-123", getSessionFile: () => parentSession } };
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({ ...sourceStatus, cwd: path.join(tempDir, "forged-cwd") }), "utf8");
			const forgedCwd = await executor.execute("nested-cwd-mismatch", { action: "resume", id: sourceRunId, index: 0, message: "must reject cwd replacement" }, new AbortController().signal, undefined, ctx);
			assert.equal(forgedCwd.isError, true);
			assert.match(forgedCwd.content[0]?.text ?? "", /persisted cwd does not match its authenticated registry entry/);
			mismatchRoute = createNestedRoute(rootRunId);
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({ ...sourceStatus, nestedRoute: mismatchRoute }), "utf8");
			const mismatched = await executor.execute("nested-route-mismatch", { action: "resume", id: sourceRunId, index: 0, message: "must reject route replacement" }, new AbortController().signal, undefined, ctx);
			assert.equal(mismatched.isError, true);
			assert.match(mismatched.content[0]?.text ?? "", /persisted route does not match its authenticated registry route/);
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({ ...sourceStatus, steps: [{ ...sourceStatus.steps[0], agent: "forged-agent" }, sourceStatus.steps[1]] }), "utf8");
			const forgedAgent = await executor.execute("nested-agent-mismatch", { action: "resume", id: sourceRunId, index: 0, message: "must reject agent replacement" }, new AbortController().signal, undefined, ctx);
			assert.equal(forgedAgent.isError, true);
			assert.match(forgedAgent.content[0]?.text ?? "", /persisted agent does not match its authenticated registry entry/);
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify(sourceStatus), "utf8");
			const resumed = await executor.execute("nested-route-resume", { action: "resume", id: sourceRunId, index: 0, message: "Continue under the same route" }, new AbortController().signal, undefined, ctx);
			assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
			const revivedId = resumed.details?.asyncId;
			assert.ok(revivedId);
			const visibilityDeadline = Date.now() + 5_000;
			let revived = projectNestedEvents(route).children.find((child) => child.id === revivedId);
			while (!revived && Date.now() < visibilityDeadline) { await new Promise((resolve) => setTimeout(resolve, 25)); revived = projectNestedEvents(route).children.find((child) => child.id === revivedId); }
			assert.ok(revived, "revived child must publish into the original route");
			assert.equal(revived.parentRunId, nestedSelf.parentRunId);
			assert.equal(revived.parentStepIndex, nestedSelf.parentStepIndex);
			assert.ok(projectNestedEvents(route).children.some((child) => child.id === sourceRunId), "completed source sibling remains visible");
			const interrupted = await executor.execute("nested-route-interrupt", { action: "interrupt", id: revivedId }, new AbortController().signal, undefined, ctx);
			assert.equal(interrupted.isError, undefined, interrupted.content[0]?.text);
			const resultPath = nestedResultsPath(rootRunId, revivedId);
			const resultDeadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath) && Date.now() < resultDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(fs.existsSync(resultPath), true, JSON.stringify({ resultPath, projected: projectNestedEvents(route).children.find((child) => child.id === revivedId) }));
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { nestedRoute?: unknown; nestedSelf?: { path?: unknown[] } };
			const revivedSelf = { ...nestedSelf, path: [...nestedSelf.path, { runId: sourceRunId, stepIndex: nestedSelf.parentStepIndex, agent: "worker" }] };
			assert.deepEqual(payload.nestedRoute, route);
			assert.deepEqual(payload.nestedSelf, revivedSelf);

			mockPi.onCall({ output: "revived nested twice" });
			const resumedAgain = await executor.execute("nested-route-resume-again", { action: "resume", id: revivedId, message: "Continue again under the same route" }, new AbortController().signal, undefined, ctx);
			assert.equal(resumedAgain.isError, undefined, resumedAgain.content[0]?.text);
			const secondRevivedId = resumedAgain.details?.asyncId;
			assert.ok(secondRevivedId);
			const secondResultPath = nestedResultsPath(rootRunId, secondRevivedId);
			const secondDeadline = Date.now() + 10_000;
			while (!fs.existsSync(secondResultPath) && Date.now() < secondDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(fs.existsSync(secondResultPath), true);
			const secondPayload = JSON.parse(fs.readFileSync(secondResultPath, "utf8")) as { nestedRoute?: unknown; nestedSelf?: { path?: Array<{ runId?: string }> } };
			assert.deepEqual(secondPayload.nestedRoute, route);
			assert.equal(secondPayload.nestedSelf?.path?.some((entry) => entry.runId === revivedId), true, "repeated revival extends authenticated lineage");
			const projectedIds = projectNestedEvents(route).children.map((child) => child.id);
			assert.ok(projectedIds.includes(sourceRunId));
			assert.ok(projectedIds.includes(revivedId));
			assert.ok(projectedIds.includes(secondRevivedId));
		} finally {
			if (mismatchRoute) fs.rmSync(path.dirname(mismatchRoute.eventSink), { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId), { recursive: true, force: true });
			fs.rmSync(path.join(RESULTS_DIR, "nested", rootRunId), { recursive: true, force: true });
		}
	});

	it("resume action revives a completed foreground child by index", async () => {
		mockPi.onCall({ output: "first child done" });
		mockPi.onCall({ output: "second child done" });
		mockPi.onCall({ output: "revived foreground answer" });
		const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });

		const original = await executor.execute(
			"foreground-resume-original",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const revived = await executor.execute(
			"foreground-resume",
			{ action: "resume", id: runId, index: 1, message: "Follow up with b" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(revived.isError, undefined);
		assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
		assert.match(revived.content[0]?.text ?? "", /Agent: b/);
		const reviveArgs = await readMockCallArgs(2);
		const selectedSession = original.details?.results?.[1]?.sessionFile;
		assert.ok(selectedSession, "expected selected child session file");
		assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
		const revivedId = revived.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});

	it("resume action rejects detached foreground children that may still be live", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const resumed = await executor.execute(
			"foreground-detached-resume",
			{ action: "resume", id: runId, message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /detached for intercom coordination/);
		assert.match(resumed.content[0]?.text ?? "", /Reply to the supervisor request first/);
		assert.doesNotMatch(resumed.content[0]?.text ?? "", /revive only/);
	});

	it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
		const base = `exact-invalid-${Date.now()}`;
		const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
		fs.writeFileSync(asyncSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: `${base}-async`,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(base, {
				runId: base,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed" }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-foreground",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Foreground run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
		const base = `exact-invalid-async-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, base);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: base,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-async",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Async run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
		const base = `namespace-ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
		const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
		const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(firstAsyncSession, "", "utf-8");
		fs.writeFileSync(secondAsyncSession, "", "utf-8");
		const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
		const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
		try {
			for (const [asyncDir, runId, sessionFile] of [[firstAsyncDir, `${base}-async-a`, firstAsyncSession], [secondAsyncDir, `${base}-async-b`, secondAsyncSession]] as const) {
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					cwd: tempDir,
					steps: [{ agent: "a", status: "complete", sessionFile }],
				}, null, 2), "utf-8");
			}
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-async-prefix-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
		} finally {
			fs.rmSync(firstAsyncDir, { recursive: true, force: true });
			fs.rmSync(secondAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
		const base = `ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground.jsonl");
		const asyncSession = path.join(tempDir, "async.jsonl");
		const asyncId = `${base}-async`;
		const foregroundId = `${base}-foreground`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(asyncSession, "", "utf-8");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(foregroundId, {
				runId: foregroundId,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("mixed foreground outcomes produce failed grouped status and receipt counts", async () => {
		mockPi.onCall({ output: "Parallel child success", exitCode: 0 });
		mockPi.onCall({ output: "Parallel child failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-mixed-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { status?: string; summary?: string; message?: string };
		assert.equal(payload.status, "failed");
		assert.match(String(payload.summary ?? ""), /1 completed, 1 failed/);
		assert.match(String(payload.message ?? ""), /Status: failed/);
		assert.match(String(payload.message ?? ""), /Parallel child failure/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
		assert.match(result.content[0]?.text ?? "", /Parallel child failure/);
	});
});
