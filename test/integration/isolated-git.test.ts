/** Bubblewrap regression for opt-in isolated Git commits and bundle export. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BubblewrapSandboxProvider } from "../../src/sandbox/bubblewrap.ts";
import { buildSubagentSandboxMounts } from "../../src/sandbox/mount-policy.ts";
import {
	createIsolatedGitRuntime,
	createIsolatedGitWorktree,
	exportIsolatedGitBundle,
	cleanupIsolatedGitRuntime,
	teardownIsolatedGitRuntimeForTests,
} from "../../src/sandbox/isolated-git.ts";

function policyProcessesForRuntime(root: string): string[] {
	return spawnSync("ps", ["-eo", "pid,ppid,pgid,sid,stat,args"], { encoding: "utf8" }).stdout
		.split("\n")
		.filter((line) => line.includes(root));
}

async function cleanupTestRuntime(runtime: { root: string; cwd: string }): Promise<void> {
	const runtimeHandle = runtime as Parameters<typeof cleanupIsolatedGitRuntime>[0];
	const root = runtime.root;
	const beforeProcesses = policyProcessesForRuntime(root);
	await cleanupIsolatedGitRuntime(runtimeHandle);
	await teardownIsolatedGitRuntimeForTests(runtimeHandle);
	assert.equal(fs.existsSync(root), false, "test runtime root must be removed after policy teardown");
	const deadline = Date.now() + 2_000;
	let afterProcesses = policyProcessesForRuntime(root);
	while (afterProcesses.length > 0 && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		afterProcesses = policyProcessesForRuntime(root);
	}
	assert.deepEqual(afterProcesses, [], `policy process leaked after test teardown (before=${JSON.stringify(beforeProcesses)})`);
	const fixtureRoot = path.dirname(runtime.cwd);
	if (path.basename(fixtureRoot).startsWith("pi-isolated-git-")) fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

const hasBubblewrap = process.platform === "linux" && spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;

function git(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function gitRaw(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

interface PolicyResponse {
	ok?: boolean;
	error?: string;
	result?: { status?: number; stdout?: string; stderr?: string };
}

function policyRequest(socketPath: string, request: unknown): Promise<PolicyResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let data = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => { data += chunk; });
		socket.on("error", reject);
		socket.on("end", () => {
			try { resolve(JSON.parse(data) as PolicyResponse); }
			catch (error) { reject(error); }
		});
		socket.on("connect", () => socket.end(JSON.stringify(request) + "\n"));
	});
}

function snapshot(cwd: string): string {
	return JSON.stringify({
		head: git(cwd, ["rev-parse", "HEAD"]),
		status: git(cwd, ["status", "--porcelain=v1"]),
		refs: git(cwd, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
		config: git(cwd, ["config", "--local", "--list"]),
		reflogs: git(cwd, ["reflog", "--all"]),
		objects: git(cwd, ["count-objects", "-v"]),
	});
}

describe("isolated Git commits", { skip: !hasBubblewrap }, () => {
	it("refuses bundle export after a failed teardown fence and retains recovery root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-fence-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "fence" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			runtime.markHookTeardownFailed();
			assert.throws(() => exportIsolatedGitBundle(runtime, { outputDir: path.join(root, "bundles"), worktree }), /export refused.*recover isolated (?:runtime\/)?worktrees/iu);
			assert.equal(fs.existsSync(runtime.root), true);
		} finally {
			await teardownIsolatedGitRuntimeForTests(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("policy server exits after its disposable owner is SIGKILLed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-owner-death-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		assert.ok(owner.pid);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "owner-death", ownerPid: owner.pid });
		const sockets = [path.join(runtime.root, "git-policy-host", "server.sock"), path.join(runtime.root, "git-policy-none", "server.sock")];
		assert.ok(sockets.every((socket) => fs.existsSync(socket)));
		process.kill(owner.pid, "SIGKILL");
		const deadline = Date.now() + 3_000;
		while (sockets.some((socket) => fs.existsSync(socket)) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		assert.ok(sockets.every((socket) => !fs.existsSync(socket)), "owner death must close policy sockets");
		await cleanupTestRuntime(runtime);
	});

	it("protects ordinary checkout metadata when Git mode is omitted or explicitly read-only", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-only-git-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		for (const gitMode of [undefined, "read-only"] as const) {
			const mounts = buildSubagentSandboxMounts({ cwd: repo, cwdMode: "rw", gitMode });
			const wrapped = new BubblewrapSandboxProvider().wrapInvocation({
				config: { provider: "bubblewrap", network: "none", fallback: "fail" },
				invocation: { command: "git", args: ["-C", repo, "config", "--local", "sandbox.mutation", "blocked"] },
				mounts,
			});
			const child = spawnSync(wrapped.invocation.command, wrapped.invocation.args, { encoding: "utf8" });
			assert.notEqual(child.status, 0, `Git mode ${gitMode ?? "omitted"} unexpectedly changed metadata`);
			assert.equal(spawnSync("git", ["-C", repo, "config", "--local", "--get", "sandbox.mutation"], { encoding: "utf8" }).status, 1);
		}
	});

	it("rejects difftool external callbacks before they can bypass Git policy", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-difftool-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "difftool" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		const run = (args: string[]) => spawnSync("bwrap", runtime.wrapInvocation(worktree, {
			command: "git",
			args: ["-C", worktree.worktreePath, ...args],
		}).args, { encoding: "utf8" });
		try {
			const callbackMarker = path.join(worktree.worktreePath, "difftool-callback-ran");
			const hookMarker = path.join(worktree.worktreePath, "difftool-hook-ran");
			const hooksDir = path.join(worktree.worktreePath, "hooks");
			fs.mkdirSync(hooksDir, { recursive: true });
			fs.writeFileSync(path.join(hooksDir, "pre-commit"), `#!/bin/sh\\nprintf ran > ${JSON.stringify(hookMarker)}\\n`, "utf8");
			fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
			const callback = path.join(worktree.worktreePath, "difftool-callback.sh");
			fs.writeFileSync(callback, `#!/bin/sh\\nprintf ran > ${JSON.stringify(callbackMarker)}\\n/usr/bin/git -c core.hooksPath=\"$PWD/hooks\" commit -m difftool-callback\\n`, "utf8");
			fs.chmodSync(callback, 0o755);
			fs.writeFileSync(path.join(worktree.worktreePath, "staged.txt"), "staged\\n");
			assert.equal(run(["add", "staged.txt"]).status, 0);
			const before = git(worktree.worktreePath, ["rev-parse", "HEAD"]);
			const attempt = run(["difftool", `--extcmd=${callback}`, "--cached"]);
			assert.notEqual(attempt.status, 0, "difftool external callback unexpectedly ran");
			assert.equal(fs.existsSync(callbackMarker), false, "difftool callback executed inside the sandbox");
			assert.equal(fs.existsSync(hookMarker), false, "difftool callback reached a commit hook");
			assert.equal(git(worktree.worktreePath, ["rev-parse", "HEAD"]), before, "difftool callback changed isolated history");
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("rejects web browsing and help web callbacks before helper invocation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-web-callback-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "web-callback" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			const run = (args: string[]) => spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, ...args],
			}).args, { encoding: "utf8" });
			const callbackMarker = path.join(worktree.worktreePath, "browser-callback-ran");
			const callback = path.join(worktree.worktreePath, "browser-callback.sh");
			fs.writeFileSync(callback, `#!/bin/sh\\nprintf ran > ${JSON.stringify(callbackMarker)}\\n`, "utf8");
			fs.chmodSync(callback, 0o755);

			const browse = run(["web--browse", `--browser=${callback}`, "https://example.invalid"]);
			assert.notEqual(browse.status, 0);
			assert.match(browse.stderr, /isolated Git policy rejects external Git callbacks/i);
			assert.equal(fs.existsSync(callbackMarker), false, "web browser callback executed inside the sandbox");
			for (const args of [["help", "--web", "status"], ["help", "-w", "status"], ["--help", "-w", "status"]]) {
				const help = run(args);
				assert.notEqual(help.status, 0, args.join(" "));
				assert.match(help.stderr, /isolated Git policy rejects external Git callbacks/i, args.join(" "));
			}
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("rejects local Git callback commands before execution while preserving normal history commands", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-local-callback-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "local-callback" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			const run = (args: string[]) => spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, ...args],
			}).args, { encoding: "utf8" });
			const callbackAttempts = [
				["instaweb"],
				["gui"],
				["citool"],
				["filter-branch", "--env-filter", "touch callback-marker", "HEAD"],
				["merge-index", "touch", "file.txt"],
				["bisect", "run", "touch", "callback-marker"],
				["rebase", "--exec", "touch callback-marker", "HEAD"],
				["submodule", "foreach", "touch callback-marker"],
				["maintenance", "run"],
				["fsmonitor--daemon", "start"],
				["update-index", "--fsmonitor"],
				["hook", "run", "pre-commit"],
			];
			for (const args of callbackAttempts) {
				const attempt = run(args);
				assert.notEqual(attempt.status, 0, args.join(" "));
				assert.match(attempt.stderr, /isolated Git policy rejects external Git callbacks/i, args.join(" "));
			}

			fs.writeFileSync(path.join(worktree.worktreePath, "normal.txt"), "normal\\n");
			assert.equal(run(["add", "normal.txt"]).status, 0);
			assert.equal(run(["commit", "-m", "normal local commit"]).status, 0);
			assert.equal(run(["log", "-1", "--format=%s"]).stdout.trim(), "normal local commit");
			assert.equal(run(["rev-parse", "HEAD"]).status, 0);
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("keeps isolated Git security policy immutable while allowing normal commits", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-policy-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "policy" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			for (const [key, value] of [
				["core.hooksPath", path.join(worktree.worktreePath, "hooks")],
				["credential.helper", "store"],
				["commit.gpgsign", "true"],
				["core.pager", "less"],
				["core.editor", "vi"],
			] as const) {
				const attempt = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
					command: "git",
					args: ["-C", worktree.worktreePath, "config", "--local", key, value],
				}).args, { encoding: "utf8" });
				assert.notEqual(attempt.status, 0, `child unexpectedly rewrote ${key}`);
			}
			assert.equal(git(worktree.worktreePath, ["config", "--get", "core.hooksPath"]), "/dev/null");
			assert.equal(git(worktree.worktreePath, ["config", "--get", "credential.helper"]), "");
			assert.equal(git(worktree.worktreePath, ["config", "--get", "commit.gpgsign"]), "false");
			assert.equal(git(worktree.worktreePath, ["config", "--get", "core.pager"]), "cat");
			assert.equal(git(worktree.worktreePath, ["config", "--get", "core.editor"]), ":");
			for (const alternateGit of ["/bin/git", "/usr/lib/git-core/git"]) {
				const alternate = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
					command: alternateGit,
					args: ["-C", worktree.worktreePath, "status", "--porcelain"],
				}).args, { encoding: "utf8" });
				assert.equal(alternate.status, 0, `${alternateGit} should retain ordinary Git usage: ${alternate.stderr}`);
			}

			const hooksDir = path.join(worktree.worktreePath, "hooks");
			const hookMarker = path.join(worktree.worktreePath, "hook-ran");
			fs.mkdirSync(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, "pre-commit");
			fs.writeFileSync(hookPath, `#!/bin/sh\nprintf ran > "${hookMarker}"\n`, "utf8");
			fs.chmodSync(hookPath, 0o755);
			fs.writeFileSync(path.join(worktree.worktreePath, "child.txt"), "child\n");
			assert.equal(spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "add", "child.txt"],
			}).args, { encoding: "utf8" }).status, 0);
			const gitRoutes = [
				"git", // PATH discovery
				"/bin/git",
				"/usr/bin/git",
				"/usr/lib/git-core/git", // Git's advertised exec-path route
				"/proc/1/root/usr/bin/git", // PID/mount visibility must not expose a host binary
				"/tmp/.pi-isolated-real-git", // the old unguarded helper route
				path.join(runtime.root, "git-policy", "git-policy.sh"), // internal host helper path
			];
			for (const route of gitRoutes) {
				const attempt = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
					command: "sh",
					args: ["-c", `${route} -c core.hooksPath=\"$PWD/hooks\" commit -m route-bypass`],
				}).args, { encoding: "utf8" });
				assert.notEqual(attempt.status, 0, `Git route unexpectedly accepted a hooksPath override: ${route}`);
				assert.equal(fs.existsSync(hookMarker), false, `the hook ran through ${route}`);
			}
			const hiddenExecPathHelper = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "sh",
				args: ["-c", "test ! -x /usr/lib/git-core/git-upload-pack"],
			}).args, { encoding: "utf8" });
			assert.equal(hiddenExecPathHelper.status, 0, "Git exec-path subprogram was directly available");
			const cliConfigBypass = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "sh",
				args: ["-c", `git -c core.hooksPath=\"$PWD/hooks\" commit -m cli-bypass`],
			}).args, { encoding: "utf8" });
			assert.notEqual(cliConfigBypass.status, 0, "git -c config override unexpectedly succeeded");
			assert.equal(fs.existsSync(hookMarker), false, "the hook ran through a -c core.hooksPath bypass");
			const configEnvBypass = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "sh",
				args: ["-c", `HOOK_PATH=\"$PWD/hooks\" git --config-env=core.hooksPath=HOOK_PATH commit -m config-env-bypass`],
			}).args, { encoding: "utf8" });
			assert.notEqual(configEnvBypass.status, 0, "git --config-env override unexpectedly succeeded");
			assert.equal(fs.existsSync(hookMarker), false, "the hook ran through a --config-env bypass");
			const inheritedConfigBypass = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "sh",
				args: ["-c", `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=\"$PWD/hooks\" git commit -m inherited-config-bypass`],
			}).args, { encoding: "utf8" });
			assert.equal(inheritedConfigBypass.status, 0, inheritedConfigBypass.stderr);
			assert.equal(fs.existsSync(hookMarker), false, "the hook ran through inherited config environment");
			fs.writeFileSync(path.join(worktree.worktreePath, "normal.txt"), "normal\n");
			assert.equal(spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "add", "normal.txt"],
			}).args, { encoding: "utf8" }).status, 0);
			const committed = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "commit", "-m", "policy remains enforced"],
			}).args, { encoding: "utf8" });
			assert.equal(committed.status, 0, committed.stderr);
			assert.equal(fs.existsSync(hookMarker), false, "the normal commit unexpectedly ran the hook");
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("rejects signing controls across local history operations while preserving safe commands", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-signing-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "signing" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			const run = (args: string[]) => spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, ...args],
			}).args, { encoding: "utf8" });
			for (const operation of ["merge", "cherry-pick", "rebase", "revert"]) {
				const denied = run([operation, "-S", "HEAD"]);
				assert.notEqual(denied.status, 0, `${operation} unexpectedly accepted -S`);
				assert.match(denied.stderr, /isolated Git policy rejects signing overrides/i, `${operation} denial was not from the policy`);
			}
			const longForm = run(["merge", "--gpg-sign=example-key", "HEAD"]);
			assert.notEqual(longForm.status, 0);
			assert.match(longForm.stderr, /isolated Git policy rejects signing overrides/i);
			const configOverride = run(["-c", "commit.gpgsign=true", "merge", "HEAD"]);
			assert.notEqual(configOverride.status, 0);
			assert.match(configOverride.stderr, /isolated Git policy rejects command-line config overrides/i);
			const normalMerge = run(["merge", "-s", "ours", "HEAD"]);
			assert.equal(normalMerge.status, 0, normalMerge.stderr);
			const normal = run(["status", "--porcelain"]);
			assert.equal(normal.status, 0, normal.stderr);
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("denies every visible Git protocol route, including mount and fd aliases", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-routes-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "routes" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		const refsBefore = git(worktree.worktreePath, ["for-each-ref", "--format=%(refname)=%(objectname)"]);
		const run = (command: string, args: string[]) => spawnSync("bwrap", runtime.wrapInvocation(worktree, { command, args }).args, { encoding: "utf8" });
		try {
			const repository = "$PWD";
			const routes = [
				"git-shell",
				"git-upload-pack",
				"git-receive-pack",
				"git-upload-archive",
				"/usr/bin/git-shell",
				"/bin/git-shell",
				"/usr/bin/git-upload-pack",
				"/bin/git-upload-pack",
				"/usr/bin/git-receive-pack",
				"/bin/git-receive-pack",
				"/usr/bin/git-upload-archive",
				"/bin/git-upload-archive",
			];
			const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
			for (const helper of [
				"git-upload-pack", "git-receive-pack", "git-upload-archive", "git-shell",
				"git-daemon", "git-http-backend", "git-http-fetch", "git-http-push",
				"git-remote-ext", "git-remote-fd", "git-remote-http", "git-remote-https",
				"git-web--browse", "git-instaweb", "git-filter-branch", "git-difftool", "git-mergetool",
				"git-gui", "git-citool", "gitk",
			]) routes.push(path.join(execPath, helper));
			for (const route of [...new Set(routes)]) {
				if (route.startsWith("/") && !fs.existsSync(route)) continue;
				const command = route.includes("shell") ? `${route} -c "git-upload-pack '${repository}'"` : `${route} '${repository}'`;
				const attempt = run("sh", ["-c", command]);
				assert.notEqual(attempt.status, 0, `Git protocol route unexpectedly remained executable: ${route}`);
				assert.doesNotMatch(attempt.stdout, /refs\/(heads|tags)\//, `Git protocol route exposed refs: ${route}`);
			}

			const mountinfo = run("sh", ["-c", "cat /proc/self/mountinfo"]);
			assert.equal(mountinfo.status, 0, mountinfo.stderr);
			const helperMounts = mountinfo.stdout.split(String.fromCharCode(10)).filter((line) => /git-(?:shell|upload-pack|receive-pack|upload-archive)/.test(line));
			assert.ok(helperMounts.every((line) => /git-helper-denied|git-exec/.test(line)), "mountinfo exposed an unguarded helper route");
			const fdLeak = run("sh", ["-c", "for fd in /proc/[0-9]*/fd/*; do target=$(readlink \"$fd\" 2>/dev/null || :); case $target in *git-shell|*git-upload-pack|*git-receive-pack|*git-upload-archive) printf '%s\\n' \"$target\"; exit 1;; esac; done"]);
			assert.equal(fdLeak.status, 0, `Git helper leaked through /proc/*/fd: ${fdLeak.stdout}`);

			for (const helper of ["upload-pack", "receive-pack", "upload-archive"]) {
				const socketPath = path.join(runtime.gitPolicy.policyRootTarget, "server.sock");
				const socketProbe = `const net=require('node:net'); const socket=net.createConnection(${JSON.stringify(socketPath)}); let data=''; socket.setEncoding('utf8'); socket.on('data', chunk => data += chunk); socket.on('end', () => { const response=JSON.parse(data); if (response.ok) { process.stdout.write(data); process.exitCode=1; } }); socket.on('error', error => { process.stderr.write(String(error)); process.exitCode=1; }); socket.end(JSON.stringify({cwd:process.cwd(),args:${JSON.stringify([helper, worktree.worktreePath])},env:{}})+'\\n');`;
				const direct = run(process.execPath, ["-e", socketProbe]);
				assert.equal(direct.status, 0, `direct policy socket request for ${helper} was accepted: ${direct.stdout}${direct.stderr}`);
			}
			assert.equal(git(worktree.worktreePath, ["for-each-ref", "--format=%(refname)=%(objectname)"]), refsBefore, "a denied helper route altered isolated refs");
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("fails closed for malformed, outside, symlink, redirected, and direct policy-server requests", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-policy-server-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "policy-server" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		const sibling = createIsolatedGitWorktree(runtime, { index: 1 });
		const socketPath = path.join(runtime.gitPolicy.networkPolicyDirs.host, "server.sock");
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside);
		try {
			const malformed = await policyRequest(socketPath, {});
			assert.equal(malformed.ok, false);

			const outsideCwd = await policyRequest(socketPath, { cwd: outside, args: ["status"], token: worktree.policyToken, env: {} });
			assert.equal(outsideCwd.ok, false, "a valid worktree token must not authorize an outside cwd");
			const siblingCwd = await policyRequest(socketPath, { cwd: sibling.worktreePath, args: ["status"], token: worktree.policyToken, env: {} });
			assert.equal(siblingCwd.ok, false, "a valid worktree token must not authorize a sibling worktree");
			const escape = path.join(worktree.worktreePath, "escape");
			fs.symlinkSync(outside, escape, "dir");
			const symlinkCwd = await policyRequest(socketPath, { cwd: escape, args: ["status"], env: {} });
			assert.equal(symlinkCwd.ok, false);

			for (const args of [
				["-C", outside, "status"],
				["status", "-C", outside],
				[`-C${outside}`, "status"],
				["status", `-C${outside}`],
				[`-C=${outside}`, "status"],
				["status", `-C=${outside}`],
			]) {
				const redirectedCwd = await policyRequest(socketPath, { cwd: worktree.worktreePath, args, token: worktree.policyToken, env: {} });
				assert.equal(redirectedCwd.ok, false, args.join(" "));
			}
			for (const option of ["--git-dir", "--work-tree", "--exec-path", "--template", "--separate-git-dir"]) {
				for (const args of [
					[option, outside, "status"],
					["status", option, outside],
					[`${option}=${outside}`, "status"],
					["status", `${option}=${outside}`],
				]) {
					const redirectedOption = await policyRequest(socketPath, {
						cwd: worktree.worktreePath,
						args,
						token: worktree.policyToken,
						env: {},
					});
					assert.equal(redirectedOption.ok, false, `${option}: ${args.join(" ")}`);
				}
			}

			const normal = await policyRequest(socketPath, { cwd: worktree.worktreePath, args: ["log", "-1", "--format=%H"], token: worktree.policyToken, env: {} });
			assert.equal(normal.ok, true, normal.error);
			assert.equal(normal.result?.status, 0, Buffer.from(normal.result?.stderr ?? "", "base64").toString("utf8"));
			assert.equal(Buffer.from(normal.result?.stdout ?? "", "base64").toString("utf8").trim(), worktree.baseCommit);
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("copies Git identities with punctuation faithfully into isolated commits", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-identity-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "A # B"]);
		git(repo, ["config", "user.email", "a+b@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "identity" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			assert.equal(git(worktree.worktreePath, ["config", "--get", "user.name"]), "A # B");
			assert.equal(git(worktree.worktreePath, ["config", "--get", "user.email"]), "a+b@example.invalid");
			fs.writeFileSync(path.join(worktree.worktreePath, "child.txt"), "child\n");
			for (const args of [["add", "child.txt"], ["commit", "-m", "identity"]]) {
				const child = spawnSync("bwrap", runtime.wrapInvocation(worktree, { command: "git", args: ["-C", worktree.worktreePath, ...args] }).args, { encoding: "utf8" });
				assert.equal(child.status, 0, child.stderr);
			}
			assert.equal(git(worktree.worktreePath, ["show", "-s", "--format=%an%x09%ae"]), "A # B\ta+b@example.invalid");
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("lets a Bubblewrap child commit and exports one compact portable bundle without changing the parent", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-test-"));
		const repo = path.join(root, "parent");
		const bundleDir = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		git(repo, ["config", "--local", "parent.only", "parent-secret"]);
		const base = git(repo, ["rev-parse", "HEAD"]);
		fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated\n");
		git(repo, ["add", "unrelated.txt"]);
		git(repo, ["commit", "-m", "unrelated"]);
		git(repo, ["branch", "unrelated-ref"]);
		const dangling = gitRaw(repo, ["hash-object", "-w", "--stdin"], "dangling\n");
		assert.match(dangling, /^[0-9a-f]{40}\n$/);
		git(repo, ["reset", "--hard", base]);
		const parentReflog = git(repo, ["reflog", "--all"]);
		assert.match(parentReflog, /unrelated/);
		const before = snapshot(repo);

		const runtime = createIsolatedGitRuntime({ cwd: repo, baseCommit: base, runId: "primary" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		const hostNetworkInvocation = runtime.wrapInvocation(worktree, { command: "git", args: ["status"] });
		assert.equal(hostNetworkInvocation.args.includes("--unshare-net"), false, "isolated Git must preserve the configured host network policy");
		assert.equal(fs.statSync(worktree.gitPointerPath).mode & 0o222, 0, "the worktree .git pointer is read-only");
		try {
			const parentConfigProbe = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "sh",
				args: ["-c", `test ! -e ${JSON.stringify(path.join(repo, ".git", "config"))}`],
			}).args, { encoding: "utf8" });
			assert.equal(parentConfigProbe.status, 0, "the child unexpectedly saw the parent Git config");
			const parentReflogProbe = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "reflog", "--all"],
			}).args, { encoding: "utf8" });
			assert.equal(parentReflogProbe.status, 0, parentReflogProbe.stderr);
			assert.doesNotMatch(parentReflogProbe.stdout, /unrelated|parent-only-reflog-marker/);

			const child = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "add", "child.txt"],
			}).args, { encoding: "utf8" });
			assert.equal(child.status, 128, "the first command intentionally proves the child cannot see an unmounted file");
			fs.writeFileSync(path.join(worktree.worktreePath, "child.txt"), "child\n");
			const commit = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "add", "child.txt"],
			}).args, { encoding: "utf8" });
			assert.equal(commit.status, 0, commit.stderr);
			const committed = spawnSync("bwrap", runtime.wrapInvocation(worktree, {
				command: "git",
				args: ["-C", worktree.worktreePath, "commit", "-m", "isolated child /tmp/personal-secret"],
			}).args, { encoding: "utf8" });
			assert.equal(committed.status, 0, committed.stderr);
			const head = git(worktree.worktreePath, ["rev-parse", "HEAD"]);
			assert.notEqual(head, base);
			assert.equal(git(worktree.worktreePath, ["merge-base", "--is-ancestor", base, head]), "");
			assert.throws(() => git(worktree.worktreePath, ["cat-file", "-e", "unrelated-ref^{commit}"]));
			assert.throws(() => git(worktree.worktreePath, ["cat-file", "-e", `${dangling.trim()}^{blob}`]));

			const exported = exportIsolatedGitBundle(runtime, { outputDir: bundleDir, worktree });
			assert.equal(fs.existsSync(exported.path), true);
			assert.equal(exported.base, base);
			assert.equal(exported.head, head);
			assert.equal(exported.checksum, createHash("sha256").update(fs.readFileSync(exported.path)).digest("hex"));
			assert.match(exported.commitSummary, /isolated child/);
			assert.equal(exported.portableMetadata.includes(root), false);
			assert.equal(exported.portableMetadata.includes(os.tmpdir()), false);
			const verify = spawnSync("git", ["bundle", "verify", exported.path], { cwd: repo, encoding: "utf8" });
			assert.equal(verify.status, 0, verify.stderr || verify.stdout);
			const heads = spawnSync("git", ["bundle", "list-heads", exported.path], { encoding: "utf8" });
			assert.equal(heads.status, 0, heads.stderr || heads.stdout);
			assert.match(heads.stdout, /refs\/heads\/isolated-0/);
			assert.match(heads.stdout, /refs\/isolated\/metadata/);
			assert.doesNotMatch(heads.stdout, /refs\/heads\/isolated-base/);
			const bundleBytes = fs.statSync(exported.path).size;
			assert.ok(bundleBytes < 16 * 1024, `incremental bundle unexpectedly large: ${bundleBytes}`);
			assert.equal(snapshot(repo), before);
		} finally {
			await cleanupIsolatedGitRuntime(runtime);
		}
		assert.equal(fs.existsSync(runtime.root), false);
		assert.equal(snapshot(repo), before);
		fs.rmSync(root, { recursive: true, force: true });
		void dangling;
	});

	it("preserves distinct staged and worktree projections in one portable bundle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-staged-worktree-test-"));
		const repo = path.join(root, "parent");
		const bundles = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "same.txt"), "A\n");
		fs.writeFileSync(path.join(repo, "delete.txt"), "delete\n");
		fs.writeFileSync(path.join(repo, "mode.sh"), "#!/bin/sh\n");
		fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		fs.writeFileSync(path.join(repo, "target"), "target\n");
		fs.symlinkSync("target", path.join(repo, "link"));
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "staged-worktree" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0, agent: "writer" });
		try {
			fs.writeFileSync(path.join(worktree.worktreePath, "same.txt"), "B\n");
			fs.rmSync(path.join(worktree.worktreePath, "delete.txt"));
			fs.chmodSync(path.join(worktree.worktreePath, "mode.sh"), 0o755);
			fs.writeFileSync(path.join(worktree.worktreePath, "binary.bin"), Buffer.from([255, 4, 5, 6]));
			fs.rmSync(path.join(worktree.worktreePath, "link"));
			fs.symlinkSync("target", path.join(worktree.worktreePath, "link"));
			git(worktree.worktreePath, ["add", "-A"]);
			fs.writeFileSync(path.join(worktree.worktreePath, "same.txt"), "C\n");
			fs.writeFileSync(path.join(worktree.worktreePath, "untracked.txt"), "untracked\n");
			const exported = exportIsolatedGitBundle(runtime, { outputDir: bundles, worktree, agent: "writer", commitRequired: true });
			assert.ok(exported.stagedSnapshot);
			assert.ok(exported.recovery);
			const metadata = JSON.parse(exported.portableMetadata) as { stagedSnapshot?: string; stagedTree?: string; recovery?: string; recoveryTree?: string; payloadRefs: string[]; commits: Array<{ id: string; subject: string }> };
			assert.equal(metadata.stagedSnapshot, exported.stagedSnapshot);
			assert.equal(metadata.recovery, exported.recovery);
			assert.equal(metadata.stagedTree, git(worktree.worktreePath, ["rev-parse", `${exported.stagedSnapshot}^{tree}`]));
			assert.equal(metadata.recoveryTree, git(worktree.worktreePath, ["rev-parse", `${exported.recovery}^{tree}`]));
			assert.ok(metadata.payloadRefs.includes("refs/isolated/staged-0"));
			assert.ok(metadata.payloadRefs.includes("refs/isolated/recovery-0"));
			assert.equal(metadata.commits.some((commit) => /packaging|snapshot/i.test(commit.subject)), false);
			const staged = spawnSync("git", ["-C", worktree.worktreePath, "cat-file", "blob", `${exported.stagedSnapshot}:same.txt`], { encoding: "utf8" });
			const final = spawnSync("git", ["-C", worktree.worktreePath, "cat-file", "blob", `${exported.recovery}:same.txt`], { encoding: "utf8" });
			assert.equal(staged.stdout, "B\n");
			assert.equal(final.stdout, "C\n");
			const stagedBinary = spawnSync("git", ["-C", worktree.worktreePath, "cat-file", "blob", `${exported.stagedSnapshot}:binary.bin`], { encoding: null });
			assert.deepEqual(stagedBinary.stdout, Buffer.from([255, 4, 5, 6]));
			assert.equal(git(worktree.worktreePath, ["cat-file", "-t", `${exported.recovery}:link`]), "blob");
			const verify = spawnSync("git", ["bundle", "verify", exported.path], { cwd: repo, encoding: "utf8" });
			assert.equal(verify.status, 0, verify.stderr || verify.stdout);
			const reconstructed = path.join(root, "reconstructed");
			assert.equal(spawnSync("git", ["clone", repo, reconstructed], { encoding: "utf8" }).status, 0);
			assert.equal(spawnSync("git", ["-C", reconstructed, "fetch", exported.path, "refs/isolated/staged-0:refs/reconstructed/staged", "refs/isolated/recovery-0:refs/reconstructed/worktree"], { encoding: "utf8" }).status, 0);
			assert.equal(git(reconstructed, ["cat-file", "blob", "refs/reconstructed/staged:same.txt"]), "B");
			assert.equal(git(reconstructed, ["cat-file", "blob", "refs/reconstructed/worktree:same.txt"]), "C");
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("packages dirty Git-visible state as an internal recovery snapshot while excluding ignored and synthetic files", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-recovery-test-"));
		const repo = path.join(root, "parent");
		const bundleDir = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 255]));
		fs.writeFileSync(path.join(repo, "executable.sh"), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(repo, "executable.sh"), 0o755);
		fs.writeFileSync(path.join(repo, "deleted.txt"), "delete me\n");
		fs.writeFileSync(path.join(repo, "staged.txt"), "staged base\n");
		fs.writeFileSync(path.join(repo, "link-target"), "target\n");
		fs.symlinkSync("link-target", path.join(repo, "tracked-link"));
		fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);

		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "recovery" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			fs.writeFileSync(path.join(worktree.worktreePath, "binary.bin"), Buffer.from([255, 0, 3, 4]));
			fs.chmodSync(path.join(worktree.worktreePath, "executable.sh"), 0o644);
			fs.rmSync(path.join(worktree.worktreePath, "deleted.txt"));
			fs.writeFileSync(path.join(worktree.worktreePath, "untracked.txt"), "authored\n");
			fs.writeFileSync(path.join(worktree.worktreePath, "new-executable.sh"), "#!/bin/sh\nexit 0\n");
			fs.chmodSync(path.join(worktree.worktreePath, "new-executable.sh"), 0o755);
			fs.writeFileSync(path.join(worktree.worktreePath, "staged.txt"), "staged replacement\n");
			git(worktree.worktreePath, ["add", "staged.txt"]);
			fs.writeFileSync(path.join(worktree.worktreePath, "ignored.txt"), "runtime cache\n");
			fs.writeFileSync(path.join(worktree.worktreePath, "synthetic.txt"), "setup output\n");
			worktree.syntheticPaths.push("synthetic.txt");
			git(worktree.worktreePath, ["add", "--force", "synthetic.txt"]);
			const liveIndexBeforeExport = gitRaw(worktree.worktreePath, ["ls-files", "--stage"]);
			fs.writeFileSync(path.join(worktree.worktreePath, "new-link-target"), "new target\n");
			fs.rmSync(path.join(worktree.worktreePath, "tracked-link"));
			fs.symlinkSync("new-link-target", path.join(worktree.worktreePath, "tracked-link"));
			const exported = exportIsolatedGitBundle(runtime, {
				outputDir: bundleDir,
				worktree,
				terminationState: "failure",
				agent: "writer",
				commitRequired: true,
			});
			assert.ok(exported.recovery, "dirty state should have an internal recovery commit");
			assert.equal(exported.terminationState, "failure");
			assert.equal(exported.incomplete, true, "dirty state without authored commit is incomplete");
			assert.equal(fs.statSync(bundleDir).mode & 0o077, 0, "bundle directory must be owner-only");
			assert.equal(fs.statSync(exported.path).mode & 0o077, 0, "bundle must be owner-only");
			const metadata = JSON.parse(exported.portableMetadata) as { recovery?: string; stagedSnapshot?: string; dirtySummary: string; bundle: { checksumScope: string; canonicalChecksum: string; canonicalSize: number }; payloadRefs: string[]; canonicalPayloadChecksum: string; canonicalPayloadSize: number; bundleSize: number; payloadSize: number; payloadChecksum: string; terminationState: string };
			assert.equal(metadata.recovery, exported.recovery);
			assert.ok(metadata.stagedSnapshot, "legitimate staged state should remain reconstructable");
			assert.equal(gitRaw(worktree.worktreePath, ["ls-files", "--stage"]), liveIndexBeforeExport, "packaging must not mutate the live child index");
			assert.equal(metadata.payloadSize, metadata.bundleSize);
			assert.equal(metadata.payloadChecksum, metadata.bundle.checksum);
			assert.equal(metadata.bundle.checksumScope, "payload");
			const canonical = metadata.payloadRefs.slice().sort().map((ref) => `${ref}\0${git(worktree.worktreePath, ["rev-parse", ref])}\n`).join("");
			assert.equal(metadata.canonicalPayloadChecksum, createHash("sha256").update(canonical).digest("hex"));
			assert.equal(metadata.canonicalPayloadSize, Buffer.byteLength(canonical));
			assert.equal(metadata.bundle.canonicalChecksum, metadata.canonicalPayloadChecksum);
			assert.equal(metadata.bundle.canonicalSize, metadata.canonicalPayloadSize);
			assert.equal(metadata.terminationState, "failure");
			assert.match(metadata.dirtySummary, /binary\.bin/);
			assert.doesNotMatch(metadata.dirtySummary, /ignored|synthetic/);
			const stagedTree = git(worktree.worktreePath, ["ls-tree", "-r", "--name-only", exported.stagedSnapshot!]).split("\n").filter(Boolean);
			assert.equal(stagedTree.includes("synthetic.txt"), false);
			const recoveryTree = git(worktree.worktreePath, ["ls-tree", "-r", "--name-only", exported.recovery!]).split("\n").filter(Boolean);
			assert.ok(recoveryTree.includes("untracked.txt"));
			assert.ok(recoveryTree.includes("staged.txt"));
			assert.ok(recoveryTree.includes("new-executable.sh"));
			assert.ok(recoveryTree.includes("tracked-link"));
			assert.equal(git(worktree.worktreePath, ["ls-tree", exported.recovery!, "executable.sh"]).split(" ")[0], "100644");
			assert.equal(git(worktree.worktreePath, ["ls-tree", exported.recovery!, "new-executable.sh"]).split(" ")[0], "100755");
			assert.equal(git(worktree.worktreePath, ["ls-tree", exported.recovery!, "tracked-link"]).split(" ")[0], "120000");
			assert.equal(git(worktree.worktreePath, ["cat-file", "blob", `${exported.recovery}:tracked-link`]), "new-link-target");
			assert.ok(!recoveryTree.includes("ignored.txt"));
			assert.ok(!recoveryTree.includes("synthetic.txt"));
			const recoveredBinary = spawnSync("git", ["-C", worktree.worktreePath, "cat-file", "blob", `${exported.recovery}:binary.bin`], { encoding: null });
			assert.equal(recoveredBinary.status, 0, recoveredBinary.stderr?.toString());
			assert.deepEqual(recoveredBinary.stdout, Buffer.from([255, 0, 3, 4]));
			assert.equal(spawnSync("git", ["bundle", "verify", exported.path], { cwd: repo, encoding: "utf8" }).status, 0);
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("treats wildcard-like synthetic filenames literally in staged and recovery refs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-literal-synthetic-test-"));
		const repo = path.join(root, "parent");
		const bundleDir = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "literal-synthetic" });
		const synthetic = "cache[*].txt";
		const sibling = "cache-a.txt";
		const worktree = createIsolatedGitWorktree(runtime, { index: 0, agent: "writer" });
		try {
			fs.writeFileSync(path.join(worktree.worktreePath, synthetic), "synthetic\\n");
			fs.writeFileSync(path.join(worktree.worktreePath, sibling), "user\\n");
			fs.writeFileSync(path.join(worktree.worktreePath, "recovery-only.txt"), "recovery\\n");
			git(worktree.worktreePath, ["--literal-pathspecs", "add", "--force", "--", synthetic, sibling]);
			worktree.syntheticPaths.push(synthetic);
			const exported = exportIsolatedGitBundle(runtime, { outputDir: bundleDir, worktree, terminationState: "failure" });
			const staged = exported.stagedSnapshot ? git(worktree.worktreePath, ["ls-tree", "-r", "--name-only", exported.stagedSnapshot]).split("\n").filter(Boolean) : [];
			const recovery = exported.recovery ? git(worktree.worktreePath, ["ls-tree", "-r", "--name-only", exported.recovery]).split("\n").filter(Boolean) : [];
			assert.equal(staged.includes(synthetic), false);
			assert.equal(recovery.includes(synthetic), false);
			assert.equal(recovery.includes(sibling), true, "literal filtering must not over-exclude the sibling filename");
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("wires production setup-hook synthetic paths into isolated recovery export", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-hook-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const hookPath = path.join(root, "setup-hook.mjs");
		fs.writeFileSync(hookPath, [
			'#!/usr/bin/env node',
			'import * as fs from "node:fs";',
			'const input = JSON.parse(fs.readFileSync(0, "utf8"));',
		'fs.writeFileSync(`${input.worktreePath}/.runtime-cache`, "generated\\n");',
		'process.stdout.write(JSON.stringify({ syntheticPaths: [".runtime-cache"] }));',
		].join("\n"));
		fs.chmodSync(hookPath, 0o755);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "hook-synthetic", worktreeSetupHook: { hookPath } });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0, agent: "writer" });
		try {
			assert.deepEqual(worktree.syntheticPaths, [".runtime-cache"]);
			const exported = exportIsolatedGitBundle(runtime, { outputDir: path.join(root, "bundles"), worktree, terminationState: "failure", commitRequired: true });
			assert.equal(exported.dirtySummary, "");
			assert.equal(exported.recovery, undefined);
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes hook-failure recovery slots without rerunning the hook", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-recovery-slots-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const hookPath = path.join(root, "setup-hook.mjs");
		const hookLog = path.join(root, "hook.log");
		fs.writeFileSync(hookPath, [
			"#!/usr/bin/env node",
			'import * as fs from "node:fs";',
			"const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
			`fs.appendFileSync(${JSON.stringify(hookLog)}, String(input.index) + "\\n");`,
			"if (input.index === 1) { fs.writeFileSync(input.worktreePath + '/hook-edit.txt', 'partial\\n'); process.exit(23); }",
			"process.stdout.write(JSON.stringify({ syntheticPaths: [] }));",
		].join("\n"));
		fs.chmodSync(hookPath, 0o755);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "recovery-slots", worktreeSetupHook: { hookPath } });
		try {
			const slotA = createIsolatedGitWorktree(runtime, { index: 0, agent: "a" });
			assert.throws(() => createIsolatedGitWorktree(runtime, { index: 1, agent: "b" }), /exit code 23/);
			const slotB = runtime.worktrees.find((worktree) => worktree.index === 1);
			assert.ok(slotB, "failed hook slot must remain registered for recovery");
			const slotC = runtime.createRecoveryWorktree({ index: 2, agent: "c" });
			assert.deepEqual(fs.readFileSync(hookLog, "utf8").trim().split("\n"), ["0", "1"]);
			const outputDir = path.join(root, "bundles");
			const bundles = [slotA, slotB, slotC].map((worktree) => exportIsolatedGitBundle(runtime, {
				outputDir,
				worktree,
				terminationState: "execution-rejected",
				agent: worktree.index === 0 ? "a" : worktree.index === 1 ? "b" : "c",
				commitRequired: true,
			}));
			assert.deepEqual(bundles.map((bundle) => bundle.terminationState), ["execution-rejected", "execution-rejected", "execution-rejected"]);
			assert.equal(bundles[0]?.incomplete, true);
			assert.equal(bundles[2]?.incomplete, true);
			assert.ok(bundles[1]?.recovery, "partial hook edits must be retained in B recovery");
			assert.match(git(slotB!.worktreePath, ["ls-tree", "-r", "--name-only", bundles[1]!.recovery!]), /hook-edit\.txt/);
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks a commit-required clean no-change export incomplete without discarding the bundle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-no-change-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "no-change" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			const exported = exportIsolatedGitBundle(runtime, { outputDir: path.join(root, "bundles"), worktree, terminationState: "success", agent: "writer", commitRequired: true });
			assert.equal(exported.incomplete, true);
			assert.equal(JSON.parse(exported.portableMetadata).incomplete, true);
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});

	it("does not mark non-commit-required dirty recovery incomplete", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-review-dirty-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "review-dirty" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0, agent: "reviewer" });
		try {
			fs.writeFileSync(path.join(worktree.worktreePath, "review.txt"), "review recovery\n");
			const bundle = exportIsolatedGitBundle(runtime, { outputDir: path.join(root, "bundles"), worktree, agent: "reviewer" });
			assert.ok(bundle.recovery);
			assert.equal(bundle.incomplete, false);
			assert.equal(JSON.parse(bundle.portableMetadata).incomplete, false);
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves the isolated runtime when bundle creation fails", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-export-failure-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "export-failure" });
		const worktree = createIsolatedGitWorktree(runtime, { index: 0 });
		const outputFile = path.join(root, "not-a-directory");
		fs.writeFileSync(outputFile, "occupied");
		try {
			assert.throws(() => exportIsolatedGitBundle(runtime, { outputDir: outputFile, worktree, terminationState: "failure" }));
			assert.equal(runtime.exportFailed, true);
			await cleanupIsolatedGitRuntime(runtime);
			assert.equal(fs.existsSync(runtime.root), true, "failed export must preserve an actionable runtime path");
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not clean up an unexported runtime worktree", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-cleanup-gate-test-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "cleanup-gate" });
		createIsolatedGitWorktree(runtime, { index: 0 });
		try {
			await cleanupIsolatedGitRuntime(runtime);
			assert.equal(fs.existsSync(runtime.root), true);
		} finally {
			await cleanupTestRuntime(runtime);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("isolated Git termination matrix preserves every terminal state in portable metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-termination-matrix-"));
		const repo = path.join(root, "parent");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Matrix Parent"]);
		git(repo, ["config", "user.email", "matrix@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const states = ["success", "failure", "timeout", "cancelled", "execution-rejected", "interrupted", "unknown"] as const;
		for (const state of states) {
			const runtime = createIsolatedGitRuntime({ cwd: repo, runId: `termination-${state}` });
			const worktree = createIsolatedGitWorktree(runtime, { index: 0, agent: "matrix" });
			try {
				const bundle = exportIsolatedGitBundle(runtime, {
					outputDir: path.join(root, "bundles", state),
					worktree,
					terminationState: state,
					agent: "matrix",
				});
				assert.equal(bundle.terminationState, state);
				assert.equal(JSON.parse(bundle.portableMetadata).terminationState, state);
			} finally {
				await cleanupTestRuntime(runtime);
			}
		}
	});

	it("keeps bundle paths collision-proof across runtimes sharing run metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-collision-test-"));
		const repo = path.join(root, "parent");
		const bundleDir = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const runtimes = [0, 1].map(() => createIsolatedGitRuntime({ cwd: repo, runId: "same-caller-run" }));
		const worktrees = runtimes.map((runtime) => createIsolatedGitWorktree(runtime, { index: 0 }));
		try {
			for (const worktree of worktrees) {
				fs.writeFileSync(path.join(worktree.worktreePath, "same.txt"), "same\n");
				const commit = spawnSync("bwrap", worktree.runtime.wrapInvocation(worktree, {
					command: "sh",
					args: ["-c", "GIT_AUTHOR_DATE='@1700000000 +0000' GIT_COMMITTER_DATE='@1700000000 +0000' git add same.txt && GIT_AUTHOR_DATE='@1700000000 +0000' GIT_COMMITTER_DATE='@1700000000 +0000' git commit -m same"],
				}).args, { encoding: "utf8" });
				assert.equal(commit.status, 0, commit.stderr);
			}
			assert.equal(git(worktrees[0]!.worktreePath, ["rev-parse", "HEAD"]), git(worktrees[1]!.worktreePath, ["rev-parse", "HEAD"]));
			const bundles = worktrees.map((worktree) => exportIsolatedGitBundle(worktree.runtime, { outputDir: bundleDir, worktree }));
			assert.notEqual(bundles[0]!.path, bundles[1]!.path);
			for (const bundle of bundles) {
				assert.equal(fs.existsSync(bundle.path), true);
				assert.equal(createHash("sha256").update(fs.readFileSync(bundle.path)).digest("hex"), bundle.checksum);
				const verify = spawnSync("git", ["bundle", "verify", bundle.path], { cwd: repo, encoding: "utf8" });
				assert.equal(verify.status, 0, verify.stderr || verify.stdout);
			}
		} finally {
			for (const runtime of runtimes) await cleanupTestRuntime(runtime);
		}
	});

	it("exports distinct bundles for multiple isolated worktrees in one runtime", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-multi-test-"));
		const repo = path.join(root, "parent");
		const bundleDir = path.join(root, "bundles");
		fs.mkdirSync(repo);
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.name", "Parent Author"]);
		git(repo, ["config", "user.email", "parent@example.invalid"]);
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		const runtime = createIsolatedGitRuntime({ cwd: repo, runId: "multi" });
		try {
			const worktrees = [0, 1].map((index) => createIsolatedGitWorktree(runtime, { index }));
			for (const [index, worktree] of worktrees.entries()) {
				fs.writeFileSync(path.join(worktree.worktreePath, `child-${index}.txt`), `child ${index}\n`);
				for (const args of [["add", "."], ["commit", "-m", `child ${index}`]]) {
					const child = spawnSync("bwrap", runtime.wrapInvocation(worktree, { command: "git", args: ["-C", worktree.worktreePath, ...args] }).args, { encoding: "utf8" });
					assert.equal(child.status, 0, child.stderr);
				}
			}
			const bundles = worktrees.map((worktree) => exportIsolatedGitBundle(runtime, { outputDir: bundleDir, worktree }));
			assert.notEqual(bundles[0]!.path, bundles[1]!.path);
			assert.notEqual(bundles[0]!.checksum, bundles[1]!.checksum);
			assert.notEqual(bundles[0]!.head, bundles[1]!.head);
			for (const bundle of bundles) {
				assert.equal(fs.existsSync(bundle.path), true);
				assert.equal(createHash("sha256").update(fs.readFileSync(bundle.path)).digest("hex"), bundle.checksum);
			}
		} finally {
			await cleanupTestRuntime(runtime);
		}
	});
});
