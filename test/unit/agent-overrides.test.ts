import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, removeBuiltinAgentOverride, saveBuiltinAgentOverride } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("bundled builtin agents inherit the default model", () => {
		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.length > 0);
		assert.deepEqual(
			builtins
				.filter((agent) => agent.model !== undefined || agent.fallbackModels !== undefined)
				.map((agent) => agent.name),
			[],
		);
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					review: {
						model: "openai/gpt-5.4",
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
						completionGuard: false,
					},
				},
			},
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.source, "builtin");
		assert.equal(review.model, "openai/gpt-5.4");
		assert.equal(review.thinking, "xhigh");
		assert.equal(review.systemPromptMode, "replace");
		assert.equal(review.inheritProjectContext, true);
		assert.equal(review.inheritSkills, true);
		assert.equal(review.completionGuard, false);
		assert.equal(review.override?.scope, "user");
		assert.equal(review.override?.path, path.join(tempHome, ".pi", "agent", "settings.json"));
	});

	it("applies user subagents.json overrides to builtin agents", () => {
		const subagentsPath = path.join(tempHome, ".pi", "agent", "subagents.json");
		writeJson(subagentsPath, {
			agentOverrides: {
				review: {
					model: "openai/gpt-5.4",
					thinking: "xhigh",
				},
			},
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai/gpt-5.4");
		assert.equal(review.thinking, "xhigh");
		assert.equal(review.override?.scope, "user");
		assert.equal(review.override?.path, subagentsPath);
	});

	it("prefers dedicated subagent config over same-scope legacy settings", () => {
		const legacyPath = path.join(tempHome, ".pi", "agent", "settings.json");
		const subagentsPath = path.join(tempHome, ".pi", "agent", "subagents.json");
		writeJson(legacyPath, {
			subagents: { agentOverrides: { review: { model: "openai/legacy" } } },
		});
		writeJson(subagentsPath, {
			agentOverrides: { review: { model: "openai/dedicated" } },
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai/dedicated");
		assert.equal(review.override?.path, subagentsPath);
	});

	it("prefers project subagents.json overrides over user subagents.json overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "subagents.json"), {
			agentOverrides: { review: { model: "openai/user" } },
		});
		writeJson(path.join(tempProject, ".pi", "subagents.json"), {
			agentOverrides: { review: { model: "openai/project", thinking: "high" } },
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai/project");
		assert.equal(review.thinking, "high");
		assert.equal(review.override?.scope, "project");
		assert.equal(review.override?.path, path.join(tempProject, ".pi", "subagents.json"));
	});

	it("surfaces malformed dedicated subagent config with its path", () => {
		const subagentsPath = path.join(tempHome, ".pi", "agent", "subagents.json");
		fs.mkdirSync(path.dirname(subagentsPath), { recursive: true });
		fs.writeFileSync(subagentsPath, '{"agentOverrides":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(subagentsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("maps legacy builtin override keys onto renamed builtins", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
					},
				},
			},
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai/gpt-5.4");
		assert.equal(review.override?.scope, "user");
	});

	it("prefers project settings overrides over user settings overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } } },
		});

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai-codex/gpt-5.4-mini");
		assert.equal(review.thinking, "high");
		assert.equal(review.override?.scope, "project");
		assert.equal(review.override?.path, path.join(tempProject, ".pi", "settings.json"));
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const review = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai/gpt-5.4");
		assert.equal(review.override?.scope, "user");
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai/gpt-5.4" } } },
		});

		const review = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.notEqual(review.model, "openai/gpt-5.4");
		assert.equal(review.override, undefined);
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), '{"subagents":', "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const review = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.model, "openai-codex/gpt-5.4-mini");
		assert.equal(review.override?.scope, "project");
	});

	it("does not apply builtin settings overrides when a full project agent overrides the builtin", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { review: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(tempProject, "review", `---\nname: review\ndescription: Project review\nmodel: google/gemini-3-pro\n---\n\nUse the project review.\n`);

		const review = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "review");
		assert.ok(review);
		assert.equal(review.source, "project");
		assert.equal(review.model, "google/gemini-3-pro");
		assert.equal(review.override, undefined);
	});

	it("does not create a settings file when removing a non-existent override", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		assert.equal(fs.existsSync(settingsPath), false);
		removeBuiltinAgentOverride(tempProject, "review", "user");
		assert.equal(fs.existsSync(settingsPath), false);
	});

	it("surfaces malformed settings files instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("surfaces settings read failures without mislabeling them as parse errors", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(settingsPath, { recursive: true });

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to read settings file"),
		);
	});

	it("surfaces malformed builtin override entries instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					review: {
						inheritProjectContext: "true",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("review")
				&& error.message.includes("inheritProjectContext"),
		);
	});

	it("surfaces malformed completion guard override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					review: {
						completionGuard: "false",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("review")
				&& error.message.includes("completionGuard"),
		);
	});

	it("saving a renamed builtin override removes its legacy key", () => {
		const legacySettingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(legacySettingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: { model: "openai/old-model" },
				},
			},
		});

		saveBuiltinAgentOverride(tempProject, "review", "user", {
			model: "openai/gpt-5.4",
		});

		const settings = JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8"));
		assert.deepEqual(settings.subagents.agentOverrides.review, { model: "openai/gpt-5.4" });
		assert.equal("reviewer" in settings.subagents.agentOverrides, false);
	});

	it("saves builtin model defaults as user-scope subagents JSON settings", () => {
		const settingsPath = saveBuiltinAgentOverride(tempProject, "review", "user", {
			model: "openai/gpt-5.4",
			fallbackModels: ["openai/gpt-5-mini"],
			thinking: "high",
		});

		assert.equal(settingsPath, path.join(tempHome, ".pi", "agent", "subagents.json"));
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		assert.deepEqual(settings.agentOverrides.review, {
			model: "openai/gpt-5.4",
			fallbackModels: ["openai/gpt-5-mini"],
			thinking: "high",
		});
	});

	it("builds false sentinels when an override clears builtin fields", () => {
		const override = buildBuiltinOverrideConfig(
			{
				model: "openai-codex/gpt-5.4-mini",
				fallbackModels: ["openai/gpt-5-mini"],
				thinking: "high",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritSkills: false,
				defaultContext: "fork",
				systemPrompt: "Base prompt",
				skills: ["safe-bash"],
				tools: ["bash"],
				mcpDirectTools: ["xcodebuild_list_sims"],
				completionGuard: false,
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				defaultContext: undefined,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
				completionGuard: true,
			},
		);

		assert.deepEqual(override, {
			model: false,
			fallbackModels: false,
			thinking: false,
			systemPromptMode: "replace",
			inheritProjectContext: false,
			defaultContext: false,
			skills: false,
			tools: false,
			completionGuard: true,
		});
	});
});
