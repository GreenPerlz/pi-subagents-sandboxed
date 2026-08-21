import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeRejectedRunnerTerminal } from "../../src/runs/background/subagent-runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rejected runner teardown recovery (issue #59)", () => {
	it("keeps a late rejection actionable after teardown becomes unproven", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runner-rejected-"));
		tempDirs.push(asyncDir);
		const resultPath = path.join(asyncDir, "result.json");
		const statusPath = path.join(asyncDir, "status.json");
		fs.writeFileSync(statusPath, JSON.stringify({
			runId: "late-rejection",
			mode: "single",
			state: "failed",
			teardownUnproven: true,
			startedAt: 100,
			steps: [{ flatIndex: 0, agent: "worker", status: "complete", teardownUnproven: true, success: false, exitCode: 1 }],
		}), "utf8");
		fs.writeFileSync(resultPath, JSON.stringify({
			id: "late-rejection",
			state: "running",
			teardownUnproven: true,
			results: [{ flatIndex: 0, agent: "worker", success: false, teardownUnproven: true, exitCode: 1 }],
		}), "utf8");

		writeRejectedRunnerTerminal({
			id: "late-rejection",
			asyncDir,
			resultPath,
			cwd: "/tmp",
			steps: [{ agent: "worker", task: "task" }],
		} as any, new Error("late writeRunLog rejection"));

		const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.equal(status.state, "running");
		assert.equal(status.teardownUnproven, true);
		assert.equal(status.steps[0].teardownUnproven, true);
		assert.equal(result.state, "running");
		assert.equal(result.teardownUnproven, true);
		assert.equal(result.results[0].teardownUnproven, true);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		assert.equal(fs.existsSync(eventsPath), false, "recovery must not publish terminal completion");
	});
});
