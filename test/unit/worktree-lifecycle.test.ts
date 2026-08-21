import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import test from "node:test";
import { WorktreeCleanupError, WorktreeSetupHookTeardownError, runWorktreeSetupHook } from "../../src/runs/shared/worktree.ts";

test("worktree cleanup failures retain structured recovery paths", () => {
	const error = new WorktreeCleanupError(["/tmp/worktree: removal refused"], ["/tmp/worktree"]);
	assert.equal(error.name, "WorktreeCleanupError");
	assert.deepEqual(error.failures, ["/tmp/worktree: removal refused"]);
	assert.deepEqual(error.recoverableWorktreePaths, ["/tmp/worktree"]);
	assert.match(error.message, /Recoverable worktree paths: \/tmp\/worktree/);
});

test("unproven setup-hook teardown carries handoff and worktree evidence", () => {
	const error = new WorktreeSetupHookTeardownError("hook group remained live", "/tmp/handoff.json", "/tmp/worktree");
	assert.equal(error.name, "WorktreeSetupHookTeardownError");
	assert.equal(error.handoffPath, "/tmp/handoff.json");
	assert.equal(error.worktreePath, "/tmp/worktree");
});

test("missing handoff plus invalid supervisor output preserves typed recovery evidence", () => {
	const worktreePath = fs.mkdtempSync(`${os.tmpdir()}/pi-worktree-preserved-`);
	const supervisorSpawn = (() => ({ stdout: "not-json", stderr: "", status: 0, signal: null, error: undefined })) as unknown as typeof import("node:child_process").spawnSync;
	try {
		assert.throws(
			() => runWorktreeSetupHook(
				{ hookPath: "/tmp/setup-hook", timeoutMs: 100 },
				{
					version: 1,
					repoRoot: worktreePath,
					worktreePath,
					agentCwd: worktreePath,
					branch: "hook-preserved",
					index: 0,
					runId: "hook-preserved",
					baseCommit: "base",
				},
				{ supervisorSpawn },
			),
			(error: unknown) => {
				assert.ok(error instanceof WorktreeSetupHookTeardownError);
				assert.match((error as Error).message, /invalid output without a valid process-group handoff/i);
				const evidence = error as WorktreeSetupHookTeardownError;
				assert.equal(evidence.worktreePath, worktreePath);
				assert.equal(fs.existsSync(evidence.handoffPath), true);
				assert.equal(JSON.parse(fs.readFileSync(evidence.handoffPath, "utf8")).type, "setup-hook-teardown-unproven");
				fs.rmSync(evidence.handoffPath, { force: true });
				return true;
			},
		);
	} finally {
		fs.rmSync(worktreePath, { recursive: true, force: true });
	}
});
