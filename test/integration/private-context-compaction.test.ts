import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "pi-subagent-runtime";
import { prepareEphemeralPiAgentDir } from "../../src/sandbox/ephemeral-auth.ts";

it("the bundled private worker runtime applies 272K and compacts between tool batches", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-context-integration-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const source = path.join(root, "source"); const run = path.join(root, "run"); const cwd = path.join(root, "project");
		for (const p of [source, run, cwd]) fs.mkdirSync(p);
		fs.writeFileSync(path.join(source, "auth.json"), "{}\n");
		fs.writeFileSync(path.join(source, "models.json"), JSON.stringify({ providers: { "context-fixture": { modelOverrides: { "gemini-3.8-flash": { contextWindow: 272000 } } } } }));
		const agentDir = prepareEphemeralPiAgentDir({ authMode: "pi-json-ephemeral", sourceAgentDir: source, tempDir: run })!;
		const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false });
		const order: string[] = [];
		let compacting = false; let calls = 0;
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		runtime.registerProvider("context-fixture", {
			api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-not-a-secret",
			models: [{ id: "gemini-3.8-flash", name: "Offline context fixture", reasoning: false, input: ["text"], cost: zeroCost, contextWindow: 1048576, maxTokens: 8192 }],
			streamSimple(model) {
				const stream = createAssistantMessageEventStream();
				const summary = compacting;
				if (!summary) calls++;
				order.push(summary ? "summary-request" : `model-request-${calls}`);
				const first = !summary && calls === 1;
				const input = first ? 255000 : 1000;
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: first ? [{ type: "toolCall", id: "fixture-call", name: "large_result", arguments: {} }] : [{ type: "text", text: summary ? "## Goal\nContinue the fixture. The tool completed successfully." : "DONE" }],
					stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: input + 50, cost: { ...zeroCost, total: 0 } },
				};
				queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); });
				return stream;
			},
		});
		const model = runtime.getModel("context-fixture", "gemini-3.8-flash")!;
		assert.equal(model.contextWindow, 272000, "private config must override an extension provider's native 1M limit");
		const settingsManager = SettingsManager.inMemory();
		assert.equal(settingsManager.getCompactionSettings().reserveTokens, 16384);
		assert.equal(model.contextWindow - settingsManager.getCompactionSettings().reserveTokens, 255616);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPromptOverride: () => "Offline test fixture.", agentsFilesOverride: () => ({ agentsFiles: [] }) });
		await loader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		// Enough prior history to leave a valid cut point outside keepRecentTokens.
		sessionManager.appendMessage({ role: "user", content: "earlier user context ".repeat(4000), timestamp: Date.now() - 2000 });
		sessionManager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "earlier assistant context ".repeat(3200) }], stopReason: "stop", timestamp: Date.now() - 1000, usage: { input: 20000, output: 20000, cacheRead: 0, cacheWrite: 0, totalTokens: 40000, cost: { ...zeroCost, total: 0 } } });
		({ session } = await createAgentSession({
			cwd, agentDir, model, modelRuntime: runtime, settingsManager, resourceLoader: loader,
			sessionManager, tools: ["large_result"],
			customTools: [{ name: "large_result", label: "Large fixture", description: "Return a large offline fixture result", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "fixture ".repeat(3000) }], details: {} }) }],
		}));
		session.subscribe((event) => {
			if (event.type === "compaction_start") { compacting = true; order.push("compaction-start"); }
			if (event.type === "compaction_end") { compacting = false; order.push("compaction-end"); }
			if (event.type === "tool_execution_end") order.push("tool-finished");
		});
		await session.prompt("Call large_result once, then say DONE.");
		assert.equal(calls, 2, JSON.stringify(order));
		assert.ok(order.includes("compaction-start"), `expected in-run compaction: ${JSON.stringify(order)}`);
		assert.ok(order.indexOf("tool-finished") < order.indexOf("compaction-start"), JSON.stringify(order));
		assert.ok(order.indexOf("compaction-end") < order.indexOf("model-request-2"), JSON.stringify(order));
		assert.ok(order.includes("summary-request"), "must run actual built-in summarization against the offline provider");
		assert.equal(session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
	} finally {
		session?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
