import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createIsolatedGitRuntime,
	hashRecoveryBundleForTests,
	MAX_RECOVERY_BUNDLE_SIZE_BYTES,
	policyServerIdentityMatchesForTests,
	startGitPolicyServerForTests,
	mapIsolatedGitCwd,
	sanitizeGitEnvironment,
	validateIsolatedMounts,
	validateIsolatedWritableMounts,
} from "../../src/sandbox/isolated-git.ts";

const fixtureRepos = new Set<string>();

function makeRepo(configureIdentity = true): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-unit-"));
	fixtureRepos.add(repo);
	spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
	if (configureIdentity) {
		spawnSync("git", ["-C", repo, "config", "user.name", "Test Author"], { encoding: "utf8" });
		spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { encoding: "utf8" });
	} else {
		// Empty local values keep this fixture independent of the host's global identity.
		spawnSync("git", ["-C", repo, "config", "user.name", ""], { encoding: "utf8" });
		spawnSync("git", ["-C", repo, "config", "user.email", ""], { encoding: "utf8" });
	}
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	spawnSync("git", ["-C", repo, "add", "base.txt"], { encoding: "utf8" });
	spawnSync("git", ["-C", repo, "-c", "user.name=Temporary", "-c", "user.email=temporary@example.invalid", "commit", "-qm", "base"], { encoding: "utf8" });
	return repo;
}

afterEach(() => {
	for (const repo of fixtureRepos) fs.rmSync(repo, { recursive: true, force: true });
	fixtureRepos.clear();
});

function policyProcessesForRun(runId: string): string[] {
	if (process.platform !== "linux") return [];
	const processes: string[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/u.test(entry)) continue;
		try {
			const command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
			if (command.includes(`pi-isolated-git-${runId}-`)) processes.push(`${entry}:${command}`);
		} catch {
			// Processes may exit while /proc is being inspected.
		}
	}
	return processes.sort();
}

