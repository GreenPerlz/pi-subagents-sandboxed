import type { ResolvedSandboxConfig } from "./types.ts";

export interface SandboxWriteInferenceInput {
	tools?: string[];
	sandbox?: Pick<ResolvedSandboxConfig, "bashWrite">;
}

function isBuiltinTool(tool: string, name: string): boolean {
	return tool.trim() === name;
}

/**
 * Infers whether a sandboxed child needs its cwd/worktree mounted writable.
 * Explicit edit/write tools are writer-capable. Bash is writer-capable only
 * when the resolved sandbox config opts into bash writes.
 */
export function inferSandboxCwdWritable(input: SandboxWriteInferenceInput): boolean {
	const tools = input.tools ?? [];
	if (tools.some((tool) => isBuiltinTool(tool, "edit") || isBuiltinTool(tool, "write"))) return true;
	if (input.sandbox?.bashWrite === true && tools.some((tool) => isBuiltinTool(tool, "bash"))) return true;
	return false;
}

export function hasSandboxWritableAgent(input: { agents: Array<SandboxWriteInferenceInput>; sandbox?: ResolvedSandboxConfig }): boolean {
	if (!input.sandbox) return false;
	return input.agents.some((agent) => inferSandboxCwdWritable({ tools: agent.tools, sandbox: input.sandbox }));
}

export function sandboxParallelWorktreeRequiredMessage(scope = "Parallel sandboxed tasks"): string {
	return `${scope} include write-capable tools and require worktree: true so each writer gets an isolated writable worktree.`;
}
