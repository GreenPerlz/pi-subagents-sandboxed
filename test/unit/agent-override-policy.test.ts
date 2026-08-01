import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectAgentOverridePaths,
	formatAgentOverridePolicyError,
	invalidAgentOverridePatterns,
	overridePathMatches,
	validateAgentOverridePolicy,
} from "../../src/runs/shared/agent-override-policy.ts";
import { makeAgent } from "../support/helpers.ts";

describe("agent override policy", () => {
	it("matches exact and segment-aware wildcard paths", () => {
		assert.equal(overridePathMatches("*", "model"), true);
		assert.equal(overridePathMatches("acceptance.*", "acceptance.criteria"), true);
		assert.equal(overridePathMatches("sandbox.*", "sandbox.provider"), true);
		assert.equal(overridePathMatches("model", "model"), true);
		assert.equal(overridePathMatches("model", "modelOverride"), false);
		assert.equal(overridePathMatches("acceptance.*", "notacceptance.criteria"), false);
		assert.equal(overridePathMatches("acceptance.*", "acceptance.review.agent"), false);
		assert.equal(overridePathMatches("model.", "model"), false);
		assert.equal(overridePathMatches("acceptance.*.", "acceptance.criteria"), false);
		assert.equal(overridePathMatches(".*", "model"), false);
	});

	it("rejects policy patterns that cannot match the guarded surface", () => {
		assert.deepEqual(invalidAgentOverridePatterns([
			"model",
			"acceptance.*",
			"sandbox.*",
			"*.provider",
			"model.",
			"acceptance.unknown",
			".*",
		]), ["model.", "acceptance.unknown", ".*"]);
	});

	it("collects only explicitly supplied paths and maps skill to skills", () => {
		const paths = collectAgentOverridePaths({
			agent: "work",
			model: "provider/model",
			skill: ["tdd"],
			acceptance: { criteria: ["ship"], selfReview: false },
			sandbox: { provider: "bubblewrap" },
		});
		assert.deepEqual([...paths.get("work")!].sort(), [
			"acceptance.criteria",
			"acceptance.selfReview",
			"model",
			"sandbox.provider",
			"skills",
		]);
	});

	it("requires shared top-level overrides to be allowed by every affected agent", () => {
		const params = { tasks: [{ agent: "one", task: "a" }, { agent: "two", task: "b" }], context: "fork", share: false };
		const one = makeAgent("one", { canBeChangedByAgent: ["context", "share"] });
		const two = makeAgent("two", { canBeChangedByAgent: ["context"] });
		const violations = validateAgentOverridePolicy(params, [one, two]);
		assert.deepEqual(violations, [{ agent: "two", paths: ["share"], allowed: ["context"] }]);
		assert.match(formatAgentOverridePolicyError(violations), /remove the denied overrides or recommend an agent-definition change to the user/);
	});

	it("requires a shared top-level worktree request from every affected agent", () => {
		const params = { tasks: [{ agent: "one", task: "a" }, { agent: "two", task: "b" }], worktree: true };
		const one = makeAgent("one", { canBeChangedByAgent: ["worktree"] });
		const two = makeAgent("two", { canBeChangedByAgent: [] });
		assert.deepEqual(validateAgentOverridePolicy(params, [one, two]), [{
			agent: "two",
			paths: ["worktree"],
			allowed: [],
		}]);
		assert.deepEqual(validateAgentOverridePolicy(params, [one, makeAgent("two", { canBeChangedByAgent: ["worktree"] })]), []);
	});

	it("treats top-level chain skill as a shared override", () => {
		const paths = collectAgentOverridePaths({
			chain: [{ agent: "one", task: "a" }, { agent: "two", task: "b" }],
			skill: ["tdd"],
		});
		assert.deepEqual([...paths.get("one")!], ["skills"]);
		assert.deepEqual([...paths.get("two")!], ["skills"]);
	});

	it("collects guarded fields across static and dynamic chain targets", () => {
		const paths = collectAgentOverridePaths({
			chain: [
				{ parallel: [{ agent: "a", task: "a", outputSchema: { type: "object" }, output: "a.md" }], cwd: "shared", worktree: true },
				{ expand: { from: { output: "items", path: "/items" } }, parallel: { agent: "b", task: "{item}", acceptance: { criteria: ["review"] } }, collect: { as: "results" } },
			],
		});
		assert.deepEqual([...paths.get("a")!].sort(), ["cwd", "output", "outputSchema", "worktree"]);
		assert.deepEqual([...paths.get("b")!].sort(), ["acceptance.criteria"]);
	});
});
