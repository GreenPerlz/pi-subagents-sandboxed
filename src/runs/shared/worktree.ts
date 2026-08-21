import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processControlUnsupported } from "../../shared/post-exit-stdio-guard.ts";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}

export interface WorktreeDiffCaptureErrorContext {
	taskIndex?: number;
	taskAgent?: string;
	diffDir: string;
	patchPath?: string;
	worktreePath?: string;
	recoverableWorktreePaths: string[];
}

export class WorktreeDiffCaptureError extends Error {
	readonly cause!: unknown;
	readonly taskIndex?: number;
	readonly taskAgent?: string;
	readonly diffDir: string;
	readonly patchPath?: string;
	readonly worktreePath?: string;
	readonly recoverableWorktreePaths: string[];

	constructor(context: WorktreeDiffCaptureErrorContext, cause: unknown) {
		const causeMessage = cause instanceof Error ? cause.message : String(cause);
		const task = context.taskAgent
			? `task ${context.taskIndex === undefined ? "?" : context.taskIndex + 1} (${context.taskAgent})`
			: "worktree diff capture";
		const worktreePaths = context.recoverableWorktreePaths.length > 0
			? context.recoverableWorktreePaths.join(", ")
			: "none recorded";
		super(
			`Failed to capture ${task}: ${causeMessage}. `
			+ `Diff directory: ${context.diffDir}. `
			+ `Recoverable worktree path${context.recoverableWorktreePaths.length === 1 ? "" : "s"}: ${worktreePaths}. `
			+ "The worktree was preserved; recover changes there or retry capture before cleanup.",
		);
		// ErrorOptions.cause is newer than this project's runtime/type target. Define
		// the standard non-enumerable property directly so the original error (and
		// its type, stack, and metadata) remains available on every supported target.
		Object.defineProperty(this, "cause", {
			value: cause,
			configurable: true,
			writable: true,
		});
		this.name = "WorktreeDiffCaptureError";
		this.taskIndex = context.taskIndex;
		this.taskAgent = context.taskAgent;
		this.diffDir = context.diffDir;
		this.patchPath = context.patchPath;
		this.worktreePath = context.worktreePath;
		this.recoverableWorktreePaths = [...context.recoverableWorktreePaths];
	}
}

interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
}

/** Format paths that remain actionable when an unexpected lifecycle rejection prevents trusted cleanup. */
export function formatRecoverableWorktreePaths(setup: WorktreeSetup | undefined): string {
	if (!setup || setup.worktrees.length === 0) return "";
	const paths = setup.worktrees.map((worktree) => worktree.path);
	return `Recoverable worktree path${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}.`;
}

export class WorktreeCleanupError extends Error {
	readonly failures: string[];
	readonly recoverableWorktreePaths: string[];
	constructor(failures: string[], recoverableWorktreePaths: string[]) {
		super(`Worktree cleanup was not proven: ${failures.join("; ")}. ${recoverableWorktreePaths.length ? `Recoverable worktree paths: ${recoverableWorktreePaths.join(", ")}.` : "Inspect git worktree state before retrying."}`);
		this.name = "WorktreeCleanupError";
		this.failures = [...failures];
		this.recoverableWorktreePaths = [...recoverableWorktreePaths];
	}
}

interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

export interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

/** Setup failed while descendants could still write; callers must retain the worktree. */
export class WorktreeSetupHookTeardownError extends Error {
	readonly handoffPath: string;
	readonly worktreePath: string;
	constructor(message: string, handoffPath: string, worktreePath: string) {
		super(message);
		this.name = "WorktreeSetupHookTeardownError";
		this.handoffPath = handoffPath;
		this.worktreePath = worktreePath;
	}
}

export interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

export interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

/** Internal runner override used to exercise fail-closed supervisor handling. */
export interface WorktreeSetupHookRunOptions {
	supervisorSpawn?: typeof spawnSync;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;
const WORKTREE_GIT_TIMEOUT_MS = 15_000;
const WORKTREE_GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
		timeout: WORKTREE_GIT_TIMEOUT_MS,
		maxBuffer: WORKTREE_GIT_MAX_BUFFER_BYTES,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.error?.message || (result.stderr ?? ""),
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function resolveRepoState(cwd: string): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

