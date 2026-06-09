import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function runReproduction(): string {
	return execFileSync(process.execPath, ["scripts/reproduce-issue-15.mjs"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

describe("issue #15 orchestrator runaway reproduction", () => {
	it("demonstrates repeated nested calls after validation failure and duplicate async starts", () => {
		const output = runReproduction();

		assert.match(output, /safe_fixture_ready/);
		assert.match(output, /malformed parallel task/);
		assert.match(output, /runaway retry after validation failure/);
		assert.match(output, /validation_failed/);
		assert.match(output, /tool-contract validation failure/);
		assert.match(output, /async_start/);
		assert.match(output, /"activeWorkersBefore":1/);
		assert.match(output, /"secondAsyncBeforeFirstCompleted":true/);
		assert.match(output, /"sandboxWorktreeFailure"/);
		assert.match(output, /interventionPoint/);
	});
});
