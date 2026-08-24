import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
	PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

type RuntimeHandler = (...args: any[]) => unknown;

function runtimeHarness() {
	const handlers = new Map<string, RuntimeHandler>();
	let structuredExecute: ((_id: string, params: { value: unknown }) => Promise<any>) | undefined;
	registerSubagentPromptRuntime({
		on(event: string, handler: RuntimeHandler) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<any> }) {
			if (tool.name === "structured_output") structuredExecute = tool.execute;
		},
	} as any);
	return { handlers, getStructuredExecute: () => structuredExecute };
}

const assistant = (stopReason: string) => ({ role: "assistant", stopReason });
const compactEvent = (reason: string, willRetry = false) => ({ reason, willRetry });
const compactContext = (pending = false) => ({ hasPendingMessages: () => pending });

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	else process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
});

describe("subagent prompt runtime", () => {
	it("cancels threshold compaction after a successful final natural stop", () => {
		const runtime = runtimeHarness();
		runtime.handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
		runtime.handlers.get("agent_start")?.({});
		runtime.handlers.get("agent_end")?.({ messages: [assistant("stop")] });

		assert.deepEqual(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), { cancel: true });
	});

	it("allows threshold compaction when continuation is pending and resets on new input", () => {
		const runtime = runtimeHarness();
		runtime.handlers.get("agent_end")?.({ messages: [assistant("stop")] });
		assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext(true)), undefined);

		runtime.handlers.get("input")?.({ text: "new prompt", source: "interactive" });
		runtime.handlers.get("message_start")?.({ message: { role: "user" } });
		assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined);
	});

	it("allows overflow, manual, and retry compactions", () => {
		for (const event of [compactEvent("overflow"), compactEvent("overflow", true), compactEvent("manual"), compactEvent("threshold", true)]) {
			const runtime = runtimeHarness();
			runtime.handlers.get("agent_end")?.({ messages: [assistant("stop")] });
			assert.equal(runtime.handlers.get("session_before_compact")?.(event, compactContext()), undefined, event.reason);
		}
	});

	it("does not cancel compaction for unsuccessful or intermediate agent ends", () => {
		for (const stopReason of ["error", "length", "aborted", "toolUse"]) {
			const runtime = runtimeHarness();
			runtime.handlers.get("agent_end")?.({ messages: [assistant(stopReason)] });
			assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined, stopReason);
		}
	});

	it("recognizes successful terminating structured output without leaking run state", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-guard-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			const runtime = runtimeHarness();
			const execute = runtime.getStructuredExecute();
			assert.ok(execute);
			runtime.handlers.get("agent_start")?.({});
			runtime.handlers.get("turn_start")?.({ turnIndex: 0 });
			runtime.handlers.get("tool_execution_start")?.({ toolCallId: "tool-1", toolName: "structured_output" });
			await execute("tool-1", { value: { ok: true } });
			runtime.handlers.get("tool_execution_end")?.({ toolCallId: "tool-1", toolName: "structured_output", result: { terminate: true }, isError: false });
			runtime.handlers.get("agent_end")?.({ messages: [assistant("toolUse")] });
			assert.deepEqual(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), { cancel: true });

			runtime.handlers.get("tool_execution_end")?.({ toolCallId: "tool-1", toolName: "structured_output", result: { terminate: true }, isError: true });
			runtime.handlers.get("agent_end")?.({ messages: [assistant("toolUse")] });
			assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined);

			const newRun = runtime.handlers.get("agent_start");
			newRun?.({});
			runtime.handlers.get("agent_end")?.({ messages: [assistant("toolUse")] });
			assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not treat a mixed terminating and non-terminating tool batch as terminal", () => {
		const runtime = runtimeHarness();
		runtime.handlers.get("agent_start")?.({});
		runtime.handlers.get("turn_start")?.({ turnIndex: 0 });
		runtime.handlers.get("tool_execution_start")?.({ toolCallId: "structured", toolName: "structured_output" });
		runtime.handlers.get("tool_execution_start")?.({ toolCallId: "other", toolName: "read" });
		runtime.handlers.get("tool_execution_end")?.({ toolCallId: "structured", toolName: "structured_output", result: { terminate: true }, isError: false });
		runtime.handlers.get("tool_execution_end")?.({ toolCallId: "other", toolName: "read", result: {}, isError: false });
		runtime.handlers.get("agent_end")?.({ messages: [assistant("toolUse")] });
		assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined);
	});

	it("allows failed structured output and keeps intermediate tool turns eligible for compaction", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-failed-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			const runtime = runtimeHarness();
			const execute = runtime.getStructuredExecute();
			assert.ok(execute);
			runtime.handlers.get("agent_start")?.({});
			runtime.handlers.get("turn_start")?.({ turnIndex: 0 });
			runtime.handlers.get("tool_execution_start")?.({ toolCallId: "tool-1", toolName: "structured_output" });
			await assert.rejects(execute("tool-1", { value: { ok: "not-a-boolean" } }));
			runtime.handlers.get("tool_execution_end")?.({ toolCallId: "tool-1", toolName: "structured_output", result: { terminate: true }, isError: true });
			runtime.handlers.get("agent_end")?.({ messages: [assistant("toolUse")] });
			assert.equal(runtime.handlers.get("session_before_compact")?.(compactEvent("threshold"), compactContext()), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			let execute: ((_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>) | undefined;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }) {
					if (tool.name === "structured_output") execute = tool.execute;
				},
				on() {},
			} as { registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }): void; on(): void });

			assert.ok(execute, "structured_output tool should be registered");
			const result = await execute("tool-1", { value: { ok: true } });
			assert.equal(result.terminate, true);
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { ok: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips only the inherited skills block", () => {
		const rewritten = stripInheritedSkills(BASE_PROMPT);
		assert.ok(rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("can strip both inherited sections together", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, call the actual edit/write tools."));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited child boundaries with the fanout boundary when authorized", () => {
		const strictPrompt = `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(strictPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
			fanoutChild: true,
		});

		assert.ok(rewritten.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("You may use the `subagent` tool only for the fanout work explicitly requested in this task."));
		assert.ok(!rewritten.includes("Do not propose or run subagents."));
		assert.equal(rewritten.lastIndexOf(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited fanout boundaries with the strict boundary when fanout is not authorized", () => {
		const fanoutPrompt = `${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(fanoutPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!rewritten.includes("explicit fanout responsibility"));
		assert.equal(rewritten.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(rewritten.includes("<skill name=\"explicit\">"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("strips the subagent orchestration skill even when inherited skills remain", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("<name>pi-subagents</name>"));
		assert.ok(!rewritten.includes("delegate to subagents"));
	});

	it("strips explicit pi-subagents skill injection from child prompts", () => {
		const prompt = "Before\n\n<skill name=\"pi-subagents\">\nDo not keep this.\n</skill>\n\n<skill name=\"safe-bash\">\nKeep this.\n</skill>\nAfter";
		const rewritten = stripSubagentOrchestrationSkill(prompt);

		assert.ok(!rewritten.includes("Do not keep this"));
		assert.ok(rewritten.includes("<skill name=\"safe-bash\">"));
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, notify, control, otherCustom]), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; setSessionName(name: string): void });

		await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("uses the fanout boundary through before_agent_start when fanout env is set", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("preserves child's own nested subagent launch/result after one-shot initial context cleanup", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		// Simulate initial context with inherited parent artifacts
		const priorParentTurn = { role: "user", content: "Earlier planning." };
		const parentSubagentResult = { role: "toolResult", toolName: "subagent", content: "parent subagent results" };
		const task = { role: "user", content: "Launch exactly one async reviewer, then status-check it once." };

		// First context event: strips inherited parent artifacts (one-shot)
		const firstResult = contextHandler?.({ messages: [priorParentTurn, parentSubagentResult, task] });
		assert.deepEqual(firstResult, { messages: [priorParentTurn, task] });

		// Child launches its own async reviewer
		const asyncLaunchCall = {
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "call-reviewer-1",
				name: "subagent",
				arguments: { agent: "reviewer", async: true, task: "smoke test" },
			}],
		};
		const asyncLaunchResult = {
			role: "toolResult",
			toolCallId: "call-reviewer-1",
			toolName: "subagent",
			content: [{ type: "text", text: "Async: reviewer [reviewer-run-1]" }],
			details: { mode: "single", asyncId: "reviewer-run-1", asyncDir: "/tmp/reviewer-run-1", results: [] },
		};

		// Second context event: child's own subagent artifacts are preserved
		const secondResult = contextHandler?.({ messages: [priorParentTurn, task, asyncLaunchCall, asyncLaunchResult] });
		assert.equal(secondResult, undefined, "one-shot cleanup should not strip child's own subagent artifacts");
	});

	it("preserves child's mixed assistant messages with subagent call after one-shot initial context cleanup", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		// Simulate initial context with inherited parent artifacts to trigger one-shot cleanup
		const priorParentTurn = { role: "user", content: "Earlier planning." };
		const parentSubagentResult = { role: "toolResult", toolName: "subagent", content: "parent subagent results" };
		const task = { role: "user", content: "Launch a reviewer." };

		// First context event: strips inherited parent artifacts
		contextHandler?.({ messages: [priorParentTurn, parentSubagentResult, task] });

		// Child's own mixed assistant message with subagent call
		const mixedLaunchCall = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will launch one reviewer." },
				{ type: "toolCall", id: "call-reviewer-1", name: "subagent", arguments: { agent: "reviewer", async: true } },
			],
		};
		const launchResult = {
			role: "toolResult",
			toolCallId: "call-reviewer-1",
			toolName: "subagent",
			content: [{ type: "text", text: "Async: reviewer [reviewer-run-1]" }],
		};

		// Second context event: child's own subagent artifacts are preserved
		const result = contextHandler?.({ messages: [priorParentTurn, task, mixedLaunchCall, launchResult] });
		assert.equal(result, undefined, "one-shot cleanup should not strip child's own subagent artifacts");
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});
