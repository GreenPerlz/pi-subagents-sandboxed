import assert from "node:assert/strict";
import test from "node:test";
import { packagedAgentIsReadOnly, packagedAgentIsWriter, resolvePackagedAgentRole } from "../../src/runs/shared/agent-role.ts";

test("packaged roles resolve their dotted package names", () => {
	assert.equal(resolvePackagedAgentRole("pi-subagents.explore"), "explore");
	assert.equal(resolvePackagedAgentRole("project.agents.work"), "work");
	assert.equal(resolvePackagedAgentRole("review"), "review");
	assert.equal(packagedAgentIsReadOnly("project.agents.review"), true);
	assert.equal(packagedAgentIsWriter("project.agents.work"), true);
	assert.equal(packagedAgentIsWriter("project.agents.review"), false);
});