	const status = runGitChecked(toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-parallel-${runId}-${index}`;
}

function buildWorktreePath(runId: string, index: number): string {
	return path.join(os.tmpdir(), `pi-worktree-${runId}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const worktreePath = buildWorktreePath(runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

export function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

const WORKTREE_HOOK_SUPERVISOR = String.raw`
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
const hook = process.argv[1];
const timeout = Number(process.argv[2]);
const max = Number(process.argv[3]);
const handoff = process.argv[4];
const identity = pid => { if (process.platform !== "linux" || !pid) return undefined; try { const stat = readFileSync("/proc/" + pid + "/stat", "utf8"); const close = stat.lastIndexOf(")"); const fields = stat.slice(close + 2).trim().split(/\s+/u); return { startToken: fields[19], pgid: Number(fields[2]), uid: (() => { try { return statSync("/proc/" + pid).uid; } catch { return undefined; } })() }; } catch { return undefined; } };
const startToken = pid => identity(pid)?.startToken;
let out = "", err = "", overflow = false, done = false;
const child = spawn(hook, [], { detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const childPid = child.pid;
const childIdentity = childPid ? identity(childPid) : undefined;
const childStartToken = childIdentity?.startToken;
const memberSnapshot = () => { if (process.platform !== "linux" || !childPid) return []; const members = []; try { for (const entry of readdirSync("/proc")) { if (!/^\\d+$/u.test(entry)) continue; const candidate = Number(entry); const current = identity(candidate); if (current?.pgid === childPid && current.startToken && current.uid !== undefined) members.push({ pid: candidate, startToken: current.startToken, uid: current.uid, pgid: current.pgid }); } } catch {} return members; };
let knownMembers = memberSnapshot();
if (handoff && childPid) writeFileSync(handoff, JSON.stringify({ supervisorPid: process.pid, supervisorStartToken: startToken(process.pid), hookPid: childPid, hookStartToken: childStartToken, hookUid: childIdentity?.uid, hookPgid: childIdentity?.pgid, members: knownMembers }), { mode: 0o600 });
const gone = () => { if (process.platform === "win32" || !childPid) return child.exitCode !== null; try { process.kill(-childPid, 0); return false; } catch (e) { return e?.code === "ESRCH"; } };
const identityMatches = () => process.platform === "linux" && childPid !== undefined && childStartToken !== undefined && childIdentity?.uid !== undefined && identity(childPid)?.startToken === childStartToken && identity(childPid)?.uid === childIdentity.uid && identity(childPid)?.pgid === childIdentity.pgid && childIdentity.pgid === childPid;
const continuityMatches = () => { if (process.platform !== "linux" || !childPid) return false; knownMembers = [...knownMembers, ...memberSnapshot()].filter((member, index, all) => all.findIndex(candidate => candidate.pid === member.pid && candidate.startToken === member.startToken) === index); return knownMembers.some(member => { const current = identity(member.pid); return current?.startToken === member.startToken && current.uid === member.uid && current.pgid === childPid; }); };
// POSIX teardown is group-only. A failed group probe must never degrade to a
// direct-child kill, which could target a reused PID and orphan descendants.
const terminate = signal => { if (!childPid || gone()) return; if (process.platform === "win32") { try { child.kill(signal); } catch (e) { err += String(e); } return; } if ((!identityMatches() && !continuityMatches())) return; try { process.kill(-childPid, signal); } catch (e) { if (e?.code !== "ESRCH") err += String(e); } };
let hardKillTimer;
const scheduleHardKill = () => { if (hardKillTimer) return; hardKillTimer = setTimeout(() => { hardKillTimer = undefined; if (!done) terminate("SIGKILL"); }, 1000); hardKillTimer.unref?.(); };
const append = (target, chunk) => { const text = chunk.toString(); if (Buffer.byteLength(out) + Buffer.byteLength(err) + Buffer.byteLength(text) > max) { overflow = true; terminate("SIGTERM"); scheduleHardKill(); return; } if (target === "out") out += text; else err += text; };
child.stdout.on("data", c => append("out", c)); child.stderr.on("data", c => append("err", c));
const waitGone = async (ms) => { const until = Date.now() + ms; while (!gone() && Date.now() < until) await new Promise(r => setTimeout(r, 20)); return gone(); };
const finish = async code => { if (done) return; done = true; clearTimeout(timer); if (hardKillTimer) { clearTimeout(hardKillTimer); hardKillTimer = undefined; } if (!gone()) { terminate("SIGTERM"); if (!await waitGone(1000)) { terminate("SIGKILL"); await waitGone(2000); } } process.stdout.write(JSON.stringify({ code, out, err, overflow, gone: gone() })); };
const timer = setTimeout(() => { terminate("SIGTERM"); scheduleHardKill(); }, timeout); timer.unref?.();
child.on("close", code => finish(code)); child.on("error", e => { err += String(e); finish(1); });
process.stdin.pipe(child.stdin);
`;

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

interface WorktreeHookHandoff {
	supervisorPid?: number;
	supervisorStartToken?: string;
	hookPid?: number;
	hookStartToken?: string;
	hookPgid?: number;
	hookUid?: number;
	members?: Array<{ pid: number; startToken: string; uid: number; pgid: number }>;
}

function parseWorktreeHookHandoff(raw: string): WorktreeHookHandoff {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid setup-hook handoff JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("setup-hook handoff must be a JSON object");
	}
	const handoff = parsed as WorktreeHookHandoff;
	if (process.platform !== "win32" && (!Number.isInteger(handoff.hookPid) || handoff.hookPid <= 0 || typeof handoff.hookStartToken !== "string" || !handoff.hookStartToken || handoff.hookPgid !== handoff.hookPid)) {
		throw new Error("setup-hook handoff is missing the hook process identity");
	}
	if (handoff.members !== undefined && (!Array.isArray(handoff.members) || handoff.members.some((member) => !member || !Number.isInteger(member.pid) || typeof member.startToken !== "string" || !Number.isInteger(member.uid) || !Number.isInteger(member.pgid)))) {
		throw new Error("setup-hook handoff has invalid process-group members");
	}
	return handoff;
}

function processIdentity(pid: number): { startToken: string; uid: number; pgid: number } | undefined {
	if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
		const uid = fs.statSync(`/proc/${pid}`).uid;
		return fields[19] && Number.isInteger(uid) ? { startToken: fields[19], uid, pgid: Number(fields[2]) } : undefined;
	} catch { return undefined; }
}


function hookGroupGone(pid: number): boolean {
	if (process.platform === "win32") return true;
	try { process.kill(-pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function waitHookGroupGone(pid: number, timeoutMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	while (!hookGroupGone(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	return hookGroupGone(pid);
}

/** Clean up only the handoff-identified private hook group. */
function teardownHookHandoff(handoff: WorktreeHookHandoff): boolean {
	if (process.platform === "win32" || !handoff.hookPid || !handoff.hookStartToken || handoff.hookPgid !== handoff.hookPid) return process.platform === "win32";
	const leader = processIdentity(handoff.hookPid);
	const exactLeader = Boolean(leader && leader.startToken === handoff.hookStartToken && leader.uid === handoff.hookUid && leader.pgid === handoff.hookPgid);
	const exactMember = (handoff.members ?? []).some((member) => { const current = processIdentity(member.pid); return Boolean(current && current.startToken === member.startToken && current.uid === member.uid && current.pgid === handoff.hookPgid); });
	if (!exactLeader && !exactMember) return false;
	if (hookGroupGone(handoff.hookPid)) return true;
	try { process.kill(-handoff.hookPid, "SIGTERM"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
	}
	if (waitHookGroupGone(handoff.hookPid, 1_000)) return true;
	const stillLeader = (() => { const current = processIdentity(handoff.hookPid!); return Boolean(current && current.startToken === handoff.hookStartToken && current.uid === handoff.hookUid && current.pgid === handoff.hookPgid); })();
	const stillMember = (handoff.members ?? []).some((member) => { const current = processIdentity(member.pid); return Boolean(current && current.startToken === member.startToken && current.uid === member.uid && current.pgid === handoff.hookPgid); });
	const stillExact = stillLeader || stillMember;
	if (!stillExact) return false;
	try { process.kill(-handoff.hookPid, "SIGKILL"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
	}
	return waitHookGroupGone(handoff.hookPid, 2_000);
}

export function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
	options?: WorktreeSetupHookRunOptions,
): string[] {
	const processControlError = processControlUnsupported();
	if (processControlError) throw new Error(`Worktree setup hooks unavailable: ${processControlError}`);
	const handoffPath = path.join(os.tmpdir(), `pi-worktree-hook-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
	let handoff: WorktreeHookHandoff | undefined;
	let handoffRaw: string | undefined;
	let preserveHandoffEvidence = false;
	const teardownUnproven = (message: string): WorktreeSetupHookTeardownError => {
		preserveHandoffEvidence = true;
		// A missing handoff is itself evidence: retain a durable record next to the
		// worktree so recovery never depends on the transient supervisor error.
		try {
			if (!fs.existsSync(handoffPath)) {
				fs.writeFileSync(handoffPath, handoffRaw ?? JSON.stringify({ type: "setup-hook-teardown-unproven", worktreePath: input.worktreePath, message }), { mode: 0o600 });
			}
		} catch {
			// The typed error below still identifies the worktree and intended evidence
			// path when the filesystem itself refuses evidence creation.
		}
		return new WorktreeSetupHookTeardownError(`${message} Handoff evidence retained at ${handoffPath}. Worktree retained at ${input.worktreePath}.`, handoffPath, input.worktreePath);
	};
	let result: ReturnType<typeof spawnSync>;
	try {
		result = (options?.supervisorSpawn ?? spawnSync)(process.execPath, ["--input-type=module", "--eval", WORKTREE_HOOK_SUPERVISOR, hook.hookPath, String(hook.timeoutMs), String(WORKTREE_GIT_MAX_BUFFER_BYTES), handoffPath], {
			cwd: input.worktreePath,
			encoding: "utf-8",
			input: JSON.stringify(input),
			maxBuffer: WORKTREE_GIT_MAX_BUFFER_BYTES + 1024 * 1024,
			shell: false,
			detached: true,
			// The supervisor's internal deadline performs TERM -> KILL and group
			// proof. This larger outer bound is only a catastrophic escape hatch.
			timeout: hook.timeoutMs + 5_000,
		});
		try {
			if (fs.existsSync(handoffPath)) {
				handoffRaw = fs.readFileSync(handoffPath, "utf8");
				handoff = parseWorktreeHookHandoff(handoffRaw);
			}
		} catch (error) {
			// Invalid handoff data cannot prove a safe process-group teardown. Keep it
			// as recovery evidence rather than allowing createSingleWorktree to remove
			// a checkout whose descendants may still be writing.
			handoff = undefined;
			if (result.error || handoffRaw !== undefined) throw teardownUnproven(`worktree setup hook supervisor failed and its handoff could not be validated (${error instanceof Error ? error.message : String(error)}); preserving worktree for recovery`);
		}
		if (result.error) {
			if (!handoff) throw teardownUnproven("worktree setup hook supervisor failed without a valid process-group handoff; preserving worktree for recovery");
			if (!teardownHookHandoff(handoff)) throw teardownUnproven("worktree setup hook supervisor timed out and hook process-group teardown was not proven; preserving worktree for recovery");
			throw new Error(`worktree setup hook failed: ${result.error.message}`);
		}
		let envelope: { code: number | null; out: string; err: string; overflow: boolean; gone: boolean };
		try { envelope = JSON.parse(result.stdout.trim()); } catch {
			// Invalid supervisor output is not evidence that the hook group is gone.
			// When the supervisor failed before publishing a handoff, there is no
			// identity-safe teardown path at all; retain typed worktree/evidence rather
			// than allowing createSingleWorktree to roll the checkout back.
			if (!handoff) throw teardownUnproven("worktree setup hook supervisor returned invalid output without a valid process-group handoff; preserving worktree for recovery");
			if (!teardownHookHandoff(handoff)) throw teardownUnproven("worktree setup hook supervisor returned invalid output and hook process-group teardown was not proven; preserving worktree for recovery");
			throw new Error("worktree setup hook supervisor returned invalid bounded output");
		}
		if (!envelope.gone && handoff && !teardownHookHandoff(handoff)) throw teardownUnproven("worktree setup hook process group teardown was not proven; preserving worktree for recovery");
		if (!envelope.gone) throw teardownUnproven("worktree setup hook process group teardown was not proven; preserving worktree for recovery");
		if (envelope.overflow) throw new Error(`worktree setup hook exceeded the ${WORKTREE_GIT_MAX_BUFFER_BYTES} byte output limit`);
		if (envelope.code === null) throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		if (envelope.code !== 0) {
			const details = envelope.err.trim() || envelope.out.trim() || "no output";
			throw new Error(`worktree setup hook failed with exit code ${envelope.code}: ${details}`);
		}

	const output = parseWorktreeSetupHookOutput(envelope.out);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
		return [...uniquePaths];
	} finally {
		// The handoff is a narrow, one-shot identity capability; never leave it
		// behind where a later run could mistake it for a live hook. If teardown
		// was unproven, retain it alongside the worktree as recovery evidence.
		if (!preserveHandoffEvidence) {
			try { fs.unlinkSync(handoffPath); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		// An unproven hook teardown may still have descendants writing into this
		// worktree. Never remove either the worktree or its handoff evidence.
		if (error instanceof WorktreeSetupHookTeardownError) throw error;
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo, failures: string[]): void {
	try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch (error) {
		failures.push(`${worktree.path}: worktree removal failed (${error instanceof Error ? error.message : String(error)})`);
	}
	try { runGitChecked(repoCwd, ["branch", "-D", worktree.branch]); } catch (error) {
		failures.push(`${worktree.path}: branch ${worktree.branch} removal failed (${error instanceof Error ? error.message : String(error)})`);
	}
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
			));
		}
	} catch (error) {
		// A hook process-group teardown refusal means descendants may still be
		// writing into the checkout. Removing it here would publish false cleanup
		// and destroy the only actionable recovery path; preserve every materialized
		// worktree until an explicit recovery attempt proves teardown.
		if (error instanceof WorktreeSetupHookTeardownError) throw error;
		try {
			cleanupWorktrees({
				cwd: repo.toplevel,
				worktrees,
				baseCommit: repo.baseCommit,
			});
		} catch (cleanupError) {
			if (cleanupError instanceof WorktreeCleanupError && error instanceof Error) {
				throw new WorktreeCleanupError([...cleanupError.failures, `setup failed (${error.message})`], cleanupError.recoverableWorktreePaths);
			}
			throw cleanupError;
		}
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	const recoverableWorktreePaths = setup.worktrees.map((worktree) => worktree.path);
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch (error) {
		throw new WorktreeDiffCaptureError({
			diffDir: diffsDir,
			recoverableWorktreePaths,
		}, error);
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			throw new WorktreeDiffCaptureError({
				taskIndex: index,
				taskAgent: agent,
				diffDir: diffsDir,
				patchPath,
				worktreePath: worktree.path,
				recoverableWorktreePaths,
			}, error);
		}
	}

	return diffs;
}

export interface CleanupWorktreesOptions {
	/** Keep all temporary worktrees and branches so their changes can be recovered. */
	preserve?: boolean;
}

export function cleanupWorktrees(setup: WorktreeSetup, options?: CleanupWorktreesOptions): void {
	if (options?.preserve) return;
	const failures: string[] = [];
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		cleanupSingleWorktree(setup.cwd, setup.worktrees[index]!, failures);
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch (error) {
		failures.push(`worktree prune failed (${error instanceof Error ? error.message : String(error)})`);
	}
	if (failures.length > 0) throw new WorktreeCleanupError(failures, setup.worktrees.map((worktree) => worktree.path));
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