describe("isolated Git guards", () => {
	it("hashes bounded bundles in chunks and rejects oversized sparse recovery files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-bundle-bound-"));
		try {
			const small = path.join(root, "small.bundle");
			fs.writeFileSync(small, "bundle-content");
			const hashed = hashRecoveryBundleForTests(small);
			assert.equal(hashed.size, Buffer.byteLength("bundle-content"));
			assert.equal(hashed.checksum.length, 64);
			const oversized = path.join(root, "oversized.bundle");
			const fd = fs.openSync(oversized, "w");
			try { fs.ftruncateSync(fd, MAX_RECOVERY_BUNDLE_SIZE_BYTES + 1); } finally { fs.closeSync(fd); }
			assert.throws(() => hashRecoveryBundleForTests(oversized), /exceeds.*recovery limit/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed for reused, gone, or crafted policy-server identities", () => {
		const argv = ["--input-type=module", "--eval", "server-source", "/tmp/host.sock", "/tmp/none.sock", "/tmp/root", "/usr/bin/git", "bwrap", "/usr/bin/node", "123", "unique-token"];
		assert.equal(policyServerIdentityMatchesForTests({ pid: process.pid, socketPath: "/tmp/host.sock", noneSocketPath: "/tmp/none.sock", ownerPid: 123, argv }), false);
		assert.equal(policyServerIdentityMatchesForTests({ pid: 999_999_999, socketPath: "/tmp/host.sock", noneSocketPath: "/tmp/none.sock", ownerPid: 123, argv }), false);
		assert.equal(policyServerIdentityMatchesForTests({ pid: process.pid, socketPath: "/tmp/other.sock", noneSocketPath: "/tmp/none.sock", ownerPid: 123, argv }), false);
	});

	it("does not let a missing startup token bypass strict teardown identity checks", () => {
		const argv = ["--input-type=module", "--eval", "server-source", "/tmp/host.sock", "/tmp/none.sock", "/tmp/root", "/usr/bin/git", "bwrap", "/usr/bin/node", String(process.pid), "unique-token"];
		// The startup-failure path must retain the captured token; a blank token
		// remains an intentional fail-closed identity mismatch.
		assert.equal(policyServerIdentityMatchesForTests({ pid: process.pid, socketPath: "/tmp/host.sock", noneSocketPath: "/tmp/none.sock", ownerPid: process.pid, argv }), false);
	});

	it("strips inherited Git redirection variables", () => {
		const env = sanitizeGitEnvironment({ GIT_DIR: "/parent/.git", GIT_INDEX_FILE: "/parent/index", GIT_CONFIG_GLOBAL: "/parent/config", PATH: "/usr/bin" });
		assert.equal(env.GIT_DIR, undefined);
		assert.equal(env.GIT_INDEX_FILE, undefined);
		assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
		assert.equal(env.PATH, "/usr/bin");
	});

	it("rejects every writable overlap with the parent common Git directory", () => {
		const common = "/repo/.git";
		assert.throws(() => validateIsolatedWritableMounts(common, [common]), /overlaps parent common Git metadata/);
		assert.throws(() => validateIsolatedWritableMounts(common, ["/repo/.git/objects"]), /overlaps parent common Git metadata/);
		assert.throws(() => validateIsolatedWritableMounts(common, ["/repo"]), /overlaps parent common Git metadata/);
		assert.doesNotThrow(() => validateIsolatedWritableMounts(common, ["/tmp/isolated-output"]));
	});

	it("canonicalizes an existing symlink before checking a nonexistent writable suffix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-symlink-"));
		const repo = path.join(root, "repo");
		const link = path.join(root, "repo-link");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.symlinkSync(repo, link, "dir");
		assert.throws(
			() => validateIsolatedWritableMounts(path.join(repo, ".git"), [path.join(link, ".git", "new-output")]),
			/overlaps parent common Git metadata/,
		);
		assert.throws(
			() => validateIsolatedWritableMounts(path.join(repo, ".git"), [path.join(link, ".git")]),
			/overlaps parent common Git metadata/,
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("rejects read-only as well as writable resource mounts around parent Git metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-resource-"));
		const common = path.join(root, "repo", ".git");
		const worktreeGitdir = path.join(common, "worktrees", "child");
		const worktreePointer = path.join(root, "repo", "worktree", ".git");
		fs.mkdirSync(worktreeGitdir, { recursive: true });
		fs.mkdirSync(path.dirname(worktreePointer), { recursive: true });
		fs.writeFileSync(worktreePointer, `gitdir: ${worktreeGitdir}\n`, "utf8");
		const alias = path.join(root, "common-alias");
		fs.symlinkSync(common, alias, "dir");
		const protectedPaths = [common, worktreeGitdir, worktreePointer];
		for (const mode of ["read-only", "writable"] as const) {
			for (const candidate of [
				common,
				path.join(common, "objects"),
				path.join(root, "repo"),
				worktreeGitdir,
				path.join(worktreeGitdir, "new", "resource"),
				worktreePointer,
				alias,
				path.join(alias, "new", "resource"),
			]) {
				assert.throws(
					() => validateIsolatedMounts(protectedPaths, [candidate], mode),
					/overlaps parent common Git metadata/,
					`${mode}: ${candidate}`,
				);
			}
		}
		assert.doesNotThrow(() => validateIsolatedMounts(protectedPaths, [path.join(root, "safe-resource")], "read-only"));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("maps repository subdirectories into the assigned isolated worktree and rejects outside paths", () => {
		const runtime = { repositoryRoot: "/repo", runtimeManaged: true, worktrees: [] } as any;
		const worktree = { runtime, worktreePath: "/tmp/private-worktree" } as any;
		runtime.worktrees.push(worktree);
		assert.equal(mapIsolatedGitCwd(worktree, "/repo"), "/tmp/private-worktree");
		assert.equal(mapIsolatedGitCwd(worktree, "/repo/packages/worker"), "/tmp/private-worktree/packages/worker");
		assert.throws(() => mapIsolatedGitCwd(worktree, "/outside"), /outside assigned repository/i);
	});

	it("fails closed for ordinary checkouts, missing identity, and unsupported provider/platform", () => {
		const ordinary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-not-repo-"));
		assert.throws(() => createIsolatedGitRuntime({ cwd: ordinary }), /not a git repository|git repository/i);
		const missingIdentity = makeRepo(false);
		assert.throws(() => createIsolatedGitRuntime({ cwd: missingIdentity }), /missing user\.(name|email)/);
		const configured = makeRepo();
		assert.throws(() => createIsolatedGitRuntime({ cwd: configured, provider: "unsupported" }), /support sandbox provider/i);
		assert.throws(() => createIsolatedGitRuntime({ cwd: configured, platform: "darwin" }), /requires Linux Bubblewrap|unsupported platform/i);
		assert.throws(() => createIsolatedGitRuntime({ cwd: configured, fallback: "none" }), /refuses fallback none/i);
	});

	it("preserves detached policy spawn errors without an unhandled event", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-policy-spawn-"));
		try {
			const spawnFailure = new Error("policy executable missing");
			const spawnPolicyServer = (() => {
				const server = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
				server.once = ((event: string, listener: (...args: any[]) => void) => {
					EventEmitter.prototype.once.call(server, event, listener);
					if (event === "error") listener(spawnFailure);
					return server;
				}) as typeof server.once;
				server.unref = () => server;
				return server;
			}) as unknown as typeof import("node:child_process").spawn;
			assert.throws(
				() => startGitPolicyServerForTests(root, "/missing/git", "/missing/node", "/missing/bwrap", spawnPolicyServer),
				(error: unknown) => error instanceof Error && /policy executable missing/.test(error.message) && (error as Error & { cause?: unknown }).cause === spawnFailure,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("adds --die-with-parent to custom policy Bubblewrap invocation", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-policy-bwrap-"));
		let source = "";
		try {
			const spawnPolicyServer = ((_: string, args: string[]) => {
				source = args[2] ?? "";
				const server = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
				(server as any).pid = process.pid;
				(server as any).unref = () => server;
				return server;
			}) as unknown as typeof import("node:child_process").spawn;
			assert.throws(() => startGitPolicyServerForTests(root, "/missing/git", "/missing/node", "/missing/bwrap", spawnPolicyServer));
			assert.match(source, /const args = \["--die-with-parent"\]/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects writable mount setup before starting a policy server or leaking a runtime", () => {
		const repo = makeRepo();
		const existingFile = path.join(repo, "existing-mount-file");
		fs.writeFileSync(existingFile, "not a directory\n");
		const runId = "leak-test";
		const beforeRoots = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`pi-isolated-git-${runId}-`)));
		const beforeProcesses = policyProcessesForRun(runId);
		let caught: unknown;
		try {
			createIsolatedGitRuntime({ cwd: repo, runId, extraWritableMounts: [existingFile] });
		} catch (error) {
			caught = error;
		}
		const cause = caught instanceof Error && caught.cause instanceof Error ? caught.cause : caught;
		assert.ok(cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EEXIST");
		const afterRoots = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`pi-isolated-git-${runId}-`)));
		assert.deepEqual(afterRoots, beforeRoots, "writable mount validation must not leave a private runtime root");
		assert.deepEqual(policyProcessesForRun(runId), beforeProcesses, "writable mount validation must not start a policy process");
	});
});
