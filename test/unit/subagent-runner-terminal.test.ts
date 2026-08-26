import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeRejectedRunnerTerminal } from "../../src/runs/background/subagent-runner.ts";

describe("subagent runner terminal recovery projection", () => {
	it("serializes cleanup-unproven rejection as idempotent failed/incomplete lifecycle truth", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-terminal-recovery-"));
		try {
			const asyncDir = path.join(root, "run");
			const resultPath = path.join(root, "result.json");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-terminal-recovery",
				mode: "single",
				state: "running",
				startedAt: 1,
				teardownUnproven: true,
				steps: [{ agent: "work", status: "paused", teardownUnproven: true }],
			}), "utf8");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "run-terminal-recovery",
				state: "running",
				success: false,
				teardownUnproven: true,
				results: [{ flatIndex: 0, agent: "work", success: false, teardownUnproven: true }],
			}), "utf8");

			writeRejectedRunnerTerminal({
				id: "run-terminal-recovery",
				asyncDir,
				resultPath,
				cwd: root,
				steps: [{ agent: "work", task: "fixture" }],
			} as never, new Error("isolated Git cleanup failed"));

			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
			const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			assert.equal(status.state, "failed");
			assert.equal(status.incomplete, true);
			assert.equal(status.teardownUnproven, true);
			assert.equal(status.steps[0].status, "failed");
			assert.equal(result.state, "failed");
			assert.equal(result.incomplete, true);
			assert.equal(result.teardownUnproven, true);
			assert.equal(fs.existsSync(path.join(asyncDir, "events.jsonl")), false, "cleanup fence is retained without a completion event");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
