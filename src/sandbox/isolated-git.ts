import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BubblewrapSandboxProvider } from "./bubblewrap.ts";
import { resolveWorktreeSetupHook, runWorktreeSetupHook, WorktreeSetupHookTeardownError, type WorktreeSetupHookConfig } from "../runs/shared/worktree.ts";
import type { GitMode, ResolvedSandboxConfig, SandboxMount, SpawnableInvocation } from "./types.ts";
import { createScopedGitEndpoint, scopedGitMounts, type ScopedGitEndpointServer, type ScopedGitRights, type ScopedGitNetwork, type ScopedGitEndpointDescriptor } from "./scoped-git-endpoint.ts";
export { cancelScopedGitChildDescriptor, createScopedGitEndpoint, delegateScopedGitWriterDescriptor, readScopedGitProcessIdentity, reserveScopedGitChildDescriptor, scopedGitInvocation, scopedGitDescriptorMounts, scopedGitMounts, validateScopedGitChildDescriptor, validateScopedGitCommand, waitForScopedGitChildRelease, waitForScopedGitProcessGone } from "./scoped-git-endpoint.ts";
export type { ScopedGitEndpointServer, ScopedGitEndpointDescriptor, ScopedGitProcessIdentity, ScopedGitRights, ScopedGitNetwork, ScopedGitScope } from "./scoped-git-endpoint.ts";
export type { GitMode } from "./types.ts";

export interface IsolatedGitRuntimeOptions {
	cwd: string;
	/** The exact commit assigned to the run. Defaults to the parent's HEAD. */
	baseCommit?: string;
	runId?: string;
	provider?: string;
	platform?: NodeJS.Platform;
	bwrapCommand?: string;
	/** Bubblewrap policy is preserved by isolated Git; isolation only changes Git mounts. */
	network?: string;
	profile?: string;
	fallback?: string;
	extraReadOnlyMounts?: string[];
	extraWritableMounts?: string[];
	/** Optional production setup hook applied to each runtime worktree. */
	worktreeSetupHook?: WorktreeSetupHookConfig;
}

export type IsolatedGitCapabilityRights = "writer" | "read-only";

/**
 * Runtime-issued authority for an inherited isolated checkout.  Capabilities
 * are intentionally opaque: callers can pass them to the runtime, but cannot
 * manufacture a valid token, worktree, or cwd identity by copying fields.
 */
export interface IsolatedGitCapability {
	readonly rights: IsolatedGitCapabilityRights;
	readonly runtimeId: string;
	readonly worktreePath: string;
	readonly cwd: string;
}


export interface IsolatedGitWorktree {
	readonly runtime: IsolatedGitRuntime;
	readonly index: number;
	readonly worktreePath: string;
	readonly gitDir: string;
	readonly gitPointerPath: string;
	readonly baseCommit: string;
	readonly userName: string;
	readonly userEmail: string;
	/** Runtime-created paths excluded from recovery snapshots by production state. */
	readonly syntheticPaths: string[];
}

export interface IsolatedGitBundle {
	path: string;
	checksum: string;
	base: string;
	head: string;
	commitSummary: string;
	/** Authored commit projection; runtime recovery/package commits are excluded. */
	commits?: Array<{ id: string; subject: string; author: string }>;
	portableMetadata: string;
	recovery?: string;
	/** Internal packaging commit containing the exact staged/index tree. */
	stagedSnapshot?: string;
	/** Tree ids make both staged and final worktree projections explicit to portable consumers. */
	stagedTree?: string;
	recoveryTree?: string;
	terminationState: IsolatedGitTerminationState;
	incomplete: boolean;
	dirtySummary: string;
	bundleSize: number;
	/** Checksum of the raw Git payload bundle generated before metadata embedding. */
	payloadChecksum: string;
	/** Byte size of the raw Git payload bundle generated before metadata embedding. */
	payloadSize: number;
	/** Checksum of a deterministic refs/object-id manifest consumers can rebuild. */
	canonicalPayloadChecksum: string;
	canonicalPayloadSize: number;
}

export type IsolatedGitTerminationState =
	| "success"
	| "failure"
	| "timeout"
	| "cancelled"
	| "execution-rejected"
	| "interrupted"
	| "unknown";

interface PortableBundleMetadata {
	/** Current metadata schema. This is packaging metadata, not a child commit. */
	schemaVersion: 2;
	version: 2;
	mode: "isolated";
	terminationState: IsolatedGitTerminationState;
	runId: string;
	agent?: string;
	base: string;
	head: string;
	recovery?: string | null;
	/** Internal packaging commit containing the exact staged/index tree, when it differs from HEAD. */
	stagedSnapshot?: string | null;
	stagedTree?: string | null;
	recoveryTree?: string | null;
	incomplete: boolean;
	commitSummary: string;
	dirtySummary: string;
	bundleSize: number;
	bundleChecksum: string;
	bundleSizeScope: "payload";
	payloadSize: number;
	payloadChecksum: string;
	payloadRefs: string[];
	canonicalPayloadChecksum: string;
	canonicalPayloadSize: number;
	commits: Array<{ id: string; subject: string; author: string }>;
	bundle: {
		/** The checksum and size cover the Git payload before this metadata blob. */
		checksum: string;
		size: number;
		checksumScope: "payload";
		canonicalChecksum: string;
		canonicalSize: number;
		canonicalScope: "refs-and-object-ids";
	};
}

const ISOLATED_GIT_TIMEOUT_MS = 15_000;
const ISOLATED_GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Recovery bundles are portable diagnostics, not an unbounded archive. */
export const MAX_RECOVERY_BUNDLE_SIZE_BYTES = 64 * 1024 * 1024;

function hashBoundedBundle(filePath: string, label: string): { checksum: string; size: number } {
	let stat = fs.statSync(filePath);
	if (!stat.isFile()) throw new Error(`isolated Git ${label} bundle is not a regular file`);
	if (!Number.isSafeInteger(stat.size) || stat.size > MAX_RECOVERY_BUNDLE_SIZE_BYTES) {
		throw new Error(`isolated Git ${label} bundle exceeds the ${MAX_RECOVERY_BUNDLE_SIZE_BYTES} byte recovery limit; preserving runtime for recovery`);
	}
	const hash = createHash("sha256");
	const fd = fs.openSync(filePath, "r");
	const chunk = Buffer.allocUnsafe(1024 * 1024);
	let offset = 0;
	try {
		while (offset < stat.size) {
			const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
			if (read === 0) throw new Error(`isolated Git ${label} bundle changed while hashing`);
			hash.update(chunk.subarray(0, read));
			offset += read;
		}
		const finalStat = fs.statSync(filePath);
		if (finalStat.size !== stat.size) throw new Error(`isolated Git ${label} bundle changed while hashing`);
	} finally {
		fs.closeSync(fd);
	}
	return { checksum: hash.digest("hex"), size: stat.size };
}

/** Narrow serial test seam for sparse-file/recovery-size bound checks. */
export function hashRecoveryBundleForTests(filePath: string): { checksum: string; size: number } {
	return hashBoundedBundle(filePath, "test");
}

interface GitCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

function runGit(cwd: string, args: string[], input?: string, extraEnv?: Record<string, string | undefined>): GitCommandResult {
	const env = { ...removeGitEnvironment(), ...extraEnv };
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		input,
		env,
		timeout: ISOLATED_GIT_TIMEOUT_MS,
		maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error instanceof Error ? result.error : undefined,
	};
}

function checkedGit(cwd: string, args: string[], input?: string, extraEnv?: Record<string, string | undefined>): string {
	const result = runGit(cwd, args, input, extraEnv);
	if (result.status !== 0) {
		const detail = result.error?.message
			|| result.stderr.trim()
			|| result.stdout.trim()
			|| `git ${args.join(" ")} failed (isolated Git command timed out or exceeded its output limit)`;
		throw new Error(`isolated Git command rejected: ${detail}`);
	}
	return result.stdout;
}

function removeGitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const clean: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("GIT_")) clean[key] = value;
	}
	return clean;
}

interface RuntimePolicySourceSnapshot {
	relative: string;
	type: "directory" | "file";
	mode: number;
	uid: number;
	dev: number;
	ino: number;
	nlink: number;
	digest?: string;
	content?: Buffer;
}

interface IsolatedGitCapabilityState {
	worktree: IsolatedGitWorktree;
	scopedEndpoint?: ScopedGitEndpointServer;
	rights: IsolatedGitCapabilityRights;
	cwd: string;
	runtime: IsolatedGitRuntime;
	released?: boolean;
}
interface IsolatedGitWorktreeState {
	observedHead: string;
	baselineRefs: Map<string, string>;
	runtimeRefs: Map<string, string>;
	writerLease?: IsolatedGitCapabilityState;
}
const isolatedGitCapabilityState = new WeakMap<object, IsolatedGitCapabilityState>();
const isolatedGitWorktreeState = new WeakMap<object, IsolatedGitWorktreeState>();
const inheritedIsolatedGitRuntimes = new WeakSet<object>();

export function isInheritedIsolatedGitRuntime(runtime: IsolatedGitRuntime): boolean {
	return inheritedIsolatedGitRuntimes.has(runtime as unknown as object);
}

