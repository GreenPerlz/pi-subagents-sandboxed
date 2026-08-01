import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { parseChain, serializeChain } from "../../src/agents/chain-serializer.ts";
import { discoverAgents, discoverAgentsAll, type AgentConfig } from "../../src/agents/agents.ts";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { collectAgentOverridePaths, validateAgentOverridePolicy } from "../../src/runs/shared/agent-override-policy.ts";

const tempDirs: string[] = [];

function readDocumentedAgentFrontmatter(relativePath: string, name: string): Record<string, string> {
	const content = fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
	for (const match of content.matchAll(/```yaml\s*\n([\s\S]*?)```/g)) {
		const frontmatterBlock = match[1]?.match(/^(---\s*\n[\s\S]*?\n---)(?:\s*\n|$)/)?.[1];
		if (!frontmatterBlock) continue;
		const frontmatter = parseFrontmatter(frontmatterBlock).frontmatter;
		if (frontmatter.name === name) return frontmatter;
	}
	assert.fail(`missing documented custom-agent frontmatter for ${name} in ${relativePath}`);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent frontmatter acceptance and override policy", () => {
	it("keeps documented custom agents discoverable and parallel designers read-only", () => {
		const examples = [
			["skills/improve-codebase-architecture/INTERFACE-DESIGN.md", "ralph-designer"],
			["skills/improve-codebase-architecture/SKILL.md", "scout"],
			["skills/pi-subagents/sandboxing.md", "sandbox-work"],
			["skills/pi-subagents/SKILL.md", "sandbox-work"],
			["README.md", "sandbox-work"],
			["README.md", "auditor"],
		] as const;
		for (const [relativePath, name] of examples) {
			const frontmatter = readDocumentedAgentFrontmatter(relativePath, name);
			assert.ok(frontmatter.description?.trim(), `${name} needs a meaningful description`);
		}
		const ralph = readDocumentedAgentFrontmatter("skills/improve-codebase-architecture/INTERFACE-DESIGN.md", "ralph-designer");
		const tools = (ralph.tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean).sort();
		assert.deepEqual(tools, ["bash", "find", "grep", "ls", "read"]);
		assert.equal(tools.includes("edit"), false);
		assert.equal(tools.includes("write"), false);
	});

	it("serializes typed acceptance defaults and allowed override paths", () => {
		const agent: AgentConfig = {
			name: "work",
			description: "Work",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/work.md",
			acceptanceSelfReview: true,
			acceptanceMaxFinalizationTurns: 7,
			canBeChangedByAgent: ["worktree", "acceptance.*", "sandbox.provider"],
		};
		const serialized = serializeAgent(agent);
		assert.match(serialized, /acceptanceSelfReview: true/);
		assert.match(serialized, /acceptanceMaxFinalizationTurns: 7/);
		assert.match(serialized, /canBeChangedByAgent: worktree, acceptance\.\*, sandbox\.provider/);
	});

	it("defaults acceptance self-review on, turn budget to three, and paths to deny-all", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-override-defaults-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
---
Work
`, "utf-8");
		const worker = discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.acceptanceSelfReview, true);
		assert.equal(worker?.acceptanceMaxFinalizationTurns, 3);
		assert.equal(worker?.output, undefined);
		assert.equal(worker?.defaultReads, undefined);
		assert.equal(worker?.defaultProgress, false);
		assert.deepEqual(worker?.canBeChangedByAgent, []);
	});

	it("parses typed acceptance fields and comma-separated paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-override-parse-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
acceptanceSelfReview: true
acceptanceMaxFinalizationTurns: 8
canBeChangedByAgent: cwd, acceptance.*, sandbox.*
---
Work
`, "utf-8");
		const worker = discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.acceptanceSelfReview, true);
		assert.equal(worker?.acceptanceMaxFinalizationTurns, 8);
		assert.deepEqual(worker?.canBeChangedByAgent, ["cwd", "acceptance.*", "sandbox.*"]);
	});
});

