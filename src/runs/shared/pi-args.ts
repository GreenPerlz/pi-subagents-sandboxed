import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNestedPathEnv, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.ts";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS } from "../../shared/model-info.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import type { ScopedGitEndpointDescriptor } from "../../sandbox/isolated-git.ts";
const TASK_ARG_LIMIT = 8000;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-prompt-runtime.ts");
const FANOUT_CHILD_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "fanout-child.ts");
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
export const SUBAGENT_PARENT_EVENT_SINK_ENV = "PI_SUBAGENT_PARENT_EVENT_SINK";
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = "PI_SUBAGENT_PARENT_CONTROL_INBOX";
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_ROOT_RUN_ID";
export const SUBAGENT_PARENT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_RUN_ID";
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = "PI_SUBAGENT_PARENT_CHILD_INDEX";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN";
export const SUBAGENT_INTERCOM_EXTENSION_DIR_ENV = "PI_SUBAGENT_INTERCOM_EXTENSION_DIR";
export const SUBAGENT_INTERCOM_STATE_DIR_ENV = "PI_SUBAGENT_INTERCOM_STATE_DIR";
export const SUBAGENT_FAST_MODE_ENV = "PI_SUBAGENT_FAST_MODE";
export const SUBAGENT_SCOPED_GIT_ENDPOINT_ENV = "PI_SUBAGENT_SCOPED_GIT_ENDPOINT";

/** Remove ambient authority before detached runners inherit the caller env.
 * Depth limits are retained as runner policy inputs and are independently
 * tightened by authenticated config before any nested launch. */
export function sanitizeAuthorityEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const clean: Record<string, string | undefined> = { ...env };
	for (const key of Object.keys(clean)) {
		if ((key.startsWith("PI_SUBAGENT_") && key !== "PI_SUBAGENT_DEPTH" && key !== "PI_SUBAGENT_MAX_DEPTH") || key === "PI_SCOPED_GIT_ENDPOINT") delete clean[key];
	}
	return clean;
}

interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	/** Inject service_tier=priority only after the caller proves this candidate eligible. */
	fastMode?: boolean;
	thinking?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	tools?: string[];
	extensions?: string[];
	packageExtensions?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	parentEventSink?: string;
	parentControlInbox?: string;
	parentRootRunId?: string;
	parentRunId?: string;
	parentChildIndex?: number;
	parentDepth?: number;
	parentPath?: NestedPathEntry[];
	parentCapabilityToken?: string;
	/** Minimal nested endpoint identity; no host paths or authority. */
	scopedGitEndpoint?: ScopedGitEndpointDescriptor;
	/** @deprecated use scopedGitEndpoint; retained at the boundary for older callers. */
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	/**
	 * When true, the child Pi process is launched as a closed runtime:
	 * --no-extensions, --no-prompt-templates, --no-themes are added,
	 * and only explicitly required runtime extensions are loaded.
	 * This prevents ambient package discovery (e.g. npm root -g) inside sandboxes.
	 */
	sandbox?: boolean;
	/**
	 * Absolute path to the pi-intercom extension package directory.
	 * When set and sandbox is true, this is added as an explicit --extension arg
	 * so the intercom extension is loaded even in closed sandbox mode.
	 * Only effective when sandbox is true; ignored otherwise.
	 */
	sandboxIntercomExtensionDir?: string;
	/** Writable pi-intercom state directory passed through to nested sandboxed fanout children. */
	sandboxIntercomStateDir?: string;
}

interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1) as typeof THINKING_LEVELS[number])) return model;
	return `${model}:${thinking}`;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = input.model ? splitKnownThinkingSuffix(input.model).baseModel : undefined;
	if (modelArg) {
		args.push("--model", modelArg);
	}
	const thinkingArg = resolveEffectiveThinking(input.model, input.thinking);
	if (thinkingArg) {
		args.push("--thinking", thinkingArg);
	}

	const declaredBuiltinTools = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools = [...declaredBuiltinTools];
		for (const tool of input.tools) {
			if (!declaredBuiltinTools.includes(tool) && (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) {
				toolExtensionPaths.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			if (input.mcpDirectTools?.length) {
				builtinTools.push(...resolveMcpDirectToolNames(input.mcpDirectTools, input.cwd));
			}
			args.push("--tools", builtinTools.join(","));
		}
	}

	const runtimeExtensions = fanoutAuthorized
		? [PROMPT_RUNTIME_EXTENSION_PATH, FANOUT_CHILD_EXTENSION_PATH]
		: [PROMPT_RUNTIME_EXTENSION_PATH];
	const useExplicitExtensions = input.sandbox || fanoutAuthorized || input.extensions !== undefined || input.packageExtensions !== undefined;
	if (useExplicitExtensions) {
		args.push("--no-extensions");
	}
	const sandboxIntercomExtension = input.sandbox && input.sandboxIntercomExtensionDir ? [input.sandboxIntercomExtensionDir] : [];
	for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...(input.packageExtensions ?? []), ...(input.extensions ?? []), ...sandboxIntercomExtension])]) {
		args.push("--extension", extPath);
	}

	if (input.sandbox) {
		args.push("--no-prompt-templates");
		args.push("--no-themes");
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = fanoutAuthorized ? "1" : "0";
	// Routing/control authority is inherited independently from the permission to
	// launch descendants.  A leaf still has to register events in its parent's
	// route, but it must not receive fanout-child.ts or the subagent tool.
	// Ambient ancestry is accepted only as a complete route handoff; top-level
	// launches with no explicit parent route therefore suppress it.
	const inheritedNestedRoute = Boolean(
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV]
			&& process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV]
			&& process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]
			&& process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
	);
	const explicitParentRoute = input.parentEventSink !== undefined || input.parentControlInbox !== undefined || input.parentRootRunId !== undefined || input.parentCapabilityToken !== undefined;
	const routeInherited = inheritedNestedRoute && !explicitParentRoute;
	const routeEventSink = input.parentEventSink ?? (routeInherited ? process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] : undefined) ?? "";
	const routeControlInbox = input.parentControlInbox ?? (routeInherited ? process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] : undefined) ?? "";
	const routeRootRunId = input.parentRootRunId ?? (routeInherited ? process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] : undefined) ?? "";
	const routeCapabilityToken = input.parentCapabilityToken ?? (routeInherited ? process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] : undefined) ?? "";
	const routeInheritedAncestry = routeInherited || explicitParentRoute;
	const parentRunId = input.parentRunId ?? input.runId ?? (routeInherited ? process.env[SUBAGENT_RUN_ID_ENV] : undefined) ?? (routeInherited ? process.env[SUBAGENT_PARENT_RUN_ID_ENV] : undefined) ?? "";
	const parentChildIndex = input.parentChildIndex !== undefined
		? String(input.parentChildIndex)
		: input.childIndex !== undefined
			? String(input.childIndex)
			: routeInherited ? process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] ?? "" : "";
	const inheritedDepth = Number(process.env[SUBAGENT_PARENT_DEPTH_ENV]);
	const parentDepth = input.parentDepth ?? (routeInherited && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : 1);
	const parentPath = input.parentPath ?? (routeInheritedAncestry ? [
		...parseNestedPathEnv(routeInherited ? process.env[SUBAGENT_PARENT_PATH_ENV] : undefined),
		...(parentRunId ? [{
			runId: parentRunId,
			...(parentChildIndex && /^\d+$/.test(parentChildIndex) ? { stepIndex: Number(parentChildIndex) } : {}),
			...(input.childAgentName ? { agent: input.childAgentName } : {}),
		}] : []),
	] : []);
	// These values describe the authenticated route, not child-tool authority.
	env[SUBAGENT_PARENT_EVENT_SINK_ENV] = routeEventSink;
	env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = routeControlInbox;
	env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = routeRootRunId;
	env[SUBAGENT_PARENT_RUN_ID_ENV] = routeInheritedAncestry ? parentRunId : "";
	env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = routeInheritedAncestry ? parentChildIndex : "";
	env[SUBAGENT_PARENT_DEPTH_ENV] = routeInheritedAncestry ? String(parentDepth) : "";
	env[SUBAGENT_PARENT_PATH_ENV] = routeInheritedAncestry ? encodeNestedPathEnv(parentPath) : "";
	env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = routeCapabilityToken;
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
	// Explicitly clear inherited parent state so nested children resolve their
	// own candidate independently.
	env[SUBAGENT_FAST_MODE_ENV] = input.fastMode ? "1" : "0";
	// There is one endpoint transport: the live narrowed endpoint descriptor.
	const scopedGitEndpoint = input.scopedGitEndpoint;
	if (scopedGitEndpoint) {
		// The selected endpoint subtree is rebound directly onto the fixed target.
		// Its child-visible coordinate is therefore always '.', never the owner's
		// private relative path or hidden host metadata.
		env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV] = JSON.stringify({ relativeSubtree: "." });
	} else {
		// Ambient environment state is never authority. Every nested launch must
		// receive a handoff explicitly produced from the live capability above.
		env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV] = "";
	}
	if (input.intercomSessionName) {
		env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	if (input.sandbox && input.sandboxIntercomExtensionDir) {
		env[SUBAGENT_INTERCOM_EXTENSION_DIR_ENV] = input.sandboxIntercomExtensionDir;
	}
	if (input.sandbox && input.sandboxIntercomStateDir) {
		env[SUBAGENT_INTERCOM_STATE_DIR_ENV] = input.sandboxIntercomStateDir;
	}
	if (input.runId) {
		env[SUBAGENT_RUN_ID_ENV] = input.runId;
	}
	if (input.childAgentName) {
		env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
	}
	if (input.childIndex !== undefined) {
		env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	}
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}
	if (input.structuredOutput) {
		env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
		env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
	}

	return { args, env, tempDir };
}

export const parseParentPathEnv = parseNestedPathEnv;

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
