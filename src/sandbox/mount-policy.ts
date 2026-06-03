import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { SandboxMount } from "./types.ts";

export interface StructuredOutputMountInput {
	schemaPath?: string;
	outputPath?: string;
}

export interface SubagentSandboxMountInput {
	cwd: string;
	tempDir?: string;
	sessionDir?: string;
	sessionFile?: string;
	artifactsDir?: string;
	jsonlPath?: string;
	outputPath?: string;
	progressPaths?: string[];
	statusPaths?: string[];
	structuredOutput?: StructuredOutputMountInput;
	piArgs?: string[];
}

function addSandboxMount(mounts: SandboxMount[], seen: Set<string>, source: string | undefined, mode: SandboxMount["mode"]): void {
	if (!source) return;
	const resolved = path.resolve(source);
	if (seen.has(resolved)) return;
	if (!existsSync(resolved)) return;
	seen.add(resolved);
	mounts.push({ source: resolved, mode });
}

function addSandboxMountParent(mounts: SandboxMount[], seen: Set<string>, filePath: string | undefined, mode: SandboxMount["mode"]): void {
	if (!filePath) return;
	const parent = path.dirname(filePath);
	if (mode === "rw") mkdirSync(parent, { recursive: true });
	addSandboxMount(mounts, seen, parent, mode);
}

function addSandboxSessionFileMount(mounts: SandboxMount[], seen: Set<string>, sessionFile: string | undefined): void {
	if (!sessionFile) return;
	const resolved = path.resolve(sessionFile);
	if (existsSync(resolved)) {
		addSandboxMount(mounts, seen, resolved, "rw");
		return;
	}
	addSandboxMountParent(mounts, seen, resolved, "rw");
}

function addSandboxExtensionMountParents(mounts: SandboxMount[], seen: Set<string>, args: string[] | undefined): void {
	if (!args) return;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--extension") continue;
		const extensionPath = args[i + 1];
		if (!extensionPath || !path.isAbsolute(extensionPath)) continue;
		addSandboxMountParent(mounts, seen, extensionPath, "ro");
	}
}

export function buildSubagentSandboxMounts(input: SubagentSandboxMountInput): SandboxMount[] {
	const mounts: SandboxMount[] = [];
	const seen = new Set<string>();
	addSandboxMount(mounts, seen, input.cwd, "rw");
	addSandboxMount(mounts, seen, input.tempDir, "ro");
	addSandboxMount(mounts, seen, input.sessionDir, "rw");
	addSandboxSessionFileMount(mounts, seen, input.sessionFile);
	addSandboxMount(mounts, seen, input.artifactsDir, "rw");
	addSandboxMountParent(mounts, seen, input.jsonlPath, "rw");
	addSandboxMountParent(mounts, seen, input.outputPath, "rw");
	for (const progressPath of input.progressPaths ?? []) addSandboxMountParent(mounts, seen, progressPath, "rw");
	for (const statusPath of input.statusPaths ?? []) addSandboxMountParent(mounts, seen, statusPath, "rw");
	addSandboxMountParent(mounts, seen, input.structuredOutput?.schemaPath, "ro");
	addSandboxMountParent(mounts, seen, input.structuredOutput?.outputPath, "rw");
	addSandboxExtensionMountParents(mounts, seen, input.piArgs);
	return mounts;
}
