import { existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
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
	/** Absolute command used to launch child Pi (for example process.execPath). */
	spawnCommand?: string;
	/** Args paired with spawnCommand; absolute CLI script args are mounted read-only. */
	spawnArgs?: string[];
	/** Sandbox auth mode. `pi-json` mounts Pi auth JSON read-only without mounting settings JSON. */
	authMode?: string;
	/** Pi agent config directory; defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
	agentDir?: string;
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

function nearestPackageRoot(filePath: string): string | undefined {
	let dir = path.dirname(path.resolve(filePath));
	while (dir !== path.dirname(dir)) {
		const packageJson = path.join(dir, "package.json");
		if (existsSync(packageJson)) return dir;
		dir = path.dirname(dir);
	}
	return undefined;
}

function nearestNodeModulesRoot(filePath: string): string | undefined {
	const parts = path.resolve(filePath).split(path.sep);
	const index = parts.lastIndexOf("node_modules");
	if (index === -1) return undefined;
	const root = parts.slice(0, index + 1).join(path.sep) || path.sep;
	return existsSync(root) ? root : undefined;
}

function addReadonlyRuntimePath(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, filePath: string | undefined): void {
	if (!filePath || !path.isAbsolute(filePath)) return;
	const packageRoot = nearestPackageRoot(filePath);
	const nodeModulesRoot = nearestNodeModulesRoot(filePath);
	if (nodeModulesRoot) {
		addSandboxMount(mounts, seen, nodeModulesRoot, "ro");
		return;
	}
	if (packageRoot) {
		addSandboxMount(mounts, seen, packageRoot, "ro");
		return;
	}
	addSandboxMount(mounts, seen, filePath, "ro");
}

function addSandboxExtensionMountParents(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, args: string[] | undefined): void {
	if (!args) return;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--extension") continue;
		const extensionPath = args[i + 1];
		if (!extensionPath || !path.isAbsolute(extensionPath)) continue;
		addReadonlyRuntimePath(mounts, seen, extensionPath);
	}
}

function addSandboxSpawnCommandMount(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, command: string | undefined): void {
	if (!command || !path.isAbsolute(command)) return;
	const commandDir = path.dirname(command);
	const installRoot = path.basename(command) === "node" && path.basename(commandDir) === "bin"
		? path.dirname(commandDir)
		: undefined;
	if (installRoot && existsSync(installRoot)) {
		addSandboxMount(mounts, seen, installRoot, "ro");
		return;
	}
	addSandboxMount(mounts, seen, command, "ro");
}

function addSandboxSpawnMounts(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, command: string | undefined, args: string[] | undefined): void {
	addSandboxSpawnCommandMount(mounts, seen, command);
	const firstArg = args?.[0];
	if (firstArg && path.isAbsolute(firstArg) && /\.(?:mjs|cjs|js)$/i.test(firstArg)) {
		addReadonlyRuntimePath(mounts, seen, firstArg);
	}
}

function expandTilde(filePath: string): string {
	if (filePath === "~") return os.homedir();
	return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function defaultAgentDir(): string {
	return expandTilde(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

function authModeUsesPiJson(authMode: string | undefined): boolean {
	if (!authMode) return false;
	const normalized = authMode.trim().toLowerCase();
	return normalized === "pi-json"
		|| normalized === "pi-config"
		|| normalized === "auth-json"
		|| normalized === "file"
		|| normalized === "json";
}

function addSandboxAuthMounts(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, authMode: string | undefined, agentDir: string | undefined): void {
	if (!authModeUsesPiJson(authMode)) return;
	const dir = path.resolve(expandTilde(agentDir || defaultAgentDir()));
	addSandboxMount(mounts, seen, path.join(dir, "auth.json"), "ro");
	// Intentionally do NOT mount settings.json for sandboxed children.
	// Parent/user settings.json may contain npm packages that trigger
	// ambient package discovery (npm root -g) inside the sandbox, which
	// fails when npm is not available under Bubblewrap.
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
	addSandboxSpawnMounts(mounts, seen, input.spawnCommand, input.spawnArgs);
	addSandboxAuthMounts(mounts, seen, input.authMode, input.agentDir);
	return mounts;
}
