import { existsSync, mkdirSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectGitWorktreePointerGitdir } from "./preflight.ts";
import type { SandboxMount, SandboxMountMode, GitMode } from "./types.ts";
import { resolveGitMode } from "./config.ts";

export interface StructuredOutputMountInput {
	schemaPath?: string;
	outputPath?: string;
}

export interface NestedRouteMountInput {
	eventSink: string;
	controlInbox: string;
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
	/** Project-local Pi package roots resolved by the parent and mounted read-only. */
	packageRoots?: string[];
	cwdMode?: SandboxMountMode;
	/** Skip cwd/.git mounts when a runtime-managed isolated Git layer supplies them. */
	includeCwd?: boolean;
	/** Explicit Git access policy; read-only also protects an in-tree .git directory. */
	gitMode?: GitMode | string;
	/** Explicit user-requested read-only paths for installed toolchains/read-only inputs. */
	extraReadOnlyMounts?: string[];
	/** Explicit user-requested writable paths for caches, outputs, or work directories. */
	extraWritableMounts?: string[];
	/** Intercom state directory path (e.g. agentDir/intercom/). Mounted writable when the intercom bridge is active in a sandbox. */
	intercomStateDir?: string;
	/** Nested subagent event route. Mounted writable so sandboxed children can launch/report nested descendants. */
	nestedRoute?: NestedRouteMountInput;
	/** Parent Git metadata that must be protected even when cwd is supplied by a runtime-managed layer. */
	protectedGitPaths?: readonly string[];
}

function validateWritableGitMount(protectedGitPaths: readonly string[] | undefined, source: string): void {
	if (!protectedGitPaths) return;
	for (const protectedPath of protectedGitPaths) {
		if (!pathsOverlap(protectedPath, source)) continue;
		throw new Error(`Writable sandbox mount '${path.resolve(source)}' overlaps protected Git metadata '${path.resolve(protectedPath)}'`);
	}
}

