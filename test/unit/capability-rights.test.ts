import assert from "node:assert/strict";
import test from "node:test";
import { resolveCapabilityRights, type CapabilityRightsInput } from "../../src/runs/shared/capability-rights.ts";

test("central capability policy is monotonic across role, tools, sandbox, task, lease, and parent", () => {
	const isolated = { provider: "bubblewrap", gitMode: "isolated" as const, bashWrite: true };
	const cases: Array<[string, CapabilityRightsInput, "writer" | "read-only"]> = [
		["review role", { packagedRole: "review", agentTools: ["read", "edit"], sandbox: isolated }, "read-only"],
		["explore role", { packagedRole: "explore", agentTools: ["read", "bash"], sandbox: isolated }, "read-only"],
		["generic read", { agentTools: ["read"], sandbox: isolated }, "read-only"],
		["omitted tools use the default writer-capable toolset", { sandbox: isolated }, "writer"],
		["edit in isolated checkout", { agentTools: ["read", "edit"], sandbox: isolated }, "writer"],
		["write in isolated checkout", { packagedRole: "work", agentTools: ["read", "write"], sandbox: isolated }, "writer"],
		["bash without bashWrite", { agentTools: ["bash"], sandbox: { ...isolated, bashWrite: false } }, "read-only"],
		["mutation tools with bashWrite disabled", { agentTools: ["edit"], sandbox: { ...isolated, bashWrite: false } }, "read-only"],
		["bash with bashWrite", { agentTools: ["bash"], sandbox: isolated }, "writer"],
		["read-only git mode", { agentTools: ["edit"], sandbox: { ...isolated, gitMode: "read-only" } }, "read-only"],
		["explicit task prohibition", { agentTools: ["edit"], sandbox: isolated, taskMutationProhibited: true }, "read-only"],
		["read-only parent cannot widen", { agentTools: ["edit"], sandbox: isolated, parentRights: "read-only" }, "read-only"],
		["no exclusive lease", { agentTools: ["edit"], sandbox: isolated, exclusiveLease: false }, "read-only"],
	];
	for (const [name, input, expected] of cases) assert.equal(resolveCapabilityRights(input), expected, name);
});

test("the same policy is applied for every foreground/background execution shape", () => {
	const shapes = [
		"foreground-single",
		"foreground-chain-static",
		"foreground-chain-sequential",
		"foreground-chain-dynamic",
		"foreground-chain-parallel",
		"background-single",
		"background-sequential",
		"background-static",
		"background-dynamic",
		"background-parallel",
	] as const;
	const isolated = { provider: "bubblewrap", gitMode: "isolated" as const, bashWrite: true };
	for (const shape of shapes) {
		assert.equal(resolveCapabilityRights({ packagedRole: "review", agentTools: ["read", "edit"], sandbox: isolated }), "read-only", `${shape}: review`);
		assert.equal(resolveCapabilityRights({ packagedRole: "work", agentTools: ["read", "write"], sandbox: isolated, parentRights: "read-only" }), "read-only", `${shape}: narrowed parent`);
		assert.equal(resolveCapabilityRights({ agentTools: ["read", "edit"], sandbox: isolated, taskMutationProhibited: true }), "read-only", `${shape}: task narrowing`);
		assert.equal(resolveCapabilityRights({ agentTools: ["read", "edit"], sandbox: isolated, exclusiveLease: false }), "read-only", `${shape}: lease`);
		assert.equal(resolveCapabilityRights({ packagedRole: "work", agentTools: ["read", "write"], sandbox: isolated }), "writer", `${shape}: legitimate writer`);
	}
});