describe("agent frontmatter defaultContext", () => {
	it("serializes defaultContext into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "work",
			description: "Work",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/work.md",
			defaultContext: "fork",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /defaultContext: fork/);
	});

	it("parses defaultContext from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-context-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "work.md"), `---
name: work
description: Work
defaultContext: fork
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const work = result.agents.find((agent) => agent.name === "work");
		assert.equal(work?.defaultContext, "fork");
	});

	it("loads the packaged builtin agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-context-"));
		tempDirs.push(dir);
		const agents = discoverAgentsAll(dir).builtin;

		assert.deepEqual(agents.map((agent) => agent.name).sort(), ["explore", "orchestrator", "research", "review", "work"]);
		const work = agents.find((candidate) => candidate.name === "work");
		const orchestrator = agents.find((candidate) => candidate.name === "orchestrator");
		assert.equal(work?.defaultContext, "fresh", "work should default to fresh context");
		assert.ok(orchestrator?.canBeChangedByAgent?.includes("worktree"), "orchestrator should allow a parent-owned worktree");
		assert.equal(orchestrator?.defaultReads, undefined);
		assert.equal(orchestrator?.defaultProgress, false);
		for (const agent of agents) {
			assert.equal(agent.defaultProgress, false, `${agent.name} should not opt into progress by default`);
			assert.equal(agent.output, undefined, `${agent.name} should not create an implicit output report`);
			assert.equal(agent.acceptanceSelfReview, true, `${agent.name} should enable same-session self-review`);
			assert.equal(agent.acceptanceMaxFinalizationTurns, 3, `${agent.name} should default to three self-review turns`);
			assert.ok(agent.canBeChangedByAgent?.includes("acceptance.criteria"), `${agent.name} should allow parent acceptance criteria`);
			assert.ok(agent.canBeChangedByAgent?.includes("acceptance.selfReview"), `${agent.name} should allow explicit self-review overrides`);
		}
	});

	it("loads packaged agents with bubblewrap sandbox defaults", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-sandbox-defaults-"));
		tempDirs.push(dir);
		const agents = discoverAgentsAll(dir).builtin;

		for (const agent of agents) {
			assert.deepEqual(agent.sandbox, {
				provider: "bubblewrap",
				profile: "host-toolchain",
				network: "host",
				auth: "pi-json",
				fallback: "fail",
				packageDiscovery: "closed",
			}, `${agent.name} should default to a closed bubblewrap sandbox`);
		}
	});

	it("accepts the complete packaged parent-owned orchestrator launch without per-run overrides", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-orchestrator-launch-"));
		tempDirs.push(dir);
		const agents = discoverAgentsAll(dir).builtin;
		const topLevelLaunch = {
			tasks: [{
				agent: "orchestrator",
				task: "Own one issue in the assigned worktree; relay inline findings and review the current diff.",
			}],
			worktree: true,
			async: true,
		};

		assert.deepEqual(Object.keys(topLevelLaunch).sort(), ["async", "tasks", "worktree"]);
		assert.deepEqual(validateAgentOverridePolicy(topLevelLaunch, agents), []);
		assert.deepEqual([...collectAgentOverridePaths(topLevelLaunch).get("orchestrator")!], ["worktree"]);
		const orchestrator = agents.find((agent) => agent.name === "orchestrator");
		assert.ok(orchestrator);
		assert.equal(orchestrator.canBeChangedByAgent?.some((path) => path.startsWith("sandbox")), false, "orchestrator should rely on its sandbox frontmatter default");

		for (const nestedLaunch of [
			{ agent: "explore", task: "Explore the issue and return findings inline.", async: false },
			{ agent: "work", task: "Implement the issue in this cwd without committing or staging.", async: false },
			{ agent: "review", task: "Inspect the actual current diff in fresh context.", async: false },
		]) {
			assert.deepEqual(Object.keys(nestedLaunch).sort(), ["agent", "async", "task"]);
			assert.deepEqual(validateAgentOverridePolicy(nestedLaunch, agents), []);
			const nestedAgent = agents.find((agent) => agent.name === nestedLaunch.agent);
			assert.equal(nestedAgent?.defaultContext, "fresh", `${nestedLaunch.agent} should use fresh context by default`);
			assert.equal(nestedAgent?.output, undefined, `${nestedLaunch.agent} should not save output by default`);
			assert.equal(nestedAgent?.defaultReads, undefined, `${nestedLaunch.agent} should not read a default report`);
			assert.equal(nestedAgent?.defaultProgress, false, `${nestedLaunch.agent} should not create progress by default`);
			assert.equal(nestedAgent?.sandbox?.provider, "bubblewrap", `${nestedLaunch.agent} should resolve its own sandbox default`);
		}
	});

	it("requires an explicit worktree opt-in for custom parallel writers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-custom-parallel-writer-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "parallel-work.md"), `---
name: parallel-work
description: Independent worktree writer
tools: read, grep, find, ls, bash, edit, write
canBeChangedByAgent: worktree
---
Implement the assigned task without committing.
`, "utf-8");

		const custom = discoverAgents(dir, "project").agents.find((agent) => agent.name === "parallel-work");
		assert.ok(custom, "custom parallel writer should be discovered");
		assert.deepEqual(validateAgentOverridePolicy({
			tasks: [{ agent: "parallel-work", task: "Implement independently" }],
			worktree: true,
		}, [custom]), []);

		const packagedWork = discoverAgentsAll(dir).builtin.find((agent) => agent.name === "work");
		assert.ok(packagedWork);
		assert.equal(packagedWork.canBeChangedByAgent?.includes("worktree"), false, "packaged work should remain opt-in for worktree overrides");
		assert.deepEqual(validateAgentOverridePolicy({
			tasks: [{ agent: "work", task: "Implement independently" }],
			worktree: true,
		}, [packagedWork]), [{
			agent: "work",
			paths: ["worktree"],
			allowed: packagedWork.canBeChangedByAgent ?? [],
		}]);
	});
});

describe("chain discovery", () => {
	it("prefers same-scope .chain.json over .chain.md for the same runtime name", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chain-format-precedence-"));
		tempDirs.push(dir);
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.md"), `---
name: dynamic-review
description: Markdown fallback
---

## scout

Run the markdown chain
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "JSON dynamic chain",
			chain: [
				{
					agent: "scout",
					task: "Return targets",
					as: "targets",
					outputSchema: { type: "object" },
				},
				{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
					parallel: { agent: "review", task: "Review {item.path}" },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const result = discoverAgentsAll(dir);
		const chain = result.chains.find((candidate) => candidate.name === "dynamic-review");
		assert.equal(chain?.description, "JSON dynamic chain");
		assert.equal(chain?.filePath.endsWith(".chain.json"), true);
		assert.equal("expand" in (chain?.steps[1] ?? {}), true);
	});
});