function addSandboxMount(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	source: string | undefined,
	mode: SandboxMount["mode"],
	protectedGitPaths?: readonly string[],
): void {
	if (!source) return;
	const resolved = path.resolve(source);
	if (mode === "rw") validateWritableGitMount(protectedGitPaths, resolved);
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

function addSandboxMountParent(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	filePath: string | undefined,
	mode: SandboxMount["mode"],
	protectedGitPaths?: readonly string[],
): void {
	if (!filePath) return;
	const parent = path.dirname(filePath);
	// addSandboxMount validates before this mkdir. A nonexistent suffix must not
	// be created under protected metadata merely to discover the overlap.
	if (mode === "rw") validateWritableGitMount(protectedGitPaths, parent);
	if (mode === "rw") mkdirSync(parent, { recursive: true });
	addSandboxMount(mounts, seen, parent, mode, protectedGitPaths);
}

function addSandboxSessionFileMount(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	sessionFile: string | undefined,
	protectedGitPaths?: readonly string[],
): void {
	if (!sessionFile) return;
	const resolved = path.resolve(sessionFile);
	if (existsSync(resolved)) {
		addSandboxMount(mounts, seen, resolved, "rw", protectedGitPaths);
		return;
	}
	addSandboxMountParent(mounts, seen, resolved, "rw", protectedGitPaths);
}

function addNestedRouteMount(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	route: NestedRouteMountInput | undefined,
	protectedGitPaths?: readonly string[],
): void {
	if (!route) return;
	const eventRoot = path.dirname(path.resolve(route.eventSink));
	const controlRoot = path.dirname(path.resolve(route.controlInbox));
	if (eventRoot !== controlRoot) return;
	addSandboxMount(mounts, seen, eventRoot, "rw", protectedGitPaths);
}

function writableMountCandidates(input: SubagentSandboxMountInput): string[] {
	const candidates: string[] = [];
	const add = (candidate: string | undefined): void => {
		if (candidate) candidates.push(path.resolve(candidate));
	};
	add(input.sessionDir);
	if (input.sessionFile) {
		const resolved = path.resolve(input.sessionFile);
		add(existsSync(resolved) ? resolved : path.dirname(resolved));
	}
	add(input.artifactsDir);
	for (const filePath of [input.jsonlPath, input.outputPath, ...(input.progressPaths ?? []), ...(input.statusPaths ?? [])]) {
		if (filePath) add(path.dirname(filePath));
	}
	if (input.structuredOutput?.outputPath) add(path.dirname(input.structuredOutput.outputPath));
	for (const configuredPath of input.extraWritableMounts ?? []) add(expandTilde(configuredPath));
	add(input.intercomStateDir);
	if (input.nestedRoute) {
		const eventRoot = path.dirname(path.resolve(input.nestedRoute.eventSink));
		const controlRoot = path.dirname(path.resolve(input.nestedRoute.controlInbox));
		if (eventRoot === controlRoot) add(eventRoot);
	}
	return candidates;
}

function validateWritableMountCandidates(protectedGitPaths: readonly string[], input: SubagentSandboxMountInput): void {
	for (const candidate of writableMountCandidates(input)) validateWritableGitMount(protectedGitPaths, candidate);
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

function addReadonlyExtensionRuntimePath(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, extensionPath: string | undefined): void {
	if (!extensionPath || !path.isAbsolute(extensionPath)) return;
	const resolvedExtensionPath = path.resolve(extensionPath);
	if (existsSync(path.join(resolvedExtensionPath, "package.json"))) {
		addSandboxMount(mounts, seen, resolvedExtensionPath, "ro");
		return;
	}
	const packageRoot = nearestPackageRoot(extensionPath);
	if (packageRoot) {
		addSandboxMount(mounts, seen, packageRoot, "ro");
		return;
	}
	addReadonlyRuntimePath(mounts, seen, extensionPath);
}

function addSandboxExtensionMountParents(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, args: string[] | undefined): void {
	if (!args) return;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--extension") continue;
		const extensionPath = args[i + 1];
		if (!extensionPath || !path.isAbsolute(extensionPath)) continue;
		addReadonlyExtensionRuntimePath(mounts, seen, extensionPath);
	}
}

function addNodeRuntimeMount(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, command: string): void {
	const commandDir = path.dirname(command);
	const installRoot = path.basename(command) === "node" && path.basename(commandDir) === "bin"
		? path.dirname(commandDir)
		: undefined;
	addSandboxMount(mounts, seen, installRoot && existsSync(installRoot) ? installRoot : command, "ro");
}

function addSandboxSpawnCommandMount(mounts: SandboxMount[], seen: Map<string, SandboxMount["mode"]>, command: string | undefined): void {
	if (!command || !path.isAbsolute(command)) return;
	addNodeRuntimeMount(mounts, seen, command);
	try {
		const realCommand = realpathSync(command);
		if (realCommand !== path.resolve(command)) addNodeRuntimeMount(mounts, seen, realCommand);
	} catch {
		// The ordinary mount path handles missing or unresolvable commands.
	}
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
	addSandboxMount(mounts, seen, path.join(dir, "subagents.json"), "ro");
	// Intentionally do NOT mount settings.json for sandboxed children.
	// Parent/user settings.json may contain npm packages that trigger
	// ambient package discovery (npm root -g) inside the sandbox, which
	// fails when npm is not available under Bubblewrap.
}

function addExplicitMounts(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	paths: string[] | undefined,
	mode: SandboxMount["mode"],
	protectedGitPaths?: readonly string[],
): void {
	for (const configuredPath of paths ?? []) {
		const resolved = path.resolve(expandTilde(configuredPath));
		if (mode === "rw") validateWritableGitMount(protectedGitPaths, resolved);
		if (mode === "rw") mkdirSync(resolved, { recursive: true });
		addSandboxMount(mounts, seen, resolved, mode, protectedGitPaths);
	}
}

function canonicalPath(candidate: string): string {
	let current = path.resolve(candidate);
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(candidate);
		suffix.unshift(path.basename(current));
		current = parent;
	}
	try {
		return path.join(realpathSync.native(current), ...suffix);
	} catch {
		return path.join(path.resolve(current), ...suffix);
	}
}

function pathsOverlap(left: string, right: string): boolean {
	const leftPath = canonicalPath(left);
	const rightPath = canonicalPath(right);
	const leftRelative = path.relative(leftPath, rightPath);
	const rightRelative = path.relative(rightPath, leftPath);
	return leftRelative === "" || rightRelative === ""
		|| (!leftRelative.startsWith(".." + path.sep) && !path.isAbsolute(leftRelative))
		|| (!rightRelative.startsWith(".." + path.sep) && !path.isAbsolute(rightRelative));
}

