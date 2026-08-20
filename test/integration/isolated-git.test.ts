/** Bubblewrap regression for opt-in isolated Git commits and bundle export. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
} from "../../src/sandbox/isolated-git.ts";

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
	it("protects ordinary checkout metadata when Git mode is omitted or explicitly read-only", () => {
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

	it("rejects difftool external callbacks before they can bypass Git policy", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("rejects web browsing and help web callbacks before helper invocation", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("rejects local Git callback commands before execution while preserving normal history commands", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("keeps isolated Git security policy immutable while allowing normal commits", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("rejects signing controls across local history operations while preserving safe commands", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("denies every visible Git protocol route, including mount and fd aliases", () => {
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
				const socketProbe = `const net=require('node:net'); const socket=net.createConnection('/tmp/pi-isolated-git-runtime/server.sock'); let data=''; socket.setEncoding('utf8'); socket.on('data', chunk => data += chunk); socket.on('end', () => { const response=JSON.parse(data); if (response.ok) { process.stdout.write(data); process.exitCode=1; } }); socket.on('error', error => { process.stderr.write(String(error)); process.exitCode=1; }); socket.end(JSON.stringify({cwd:process.cwd(),args:${JSON.stringify([helper, worktree.worktreePath])},env:{}})+'\\n');`;
				const direct = run(process.execPath, ["-e", socketProbe]);
				assert.equal(direct.status, 0, `direct policy socket request for ${helper} was accepted: ${direct.stdout}${direct.stderr}`);
			}
			assert.equal(git(worktree.worktreePath, ["for-each-ref", "--format=%(refname)=%(objectname)"]), refsBefore, "a denied helper route altered isolated refs");
		} finally {
			cleanupIsolatedGitRuntime(runtime);
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("copies Git identities with punctuation faithfully into isolated commits", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("lets a Bubblewrap child commit and exports one compact portable bundle without changing the parent", () => {
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
				args: ["-C", worktree.worktreePath, "commit", "-m", "isolated child"],
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
			cleanupIsolatedGitRuntime(runtime);
		}
		assert.equal(fs.existsSync(runtime.root), false);
		assert.equal(snapshot(repo), before);
		void dangling;
	});

	it("keeps bundle paths collision-proof across runtimes sharing run metadata", () => {
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
			for (const runtime of runtimes) cleanupIsolatedGitRuntime(runtime);
		}
	});

	it("exports distinct bundles for multiple isolated worktrees in one runtime", () => {
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
			cleanupIsolatedGitRuntime(runtime);
		}
	});
});
