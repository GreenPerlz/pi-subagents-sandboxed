import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { resolveAggregateState } from "../../src/shared/aggregate-state.ts";
import { resolveSubagentResultStatus } from "../../src/intercom/result-intercom.ts";
import { buildWorkflowGraphSnapshot } from "../../src/runs/shared/workflow-graph.ts";

describe("shared aggregate lifecycle precedence", () => {
	test("failure outranks pause and cancellation", () => {
		assert.equal(resolveAggregateState(["complete", "paused", "cancelled", "failed"]), "failed");
		assert.equal(resolveAggregateState(["complete", "paused", "cancelled"]), "cancelled");
		assert.equal(resolveAggregateState(["complete", "paused"]), "paused");
	});

	test("teardown-unproven failed state remains actionable", () => {
		assert.equal(resolveAggregateState([{ state: "failed", teardownUnproven: true }]), "running");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1, teardownUnproven: true }), "detached");
	});

	test("scans all values before applying precedence", () => {
		function* values() {
			yield { state: "failed" };
			yield { state: "complete", teardownUnproven: true };
		}
		assert.equal(resolveAggregateState(values()), "running");
		assert.equal(resolveAggregateState(["complete", "running"]), "running");
	});

	test("keeps projection surfaces aligned for terminal precedence", () => {
		const cases = [
			["failed", { exitCode: 1 }],
			["cancelled", { exitCode: 1, cancelled: true }],
			["paused", { exitCode: 0, interrupted: true }],
		] as const;
		for (const [expected, result] of cases) {
			const graph = buildWorkflowGraphSnapshot({
				runId: `cross-surface-${expected}`,
				steps: [{ parallel: [{ agent: "first" }, { agent: "second" }] }],
				results: [result, { exitCode: 0 }],
			});
			assert.equal(resolveAggregateState([resolveSubagentResultStatus(result), "completed"]), expected);
			assert.equal(graph.nodes[0]?.status, expected);
		}
	});
});
