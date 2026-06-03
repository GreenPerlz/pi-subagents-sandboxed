import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { SandboxMount, SandboxMountMode } from "./types.ts";

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
	cwdMode?: SandboxMountMode;
}

function addSandboxMount(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, source: string | undefined, mode: SandboxMount["mode"]): void {
	if (!source) return;
	const resolved = path.resolve(source);
	const existingMode = seen.get(resolved);
	if (existingMode) {
		if (existingMode === "ro" && mode === "rw") {
			seen.set(resolved, "rw");
			const existingMount = mounts.find((mount) => mount.source === resolved);
			if (existingMount) existingMount.mode = "rw";
		}
		return;
	}
	if (!existsSync(resolved)) return;
	seen.set(resolved, mode);
	mounts.push({ source: resolved, mode });
}

function addSandboxMountParent(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, filePath: string | undefined, mode: SandboxMount["mode"]): void {
	if (!filePath) return;
	const parent = path.dirname(filePath);
	if (mode === "rw") mkdirSync(parent, { recursive: true });
	addSandboxMount(mounts, seen, parent, mode);
}

function addSandboxSessionFileMount(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, sessionFile: string | undefined): void {
	if (!sessionFile) return;
	const resolved = path.resolve(sessionFile);
	if (existsSync(resolved)) {
		addSandboxMount(mounts, seen, resolved, "rw");
		return;
	}
	addSandboxMountParent(mounts, seen, resolved, "rw");
}

function addSandboxExtensionMountParents(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, args: string[] | undefined): void {
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
	const seen = new Map<string, SandboxMount["mode"]>();
	addSandboxMount(mounts, seen, input.cwd, input.cwdMode ?? "rw");
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
