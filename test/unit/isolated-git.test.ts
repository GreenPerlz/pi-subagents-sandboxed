import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createIsolatedGitRuntime,
	mapIsolatedGitCwd,
	sanitizeGitEnvironment,
	validateIsolatedMounts,
	validateIsolatedWritableMounts,
} from "../../src/sandbox/isolated-git.ts";

function makeRepo(configureIdentity = true): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-git-unit-"));
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

describe("isolated Git guards", () => {
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

	it("removes the private runtime when writable mount setup fails after mkdtemp", () => {
		const repo = makeRepo();
		const existingFile = path.join(repo, "existing-mount-file");
		fs.writeFileSync(existingFile, "not a directory\n");
		const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-isolated-git-leak-test-")));
		assert.throws(
			() => createIsolatedGitRuntime({ cwd: repo, runId: "leak-test", extraWritableMounts: [existingFile] }),
			(error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST",
		);
		const after = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-isolated-git-leak-test-")));
		assert.deepEqual(after, before, "constructor failure leaked a private isolated Git runtime root");
	});
});
