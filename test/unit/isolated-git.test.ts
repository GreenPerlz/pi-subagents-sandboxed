import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolatedGitRuntime, validateIsolatedMounts, type IsolatedGitRuntime } from "../../src/sandbox/isolated-git.ts";
import { validateScopedGitCommand } from "../../src/sandbox/scoped-git-endpoint.ts";

describe("scoped Git execution policy", () => {
	it("rejects helper, repository-redirection, and read-only mutation routes", () => {
		assert.throws(() => validateScopedGitCommand(["push"], "writer"), /rejects/);
		assert.throws(() => validateScopedGitCommand(["--git-dir=/tmp/other", "status"], "writer"), /rejects/);
		assert.throws(() => validateScopedGitCommand(["commit"], "read-only"), /rejects/);
	});

	it("still rejects user-declared mounts that expose parent Git metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-user-mount-"));
		try {
			const gitDir = path.join(root, ".git");
			fs.mkdirSync(gitDir);
			assert.throws(() => validateIsolatedMounts(gitDir, [root], "read-only"), /overlaps parent common Git metadata/);
			assert.throws(() => validateIsolatedMounts(gitDir, [gitDir], "read-only"), /overlaps parent common Git metadata/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("retains runtime evidence until every endpoint owner proves closure", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-cleanup-proof-"));
		let proven = false;
		const runtime = {
			root, runtimeManaged: true, worktrees: [], exportFailed: false, exportFenceFailed: false, hookTeardownFailed: false,
			refreshRecoveryState() {}, isExported() { return true; }, async closeGitExecutionOwners() { return proven; },
		} as unknown as IsolatedGitRuntime;
		try {
			await cleanupIsolatedGitRuntime(runtime);
			assert.equal(fs.existsSync(root), true, "unproven endpoint teardown retains recovery evidence");
			proven = true;
			await cleanupIsolatedGitRuntime(runtime);
			assert.equal(fs.existsSync(root), false, "a later proven retry may remove the runtime");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
