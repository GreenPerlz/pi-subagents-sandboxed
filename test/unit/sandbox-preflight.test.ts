import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	checkGhAuthAvailability,
	checkGitProbe,
	checkGitWorktreePointer,
	runSandboxPreflight,
	type GhAuthResult,
	type GitProbeResult,
	type GitWorktreePointerResult,
	type PreflightCheckResult,
	type PreflightDeps,
} from "../../src/sandbox/preflight.ts";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createBareRepo(prefix: string): { repoDir: string; bareDir: string } {
	// Create a normal repo first with a commit
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-repo-`));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Preflight Tests"]);
	fs.writeFileSync(path.join(repoDir, "README.md"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	// Clone --bare from the repo
	const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-bare-`));
	git(repoDir, ["clone", "--bare", ".", bareDir]);
	return { repoDir, bareDir };
}

function createWorktreeWithPointerFile(bareDir: string, prefix: string): {
	worktreeDir: string;
	gitdirPath: string;
	cleanup: () => void;
} {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-wt-`));
	// Use git worktree add to create a worktree whose .git is a pointer file
	const branch = `preflight-test-${Date.now()}`;
	git(bareDir, ["worktree", "add", worktreeDir, "-b", branch, "HEAD"]);
	// Verify it's a pointer file
	const gitPath = path.join(worktreeDir, ".git");
	const gitContent = fs.readFileSync(gitPath, "utf-8").trim();
	assert.ok(gitContent.startsWith("gitdir:"), `Expected pointer file but got: ${gitContent}`);

	return {
		worktreeDir,
		gitdirPath: gitContent.replace(/^gitdir:\s*/, "").trim(),
		cleanup: () => {
			try { git(bareDir, ["worktree", "remove", "--force", worktreeDir]); } catch {}
			try { git(bareDir, ["branch", "-D", branch]); } catch {}
			try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
		},
	};
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
});

describe("sandbox preflight: gh auth availability", () => {
	it("reports available when gh auth status succeeds", () => {
		const result = checkGhAuthAvailability({
			execSync: () => ({ status: 0, stdout: "gh version 2.42.0", stderr: "" }),
		});
		assert.equal(result.available, true);
		assert.equal(result.error, undefined);
	});

	it("reports unavailable when gh command fails with auth error", () => {
		const result = checkGhAuthAvailability({
			execSync: () => ({ status: 1, stdout: "", stderr: "gh auth: no token found" }),
		});
		assert.equal(result.available, false);
		assert.ok(result.error);
		assert.match(result.error, /gh auth.*unavailable|no token/i);
	});

	it("reports unavailable when gh is not found", () => {
		const result = checkGhAuthAvailability({
			execSync: () => ({
				status: null,
				stdout: "",
				stderr: "spawn gh ENOENT",
				error: new Error("spawn gh ENOENT"),
			}),
		});
		assert.equal(result.available, false);
		assert.ok(result.error);
		assert.match(result.error, /not installed|not found|ENOENT/i);
	});

	it("reports unavailable with clear message when not in sandbox context", () => {
		// When gh auth works but we're not in a sandbox, this is informational
		const result = checkGhAuthAvailability({
			execSync: () => ({ status: 0, stdout: "", stderr: "" }),
		});
		assert.equal(result.available, true);
	});
});

describe("sandbox preflight: git probe", () => {
	it("passes when git works in a normal repo", () => {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-probe-normal-"));
		tempDirs.push(repoDir);
		git(repoDir, ["init"]);
		git(repoDir, ["config", "user.email", "tests@example.com"]);
		git(repoDir, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "init"]);

		const result = checkGitProbe(repoDir);
		assert.equal(result.ok, true);
		assert.ok(result.gitdir);
		assert.equal(result.error, undefined);
	});

	it("passes when git works in a worktree with pointer file", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-probe-wt");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-probe-wt");
		tempDirs.push(worktreeDir);

		try {
			const result = checkGitProbe(worktreeDir);
			assert.equal(result.ok, true);
			assert.ok(result.gitdir);
		} finally {
			cleanup();
		}
	});

	it("fails with actionable error when git is not found", () => {
		const result = checkGitProbe("/some/path", {
			execSync: () => ({
				status: null,
				stdout: "",
				stderr: "",
				error: new Error("spawn git ENOENT"),
			}),
		});
		assert.equal(result.ok, false);
		assert.ok(result.error);
		assert.match(result.error, /not installed|not found|ENOENT/i);
		assert.ok(result.stderr !== undefined);
	});

	it("fails with actionable stderr when git cannot operate on worktree", () => {
		const result = checkGitProbe("/nonexistent/path", {
			execSync: () => ({
				status: 128,
				stdout: "",
				stderr: "fatal: not a git repository",
			}),
		});
		assert.equal(result.ok, false);
		assert.ok(result.error);
		assert.match(result.error, /cannot operate on worktree|not a git repository/i);
		assert.equal(result.stderr, "fatal: not a git repository");
	});

	it("fails with stdout detail when git exits nonzero with only stdout", () => {
		const result = checkGitProbe("/some/path", {
			execSync: () => ({
				status: 1,
				stdout: "error: something went wrong",
				stderr: "",
			}),
		});
		assert.equal(result.ok, false);
		assert.ok(result.error);
		assert.match(result.error, /something went wrong/);
	});

	it("returns skipped when explicitly disabled", () => {
		const result = runSandboxPreflight({
			cwd: "/workspace/project",
			sandboxRoot: "/workspace/project",
			skipGitProbe: true,
		});
		assert.equal(result.gitProbe.ok, true);
		assert.equal(result.gitProbe.skipped, true);
	});
});

describe("sandbox preflight: git worktree pointer file", () => {
	it("passes when .git is a directory (not a pointer file)", () => {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-normal-"));
		tempDirs.push(repoDir);
		git(repoDir, ["init"]);
		git(repoDir, ["config", "user.email", "tests@example.com"]);
		git(repoDir, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "init"]);

		const result = checkGitWorktreePointer(repoDir, {
			sandboxRoot: repoDir,
		});
		assert.equal(result.ok, true);
		assert.equal(result.pointerGitdir, undefined);
		assert.equal(result.error, undefined);
	});

	it("passes when .git is a pointer file and gitdir is inside the sandbox root", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-inside");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, gitdirPath, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-inside");
		tempDirs.push(worktreeDir);
		// The gitdir will be inside the bare repo directory, so use a parent that covers both
		const parentRoot = path.dirname(bareDir);

		try {
			const result = checkGitWorktreePointer(worktreeDir, {
				sandboxRoot: parentRoot,
			});
			assert.equal(result.ok, true);
			assert.ok(result.pointerGitdir);
			// The gitdir should be within parentRoot
			assert.ok(result.pointerGitdir.startsWith(parentRoot));
		} finally {
			cleanup();
		}
	});

	it("fails when .git is a pointer file and gitdir is outside the sandbox root", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-outside");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, gitdirPath, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-outside");
		tempDirs.push(worktreeDir);

		try {
			// Use the worktree itself as sandbox root — the gitdir in the bare repo will be outside
			const result = checkGitWorktreePointer(worktreeDir, {
				sandboxRoot: worktreeDir,
			});
			assert.equal(result.ok, false);
			assert.ok(result.error);
			assert.match(result.error, /gitdir.*outside.*sandbox|sandbox.*mount.*gitdir/i);
			assert.ok(result.pointerGitdir);
			assert.ok(!result.pointerGitdir.startsWith(worktreeDir));
		} finally {
			cleanup();
		}
	});

	it("passes when no .git exists", () => {
		const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-nogit-"));
		tempDirs.push(plainDir);
		const result = checkGitWorktreePointer(plainDir, {
			sandboxRoot: plainDir,
		});
		assert.equal(result.ok, true);
		assert.equal(result.pointerGitdir, undefined);
		assert.equal(result.error, undefined);
	});

	it("passes when gitdir is outside sandboxRoot but inside extraMountRoots", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-extra-mount");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, gitdirPath, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-extra-mount");
		tempDirs.push(worktreeDir);

		try {
			// The gitdir is outside the worktree (sandboxRoot), but inside an extra mount root
			const parentRoot = path.dirname(bareDir);
			const result = checkGitWorktreePointer(worktreeDir, {
				sandboxRoot: worktreeDir,
				extraMountRoots: [parentRoot],
			});
			assert.equal(result.ok, true);
			assert.ok(result.pointerGitdir);
			// The gitdir should be under parentRoot, not under worktreeDir
			assert.ok(!result.pointerGitdir.startsWith(worktreeDir));
			assert.ok(result.pointerGitdir.startsWith(parentRoot));
		} finally {
			cleanup();
		}
	});

	it("fails when gitdir is outside both sandboxRoot and extraMountRoots", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-extra-mount-fail");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-extra-mount-fail");
		tempDirs.push(worktreeDir);

		try {
			// The gitdir is outside the worktree, and extraMountRoots point elsewhere
			const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-unrelated-"));
			tempDirs.push(unrelatedRoot);
			const result = checkGitWorktreePointer(worktreeDir, {
				sandboxRoot: worktreeDir,
				extraMountRoots: [unrelatedRoot],
			});
			assert.equal(result.ok, false);
			assert.ok(result.error);
			assert.match(result.error, /gitdir.*outside.*sandbox/i);
		} finally {
			cleanup();
		}
	});
});

describe("sandbox preflight: combined run", () => {
	it("runs both checks and reports combined results", () => {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-combined-"));
		tempDirs.push(repoDir);
		git(repoDir, ["init"]);
		git(repoDir, ["config", "user.email", "tests@example.com"]);
		git(repoDir, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "init"]);

		const result = runSandboxPreflight({
			cwd: repoDir,
			sandboxRoot: repoDir,
			ghAuth: {
				execSync: () => ({ status: 0, stdout: "", stderr: "" }),
			},
		});

		assert.equal(result.passed, true);
		assert.equal(result.ghAuth.available, true);
		assert.equal(result.gitProbe.ok, true);
		assert.equal(result.worktree.ok, true);
		assert.equal(result.errors.length, 0);
		assert.equal(result.warnings.length, 0);
	});

	it("collects warnings from gh auth and errors from worktree", () => {
		const { repoDir, bareDir } = createBareRepo("pi-preflight-combined-fail");
		tempDirs.push(repoDir, bareDir);
		const { worktreeDir, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-preflight-combined-fail");
		tempDirs.push(worktreeDir);

		try {
			const result = runSandboxPreflight({
				cwd: worktreeDir,
				sandboxRoot: worktreeDir,
				ghAuth: {
					execSync: () => ({ status: 1, stdout: "", stderr: "no token" }),
				},
			});

			// gh auth failure is informational (warning), worktree is blocking (error)
			assert.equal(result.passed, false);
			assert.equal(result.ghAuth.available, false);
			assert.equal(result.worktree.ok, false);
			assert.equal(result.errors.length, 1); // worktree only
			assert.equal(result.warnings.length, 1); // gh auth only
		} finally {
			cleanup();
		}
	});

	it("reports blocking error when git probe fails", () => {
		const result = runSandboxPreflight({
			cwd: "/nonexistent/path",
			sandboxRoot: "/nonexistent/path",
			gitProbe: {
				execSync: () => ({
					status: 128,
					stdout: "",
					stderr: "fatal: not a git repository",
				}),
			},
			skipWorktree: true,
		});

		assert.equal(result.passed, false);
		assert.equal(result.gitProbe.ok, false);
		assert.match(result.gitProbe.error!, /cannot operate on worktree/);
		assert.equal(result.errors.length, 1);
		assert.match(result.summary, /git probe.*failed|cannot operate/i);
	});

	it("reports blocking error when git is not found", () => {
		const result = runSandboxPreflight({
			cwd: "/some/path",
			sandboxRoot: "/some/path",
			gitProbe: {
				execSync: () => ({
					status: null,
					stdout: "",
					stderr: "",
					error: new Error("spawn git ENOENT"),
				}),
			},
			skipWorktree: true,
		});

		assert.equal(result.passed, false);
		assert.equal(result.gitProbe.ok, false);
		assert.match(result.gitProbe.error!, /not installed|not found|ENOENT/);
		assert.equal(result.errors.length, 1);
	});

	it("formats a human-readable summary", () => {
		const result = runSandboxPreflight({
			cwd: "/workspace/project",
			sandboxRoot: "/workspace/project",
			ghAuth: {
				execSync: () => ({ status: 1, stdout: "", stderr: "no token" }),
			},
			worktreeOverride: { ok: true },
		});

		// gh auth failure is informational only
		assert.match(result.summary, /gh auth.*unavailable|no token/i);
		assert.match(result.summary, /git probe.*ok/i);
		assert.match(result.summary, /git worktree.*ok/i);
		assert.equal(result.passed, true); // gh auth warning doesn't block
		assert.equal(result.warnings.length, 1);
	});

	it("skips gh auth check when explicitly disabled", () => {
		const result = runSandboxPreflight({
			cwd: "/workspace/project",
			sandboxRoot: "/workspace/project",
			skipGhAuth: true,
		});

		assert.equal(result.ghAuth.available, true);
		assert.equal(result.ghAuth.skipped, true);
	});

	it("skips worktree check when explicitly disabled", () => {
		const result = runSandboxPreflight({
			cwd: "/workspace/project",
			sandboxRoot: "/workspace/project",
			skipWorktree: true,
		});

		assert.equal(result.worktree.ok, true);
		assert.equal(result.worktree.skipped, true);
	});

	it("summary includes git probe line on success", () => {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-summary-"));
		tempDirs.push(repoDir);
		git(repoDir, ["init"]);
		git(repoDir, ["config", "user.email", "tests@example.com"]);
		git(repoDir, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "init"]);

		const result = runSandboxPreflight({
			cwd: repoDir,
			sandboxRoot: repoDir,
			skipGhAuth: true,
		});

		assert.equal(result.passed, true);
		assert.match(result.summary, /git probe: ok/);
	});

	it("allows generic preflight to opt out of git worktree requirement", () => {
		const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-norequire-"));
		tempDirs.push(plainDir);
		const result = runSandboxPreflight({
			cwd: plainDir,
			sandboxRoot: plainDir,
			skipGhAuth: true,
		});
		assert.equal(result.passed, true);
		assert.equal(result.gitProbe.ok, true);
		assert.equal(result.worktree.ok, true);
	});

	it("blocks when requireGitWorktree is true and cwd has no .git", () => {
		const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-requiregit-"));
		tempDirs.push(plainDir);
		const result = runSandboxPreflight({
			cwd: plainDir,
			sandboxRoot: plainDir,
			skipGhAuth: true,
			requireGitWorktree: true,
		});
		assert.equal(result.passed, false);
		assert.equal(result.gitProbe.ok, false);
		assert.match(result.gitProbe.error!, /not a git repository/i);
	});
});

describe("sandbox preflight: ralph-orchestrator integration", () => {
	const routeRoots: string[] = [];
	const envKeys = [
		SUBAGENT_CHILD_ENV,
		SUBAGENT_FANOUT_CHILD_ENV,
		SUBAGENT_PARENT_EVENT_SINK_ENV,
		SUBAGENT_PARENT_CONTROL_INBOX_ENV,
		SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
		SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
		SUBAGENT_PARENT_RUN_ID_ENV,
		SUBAGENT_PARENT_CHILD_INDEX_ENV,
		SUBAGENT_CHILD_AGENT_ENV,
		SUBAGENT_RUN_ID_ENV,
	];
	let savedEnv: Record<string, string | undefined> | undefined;

	function saveAndClearEnv(): void {
		savedEnv = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
		}
	}

	afterEach(() => {
		for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
		if (savedEnv) {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
			savedEnv = undefined;
		}
	});

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

	function createTestExecutor(state = createState(), agents: Array<Record<string, unknown>> = [{ name: "worker", description: "Worker", prompt: "Do work" }]) {
		return createSubagentExecutor({
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
			state,
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
			asyncByDefault: false,
			tempArtifactsDir: os.tmpdir(),
			getSubagentSessionRoot: () => os.tmpdir(),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: agents as any }),
		});
	}

	function testCtx(root: string) {
		return {
			cwd: root,
			hasUI: false,
			sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
			modelRegistry: { getAvailable() { return []; } },
		} as any;
	}

	function setRalphOrchestratorNestedEnv(route: ReturnType<typeof createNestedRoute>, runId = "ralph-preflight-run") {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "parent-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
		process.env[SUBAGENT_CHILD_AGENT_ENV] = "ralph-orchestrator";
		process.env[SUBAGENT_RUN_ID_ENV] = runId;
	}

	function text(result: Awaited<ReturnType<ReturnType<typeof createTestExecutor>["execute"]>>): string {
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	}

	it("runs preflight and proceeds when checks pass", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-preflight-pass-"));
		tempDirs.push(root);
		git(root, ["init"]);
		git(root, ["config", "user.email", "tests@example.com"]);
		git(root, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
		git(root, ["add", "-A"]);
		git(root, ["commit", "-m", "init"]);
		try {
			const route = createNestedRoute("root-preflight-pass");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const throwingCtx = {
				...testCtx(root),
				modelRegistry: { getAvailable() { throw new Error("worker reached execution"); } },
			};
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			// Preflight should pass (normal repo)
			// Then execution proceeds and hits the throwing model registry
			assert.equal(result.isError, true);
			assert.match(text(result), /worker reached execution/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces preflight summary in result text on success", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-preflight-visible-"));
		tempDirs.push(root);
		git(root, ["init"]);
		git(root, ["config", "user.email", "tests@example.com"]);
		git(root, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
		git(root, ["add", "-A"]);
		git(root, ["commit", "-m", "init"]);
		try {
			const route = createNestedRoute("root-preflight-visible");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const throwingCtx = {
				...testCtx(root),
				modelRegistry: { getAvailable() { throw new Error("worker reached execution"); } },
			};
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			const resultText = text(result);
			// Preflight summary should be prepended to the result text
			assert.match(resultText, /Preflight:/);
			assert.match(resultText, /git probe: ok/);
			assert.match(resultText, /worker reached execution/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks ralph-orchestrator worker when gitdir is outside sandbox mount", async () => {
		saveAndClearEnv();
		const { repoDir, bareDir } = createBareRepo("pi-ralph-preflight-block");
		const { worktreeDir, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-ralph-preflight-block");

		try {
			const route = createNestedRoute("root-preflight-block");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, testCtx(worktreeDir));

			assert.equal(result.isError, true);
			assert.match(text(result), /preflight failed/i);
			assert.match(text(result), /gitdir.*outside.*sandbox/i);
		} finally {
			cleanup();
			try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
			try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch {}
		}
	});

	it("blocks ralph-orchestrator worker when git probe fails", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-preflight-nogit-"));
		// Create a broken .git pointer to a nonexistent gitdir so git probe fails
		fs.writeFileSync(path.join(root, ".git"), "gitdir: /nonexistent/bare/repo", "utf-8");
		try {
			const route = createNestedRoute("root-preflight-nogit");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, testCtx(root));

			assert.equal(result.isError, true);
			const resultText = text(result);
			assert.match(resultText, /preflight failed/i);
			assert.match(resultText, /git probe/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not run preflight for non-ralph-orchestrator nested workers", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-non-ralph-preflight-"));
		try {
			const route = createNestedRoute("root-non-ralph-preflight");
			routeRoots.push(path.dirname(route.eventSink));
			process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
			process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
			process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
			process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
			process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "parent-run";
			process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker"; // not ralph-orchestrator
			process.env[SUBAGENT_RUN_ID_ENV] = "worker-run";
			const throwingCtx = {
				...testCtx(root),
				modelRegistry: { getAvailable() { throw new Error("non-ralph reached execution"); } },
			};
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /non-ralph reached execution/);
			assert.doesNotMatch(text(result), /preflight/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks ralph-orchestrator worker when cwd is not a git repo (no .git)", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-preflight-nogitrepo-"));
		tempDirs.push(root);
		try {
			const route = createNestedRoute("root-preflight-nogitrepo");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, testCtx(root));

			assert.equal(result.isError, true);
			const resultText = text(result);
			assert.match(resultText, /preflight failed/i);
			assert.match(resultText, /not a git repository/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("agent-level sandbox extra mounts cover pointer gitdir", async () => {
		saveAndClearEnv();
		const { repoDir, bareDir } = createBareRepo("pi-ralph-preflight-agent-mount");
		const { worktreeDir, cleanup } = createWorktreeWithPointerFile(bareDir, "pi-ralph-preflight-agent-mount");
		tempDirs.push(repoDir, bareDir, worktreeDir);
		try {
			const route = createNestedRoute("root-preflight-agent-mount");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const parentRoot = path.dirname(bareDir);
			const executor = createTestExecutor(createState(), [
				{ name: "worker", description: "Worker", prompt: "Do work", sandbox: { provider: "bubblewrap", extraReadOnlyMounts: [parentRoot] } },
			]);
			const throwingCtx = {
				...testCtx(worktreeDir),
				modelRegistry: { getAvailable() { throw new Error("worker reached execution"); } },
			};

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /worker reached execution/);
			assert.doesNotMatch(text(result), /preflight failed/i);
		} finally {
			cleanup();
			try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
			try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch {}
		}
	});

	it("nested completion event includes preflight summary on success", async () => {
		saveAndClearEnv();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-preflight-nested-event-"));
		tempDirs.push(root);
		git(root, ["init"]);
		git(root, ["config", "user.email", "tests@example.com"]);
		git(root, ["config", "user.name", "Preflight Tests"]);
		fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf-8");
		git(root, ["add", "-A"]);
		git(root, ["commit", "-m", "init"]);
		try {
			const route = createNestedRoute("root-preflight-nested-event");
			routeRoots.push(path.dirname(route.eventSink));
			setRalphOrchestratorNestedEnv(route);
			const throwingCtx = {
				...testCtx(root),
				modelRegistry: { getAvailable() { throw new Error("worker reached execution"); } },
			};
			const executor = createTestExecutor();

			const result = await executor.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			const resultText = text(result);
			assert.match(resultText, /Preflight:/);
			assert.match(resultText, /git probe: ok/);

			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			const child = registry.children[0]!;
			assert.ok(child.summary, "expected nested event to include summary");
			assert.match(child.summary, /Preflight:/);
			assert.match(child.summary, /git probe: ok/);
			assert.match(child.summary, /worker reached execution/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
