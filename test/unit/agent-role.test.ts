import assert from "node:assert/strict";
import test from "node:test";
import { packagedAgentIsReadOnly, packagedAgentIsWriter, resolvePackagedAgentRole } from "../../src/runs/shared/agent-role.ts";

test("packaged roles require the builtin discovery source", () => {
	assert.equal(resolvePackagedAgentRole("pi-subagents.explore", "builtin"), "explore");
	assert.equal(resolvePackagedAgentRole("project.agents.work", "builtin"), "work");
	assert.equal(resolvePackagedAgentRole("review", "builtin"), "review");
	assert.equal(resolvePackagedAgentRole("orchestrator", "builtin"), "orchestrator");
	assert.equal(resolvePackagedAgentRole("research", "builtin"), "explore");
	assert.equal(resolvePackagedAgentRole("work", "project"), undefined);
	assert.equal(resolvePackagedAgentRole("worker", "user"), undefined);
	assert.equal(resolvePackagedAgentRole("pi-subagents.work"), undefined);
	assert.equal(resolvePackagedAgentRole("research", "user"), undefined);
	assert.equal(resolvePackagedAgentRole("orchestrator", "project"), undefined);
	assert.equal(resolvePackagedAgentRole("research", "builtin"), "explore");
	assert.equal(packagedAgentIsReadOnly("project.agents.review", "builtin"), true);
	assert.equal(packagedAgentIsWriter("project.agents.work", "builtin"), true);
	assert.equal(packagedAgentIsReadOnly("project.agents.review", "project"), false);
	assert.equal(packagedAgentIsWriter("project.agents.review"), false);
});