function canonicalPath(candidate: string): string {
	let current = path.resolve(candidate); const suffix: string[] = [];
	while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) return path.resolve(candidate); suffix.unshift(path.basename(current)); current = parent; }
	try { return path.join(fs.realpathSync.native(current), ...suffix); } catch { return path.join(path.resolve(current), ...suffix); }
}
function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
	return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function resolveHostGitPath(): string {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) { if (!dir) continue; const candidate = path.join(dir, "git"); try { const stat = fs.statSync(candidate); if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync.native(candidate); } catch {} }
	throw new Error("isolated Git requires a discoverable host git executable");
}
function ensureBubblewrap(platform: NodeJS.Platform, command: string): void {
	if (platform !== "linux") throw new Error("isolated Git requires Linux Bubblewrap; unsupported platform");
	const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: ISOLATED_GIT_TIMEOUT_MS });
	if (result.error || result.status !== 0) throw new Error("isolated Git requires Bubblewrap (bwrap); refusing to run without the sandbox");
}
function safeRunSegment(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run"; }
export function sanitizeGitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> { const clean: Record<string, string | undefined> = {}; for (const [key, value] of Object.entries(env)) if (!key.startsWith("GIT_")) clean[key] = value; return clean; }
function authModeUsesPiJson(authMode: string | undefined): boolean { return ["pi-json", "pi-config", "auth-json", "file", "json"].includes(authMode?.trim().toLowerCase() ?? ""); }
function resolveIdentity(cwd: string): { userName: string; userEmail: string } {
	const userName = readGitConfigValue(cwd, "user.name"), userEmail = readGitConfigValue(cwd, "user.email");
	if (!userName || !userEmail) throw new Error("isolated Git requires parent Git identity; configure git user.name and user.email before launch.");
	if (/[\r\n]/u.test(userName) || /[\r\n]/u.test(userEmail)) throw new Error("isolated Git parent identity contains a newline");
	return { userName, userEmail };
}
function writePrivateGitConfig(worktree: IsolatedGitWorktree): void {
	const configPath = path.join(worktree.gitDir, "config"); fs.writeFileSync(configPath, "", "utf8");
	const set = (key: string, value: string) => checkedGit(worktree.worktreePath, ["config", "--file", configPath, key, value], undefined, worktree.runtime.gitEnv);
	for (const [key, value] of [["core.repositoryformatversion", "0"], ["core.filemode", "true"], ["core.bare", "false"], ["core.worktree", worktree.worktreePath], ["core.logallrefupdates", "false"], ["core.hooksPath", "/dev/null"], ["core.pager", "cat"], ["core.editor", ":"], ["core.sequenceEditor", ":"], ["user.name", worktree.userName], ["user.email", worktree.userEmail], ["credential.helper", ""], ["commit.gpgsign", "false"], ["tag.gpgSign", "false"]] as const) set(key, value);
	fs.chmodSync(configPath, 0o444);
}
function privatePack(baseGitDir: string, parentCwd: string, baseCommit: string): void {
	const packed = spawnSync("git", ["-C", parentCwd, "pack-objects", "--revs", "--stdout"], { input: `${baseCommit}\n`, encoding: null, env: removeGitEnvironment(), timeout: ISOLATED_GIT_TIMEOUT_MS, maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES });
	if (packed.status !== 0 || !packed.stdout || packed.stdout.length === 0) throw new Error(`isolated Git base pack rejected: ${packed.error?.message ?? "failed to construct sanitized Git base"}`);
	const indexed = spawnSync("git", ["-C", baseGitDir, "index-pack", "--stdin"], { input: packed.stdout, encoding: "utf8", env: removeGitEnvironment(), timeout: ISOLATED_GIT_TIMEOUT_MS, maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES });
	if (indexed.status !== 0) throw new Error((indexed.stderr || "failed to index sanitized Git base").trim());
}
export function validateIsolatedMounts(
	parentGitPaths: string | readonly string[],
	mounts: readonly string[],
	mode: "read-only" | "writable" = "writable",
): void {
	const expandTilde = (candidate: string): string => candidate === "~" ? os.homedir() : candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
	const protectedPaths = (Array.isArray(parentGitPaths) ? parentGitPaths : [parentGitPaths]).map((candidate) => canonicalPath(expandTilde(candidate)));
	for (const candidate of mounts) {
		const resolved = path.resolve(expandTilde(candidate));
		for (const protectedPath of protectedPaths) {
			if (!isPathWithin(protectedPath, resolved) && !isPathWithin(resolved, protectedPath)) continue;
			throw new Error(`isolated Git refuses ${mode} mount '${resolved}' because it overlaps parent common Git metadata '${protectedPath}'`);
		}
	}
}

export function validateIsolatedWritableMounts(parentCommonGitDir: string, writableMounts: readonly string[]): void {
	validateIsolatedMounts(parentCommonGitDir, writableMounts, "writable");
}

function resolveCommonGitDir(cwd: string): string {
	const raw = checkedGit(cwd, ["rev-parse", "--git-common-dir"]).trim();
	return path.resolve(cwd, raw);
}

function resolveParentGitPaths(cwd: string, commonGitDir: string): string[] {
	const rawGitDir = checkedGit(cwd, ["rev-parse", "--git-dir"]).trim();
	return [
		commonGitDir,
		path.resolve(cwd, rawGitDir),
		path.join(path.resolve(cwd), ".git"),
	];
}

function resolveBaseCommit(cwd: string, requested: string | undefined): string {
	const candidate = requested?.trim() || checkedGit(cwd, ["rev-parse", "HEAD"]).trim();
	const result = runGit(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`]);
	if (result.status !== 0) throw new Error(`isolated Git assigned base is not a commit: ${candidate}`);
	return result.stdout.trim();
}

function resolveRepositoryRoot(cwd: string): string {
	return path.resolve(checkedGit(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

function readGitConfigValue(cwd: string, key: string): string {
	const result = runGit(cwd, ["config", "--get", key]);
	if (result.status !== 0) return "";
	return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}

function createWorktree(runtime: IsolatedGitRuntime, index: number, agent?: string, runSetupHook = true): IsolatedGitWorktree {
	if (runtime.worktrees.some((candidate) => candidate.index === index)) throw new Error(`isolated Git worktree index ${index} already exists`);
	if (!Number.isInteger(index) || index < 0) throw new Error("isolated Git worktree index must be a non-negative integer");
	const worktreePath = path.join(runtime.root, "worktrees", String(index));
	const gitDir = path.join(runtime.root, "metadata", String(index));
	fs.mkdirSync(worktreePath, { recursive: true });
	fs.mkdirSync(gitDir, { recursive: true });

	fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.mkdirSync(path.join(gitDir, "refs", "tags"), { recursive: true });
	fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
	fs.mkdirSync(path.join(gitDir, "disabled-hooks"), { recursive: true });
	const gitPointerPath = path.join(worktreePath, ".git");
	const worktree = {
		runtime,
		index,
		worktreePath,
		gitDir,
		gitPointerPath,
		baseCommit: runtime.baseCommit,
		userName: runtime.userName,
		userEmail: runtime.userEmail,
		syntheticPaths: [],
	} satisfies IsolatedGitWorktree;

	fs.writeFileSync(gitPointerPath, `gitdir: ${gitDir}\n`, "utf8");
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/isolated-" + index + "\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "packed-refs"), "", "utf8");
	fs.writeFileSync(path.join(gitDir, "description"), "isolated Git metadata\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "info", "exclude"), "", "utf8");
	fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${runtime.baseGitDir}/objects\n`, "utf8");
	writePrivateGitConfig(worktree);
	checkedGit(worktreePath, ["update-ref", `refs/heads/isolated-${index}`, runtime.baseCommit], undefined, runtime.gitEnv);
	checkedGit(worktreePath, ["update-ref", "refs/heads/isolated-base", runtime.baseCommit], undefined, runtime.gitEnv);
	// Checkout the local branch name (not its full ref) so HEAD remains
	// attached and ordinary child commits advance the isolated ref naturally.
	checkedGit(worktreePath, ["checkout", "-f", `isolated-${index}`], undefined, runtime.gitEnv);
	isolatedGitWorktreeState.set(worktree, {
		observedHead: runtime.baseCommit,
		baselineRefs: new Map([
			[`refs/heads/isolated-${index}`, runtime.baseCommit],
			["refs/heads/isolated-base", runtime.baseCommit],
		]),
		runtimeRefs: new Map(),
	});
	// Register the private checkout before invoking user setup. A hook may edit
	// files and then fail; keeping the handle in the runtime makes those edits
	// reachable by the recovery exporter instead of allowing setup cleanup to
	// discard the only copy.
	runtime.worktrees.push(worktree);
	// The pointer is deliberately immutable in the child mount. Metadata remains writable.
	fs.chmodSync(gitPointerPath, 0o444);
	if (runSetupHook && runtime.worktreeSetupHook) {
		try {
			worktree.syntheticPaths.push(...runWorktreeSetupHook(runtime.worktreeSetupHook, {
			version: 1,
			repoRoot: runtime.repositoryRoot,
			worktreePath,
			agentCwd: worktreePath,
			branch: `isolated-${index}`,
			index,
			runId: runtime.runId,
			baseCommit: runtime.baseCommit,
			agent,
			}));
		} catch (error) {
			if (error instanceof WorktreeSetupHookTeardownError) runtime.markHookTeardownFailed();
			throw error;
		}
	}
	// The pointer is deliberately immutable in the child mount. Metadata remains writable.
	fs.chmodSync(gitPointerPath, 0o444);
	return worktree;
}


export class IsolatedGitRuntime {
	readonly root: string; readonly cwd: string; readonly repositoryRoot: string; readonly baseCommit: string; readonly baseGitDir: string; readonly commonGitDir: string; readonly parentGitPaths: string[];
	readonly userName: string; readonly userEmail: string; readonly gitEnv: Record<string, string | undefined>; readonly bwrapCommand: string; readonly network: string; readonly profile: string; readonly fallback: string; readonly runId: string; readonly instanceId: string; readonly gitPath: string;
	readonly extraReadOnlyMounts: string[]; readonly extraWritableMounts: string[]; readonly worktreeSetupHook?: ReturnType<typeof resolveWorktreeSetupHook>; readonly worktrees: IsolatedGitWorktree[] = [];
	private readonly exportedWorktrees = new Set<number>(); private readonly scopedEndpointOwners = new Set<ScopedGitEndpointServer>();
	exportFailed = false; exportFenceFailed = false; hookTeardownFailed = false; readonly runtimeManaged = true;
	getProtectedMountPaths(_worktree?: IsolatedGitWorktree): string[] { return [...this.parentGitPaths, this.root, path.join(this.root, "worktrees"), path.join(this.root, "metadata"), path.join(this.root, "base")]; }
	assertCapability(capability: IsolatedGitCapability, worktree?: IsolatedGitWorktree): void {
		const state = isolatedGitCapabilityState.get(capability as object);
		if (!state || state.runtime !== this || state.released || capability.runtimeId !== this.instanceId || capability.rights !== state.rights || capability.cwd !== state.cwd || (worktree !== undefined && state.worktree !== worktree)) throw new Error("isolated Git capability identity is invalid, stale, or revoked");
	}
	authorizeRequestedCwd(capability: IsolatedGitCapability, requestedCwd: string): void { this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; const mapped = mapIsolatedGitCwd(state.worktree, requestedCwd); if (!isPathWithin(state.cwd, mapped)) throw new Error(`isolated Git capability cwd '${requestedCwd}' widens the authenticated capability scope`); }
	constructor(options: IsolatedGitRuntimeOptions) {
		const cwd = path.resolve(options.cwd), provider = options.provider ?? "bubblewrap", bwrapCommand = options.bwrapCommand ?? "bwrap";
		if (provider !== "bubblewrap") throw new Error(`isolated Git does not support sandbox provider '${provider}'`); if (options.fallback === "none") throw new Error("isolated Git refuses fallback none; it cannot run without Bubblewrap"); ensureBubblewrap(options.platform ?? process.platform, bwrapCommand);
		const commonGitDir = resolveCommonGitDir(cwd), repositoryRoot = resolveRepositoryRoot(cwd), parentGitPaths = resolveParentGitPaths(cwd, commonGitDir); validateIsolatedMounts(parentGitPaths, options.extraReadOnlyMounts ?? [], "read-only"); validateIsolatedMounts(parentGitPaths, options.extraWritableMounts ?? [], "writable");
		const baseCommit = resolveBaseCommit(cwd, options.baseCommit), identity = resolveIdentity(cwd), resolvedHook = resolveWorktreeSetupHook(repositoryRoot, options.worktreeSetupHook), ro = [...(options.extraReadOnlyMounts ?? [])].map((mount) => path.resolve(mount)), rw = [...(options.extraWritableMounts ?? [])].map((mount) => path.resolve(mount));
		for (const mount of ro) if (!fs.existsSync(mount)) throw new Error(`isolated Git read-only mount does not exist: ${mount}`); for (const mount of rw) fs.mkdirSync(mount, { recursive: true });
		const runId = safeRunSegment(options.runId ?? randomUUID()), root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-isolated-git-${runId}-`));
		this.root = root; this.cwd = cwd; this.repositoryRoot = repositoryRoot; this.baseCommit = baseCommit; this.commonGitDir = commonGitDir; this.parentGitPaths = parentGitPaths; this.userName = identity.userName; this.userEmail = identity.userEmail; this.worktreeSetupHook = resolvedHook; this.bwrapCommand = bwrapCommand; this.network = options.network ?? "host"; this.profile = options.profile ?? "host-toolchain"; this.fallback = options.fallback ?? "fail"; this.runId = runId; this.instanceId = randomUUID(); this.extraReadOnlyMounts = ro; this.extraWritableMounts = rw;
		this.gitPath = resolveHostGitPath(); this.gitEnv = { ...removeGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":", GIT_ASKPASS: "/bin/false", GIT_OPTIONAL_LOCKS: "0", HOME: path.join(root, "home"), PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
		try { fs.mkdirSync(path.join(root, "home"), { recursive: true }); fs.mkdirSync(path.join(root, "worktrees"), { recursive: true }); fs.mkdirSync(path.join(root, "metadata"), { recursive: true }); this.baseGitDir = path.join(root, "base"); fs.mkdirSync(this.baseGitDir, { recursive: true }); checkedGit(this.baseGitDir, ["init", "--bare"], undefined, this.gitEnv); privatePack(this.baseGitDir, cwd, baseCommit); checkedGit(this.baseGitDir, ["update-ref", "refs/heads/isolated-base", baseCommit], undefined, this.gitEnv); }
		catch (error) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} throw error; }
	}
	createWorktree(options: { index: number; agent?: string }): IsolatedGitWorktree { return createWorktree(this, options.index, options.agent); }
	createRecoveryWorktree(options: { index: number; agent?: string }): IsolatedGitWorktree { return createWorktree(this, options.index, options.agent, false); }
	createGitExecutionOwner(worktree: IsolatedGitWorktree, options: { rights: ScopedGitRights; cwd?: string; network?: ScopedGitNetwork } = { rights: "writer" }): ScopedGitEndpointServer {
		if (worktree.runtime !== this || !this.worktrees.includes(worktree)) throw new Error("scoped Git endpoint requires an owner-managed worktree");
		const owner = createScopedGitEndpoint({ runtimeRoot: path.join(os.tmpdir(), "pi-scoped-git"), runtimeId: this.instanceId, worktree: worktree.worktreePath, cwd: options.cwd, rights: options.rights, network: options.network ?? (this.network === "none" ? "none" : "host"), gitPath: this.gitPath }); this.scopedEndpointOwners.add(owner); return owner;
	}
	getScopedGitEndpointDescriptor(capability: IsolatedGitCapability): ScopedGitEndpointDescriptor { this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; if (!state.scopedEndpoint) state.scopedEndpoint = this.createGitExecutionOwner(state.worktree, { rights: state.rights, cwd: state.cwd }); return state.scopedEndpoint.descriptor; }
	reserveScopedGitChild(capability: IsolatedGitCapability, options: { cwd?: string; rights?: ScopedGitRights } = {}): ScopedGitEndpointDescriptor { this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; if (!state.scopedEndpoint) state.scopedEndpoint = this.createGitExecutionOwner(state.worktree, { rights: state.rights, cwd: state.cwd }); return state.scopedEndpoint.reserveChild({ ...options, ...(options.rights === "writer" ? { allowWriter: true } : {}) }).descriptor; }
	delegateScopedGitWriter(capability: IsolatedGitCapability, identity: import("./scoped-git-endpoint.ts").ScopedGitProcessIdentity, descriptor: ScopedGitEndpointDescriptor, options: { cwd?: string } = {}): ScopedGitEndpointServer & { readonly waitForRelease: Promise<void> } { this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; if (!state.scopedEndpoint) throw new Error("scoped Git writer delegation requires a live endpoint"); return state.scopedEndpoint.delegateWriter(identity, { ...options, descriptor }); }
	issueInheritedContext(options: { parent?: IsolatedGitCapability; worktree?: IsolatedGitWorktree; index?: number; agent?: string; rights?: IsolatedGitCapabilityRights; cwd?: string } = {}): IsolatedGitCapability {
		const parentState = options.parent ? isolatedGitCapabilityState.get(options.parent as object) : undefined; if (options.parent && (!parentState || parentState.runtime !== this || parentState.released)) throw new Error("isolated Git inherited capability is invalid");
		const rights = options.rights ?? parentState?.rights ?? "writer"; if (parentState?.rights === "read-only" && rights === "writer") throw new Error("isolated Git capability rights cannot widen from read-only to writer"); const worktree = options.worktree ?? parentState?.worktree ?? this.createWorktree({ index: options.index ?? 0, agent: options.agent }); if (worktree.runtime !== this) throw new Error("isolated Git capability requires a runtime-managed worktree"); const cwd = options.cwd ? mapIsolatedGitCwd(worktree, options.cwd) : parentState?.cwd ?? worktree.worktreePath; if (parentState && !isPathWithin(parentState.cwd, cwd)) throw new Error("isolated Git capability cwd widens its parent scope"); const ws = isolatedGitWorktreeState.get(worktree)!; if (rights === "writer" && ws.writerLease) throw new Error("isolated Git writer capability is already leased; shared checkout use must be serial"); const capability = Object.freeze({ rights, runtimeId: this.instanceId, worktreePath: worktree.worktreePath, cwd }) as IsolatedGitCapability; const state = { worktree, rights, cwd, runtime: this }; isolatedGitCapabilityState.set(capability as object, state); if (rights === "writer") ws.writerLease = state; return capability;
	}
	releaseInheritedContext(capability: IsolatedGitCapability): void { this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; const head = checkedGit(state.worktree.worktreePath, ["rev-parse", "HEAD"], undefined, this.gitEnv).trim(); validateAuthoredHistory(state.worktree, head); const ws = isolatedGitWorktreeState.get(state.worktree)!; ws.observedHead = head; state.released = true; if (ws.writerLease === state) ws.writerLease = undefined; const endpoint = state.scopedEndpoint; state.scopedEndpoint = undefined; if (endpoint) void endpoint.close(); }
	wrapInvocation(capability: IsolatedGitCapability, invocation: SpawnableInvocation, resourceMounts: SandboxMount[] = [], sandboxConfig?: Pick<ResolvedSandboxConfig, "network" | "profile" | "fallback">): SpawnableInvocation {
		this.assertCapability(capability); const state = isolatedGitCapabilityState.get(capability as object)!; const worktree = state.worktree; const invocationCwd = invocation.cwd ?? state.cwd; if (canonicalPath(invocationCwd) !== canonicalPath(state.cwd) || !isPathWithin(worktree.worktreePath, invocationCwd)) throw new Error(`isolated Git cwd '${invocationCwd}' is outside the assigned private worktree`); const nodeRoot = path.dirname(path.dirname(process.execPath)); const mounts: SandboxMount[] = [{ source: nodeRoot, mode: "ro" }, { source: worktree.worktreePath, mode: state.rights === "read-only" ? "ro" : "rw" }, { source: worktree.gitDir, mode: state.rights === "read-only" ? "ro" : "rw" }, { source: path.join(worktree.gitDir, "config"), mode: "ro" }, { source: this.baseGitDir, mode: "ro" }, { source: worktree.gitPointerPath, mode: "ro" }, ...resourceMounts]; validateIsolatedMounts(this.getProtectedMountPaths(worktree), resourceMounts.filter((m) => m.mode === "ro").flatMap((m) => [m.source, ...(m.target ? [m.target] : [])]), "read-only"); validateIsolatedMounts(this.getProtectedMountPaths(worktree), resourceMounts.filter((m) => m.mode === "rw").flatMap((m) => [m.source, ...(m.target ? [m.target] : [])]), "writable"); const network = sandboxConfig?.network ?? this.network; const endpoint = state.scopedEndpoint ??= this.createGitExecutionOwner(worktree, { rights: state.rights, cwd: state.cwd, network: network === "none" ? "none" : "host" }); mounts.push(...scopedGitMounts(endpoint.scope)); const provider = new BubblewrapSandboxProvider({ bwrapCommand: this.bwrapCommand, env: this.gitEnv, unsharePid: true }); const env = { ...sanitizeGitEnvironment(invocation.env as NodeJS.ProcessEnv | undefined), ...this.gitEnv, ...(authModeUsesPiJson(sandboxConfig?.auth) ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent") } : {}) }; return provider.wrapInvocation({ config: { provider: "bubblewrap", profile: sandboxConfig?.profile ?? this.profile, network, fallback: "fail", auth: "none" }, invocation: { ...invocation, cwd: invocationCwd, env, pinReadonlyMounts: true }, mounts }).invocation;
	}
	async closeGitExecutionOwners(): Promise<boolean> {
		for (const owner of [...this.scopedEndpointOwners]) {
			if (await owner.close()) this.scopedEndpointOwners.delete(owner);
		}
		return this.scopedEndpointOwners.size === 0;
	}
	isExported(index: number): boolean { return this.exportedWorktrees.has(index); } markExported(index: number): void { if (this.exportedWorktrees.has(index)) throw new Error(`isolated Git worktree ${index} already exported`); this.exportedWorktrees.add(index); if (this.worktrees.length > 0 && this.worktrees.every((w) => this.exportedWorktrees.has(w.index))) this.exportFailed = false; }
	markExportFailed(): void { this.exportFailed = true; } markExportFenceFailed(): void { this.exportFenceFailed = true; this.exportFailed = true; } markHookTeardownFailed(): void { this.hookTeardownFailed = true; this.exportFailed = true; }
	refreshRecoveryState(): void { if (fs.existsSync(path.join(this.root, "recovery", "export-fence-failed.json"))) { this.exportFenceFailed = true; this.exportFailed = true; } }
	markExportFenceResolved(): void { this.refreshRecoveryState(); this.exportFenceFailed = false; try { fs.unlinkSync(path.join(this.root, "recovery", "export-fence-failed.json")); } catch {} }
}
export function createIsolatedGitRuntime(options: IsolatedGitRuntimeOptions): IsolatedGitRuntime { return new IsolatedGitRuntime(options); }
export function mapIsolatedGitCwd(worktree: IsolatedGitWorktree, requestedCwd: string): string {
	const runtime = worktree.runtime;
	if (!runtime.runtimeManaged || !runtime.worktrees.includes(worktree)) throw new Error("isolated Git cwd mapping requires a runtime-managed worktree handle");
	const resolved = canonicalPath(path.resolve(runtime.cwd, requestedCwd));
	const repositoryRoot = canonicalPath(runtime.repositoryRoot);
	if (!isPathWithin(repositoryRoot, resolved)) {
		throw new Error(`isolated Git cwd '${resolved}' is outside assigned repository '${repositoryRoot}'`);
	}
	return path.join(worktree.worktreePath, path.relative(repositoryRoot, resolved));
}

export function createIsolatedGitWorktree(runtime: IsolatedGitRuntime, options: { index: number; agent?: string }): IsolatedGitWorktree {
	if (!runtime.runtimeManaged) throw new Error("isolated Git requires a runtime-managed worktree handle");
	return runtime.createWorktree(options);
}

// Metadata emitted by isolated Git is allowed to contain user-authored prose.
// Redaction targets selected local checkout roots rather than every slash-prefixed
// token (which would corrupt routes such as `/api/v1`). Components may contain
// spaces and Unicode; punctuation and path-boundary separators terminate candidates.
const PERSONAL_PATH_START = /(?:\\\\|[A-Za-z]:[\\/]|\/(?:tmp(?:\/|$)|var\/(?:tmp\/)?|private\/tmp(?:\/|$)|home\/|Users\/))/gu;
const PATH_DELIMITER = /[\r\n"'(){}<>;,=:!?|\[\]]/u;

function isPathBoundary(value: string, index: number): boolean {
	if (index === 0) return true;
	const previous = value[index - 1]!;
	return !/[A-Za-z0-9_:\\\/]/u.test(previous);
}

function pathCandidateEnd(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const character = value[index]!;
		if (PATH_DELIMITER.test(character)) break;
		if (character === "." && /\s/.test(value[index + 1] ?? "")) break;
		if (/\s/.test(character)) {
			const remainder = value.slice(index + 1);
			// Include bounded spaces in a legitimate final basename (`foo bar`),
			// but stop at adjacent roots and common prose suffixes. This avoids
			// relying on filesystem existence while keeping sentence text intact.
			PERSONAL_PATH_START.lastIndex = 0;
			const nextRoot = PERSONAL_PATH_START.exec(remainder);
			if (nextRoot?.index === 0) break;
			const nextWord = /^[^\s\r\n;,.!?()[\]{}<>:"']+/u.exec(remainder)?.[0]?.toLowerCase();
			const proseBoundary = new Set(["and", "or", "but", "completed", "successfully", "crashed", "yesterday", "today", "could", "cannot", "failed", "for", "with", "at", "see", "next", "step"]);
			if (nextWord && proseBoundary.has(nextWord)) break;
			const nextSlash = remainder.search(/[\\/]/u);
			const beforeSlash = nextSlash >= 0 ? remainder.slice(0, nextSlash) : remainder;
			if (nextSlash >= 0 && /\s/u.test(beforeSlash)) break;
			if (nextSlash < 0 && index - start > 256) break;
		}
		index++;
	}
	return index;
}

function isPathCandidate(value: string, start: number, end: number): boolean {
	const candidate = value.slice(start, end);
	if (candidate.length < 3 || !isPathBoundary(value, start)) return false;
	if (candidate.startsWith("\\\\")) return candidate.length > 2 && /[^\\\\/\s]/u.test(candidate.slice(2));
	if (/^[A-Za-z]:[\\\\/]/u.test(candidate)) return candidate.length === 3 || /[^\\\\/\s]/u.test(candidate.slice(3));
	if (/^\/(?:tmp|var\/tmp|private\/tmp|home|Users)\/?$/u.test(candidate)) return true;
	return /[^\\/\s]/u.test(candidate.replace(/^\/(?:tmp|var\/tmp|private\/tmp|home|Users)(?:\/|$)/u, ""));
}

/**
 * Remove only diagnostics emitted by isolated-Git export/fence recovery. This
 * keeps a real execution error intact when a later retry successfully exports
 * the bundle.
 */
export function stripIsolatedGitExportDiagnostics(value: string | undefined): { error?: string; onlyDiagnostics: boolean } {
	if (!value) return { onlyDiagnostics: false };
	const diagnostic = /(?:Isolated Git bundle export failed; recover (?:isolated )?worktrees? at |Nested descendants did not reach a proven terminal state before export; recover isolated worktrees? at |Nested descendants did not reach a proven terminal state before the export fence timed out; recover isolated worktrees? at )/u;
	const lines = value.split("\n");
	let removed = false;
	const remaining: string[] = [];
	for (const line of lines) {
		const match = diagnostic.exec(line);
		if (!match) {
			remaining.push(line);
			continue;
		}
		removed = true;
		const prefix = line.slice(0, match.index).replace(/[;,:\s]+$/u, "").trim();
		if (prefix) remaining.push(prefix);
	}
	const error = remaining.join("\n").trim();
	return { ...(error ? { error } : {}), onlyDiagnostics: removed && !error };
}

/** Redact local filesystem roots while preserving delimiters and ordinary prose. */
export function redactAbsolutePaths(value: string): string {
	let output = "";
	let cursor = 0;
	PERSONAL_PATH_START.lastIndex = 0;
	for (;;) {
		const match = PERSONAL_PATH_START.exec(value);
		if (!match) break;
		const start = match.index;
		if (!isPathBoundary(value, start)) {
			// A rejected match must still move the global scanner forward.
			PERSONAL_PATH_START.lastIndex = Math.max(PERSONAL_PATH_START.lastIndex, start + 1);
			continue;
		}
		const end = pathCandidateEnd(value, PERSONAL_PATH_START.lastIndex);
		// pathCandidateEnd temporarily scans the remainder with this global
		// expression, so restore a forward position before either branch below.
		PERSONAL_PATH_START.lastIndex = Math.max(PERSONAL_PATH_START.lastIndex, start + 1, end);
		if (!isPathCandidate(value, start, end)) continue;
		output += value.slice(cursor, start) + "[absolute-path]";
		cursor = end;
		PERSONAL_PATH_START.lastIndex = end;
	}
	return output + value.slice(cursor);
}

function validateAuthoredHistory(worktree: IsolatedGitWorktree, head: string): void {
	const env = worktree.runtime.gitEnv;
	const state = isolatedGitWorktreeState.get(worktree);
	if (!state) throw new Error("isolated Git export rejected: continuity state is unavailable");
	// Continuity is independent of the current head. A reset to base therefore
	// cannot erase the last observed authored tip.
	if (state.observedHead && state.observedHead !== head) {
		const observed = runGit(worktree.worktreePath, ["merge-base", "--is-ancestor", state.observedHead, head], undefined, env);
		if (observed.status !== 0) throw new Error("isolated Git export rejected: authored history rewrote, amended, or reset an already observed commit");
	}
	if (head !== worktree.baseCommit) {
		const ancestry = runGit(worktree.worktreePath, ["merge-base", "--is-ancestor", worktree.baseCommit, head], undefined, env);
		if (ancestry.status !== 0) throw new Error("isolated Git export rejected: HEAD is not based on the assigned base commit");
		// Every authored commit must be a direct child of the previous commit.
		// This rejects merge commits rather than silently flattening their history.
		const history = checkedGit(worktree.worktreePath, ["rev-list", "--parents", `${worktree.baseCommit}..${head}`], undefined, env).trim();
		for (const line of history ? history.split("\n") : []) {
			if (line.trim().split(/\s+/u).length !== 2) throw new Error(`isolated Git export rejected: authored history is not strictly linear (merge commit detected: ${line})`);
		}
	}
	// A reset or amend can leave a post-base commit unreachable while HEAD looks
	// valid. The private base has no such objects, so retain the runtime instead
	// of silently publishing a rewritten history.
	const unreachable = runGit(worktree.worktreePath, ["fsck", "--unreachable", "--no-reflogs", "--no-progress"], undefined, env);
	for (const line of unreachable.stdout.split("\n")) {
		const match = /^unreachable commit ([0-9a-f]{40})(?:$|\s)/u.exec(line.trim());
		if (!match) continue;
		const authored = runGit(worktree.worktreePath, ["merge-base", "--is-ancestor", worktree.baseCommit, match[1]!], undefined, env);
		if (authored.status === 0) throw new Error("isolated Git export rejected: authored history was reset or amended; recovery remains in the private runtime");
	}
	const refs = checkedGit(worktree.worktreePath, ["for-each-ref", "--format=%(refname)"], undefined, env)
		.split("\n").map((ref) => ref.trim()).filter(Boolean);
	const expectedRefs = new Map([...state.baselineRefs, ...state.runtimeRefs]);
	const branchRef = `refs/heads/isolated-${worktree.index}`;
	for (const ref of expectedRefs.keys()) {
		if (ref !== branchRef && !refs.includes(ref)) throw new Error(`isolated Git export rejected: reserved ref '${ref}' was deleted`);
	}
	for (const ref of refs) {
		if (!expectedRefs.has(ref) && ref !== branchRef) {
			throw new Error(`isolated Git export rejected: child-created ref '${ref}' is not part of the isolated linear history`);
		}
		const actual = checkedGit(worktree.worktreePath, ["rev-parse", ref], undefined, env).trim();
		if (ref === branchRef) {
			if (actual !== head) throw new Error(`isolated Git export rejected: isolated branch ref '${ref}' does not match HEAD`);
		} else if (expectedRefs.get(ref) !== actual) {
			throw new Error(`isolated Git export rejected: reserved ref '${ref}' was mutated`);
		}
	}
}

function commitSummary(worktree: IsolatedGitWorktree, head: string): string {
	validateAuthoredHistory(worktree, head);
	if (head === worktree.baseCommit) return "";
	return redactAbsolutePaths(checkedGit(worktree.worktreePath, ["log", "--format=%H%x09%an%x09%s", `${worktree.baseCommit}..${head}`], undefined, worktree.runtime.gitEnv).trim());
}

function normalizeRecoveryPath(rawPath: string): string {
	if (!rawPath || path.isAbsolute(rawPath) || rawPath.includes("\0")) {
		throw new Error(`isolated Git synthetic path must be relative: ${rawPath}`);
	}
	const normalized = path.normalize(rawPath);
	if (normalized === "." || normalized === "" || normalized.startsWith(".." + path.sep) || path.isAbsolute(normalized)) {
		throw new Error(`isolated Git synthetic path escapes the worktree: ${rawPath}`);
	}
	return normalized;
}

function removeRecoveryPaths(worktree: IsolatedGitWorktree, indexPath: string, syntheticPaths: readonly string[]): void {
	if (syntheticPaths.length === 0) return;
	// Git evaluates pathspecs as patterns by default. The environment-level
	// literal mode applies to both discovery and removal, including metacharacter
	// names, while this helper always runs from the worktree root (top-safe).
	const env = { ...worktree.runtime.gitEnv, GIT_INDEX_FILE: indexPath, GIT_LITERAL_PATHSPECS: "1" };
	for (const syntheticPath of syntheticPaths) {
		const listed = checkedGit(worktree.worktreePath, ["ls-files", "-z", "--", syntheticPath], undefined, env);
		const entries = listed.split("\0").filter(Boolean);
		if (entries.length > 0) checkedGit(worktree.worktreePath, ["update-index", "--force-remove", "--", ...entries], undefined, env);
	}
}

interface RecoverySnapshot {
	recovery?: string;
	/** Internal packaging commit preserving the exact Git index (staged state). */
	stagedSnapshot?: string;
	stagedTree?: string;
	recoveryTree?: string;
	dirtySummary: string;
}

function createPackagingCommit(worktree: IsolatedGitWorktree, tree: string, parent: string, env: Record<string, string | undefined>, subject: string): string {
	return checkedGit(
		worktree.worktreePath,
		["commit-tree", tree, "-p", parent],
		`Pi runtime ${subject}\n\nThis commit is packaging metadata and is not child-authored.\n`,
		{
			...env,
			GIT_AUTHOR_NAME: "Pi runtime",
			GIT_AUTHOR_EMAIL: "pi-runtime@localhost",
			GIT_COMMITTER_NAME: "Pi runtime",
			GIT_COMMITTER_EMAIL: "pi-runtime@localhost",
		},
	).trim();
}

function createStagedSnapshot(worktree: IsolatedGitWorktree, syntheticPaths: readonly string[]): { stagedSnapshot?: string; stagedTree?: string; dirtySummary: string } {
	const liveEnv = worktree.runtime.gitEnv;
	const changed = runGit(worktree.worktreePath, ["diff", "--cached", "--quiet", "HEAD", "--"], undefined, liveEnv);
	if (changed.status === 0) return { dirtySummary: "" };
	if (changed.status !== 1) throw new Error(changed.stderr.trim() || "cannot compare isolated Git staged index");

	// Packaging must never mutate the child's live index. In particular, setup
	// hooks may report synthetic paths after a child force-adds them with `git
	// add -f`; filter a private index copy before writing the staged tree.
	const stagedIndexPath = path.join(worktree.runtime.root, `staged-index-${worktree.index}`);
	const liveIndexPath = path.join(worktree.gitDir, "index");
	fs.copyFileSync(liveIndexPath, stagedIndexPath);
	const env = { ...liveEnv, GIT_INDEX_FILE: stagedIndexPath };
	try {
		removeRecoveryPaths(worktree, stagedIndexPath, syntheticPaths);
		const filteredChanged = runGit(worktree.worktreePath, ["diff", "--cached", "--quiet", "HEAD", "--"], undefined, env);
		if (filteredChanged.status === 0) return { dirtySummary: "" };
		if (filteredChanged.status !== 1) throw new Error(filteredChanged.stderr.trim() || "cannot compare isolated Git staged index");
		const stagedTree = checkedGit(worktree.worktreePath, ["write-tree"], undefined, env).trim();
		const stagedSnapshot = createPackagingCommit(
			worktree,
			stagedTree,
			checkedGit(worktree.worktreePath, ["rev-parse", "HEAD"], undefined, env).trim(),
			env,
			"staged-state snapshot",
		);
		const dirtySummary = checkedGit(worktree.worktreePath, ["diff", "--cached", "--name-status", "--", "."], undefined, env).trim();
		return { stagedSnapshot, stagedTree, dirtySummary };
	} finally {
		try { fs.unlinkSync(stagedIndexPath); } catch { /* best effort */ }
	}
}

function createRecoverySnapshot(worktree: IsolatedGitWorktree, syntheticPaths: readonly string[]): RecoverySnapshot {
	const staged = createStagedSnapshot(worktree, syntheticPaths);
	const indexPath = path.join(worktree.runtime.root, `recovery-index-${worktree.index}`);
	const env = { ...worktree.runtime.gitEnv, GIT_INDEX_FILE: indexPath };
	try {
		try { fs.unlinkSync(indexPath); } catch { /* A previous failed export is safe to replace. */ }
		checkedGit(worktree.worktreePath, ["read-tree", "HEAD"], undefined, env);
		// Git's normal add machinery deliberately excludes ignored files. This is
		// important here: recovery describes authored state, not runtime caches.
		checkedGit(worktree.worktreePath, ["add", "-A", "--", "."], undefined, env);
		removeRecoveryPaths(worktree, indexPath, syntheticPaths);
		const parent = staged.stagedSnapshot
			?? checkedGit(worktree.worktreePath, ["rev-parse", "HEAD"], undefined, worktree.runtime.gitEnv).trim();
		const changed = runGit(worktree.worktreePath, ["diff", "--cached", "--quiet", parent, "--"], undefined, env);
		const tree = checkedGit(worktree.worktreePath, ["write-tree"], undefined, env).trim();
		const worktreeDirtySummary = changed.status === 1
			? checkedGit(worktree.worktreePath, ["diff", "--cached", "--name-status", parent, "--", "."], undefined, env).trim()
			: "";
		if (changed.status !== 0 && changed.status !== 1) throw new Error(changed.stderr.trim() || "cannot compare isolated Git recovery index");
		// Keep a distinct final worktree-result tip whenever an index snapshot was
		// needed, even when B and C happen to have the same tree. This makes the
		// recovery id unambiguously the final projection and leaves B reachable as
		// its packaging parent.
		const recovery = (changed.status === 1 || staged.stagedSnapshot)
			? createPackagingCommit(worktree, tree, parent, env, "recovery snapshot")
			: undefined;
		const dirtySummary = [
			staged.dirtySummary ? `staged:\n${staged.dirtySummary}` : "",
			worktreeDirtySummary ? `worktree:\n${worktreeDirtySummary}` : "",
		].filter(Boolean).join("\n");
		return { ...staged, recovery, recoveryTree: recovery ? tree : undefined, dirtySummary };
	} finally {
		try { fs.unlinkSync(indexPath); } catch { /* best effort */ }
	}
}

function exportIsolatedGitBundleImpl(runtime: IsolatedGitRuntime, options: {
	outputDir: string;
	worktree: IsolatedGitWorktree;
	terminationState?: IsolatedGitTerminationState;
	termination?: IsolatedGitTerminationState;
	agent?: string;
	syntheticPaths?: readonly string[];
	/** A caller requiring a child-authored commit may mark residual state incomplete. */
	commitRequired?: boolean;
}): IsolatedGitBundle {
	if (isInheritedIsolatedGitRuntime(runtime)) throw new Error("inherited isolated Git runtime cannot export parent-owned worktrees");
	runtime.refreshRecoveryState();
	// Export is the mandatory packaging gate for every caller. Once either the
	// nested-stop fence or hook teardown fence failed, the checkout may still be
	// mutable; packaging it would turn unproven state into a portable artifact.
	// Keep the runtime root actionable and fail closed instead.
	if (runtime.exportFenceFailed || runtime.hookTeardownFailed) {
		runtime.markExportFailed();
		const fences = [
			...(runtime.exportFenceFailed ? ["nested descendant stop"] : []),
			...(runtime.hookTeardownFailed ? ["setup-hook teardown"] : []),
		].join(" and ");
		throw new Error(`Isolated Git bundle export refused after ${fences} fence failure; recover isolated runtime/worktrees at ${runtime.root}`);
	}
	if (options.worktree.runtime !== runtime || !runtime.worktrees.includes(options.worktree)) {
		throw new Error("isolated Git bundle export requires a runtime-managed worktree handle");
	}
	const worktree = options.worktree;
	const requestedTerminationState = options.terminationState ?? options.termination ?? "success";
	const syntheticPaths = [...new Set((options.syntheticPaths ?? worktree.syntheticPaths).map(normalizeRecoveryPath))];
	const head = checkedGit(worktree.worktreePath, ["rev-parse", "HEAD"], undefined, runtime.gitEnv).trim();
	const attachedHead = runGit(worktree.worktreePath, ["symbolic-ref", "-q", "HEAD"], undefined, runtime.gitEnv);
	if (attachedHead.status !== 0) throw new Error("isolated Git export rejected: detached HEAD cannot be exported");
	// The attached runtime-owned branch must already point at the authoritative
	// HEAD; export never repairs or advances it before continuity validation.
	const branchRef = `refs/heads/isolated-${worktree.index}`;
	const branchBeforeExport = checkedGit(worktree.worktreePath, ["rev-parse", branchRef], undefined, runtime.gitEnv).trim();
	if (branchBeforeExport !== head) {
		throw new Error(`isolated Git export rejected: reserved ref '${branchRef}' does not continue the observed HEAD`);
	}
	const summary = commitSummary(worktree, head);
	const worktreeState = isolatedGitWorktreeState.get(worktree);
	if (!worktreeState) throw new Error("isolated Git export rejected: continuity state is unavailable");
	// Export is also a terminal observation. Record it before any later release
	// or cleanup so a final writer cannot rewrite and disappear before evidence
	// capture notices the discontinuity.
	worktreeState.observedHead = head;
	const recoverySnapshot = createRecoverySnapshot(worktree, syntheticPaths);
	const recovery = recoverySnapshot.recovery;
	const stagedSnapshot = recoverySnapshot.stagedSnapshot;
	// A recovery snapshot without a child-authored commit is useful but cannot
	// claim that the requested authored change was completed. Read-only/reviewer
	// runs may legitimately return a dirty recovery without being incomplete.
	const incomplete = Boolean(options.commitRequired && (recovery || stagedSnapshot || !summary));
	// A successful execution cannot carry success metadata when a required
	// authored commit is incomplete: callers and the portable bundle must agree.
	const terminationState = requestedTerminationState === "success" && incomplete ? "failure" : requestedTerminationState;
	// A commit-required writer with no authored commit still receives a bundle
	// (and is marked incomplete) so the clean checkout is not discarded. Callers
	// decide whether their run semantics turn that incomplete outcome into a
	// failed result; read-only/review semantics may legitimately allow no change.
	const outputDir = path.resolve(options.outputDir);
	fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(outputDir, 0o700); } catch { /* portable filesystems may not support chmod */ }
	const payloadPath = path.join(runtime.root, `isolated-payload-${worktree.index}.bundle`);
	const bundlePath = path.join(outputDir, `isolated-${terminationState}-${runtime.runId}-${runtime.instanceId}-${worktree.index}-${head}.bundle`);
	if (recovery) {
		checkedGit(worktree.worktreePath, ["update-ref", `refs/isolated/recovery-${worktree.index}`, recovery], undefined, runtime.gitEnv);
		worktreeState.runtimeRefs.set(`refs/isolated/recovery-${worktree.index}`, recovery);
	}
	if (stagedSnapshot) {
		checkedGit(worktree.worktreePath, ["update-ref", `refs/isolated/staged-${worktree.index}`, stagedSnapshot], undefined, runtime.gitEnv);
		worktreeState.runtimeRefs.set(`refs/isolated/staged-${worktree.index}`, stagedSnapshot);
	}
	const payloadRefs = [
		`refs/heads/isolated-${worktree.index}`,
		...(recovery ? [`refs/isolated/recovery-${worktree.index}`] : []),
		...(stagedSnapshot ? [`refs/isolated/staged-${worktree.index}`] : []),
	];
	const payload = summary || recovery || stagedSnapshot
		? (checkedGit(worktree.worktreePath, ["bundle", "create", payloadPath, ...payloadRefs, `^${worktree.baseCommit}`], undefined, runtime.gitEnv), hashBoundedBundle(payloadPath, "payload"))
		: { checksum: createHash("sha256").update(Buffer.alloc(0)).digest("hex"), size: 0 };
	const payloadChecksum = payload.checksum;
	// Unlike raw bundle bytes (whose headers/packing are implementation details),
	// this sorted refs/object-id manifest is deterministic and reconstructable by
	// any consumer after `git bundle verify`/fetch.
	const canonicalPayload = payloadRefs
		.slice()
		.sort()
		.map((ref) => `${ref}\0${checkedGit(worktree.worktreePath, ["rev-parse", ref], undefined, runtime.gitEnv).trim()}\n`)
		.join("");
	const canonicalPayloadBytes = Buffer.from(canonicalPayload, "utf8");
	const canonicalPayloadChecksum = createHash("sha256").update(canonicalPayloadBytes).digest("hex");
	const metadata: PortableBundleMetadata = {
		schemaVersion: 2,
		version: 2,
		mode: "isolated",
		terminationState,
		runId: runtime.runId,
		...(options.agent ? { agent: safeRunSegment(options.agent) } : {}),
		base: worktree.baseCommit,
		head,
		recovery: recovery ?? null,
		stagedSnapshot: stagedSnapshot ?? null,
		stagedTree: recoverySnapshot.stagedTree ?? null,
		recoveryTree: recoverySnapshot.recoveryTree ?? null,
		incomplete,
		commitSummary: summary,
		dirtySummary: recoverySnapshot.dirtySummary,
		bundleSize: payload.size,
		bundleChecksum: payloadChecksum,
		bundleSizeScope: "payload",
		payloadSize: payload.size,
		payloadChecksum,
		payloadRefs,
		canonicalPayloadChecksum,
		canonicalPayloadSize: canonicalPayloadBytes.length,
		commits: summary.split("\n").filter(Boolean).map((line) => {
			const [id, author, ...subject] = line.split("\t");
			return { id: id ?? "", author: author ?? "", subject: subject.join("\t") };
		}),
		bundle: { checksum: payloadChecksum, size: payload.size, checksumScope: "payload", canonicalChecksum: canonicalPayloadChecksum, canonicalSize: canonicalPayloadBytes.length, canonicalScope: "refs-and-object-ids" },
	};
	const portableMetadata = JSON.stringify(metadata);
	// Git bundle headers do not accept arbitrary comments. Store portable
	// metadata as a private blob/ref so it is embedded in the verified bundle.
	const metadataBlob = checkedGit(worktree.worktreePath, ["hash-object", "-w", "--stdin"], portableMetadata, runtime.gitEnv).trim();
	checkedGit(worktree.worktreePath, ["update-ref", "refs/isolated/metadata", metadataBlob], undefined, runtime.gitEnv);
	worktreeState.runtimeRefs.set("refs/isolated/metadata", metadataBlob);
	checkedGit(worktree.worktreePath, ["bundle", "create", bundlePath, ...payloadRefs, "refs/isolated/metadata", `^${worktree.baseCommit}`], undefined, runtime.gitEnv);
	try { fs.chmodSync(bundlePath, 0o600); } catch { /* best effort on portable filesystems */ }
	const verification = runGit(worktree.worktreePath, ["bundle", "verify", bundlePath], undefined, runtime.gitEnv);
	if (verification.status !== 0) throw new Error(verification.stderr.trim() || "isolated Git bundle verification failed");
	const bundle = hashBoundedBundle(bundlePath, "final");
	runtime.markExported(worktree.index);
	return {
		path: bundlePath,
		checksum: bundle.checksum,
		base: worktree.baseCommit,
		head,
		commitSummary: summary,
		commits: metadata.commits,
		portableMetadata,
		...(recovery ? { recovery } : {}),
		...(stagedSnapshot ? { stagedSnapshot } : {}),
		...(recoverySnapshot.stagedTree ? { stagedTree: recoverySnapshot.stagedTree } : {}),
		...(recoverySnapshot.recoveryTree ? { recoveryTree: recoverySnapshot.recoveryTree } : {}),
		terminationState,
		incomplete,
		dirtySummary: recoverySnapshot.dirtySummary,
		bundleSize: bundle.size,
		payloadChecksum,
		payloadSize: payload.size,
		canonicalPayloadChecksum,
		canonicalPayloadSize: canonicalPayloadBytes.length,
	};
}

export function exportIsolatedGitBundle(
	runtime: IsolatedGitRuntime,
	options: Parameters<typeof exportIsolatedGitBundleImpl>[1],
): IsolatedGitBundle {
	try {
		return exportIsolatedGitBundleImpl(runtime, options);
	} catch (error) {
		// The caller may safely retain the runtime root and inspect this path
		// after any packaging failure. Never turn a failed export into deletion.
		runtime.markExportFailed();
		throw error;
	}
}

export async function cleanupIsolatedGitRuntime(runtime: IsolatedGitRuntime): Promise<void> {
	if (!runtime.runtimeManaged || isInheritedIsolatedGitRuntime(runtime)) return;
	runtime.refreshRecoveryState();
	const allWorktreesExported = runtime.worktrees.length === 0
		|| runtime.worktrees.every((worktree) => runtime.isExported(worktree.index));
	// A fence refusal or packaging failure keeps the complete runtime alive for
	// operator recovery; even calling cleanup must not tear down that evidence.
	if (!allWorktreesExported || runtime.exportFailed || runtime.exportFenceFailed || runtime.hookTeardownFailed) return;
	if (!await runtime.closeGitExecutionOwners()) return;
	fs.rmSync(runtime.root, { recursive: true, force: true });
}

/**
 * Test-only teardown for intentionally preserved runtimes.
 *
 * Production cleanup remains fail-closed above: unexported or failed runtimes
 * stay recoverable. Preservation fixtures may remove their temporary evidence
 * only after explicitly stopping the detached policy process group.
 * @internal
 */
export async function teardownIsolatedGitRuntimeForTests(runtime: IsolatedGitRuntime): Promise<void> {
	if (!runtime.runtimeManaged || isInheritedIsolatedGitRuntime(runtime) || !fs.existsSync(runtime.root)) return;
	if (!await runtime.closeGitExecutionOwners()) return;
	fs.rmSync(runtime.root, { recursive: true, force: true });
}