describe("agent frontmatter maxSubagentDepth", () => {
	it("serializes maxSubagentDepth into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Inspect code",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/scout.md",
			maxSubagentDepth: 1,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /maxSubagentDepth: 1/);
	});

	it("parses maxSubagentDepth from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
maxSubagentDepth: 1
---

Inspect code
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.maxSubagentDepth, 1);
	});
});

describe("agent frontmatter fallbackModels", () => {
	it("serializes fallbackModels into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "work",
			description: "Work",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/work.md",
			fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /fallbackModels: openai\/gpt-5-mini, anthropic\/claude-sonnet-4/);
	});

	it("parses fallbackModels from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-fallback-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "work.md"), `---
name: work
description: Work
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const work = result.agents.find((agent) => agent.name === "work");
		assert.deepEqual(work?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
	});
});

describe("agent frontmatter systemPromptMode", () => {
	it("serializes systemPromptMode into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "work",
			description: "Work",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/work.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /systemPromptMode: replace/);
	});

	it("parses systemPromptMode from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-mode-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "work.md"), `---
name: work
description: Work
systemPromptMode: replace
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const work = result.agents.find((agent) => agent.name === "work");
		assert.equal(work?.systemPromptMode, "replace");
	});
});

describe("agent frontmatter prompt inheritance flags", () => {
	it("serializes inheritProjectContext and inheritSkills into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "work",
			description: "Work",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: true,
			source: "project",
			filePath: "/tmp/work.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /inheritProjectContext: true/);
		assert.match(serialized, /inheritSkills: true/);
	});

	it("parses inheritProjectContext and inheritSkills from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-inheritance-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "work.md"), `---
name: work
description: Work
inheritProjectContext: true
inheritSkills: true
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const work = result.agents.find((agent) => agent.name === "work");
		assert.equal(work?.inheritProjectContext, true);
		assert.equal(work?.inheritSkills, true);
	});
});