function addGitWorktreePointerMount(
	mounts: SandboxMount[],
	seen: Map<string, SandboxMount["mode"]>,
	cwd: string,
	gitMode: GitMode | string | undefined,
	protectedGitPaths: string[],
): void {
	const detection = detectGitWorktreePointerGitdir(cwd);
	if (!detection.ok) {
		throw new Error(detection.error ?? `Invalid Git worktree .git pointer in ${path.resolve(cwd)}`);
	}
	const resolvedCwd = path.resolve(cwd);
	const gitEntry = path.join(resolvedCwd, ".git");
	const effectiveGitMode = resolveGitMode({ gitMode });
	if (existsSync(gitEntry)) protectedGitPaths.push(gitEntry);
	// Always overlay the checkout's .git entry read-only. This covers both
	// ordinary directory repositories (which have no pointerGitdir) and the
	// pointer file itself for linked worktrees.
	if (effectiveGitMode === "read-only") {
		addSandboxMount(mounts, seen, gitEntry, "ro");
	}
	if (!detection.pointerGitdir) return;
	protectedGitPaths.push(detection.pointerGitdir);
	// Mount even in-tree metadata explicitly: cwd may be writable, and the
	// nested read-only bind is what prevents an ordinary checkout from
	// modifying linked-worktree state.
	addSandboxMount(mounts, seen, detection.pointerGitdir, "ro");
	if (detection.commonGitdir) {
		protectedGitPaths.push(detection.commonGitdir);
		addSandboxMount(mounts, seen, detection.commonGitdir, "ro");
	}
}

export function buildSubagentSandboxMounts(input: SubagentSandboxMountInput): SandboxMount[] {
	const mounts: SandboxMount[] = [];
	const seen = new Map<string, SandboxMount["mode"]>();
	const protectedGitPaths: string[] = [...(input.protectedGitPaths ?? [])];
	if (input.includeCwd !== false) {
		addSandboxMount(mounts, seen, input.cwd, input.cwdMode ?? "rw");
		addGitWorktreePointerMount(mounts, seen, input.cwd, input.gitMode, protectedGitPaths);
	}
	// Validate the complete writable set before any generated parent/resource
	// directory is created by the mount assembly below.
	validateWritableMountCandidates(protectedGitPaths, input);
	addSandboxMount(mounts, seen, input.tempDir, "ro");
	addSandboxMount(mounts, seen, input.sessionDir, "rw", protectedGitPaths);
	addSandboxSessionFileMount(mounts, seen, input.sessionFile, protectedGitPaths);
	addSandboxMount(mounts, seen, input.artifactsDir, "rw", protectedGitPaths);
	addSandboxMountParent(mounts, seen, input.jsonlPath, "rw", protectedGitPaths);
	addSandboxMountParent(mounts, seen, input.outputPath, "rw", protectedGitPaths);
	for (const progressPath of input.progressPaths ?? []) addSandboxMountParent(mounts, seen, progressPath, "rw", protectedGitPaths);
	for (const statusPath of input.statusPaths ?? []) addSandboxMountParent(mounts, seen, statusPath, "rw", protectedGitPaths);
	addSandboxMountParent(mounts, seen, input.structuredOutput?.schemaPath, "ro");
	addSandboxMountParent(mounts, seen, input.structuredOutput?.outputPath, "rw", protectedGitPaths);
	for (const packageRoot of input.packageRoots ?? []) addSandboxMount(mounts, seen, packageRoot, "ro");
	addSandboxExtensionMountParents(mounts, seen, input.piArgs);
	addSandboxSpawnMounts(mounts, seen, input.spawnCommand, input.spawnArgs);
	addSandboxAuthMounts(mounts, seen, input.authMode, input.agentDir);
	addExplicitMounts(mounts, seen, input.extraReadOnlyMounts, "ro");
	addExplicitMounts(mounts, seen, input.extraWritableMounts, "rw", protectedGitPaths);
	if (input.intercomStateDir) {
		const resolved = path.resolve(input.intercomStateDir);
		validateWritableGitMount(protectedGitPaths, resolved);
		mkdirSync(resolved, { recursive: true });
		addSandboxMount(mounts, seen, resolved, "rw", protectedGitPaths);
	}
	addNestedRouteMount(mounts, seen, input.nestedRoute, protectedGitPaths);
	return mounts;
}
