import assert from "node:assert/strict";
import test from "node:test";
import { fastModeSupportForModel, resolveFastModeStatus, shouldRequestFastMode } from "../../src/shared/fast-mode.ts";
import { buildPiArgs, SUBAGENT_FAST_MODE_ENV } from "../../src/runs/shared/pi-args.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { collectAgentOverridePaths, validateAgentOverridePolicy } from "../../src/runs/shared/agent-override-policy.ts";
import { buildSettingsRows } from "../../src/tui/subagents-settings-overlay.ts";
import { buildBuiltinOverrideConfig } from "../../src/agents/agents.ts";

const models = [
	{ provider: "openai", id: "gpt-5.4", fullId: "openai/gpt-5.4", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai", id: "gpt-5.5", fullId: "openai/gpt-5.5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai", id: "gpt-5.6-sol", fullId: "openai/gpt-5.6-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai", id: "gpt-5.6-terra", fullId: "openai/gpt-5.6-terra", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai", id: "gpt-5.6-luna", fullId: "openai/gpt-5.6-luna", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai", id: "gpt-4o", fullId: "openai/gpt-4o", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
	{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
	{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
];

test("agent frontmatter exposes fast mode without changing model or thinking", () => {
	const parsed = parseFrontmatter("---\nname: worker\ndescription: Worker\nfastMode: true\nmodel: openai/gpt-5\nthinking: high\n---\nWork");
	assert.equal(parsed.frontmatter.fastMode, "true");
	assert.equal(parsed.frontmatter.model, "openai/gpt-5");
	assert.equal(parsed.frontmatter.thinking, "high");
});

test("fast mode follows canonical models whose Pi adapter supports service tiers", () => {
	for (const model of [
		"openai/gpt-5.4",
		"openai/gpt-5.5",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
		"openai/gpt-5.6-luna",
		"openai/gpt-4o",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.6-sol",
	]) {
		assert.equal(fastModeSupportForModel(model, models), "supported", model);
	}
	assert.equal(fastModeSupportForModel("anthropic/claude-sonnet-4", models), "unsupported");
	assert.equal(fastModeSupportForModel("openai/not-in-registry", models), "unknown");
});

test("fast mode rejects registry replacements and proxies under supported keys", () => {
	assert.equal(fastModeSupportForModel("openai/gpt-5.5", [{
		provider: "openai", id: "gpt-5.5", fullId: "openai/gpt-5.5", api: "openai-completions", baseUrl: "https://proxy.example.test/v1",
	}]), "unsupported");
	assert.equal(fastModeSupportForModel("openai-codex/gpt-5.4", [{
		provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4", api: "openai-codex-responses", baseUrl: "https://proxy.example.test",
	}]), "unsupported");
	assert.equal(fastModeSupportForModel("openai/gpt-5.5", [{ provider: "openai", id: "gpt-5.5", fullId: "openai/gpt-5.5" }]), "unsupported");
});

test("fast mode causes the explicit runtime extension and child env opt-in", () => {
	const enabled = buildPiArgs({ baseArgs: [], task: "task", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, fastMode: true });
	assert.equal(enabled.env[SUBAGENT_FAST_MODE_ENV], "1");
	assert.ok(enabled.args.includes("--extension"));
	const cleared = buildPiArgs({ baseArgs: [], task: "task", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, fastMode: false });
	assert.equal(cleared.env[SUBAGENT_FAST_MODE_ENV], "0");
});

test("unsupported and unknown models preserve requested state without injecting priority", () => {
	const unsupported = resolveFastModeStatus(true, "anthropic/claude-sonnet-4", models);
	assert.deepEqual(unsupported, { requested: true, eligible: false, active: false, model: "anthropic/claude-sonnet-4" });
	assert.equal(shouldRequestFastMode(unsupported), false);
	const unknown = resolveFastModeStatus(true, "openai/not-in-registry", models);
	assert.equal(unknown?.eligible, "unknown");
	assert.equal(unknown?.active, "unknown");
	assert.equal(shouldRequestFastMode(unknown), false);
	const supported = resolveFastModeStatus(true, "openai/gpt-5.5", models);
	assert.equal(supported?.requested, true);
	assert.equal(supported?.eligible, true);
	assert.equal(supported?.active, "unknown");
	assert.equal(shouldRequestFastMode(supported), true);
});

test("the child runtime rewrites an actual provider payload only for an eligible launch", () => {
	const previous = process.env[SUBAGENT_FAST_MODE_ENV];
	const handlers = new Map<string, (event: unknown) => unknown>();
	try {
		process.env[SUBAGENT_FAST_MODE_ENV] = "1";
		registerSubagentPromptRuntime({ on(event: string, handler: (event: unknown) => unknown) {
			handlers.set(event, handler);
		} } as never);
		const rewritten = handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5", input: [] } });
		assert.deepEqual(rewritten, { model: "gpt-5.5", input: [], service_tier: "priority" });
	} finally {
		if (previous === undefined) delete process.env[SUBAGENT_FAST_MODE_ENV];
		else process.env[SUBAGENT_FAST_MODE_ENV] = previous;
	}
});

test("nested or unsupported launches clear the fast-mode environment opt-in", () => {
	const previous = process.env[SUBAGENT_FAST_MODE_ENV];
	const handlers = new Map<string, (event: unknown) => unknown>();
	try {
		const cleared = buildPiArgs({ baseArgs: [], task: "task", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, fastMode: false });
		process.env[SUBAGENT_FAST_MODE_ENV] = cleared.env[SUBAGENT_FAST_MODE_ENV];
		registerSubagentPromptRuntime({ on(event: string, handler: (event: unknown) => unknown) {
			handlers.set(event, handler);
		} } as never);
		assert.equal(handlers.has("before_provider_request"), false);
	} finally {
		if (previous === undefined) delete process.env[SUBAGENT_FAST_MODE_ENV];
		else process.env[SUBAGENT_FAST_MODE_ENV] = previous;
	}
});

test("closed sandbox fast-mode launches retain explicit runtime and intercom extensions", () => {
	const built = buildPiArgs({
		baseArgs: [],
		task: "task",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		fastMode: true,
		sandbox: true,
		sandboxIntercomExtensionDir: "/tmp/pi-intercom",
	});
	const extensions = built.args.flatMap((arg, index) => arg === "--extension" ? [built.args[index + 1]] : []);
	assert.equal(built.env[SUBAGENT_FAST_MODE_ENV], "1");
	assert.ok(built.args.includes("--no-extensions"));
	assert.ok(extensions.some((extension) => extension?.endsWith("subagent-prompt-runtime.ts")));
	assert.ok(extensions.includes("/tmp/pi-intercom"));
});

test("fastMode is a guarded override in single, parallel, static-chain, and dynamic-chain requests", () => {
	const requests = [
		{ agent: "single", fastMode: true },
		{ tasks: [{ agent: "parallel", task: "work", fastMode: true }] },
		{ chain: [{ agent: "static", task: "work", fastMode: true }] },
		{ chain: [{ expand: { from: { output: "items", path: "/items" } }, parallel: { agent: "dynamic", task: "{item}", fastMode: true }, collect: { as: "results" } }] },
	] as const;
	for (const request of requests) {
		const paths = collectAgentOverridePaths(request);
		const target = [...paths.keys()][0]!;
		assert.deepEqual([...paths.get(target)!], ["fastMode"]);
		assert.deepEqual(validateAgentOverridePolicy(request, [{ name: target, canBeChangedByAgent: ["fastMode"] } as never]), []);
		assert.deepEqual(validateAgentOverridePolicy(request, [{ name: target, canBeChangedByAgent: [] } as never]), [{ agent: target, paths: ["fastMode"], allowed: [] }]);
	}
});

test("builtin override persistence keeps fastMode independently from model and thinking", () => {
	const base = { model: "openai/gpt-5.5", fastMode: false, thinking: "high", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } as any;
	assert.deepEqual(buildBuiltinOverrideConfig(base, { ...base, fastMode: true }), { fastMode: true });
	assert.deepEqual(buildBuiltinOverrideConfig(base, { ...base, model: "openai/gpt-4o", thinking: "off", fastMode: false }), { model: "openai/gpt-4o", thinking: "off" });
});

test("settings distinguish fast-mode support for primary and fallback candidates", () => {
	const rows = buildSettingsRows([{
		name: "worker",
		description: "Worker",
		source: "user",
		filePath: "/tmp/worker.md",
		model: "openai/gpt-5.5",
		fallbackModels: ["anthropic/claude-sonnet-4", "unknown/model"],
		fastMode: true,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	} as never], models);
	assert.equal(rows.find((row) => row.field === "fastMode")?.value, "on (primary: supported; fallback: unsupported, unknown)");
});