describe("agent frontmatter prompt assembly defaults", () => {
	it("defaults ordinary agents to replace mode with no inherited context or skills", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-prompt-settings-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "work.md"), `---
name: work
description: Work
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const work = result.agents.find((agent) => agent.name === "work");
		assert.equal(work?.systemPromptMode, "replace");
		assert.equal(work?.inheritProjectContext, false);
		assert.equal(work?.inheritSkills, false);
	});

	it("builtin agents inherit project context by default", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-prompt-settings-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;

			const result = discoverAgents(dir, "both");
			const review = result.agents.find((agent) => agent.name === "review");
			const research = result.agents.find((agent) => agent.name === "research");
			const work = result.agents.find((agent) => agent.name === "work");
			assert.equal(review?.inheritProjectContext, true);
			assert.equal(research?.inheritProjectContext, true);
			assert.equal(work?.inheritProjectContext, true);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("bundled agents all have explicit tool allowlists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-tools-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-tools-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;
			const builtins = discoverAgentsAll(dir).builtin;
			assert.ok(builtins.length > 0);
			for (const agent of builtins) {
				assert.ok(agent.tools && agent.tools.length > 0, `${agent.name} should have explicit tools frontmatter`);
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("work includes the child-facing supervisor tool", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-supervisor-tool-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-supervisor-tool-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;
			const agents = discoverAgentsAll(dir).builtin;
			const agent = agents.find((candidate) => candidate.name === "work");
			assert.ok(agent, "work builtin should be discovered");
			assert.deepEqual(agent?.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"]);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("defaults delegate to append mode with inherited project context", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-delegate-default-prompt-settings-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "delegate.md"), `---
name: delegate
description: Delegate
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const delegate = result.agents.find((agent) => agent.name === "delegate");
		assert.equal(delegate?.systemPromptMode, "append");
		assert.equal(delegate?.inheritProjectContext, true);
		assert.equal(delegate?.inheritSkills, false);
	});
});

describe("packaged agent and chain discovery", () => {
	it("recursively discovers nested project agents while keeping chain files separate", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-agent-discovery-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "agents", "code-analysis", "deep");
		const nestedChainDir = path.join(dir, ".pi", "chains", "code-analysis", "deep");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.mkdirSync(nestedChainDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "scout.md"), `---
name: scout
description: Nested scout
---

Inspect code
`, "utf-8");
		fs.writeFileSync(path.join(nestedChainDir, "review.chain.md"), `---
name: review-flow
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "scout" && agent.filePath === path.join(nestedDir, "scout.md")));
		assert.ok(result.chains.find((chain) => chain.name === "review-flow" && chain.filePath === path.join(nestedChainDir, "review.chain.md")));
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("review.chain.md")), false);
	});

	it("registers packaged agents by runtime name and serializes local name plus package", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-agent-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect code
`, "utf-8");

		const scout = discoverAgents(dir, "project").agents.find((agent) => agent.name === "code-analysis.scout");
		assert.ok(scout);
		assert.equal(scout.localName, "scout");
		assert.equal(scout.packageName, "code-analysis");
		const serialized = serializeAgent(scout);
		assert.match(serialized, /^name: scout$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.scout$/m);
	});

	it("recursively discovers packaged chains by runtime name and preserves package on serialize", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-chain-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "chains", "flows");
		fs.mkdirSync(nestedDir, { recursive: true });
		const content = `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect {task}
`;
		fs.writeFileSync(path.join(nestedDir, "review.chain.md"), content, "utf-8");

		const chain = discoverAgentsAll(dir).chains.find((candidate) => candidate.name === "code-analysis.review-flow");
		assert.ok(chain);
		assert.equal(chain.localName, "review-flow");
		assert.equal(chain.packageName, "code-analysis");
		assert.equal(chain.steps[0]?.agent, "code-analysis.scout");
		const serialized = serializeChain(chain);
		assert.match(serialized, /^name: review-flow$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.match(serialized, /^## code-analysis\.scout$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.review-flow$/m);
	});

	it("keeps packaged and un-packaged runtime names distinct while preserving un-packaged precedence", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-collisions-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "scout.md"), `---
name: scout
description: Legacy scout
---

Legacy
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Project scout
---

Project
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "packaged.md"), `---
name: scout
package: code-analysis
description: Packaged scout
---

Packaged
`, "utf-8");

		const agents = discoverAgents(dir, "project").agents;
		const unqualified = agents.find((agent) => agent.name === "scout");
		const packaged = agents.find((agent) => agent.name === "code-analysis.scout");
		assert.equal(unqualified?.description, "Project scout");
		assert.equal(unqualified?.filePath, path.join(dir, ".pi", "agents", "scout.md"));
		assert.equal(packaged?.description, "Packaged scout");
	});

	it("parses packaged chains directly from serializer helpers", () => {
		const parsed = parseChain(`---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect
`, "project", "/tmp/review.chain.md");

		assert.equal(parsed.name, "code-analysis.review-flow");
		assert.equal(parsed.localName, "review-flow");
		assert.equal(parsed.packageName, "code-analysis");
		assert.match(serializeChain(parsed), /^name: review-flow$/m);
	});

	it("normalizes package frontmatter consistently for agents and chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-normalize-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: Code Analysis!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: Code Analysis!
description: Review flow
---

## code-analysis.scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "code-analysis.scout"));
		assert.ok(result.chains.find((chain) => chain.name === "code-analysis.review-flow"));
	});

	it("skips invalid package frontmatter that cannot be normalized", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-invalid-package-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: !!!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: !!!
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("scout.md")), false);
		assert.equal(result.chains.some((chain) => chain.filePath.endsWith("review.chain.md")), false);
	});
});

describe("project agent directory discovery", () => {
	it("discovers project agents from both .agents and .pi/agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "legacy.md"), `---
name: legacy
description: Legacy
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "canonical.md"), `---
name: canonical
description: Canonical
---

Canonical prompt
`, "utf-8");

		const result = discoverAgents(dir, "project");
		assert.ok(result.agents.find((agent) => agent.name === "legacy" && agent.filePath === path.join(dir, ".agents", "legacy.md")));
		assert.ok(result.agents.find((agent) => agent.name === "canonical" && agent.filePath === path.join(dir, ".pi", "agents", "canonical.md")));
		assert.equal(result.projectAgentsDir, path.join(dir, ".pi", "agents"));
	});

	it("prefers .pi/agents over .agents on project agent name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-collision-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "shared.md"), `---
name: shared
description: Legacy shared
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "shared.md"), `---
name: shared
description: Canonical shared
---

Canonical prompt
`, "utf-8");

		const shared = discoverAgents(dir, "project").agents.find((agent) => agent.name === "shared");
		assert.ok(shared);
		assert.equal(shared.filePath, path.join(dir, ".pi", "agents", "shared.md"));
		assert.equal(shared.description, "Canonical shared");
		assert.equal(shared.systemPrompt.trim(), "Canonical prompt");
	});

	it("uses the project root for the canonical project agent dir even when only .agents exists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-root-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app");
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(nested, { recursive: true });

		const result = discoverAgentsAll(nested);
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
	});

	it("discovers project chains from .pi/chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "chains", "flows"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "agents", "ignored.chain.md"), `---
name: ignored-chain
description: Ignored chain
---

## scout

Ignore
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"), `---
name: canonical-chain
description: Canonical chain
---

## work

Inspect canonical
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.chains.some((chain) => chain.name === "ignored-chain"), false);
		assert.ok(result.chains.find((chain) => chain.name === "canonical-chain" && chain.filePath === path.join(dir, ".pi", "chains", "flows", "canonical.chain.md")));
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
		assert.equal(result.projectChainDir, path.join(dir, ".pi", "chains"));
	});

	it("prefers project .pi/chains over user chains on name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-collision-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-chain-home-"));
		tempDirs.push(dir, home);
		const oldHome = process.env.HOME;
		const oldUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const userChainsDir = path.join(home, ".pi", "agent", "chains");
			fs.mkdirSync(userChainsDir, { recursive: true });
			fs.mkdirSync(path.join(dir, ".pi", "chains"), { recursive: true });
			fs.writeFileSync(path.join(userChainsDir, "shared.chain.md"), `---
name: shared-chain
description: User chain
---

## scout

Inspect user
`, "utf-8");
			fs.writeFileSync(path.join(dir, ".pi", "chains", "shared.chain.md"), `---
name: shared-chain
description: Project chain
---

## work

Inspect project
`, "utf-8");

			const sharedChains = discoverAgentsAll(dir).chains.filter((chain) => chain.name === "shared-chain");
			assert.equal(sharedChains.length, 2);
			assert.deepEqual(sharedChains.map((chain) => chain.source), ["user", "project"]);
			const savedChainLookup = new Map(sharedChains.map((chain) => [chain.name, chain]));
			const shared = savedChainLookup.get("shared-chain");
			assert.ok(shared);
			assert.equal(shared.filePath, path.join(dir, ".pi", "chains", "shared.chain.md"));
			assert.equal(shared.description, "Project chain");
			assert.equal(shared.steps[0]?.agent, "work");
			assert.equal(shared.steps[0]?.task, "Inspect project");
		} finally {
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			if (oldUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = oldUserProfile;
		}
	});
});
