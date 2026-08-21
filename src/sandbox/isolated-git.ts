import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BubblewrapSandboxProvider } from "./bubblewrap.ts";
import { resolveWorktreeSetupHook, runWorktreeSetupHook, WorktreeSetupHookTeardownError, type WorktreeSetupHookConfig } from "../runs/shared/worktree.ts";
import type { GitMode, ResolvedSandboxConfig, SandboxMount, SpawnableInvocation } from "./types.ts";
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
	/** PID of the runner that owns the detached policy server. */
	ownerPid?: number;
	/** Optional production setup hook applied to each runtime worktree. */
	worktreeSetupHook?: WorktreeSetupHookConfig;
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
	readonly policyToken: string;
	/** Runtime-created paths excluded from recovery snapshots by production state. */
	readonly syntheticPaths: string[];
}

export interface IsolatedGitBundle {
	path: string;
	checksum: string;
	base: string;
	head: string;
	commitSummary: string;
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

interface GitPolicyOverlay {
	scriptPath: string;
	clientPath: string;
	/** Per-runtime target path prevents concurrent Bubblewrap mounts colliding. */
	policyRootTarget: string;
	deniedScriptPath: string;
	networkPolicyDirs: { host: string; none: string };
	execOverlayPath: string;
	execPath: string;
	hostGitPath: string;
	targets: string[];
	helperTargets: string[];
}

interface GitPolicyServerHandle {
	pid: number;
	socketPath: string;
	noneSocketPath: string;
	ownerPid: number;
	/** Exact argv used to create this server; required for Linux group cleanup. */
	argv: string[];
	/** Linux /proc/<pid>/stat field 22 captured at spawn. */
	startToken: string;
	/** Expected direct parent and owner identity captured at spawn. */
	parentPid: number;
	ownerUid?: number;
	/** Retained ownership handle for platforms without /proc identity checks. */
	child?: ChildProcess;
}

const GIT_POLICY_ROOT_TARGET = "/tmp/pi-isolated-git-runtime";

function resolveHostGitPath(): string {
	const pathValue = process.env.PATH ?? "";
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "git");
		try {
			if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0) return fs.realpathSync.native(candidate);
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new Error("isolated Git requires a discoverable host git executable");
}

function resolveGitExecPath(hostGitPath: string): string {
	const execPath = spawnSync(hostGitPath, ["--exec-path"], {
		encoding: "utf8",
		env: removeGitEnvironment(),
		timeout: ISOLATED_GIT_TIMEOUT_MS,
		maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES,
	});
	if (execPath.error) throw new Error(`isolated Git exec-path lookup rejected: ${execPath.error.message}`);
	const gitCore = execPath.status === 0 ? execPath.stdout.trim() : "";
	if (!gitCore.startsWith("/")) throw new Error("isolated Git could not resolve the host Git exec path (command failed or exceeded its bounds)");
	return gitCore;
}

// Every executable whose name begins with git is an alternate Git-family
// entry point; only the exact git executable is replaced with the broker.
const GIT_FAMILY_ENTRYPOINT = /^(?:git|scalar$)/;

function isExecutableFile(candidate: string): boolean {
	try {
		const stat = fs.statSync(candidate);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function inventoryGitFamilyEntrypoints(hostGitPath: string, execPath: string): string[] {
	const roots = new Set<string>(["/usr", "/bin", "/sbin", "/lib", "/lib64", path.dirname(hostGitPath), path.dirname(execPath)]);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) roots.add(dir);
	const targets = new Set<string>();
	const visited = new Set<string>();
	const scan = (directory: string, depth: number): void => {
		let realDirectory: string;
		try { realDirectory = fs.realpathSync.native(directory); } catch { return; }
		if (visited.has(realDirectory)) return;
		visited.add(realDirectory);
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(realDirectory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const candidate = path.join(realDirectory, entry.name);
			if (GIT_FAMILY_ENTRYPOINT.test(entry.name) && isExecutableFile(candidate)) {
				try { targets.add(fs.realpathSync.native(candidate)); } catch { targets.add(candidate); }
			}
			// Git's helper directories are normally directly below /usr/lib or
			// /usr/libexec. A shallow walk also finds equivalent vendor layouts,
			// without traversing arbitrary application trees under /usr.
			if (entry.isDirectory() && depth < 3) scan(candidate, depth + 1);
		}
	};
	for (const root of roots) scan(root, 0);
	return [...targets];
}

function pathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function resolveGitPolicyTargets(hostGitPath: string, execPath: string): string[] {
	const targets = new Set(["/usr/bin/git", "/bin/git", hostGitPath]);
	for (const candidate of inventoryGitFamilyEntrypoints(hostGitPath, execPath)) {
		if (path.basename(candidate) === "git" && !pathWithin(execPath, candidate)) targets.add(candidate);
	}
	// The whole exec-path directory is overlaid separately. Keeping its other
	// helpers out of the child prevents direct git-upload-pack and similar
	// subprogram routes from bypassing the controlled entry point.
	targets.delete(path.join(execPath, "git"));
	return [...targets];
}

function resolveGitHelperTargets(hostGitPath: string, execPath: string, policyTargets: readonly string[]): string[] {
	const controlled = new Set(policyTargets.map((target) => path.resolve(target)));
	return inventoryGitFamilyEntrypoints(hostGitPath, execPath).filter((candidate) => {
		if (path.basename(candidate) === "git") return false;
		if (pathWithin(execPath, candidate)) return false;
		if (controlled.has(path.resolve(candidate))) return false;
		return true;
	});
}

const GIT_POLICY_SERVER_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [hostSocketPath, noneSocketPath, runtimeRoot, hostGitPath, bwrapCommand, execPath, ownerPidRaw] = process.argv.slice(1);
const ownerPid = Number(ownerPidRaw);
const worktreesRoot = path.join(runtimeRoot, "worktrees");
const metadataRoot = path.join(runtimeRoot, "metadata");
const policyTokensRoot = path.join(runtimeRoot, "policy-tokens");
const baseGitDir = path.join(runtimeRoot, "base");
const fixedEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EXEC_PATH: execPath,
  HOME: "/tmp/pi-isolated-git-home",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

function rejectProtocolCommand(command) {
  const normalized = path.basename(command).replace(/^git-/, "");
  if (normalized === "shell" || normalized === "daemon" || normalized === "upload-pack" || normalized === "receive-pack" || normalized === "upload-archive" || normalized === "fetch-pack" || normalized === "send-pack" || normalized === "cvsserver" || normalized.startsWith("http-") || normalized.startsWith("remote-")) {
    throw new Error("isolated Git policy rejects direct Git protocol helpers");
  }
  if (normalized === "difftool" || normalized === "mergetool" || normalized === "filter-branch" || normalized === "merge-index" || normalized === "instaweb" || normalized === "send-email" || normalized === "web--browse" || normalized === "gui" || normalized === "citool" || normalized === "gitk" || normalized === "hook" || normalized === "maintenance" || normalized === "fsmonitor--daemon") {
    throw new Error("isolated Git policy rejects external Git callbacks");
  }
  // A private base is intentionally not a remote-capable checkout. Reject
  // porcelain that can invoke a transport even when it is given a URL or a
  // command-scoped transport option; local add/commit/status remain allowed.
  if (["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"].includes(normalized)) {
    throw new Error("isolated Git policy rejects remotes and transport commands");
  }
}

function rejectArgs(args) {
  for (const arg of args) {
    if (arg === "-c" || arg.startsWith("-c") || arg === "--config-env" || arg.startsWith("--config-env=")) {
      throw new Error("isolated Git policy rejects command-line config overrides");
    }
    if (arg === "--extcmd" || arg.startsWith("--extcmd=") || arg === "--ext-diff" || arg === "--tool" || arg.startsWith("--tool=") || arg === "--browser" || arg.startsWith("--browser=") || arg === "--exec" || arg.startsWith("--exec=") || arg === "--pager" || arg.startsWith("--pager=") || arg === "--open-files-in-pager" || arg.startsWith("--open-files-in-pager=") || arg === "--editor" || arg.startsWith("--editor=") || arg === "--fsmonitor" || arg === "--fsmonitor-daemon" || arg === "-x" || arg.startsWith("-x")) {
      throw new Error("isolated Git policy rejects external Git callbacks");
    }
    if (arg.startsWith("-C=") || arg.startsWith("--git-dir") || arg.startsWith("--work-tree") || arg.startsWith("--exec-path") || arg.startsWith("--template") || arg.startsWith("--separate-git-dir")) {
      throw new Error("isolated Git policy rejects repository, executable, or template redirection");
    }
  }
  let command;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-C") {
      if (!args[i + 1]) throw new Error("isolated Git policy rejects incomplete -C");
      i += 1;
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) continue;
    if (arg === "--remote" || arg.startsWith("--remote=") || arg.startsWith("--git-dir") || arg.startsWith("--work-tree") || arg === "--super-prefix" || arg.startsWith("--exec-path") || arg.startsWith("--upload-pack") || arg.startsWith("--receive-pack") || arg.startsWith("--git-upload-pack") || arg.startsWith("--git-receive-pack") || arg.startsWith("--template") || arg.startsWith("--separate-git-dir")) {
      throw new Error("isolated Git policy rejects repository, executable, or template redirection");
    }
    if (arg.startsWith("-")) continue;
    command = arg;
    break;
  }
  if (command === "submodule" && args.slice(args.indexOf(command) + 1).includes("foreach")) {
    throw new Error("isolated Git policy rejects external Git callbacks");
  }
  if (command) rejectProtocolCommand(command);
  if ((command === "help" || args.includes("--help")) && args.some((arg) => arg === "-w" || arg.startsWith("-w") || arg === "--web" || arg.startsWith("--web="))) {
    throw new Error("isolated Git policy rejects external Git callbacks");
  }
  if (command === "config") throw new Error("isolated Git policy rejects config rewriting");
  if (command === "bisect" && args.some((arg, index) => index > args.indexOf(command) && arg === "run")) {
    throw new Error("isolated Git policy rejects external Git callbacks");
  }
  if (command === "grep" && args.some((arg) => arg === "-O" || arg.startsWith("-O"))) {
    throw new Error("isolated Git policy rejects external Git callbacks");
  }
  const signingOperations = ["commit", "tag", "merge", "cherry-pick", "rebase", "revert"];
  const signingControl = (arg) => arg === "-S" || arg.startsWith("-S") || arg === "--gpg-sign" || arg.startsWith("--gpg-sign=") || arg === "--no-gpg-sign" || arg === "--sign" || arg === "--local-user" || arg.startsWith("--local-user=") || arg === "-u" || arg.startsWith("-u");
  const commitTagSigningControl = (arg) => signingControl(arg) || arg === "-s";
  if ((command === "commit" || command === "tag") && args.some(commitTagSigningControl) || (signingOperations.includes(command) && args.some(signingControl))) {
    throw new Error("isolated Git policy rejects signing overrides");
  }
}

function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(candidate);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try { return path.join(fs.realpathSync.native(current), ...suffix); }
  catch { return path.join(path.resolve(current), ...suffix); }
}

function resolveWorktree(cwd) {
  const absolute = canonicalPath(cwd);
  const runtimeWorktrees = canonicalPath(worktreesRoot);
  const relative = path.relative(runtimeWorktrees, absolute);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("isolated Git policy rejects a worktree outside the private runtime");
  const [index] = relative.split(path.sep);
  if (!/^\d+$/.test(index ?? "")) throw new Error("isolated Git policy rejects an unknown worktree");
  const worktree = canonicalPath(path.join(runtimeWorktrees, index));
  if (fs.existsSync(worktree) && isWithin(worktree, absolute)) return { worktree, gitDir: path.join(metadataRoot, index), cwd: absolute };
  throw new Error("isolated Git policy rejects a worktree outside the private runtime");
}

function isWithin(root, candidate) {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function validateRequest(request) {
  if (!request || !Array.isArray(request.args) || typeof request.cwd !== "string") throw new Error("invalid isolated Git request");
  rejectArgs(request.args);
  const resolved = resolveWorktree(request.cwd);
  let expectedToken;
  try { expectedToken = fs.readFileSync(path.join(policyTokensRoot, path.relative(metadataRoot, resolved.gitDir)), "utf8").trim(); }
  catch { throw new Error("isolated Git policy rejects an unauthorized worktree request"); }
  if (typeof request.token !== "string" || request.token !== expectedToken) throw new Error("isolated Git policy rejects an unauthorized worktree request");
  for (let i = 0; i < request.args.length; i += 1) {
    const arg = request.args[i];
    if (arg === "-C") {
      const value = request.args[++i];
      if (!value || !isWithin(resolved.worktree, path.resolve(resolved.cwd, value))) throw new Error("isolated Git policy rejects a redirected worktree");
    } else if (arg.startsWith("-C") && arg.length > 2 && !isWithin(resolved.worktree, path.resolve(resolved.cwd, arg.slice(2)))) {
      throw new Error("isolated Git policy rejects a redirected worktree");
    }
  }
  return resolved;
}

function run(request, network) {
  const resolved = validateRequest(request);
  const requestEnv = request.env ?? {};
  const safeDateEnv = {};
  for (const key of ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
    if (typeof requestEnv[key] === "string" && !/[\r\n]/.test(requestEnv[key])) safeDateEnv[key] = requestEnv[key];
  }
  // Do not assume a Debian-style /lib64 exists. Every system path is
  // mounted only when it exists on the host; omitting an absent optional
  // directory keeps Bubblewrap fail-closed without making the policy distro
  // dependent.
  const args = ["--die-with-parent"];
  for (const systemPath of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    if (fs.existsSync(systemPath)) args.push("--ro-bind", systemPath, systemPath);
  }
  args.push(
    "--proc", "/proc",
    "--dev", "/dev", 
    "--bind", resolved.worktree, resolved.worktree,
    "--bind", resolved.gitDir, resolved.gitDir,
    "--ro-bind", path.join(resolved.gitDir, "config"), path.join(resolved.gitDir, "config"),
    "--ro-bind", baseGitDir, baseGitDir,
    "--ro-bind", path.join(resolved.worktree, ".git"), path.join(resolved.worktree, ".git"),
    "--dir", "/tmp/pi-isolated-git-home",
  );
  const hostGitDir = path.dirname(hostGitPath);
  if (!["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].some((root) => isWithin(root, hostGitDir))) args.push("--ro-bind", hostGitDir, hostGitDir);
  if (network === "none") args.push("--unshare-net");
  args.push("--chdir", resolved.cwd, "--clearenv");
  for (const [key, value] of Object.entries({ ...fixedEnv, ...safeDateEnv })) args.push("--setenv", key, value);
  args.push("--", hostGitPath, ...request.args);
  const result = spawnSync(bwrapCommand, args, {
    input: request.input ? Buffer.from(request.input, "base64") : undefined,
    encoding: null,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: Buffer.from(result.stdout ?? "").toString("base64"),
    stderr: Buffer.from(result.stderr ?? "").toString("base64") || (result.error ? Buffer.from("isolated Git policy command rejected: " + result.error.message).toString("base64") : ""),
  };
}

function createServer(socketPath, network) {
  try { fs.unlinkSync(socketPath); } catch {}
  return net.createServer((connection) => {
    // Absolute deadline and size cap prevent drip-feed requests from keeping
    // this privileged child alive indefinitely.
    const deadline = setTimeout(() => connection.destroy(), 16000);
    const maxRequestBytes = 1024 * 1024;
    let data = "";
    let bytes = 0;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxRequestBytes) { clearTimeout(deadline); connection.destroy(); return; }
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(deadline);
      connection.removeAllListeners("data");
      let response;
      try { response = { ok: true, result: run(JSON.parse(data.slice(0, newline)), network) }; }
      catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      connection.end(JSON.stringify(response) + "\n");
    });
  }).listen(socketPath);
}
const servers = [createServer(hostSocketPath, "host"), createServer(noneSocketPath, "none")];
function ownerIsAlive() {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || process.ppid !== ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    // A SIGKILLed child can remain as a zombie until its parent reaps it;
    // kill(pid, 0) still succeeds in that window, so treat Linux state Z as dead.
    if (process.platform === "linux") {
      const stat = fs.readFileSync("/proc/" + ownerPid + "/stat", "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (state === "Z") return false;
    }
    return true;
  } catch { return false; }
}
const ownerPoll = setInterval(() => {
  if (!ownerIsAlive()) { shutdown(); process.exit(0); }
}, 250);
ownerPoll?.unref?.();
function shutdown() {
  if (ownerPoll) clearInterval(ownerPoll);
  for (const server of servers) { try { server.close(); } catch {} }
  for (const socket of [hostSocketPath, noneSocketPath]) { try { fs.unlinkSync(socket); } catch {} }
}
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });
`;

const GIT_POLICY_CLIENT_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";
const socketPath = "/tmp/pi-isolated-git-runtime/server.sock";
try {
  const maxInputBytes = 768 * 1024;
  const inputChunks = [];
  let inputBytes = 0;
  const inputBuffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const read = fs.readSync(0, inputBuffer, 0, inputBuffer.length, null);
    if (read === 0) break;
    inputBytes += read;
    if (inputBytes > maxInputBytes) throw new Error("isolated Git policy request exceeds the 768 KiB input limit");
    inputChunks.push(Buffer.from(inputBuffer.subarray(0, read)));
  }
  const input = Buffer.concat(inputChunks, inputBytes);
  const request = JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input: input.toString("base64"), token: process.env.PI_ISOLATED_GIT_POLICY_TOKEN, env: { GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE } }) + "\n";
  const socket = net.createConnection(socketPath);
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("end", () => {
    try {
      const response = JSON.parse(data);
      if (!response.ok) { process.stderr.write(response.error + "\n"); process.exitCode = 129; return; }
      process.stdout.write(Buffer.from(response.result.stdout, "base64"));
      process.stderr.write(Buffer.from(response.result.stderr, "base64"));
      process.exitCode = response.result.status;
    } catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
  });
  socket.on("error", (error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
  socket.end(request);
} catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
`;

function startGitPolicyServer(root: string, hostGitPath: string, execPath: string, bwrapCommand: string, spawnPolicyServer: typeof spawn = spawn, ownerPid?: number): GitPolicyServerHandle {
	const hostSocketPath = path.join(root, "git-policy-host", "server.sock");
	const noneSocketPath = path.join(root, "git-policy-none", "server.sock");
	const identityToken = randomUUID();
	const argv = [
		"--input-type=module",
		"--eval",
		GIT_POLICY_SERVER_SOURCE,
		hostSocketPath,
		noneSocketPath,
		root,
		hostGitPath,
		bwrapCommand,
		execPath,
		String(ownerPid ?? process.pid),
		identityToken,
	];
	let spawnError: Error | undefined;
	let server: ReturnType<typeof spawn>;
	try {
		server = spawnPolicyServer(process.execPath, argv, { stdio: "ignore", detached: true });
		// Attach before any synchronous startup wait: a failed detached spawn must
		// never become an unhandled `error` event.
		server.once("error", (error) => {
			spawnError = error instanceof Error ? error : new Error(String(error));
		});
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
	// Capture the child identity before waiting for readiness. A server can
	// create neither socket and still be a live, owned process; rereading only
	// after the readiness timeout loses the exact start token needed for strict
	// teardown verification.
	// Spawn publishes pid before /proc is guaranteed readable. Retry the exact
	// Linux identity briefly; an unknown identity is never promoted to a signal
	// target or externally usable runtime.
	const identityDeadline = Date.now() + 250;
	let startupIdentity: ReturnType<typeof readLinuxProcessIdentity>;
	do {
		startupIdentity = readLinuxProcessIdentity(server.pid ?? -1);
		if (startupIdentity) break;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	} while (Date.now() < identityDeadline);
	server.unref();
	// Full integration runs start many detached policy servers concurrently;
	// allow scheduler/loader contention without treating a slow but healthy
	// server as a failed setup. The bound remains finite and fail-closed.
	const deadline = Date.now() + 10_000;
	while (!spawnError && (!fs.existsSync(hostSocketPath) || !fs.existsSync(noneSocketPath)) && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	if (!fs.existsSync(hostSocketPath) || !fs.existsSync(noneSocketPath)) {
		// Constructor startup is synchronous, so it cannot await the proof needed
		// to reap this detached child. Request termination only after the exact
		// spawn identity check and retain the runtime as actionable evidence.
		const failedServer = {
			pid: server.pid ?? -1,
			socketPath: hostSocketPath,
			noneSocketPath,
			ownerPid: ownerPid ?? process.pid,
			argv,
			startToken: startupIdentity?.startToken ?? "",
			parentPid: startupIdentity?.parentPid ?? process.pid,
			ownerUid: startupIdentity?.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
			child: server,
		} satisfies GitPolicyServerHandle;
		if (policyServerIdentityMatches(failedServer)) {
			// The exact /proc identity proves the private group target. The
			// constructor cannot await exit, so retain the runtime until normal async
			// cleanup proves disappearance.
			try { process.kill(-failedServer.pid, "SIGTERM"); } catch { /* retained root records the unproven teardown */ }
		} else if (server.exitCode == null && server.signalCode == null) {
			// Missing or strict-invalid identity may use only the active detached
			// ChildProcess handle. A failed/unreaped startup must never become a bare
			// PID fallback, and the root remains actionable until reaping is proven.
			try { server.kill("SIGTERM"); } catch { /* retained root records refusal */ }
		}
		const cause = spawnError ? `: ${spawnError.message}` : "";
		throw new Error(`isolated Git policy server failed to start${cause}; isolated Git runtime retained at ${root} because async policy shutdown proof is unavailable`, spawnError ? { cause: spawnError } : undefined);
	}
	const pid = server.pid ?? -1;
	const startToken = startupIdentity?.startToken;
	if (process.platform === "linux" && (!startToken || startupIdentity?.pgid !== pid)) {
		// The detached ChildProcess handle is still unreaped here, so spawn's
		// private-PGID guarantee permits one immediate group teardown attempt even
		// though /proc token capture failed. Keep the runtime root until later
		// async cleanup proves the group was reaped; never signal this PID again.
		if (server.exitCode == null && server.signalCode == null) {
			try { server.kill("SIGTERM"); } catch { /* retained runtime records the unproven teardown */ }
		}
		throw new Error(`isolated Git policy server identity could not be captured as a private PGID; runtime retained at ${root} because async policy shutdown proof is unavailable`);
	}
	return { pid, socketPath: hostSocketPath, noneSocketPath, ownerPid: ownerPid ?? process.pid, argv, startToken: startToken ?? "", parentPid: startupIdentity?.parentPid ?? process.pid, ownerUid: startupIdentity?.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined), child: server };
}

/** Narrow seam for serial startup-failure tests; not part of child settings. */
export function startGitPolicyServerForTests(
	root: string,
	hostGitPath: string,
	execPath: string,
	bwrapCommand: string,
	spawnPolicyServer: typeof spawn,
): GitPolicyServerHandle {
	return startGitPolicyServer(root, hostGitPath, execPath, bwrapCommand, spawnPolicyServer);
}

function readLinuxProcessIdentity(pid: number): { startToken: string; parentPid: number; pgid: number; uid: number } | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
		const parentPid = Number(fields[1]);
		const pgid = Number(fields[2]);
		const startToken = fields[19];
		const uid = fs.statSync(`/proc/${pid}`).uid;
		return Number.isInteger(parentPid) && parentPid > 0 && Number.isInteger(pgid) && pgid > 0 && startToken && Number.isInteger(uid) ? { startToken, parentPid, pgid, uid } : undefined;
	} catch {
		return undefined;
	}
}

function readLinuxProcessStartToken(pid: number): string | undefined {
	return readLinuxProcessIdentity(pid)?.startToken;
}

function policyServerIdentityMatches(server: GitPolicyServerHandle): boolean {
	if (process.platform !== "linux" || !Number.isInteger(server.ownerPid) || server.ownerPid <= 0 || !server.startToken || !Number.isInteger(server.parentPid) || server.parentPid <= 0 || server.argv.length < 11 || server.argv[3] !== server.socketPath || server.argv[4] !== server.noneSocketPath || server.argv[9] !== String(server.ownerPid) || !server.argv[10]) return false;
	try {
		const identity = readLinuxProcessIdentity(server.pid);
		if (!identity || identity.startToken !== server.startToken || identity.parentPid !== server.parentPid || identity.pgid !== server.pid) return false;
		if (server.ownerUid !== undefined && identity.uid !== server.ownerUid) return false;
		const cmdline = fs.readFileSync(`/proc/${server.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		if (cmdline.length !== server.argv.length + 1 || cmdline[0] !== process.execPath) return false;
		for (let index = 0; index < server.argv.length; index += 1) if (cmdline[index + 1] !== server.argv[index]) return false;
		return true;
	} catch {
		return false;
	}
}

/** Narrow serial seam for PID-reuse/argv-mismatch identity tests. */
export function policyServerIdentityMatchesForTests(server: { pid: number; socketPath: string; noneSocketPath: string; ownerPid: number; argv: string[] }): boolean {
	return policyServerIdentityMatches(server as GitPolicyServerHandle);
}

interface PolicyStopOutcome { proven: boolean; reason?: string }

function policyProcessGone(pid: number): boolean {
	try { process.kill(pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Group teardown is proven only by a negative-PGID ESRCH probe. */
function policyProcessGroupGone(pid: number): boolean {
	try { process.kill(-pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

const POLICY_TEARDOWN_TIMEOUT_MS = 2_000;

function waitForChildExit(child: ChildProcess | undefined, timeoutMs: number): Promise<boolean> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(Boolean(child));
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			resolve(value);
		};
		const onExit = (): void => finish(true);
		const onClose = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

async function waitForPolicyProcessGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!policyProcessGroupGone(pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
	return policyProcessGroupGone(pid);
}

async function stopGitPolicyServer(server: GitPolicyServerHandle | undefined): Promise<PolicyStopOutcome> {
	if (!server || !Number.isFinite(server.pid) || !Number.isInteger(server.pid) || server.pid <= 0) return { proven: true };
	// Detached cleanup is fail-closed: on Linux, prove the exact server argv and
	// owner before touching its private process group. A reused PID/PGID is never
	// a valid target, even if its socket path happens to exist.
	if (process.platform === "linux") {
		const child = childForPolicy(server);
		const childIsLive = Boolean(child && child.pid === server.pid && child.exitCode == null && child.signalCode == null);
		const identityMatches = policyServerIdentityMatches(server);
		// Once the owned ChildProcess has exited, its PID is no longer authority.
		// Without exact captured member identities, never signal a possibly reused
		// group; retain the runtime as actionable evidence instead.
		if (!identityMatches) {
			if (!childIsLive) return { proven: policyProcessGroupGone(server.pid), reason: "policy server identity verification refused" };
			// Strict-invalid identity is not permission to signal a possibly shared
			// PGID. The live ChildProcess handle is the sole startup ownership proof;
			// after it exits, retain the runtime rather than falling back to its PID.
			try { child!.kill("SIGTERM"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { proven: false, reason: `policy server signal failed: ${String(error)}` };
			}
			if (!(await waitForChildExit(child, POLICY_TEARDOWN_TIMEOUT_MS))) return { proven: false, reason: "policy server exit could not be proven after identity refusal" };
			return policyProcessGroupGone(server.pid) ? { proven: true } : { proven: false, reason: "policy server identity verification refused; descendants may remain" };
		}
		if (!childIsLive) return policyProcessGroupGone(server.pid) ? { proven: true } : { proven: false, reason: "policy server child already exited without member teardown proof" };
		try { process.kill(-server.pid, "SIGTERM"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { proven: false, reason: `policy server signal failed: ${String(error)}` };
		}
		await waitForChildExit(child, POLICY_TEARDOWN_TIMEOUT_MS);
		// A KILL escalation is safe only while the original detached server is
		// still unreaped and its exact identity remains valid.
		if (!policyProcessGroupGone(server.pid) && child.exitCode == null && child.signalCode == null && policyServerIdentityMatches(server)) {
			try { process.kill(-server.pid, "SIGKILL"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { proven: false, reason: `policy server kill failed: ${String(error)}` };
			}
			await waitForChildExit(child, POLICY_TEARDOWN_TIMEOUT_MS);
		}
		if (!await waitForPolicyProcessGroupGone(server.pid, POLICY_TEARDOWN_TIMEOUT_MS)) return { proven: false, reason: "policy server process group did not disappear within teardown bound" };
		if (child.exitCode == null && child.signalCode == null) return { proven: false, reason: "policy server child did not exit within teardown bound" };
		return { proven: true };
	}
	// Unsupported platforms have no safe /proc identity equivalent. Only the
	// still-live ChildProcess object created by this runtime may be stopped.
	const child = server.child;
	if (!child || child.pid !== server.pid) return { proven: false, reason: "owned policy child identity unavailable" };
	if (child.exitCode !== null || child.signalCode !== null) return { proven: true };
	try { child.kill("SIGTERM"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { proven: false, reason: `policy server signal failed: ${String(error)}` };
	}
	if (!(await waitForChildExit(child, POLICY_TEARDOWN_TIMEOUT_MS))) return { proven: false, reason: "policy server exit could not be proven" };
	return policyProcessGone(server.pid) ? { proven: true } : { proven: false, reason: "policy server exit could not be proven" };
}

function childForPolicy(server: GitPolicyServerHandle): ChildProcess | undefined {
	return server.child;
}

function createGitPolicyOverlay(root: string, hostGitPath: string, execPath: string): GitPolicyOverlay {
	const policyDir = path.join(root, "git-policy");
	// Bubblewrap targets are private to each mount namespace, but all concurrent
	// runtimes still execute the generated client from their own overlay. Keep
	// the target unique so a runtime that is cleaned up cannot invalidate a
	// sibling's child process or policy socket.
	const policyRootTarget = path.join("/tmp", `${path.basename(root)}-policy`);
	const execOverlayDir = path.join(policyDir, "git-exec");
	const scriptPath = path.join(policyDir, "git-policy.sh");
	const deniedScriptPath = path.join(policyDir, "git-helper-denied.sh");
	const clientPath = path.join(policyDir, "git-policy-client.mjs");
	const hostPolicyDir = path.join(root, "git-policy-host");
	const nonePolicyDir = path.join(root, "git-policy-none");
	fs.mkdirSync(execOverlayDir, { recursive: true });
	fs.mkdirSync(hostPolicyDir, { recursive: true });
	fs.mkdirSync(nonePolicyDir, { recursive: true });
	const clientSource = GIT_POLICY_CLIENT_SOURCE.replaceAll(GIT_POLICY_ROOT_TARGET, policyRootTarget);
	fs.writeFileSync(clientPath, clientSource, "utf8");
	fs.chmodSync(clientPath, 0o444);
	const nodePath = process.execPath.replaceAll('"', '\\"');
	const clientTarget = `${policyRootTarget}/git-policy-client.mjs`;
	fs.writeFileSync(scriptPath, `#!/bin/sh\nexec "${nodePath}" "${clientTarget}" "$@"\n`, "utf8");
	fs.chmodSync(scriptPath, 0o555);
	fs.writeFileSync(deniedScriptPath, "#!/bin/sh\nprintf '%s\\n' 'isolated Git policy rejects direct Git helper entry points' >&2\nexit 126\n", "utf8");
	fs.chmodSync(deniedScriptPath, 0o555);
	for (const policyRoot of [hostPolicyDir, nonePolicyDir]) {
		const policyClientPath = path.join(policyRoot, "git-policy-client.mjs");
		const policyScriptPath = path.join(policyRoot, "git-policy.sh");
		fs.copyFileSync(clientPath, policyClientPath);
		fs.chmodSync(policyClientPath, 0o444);
		fs.writeFileSync(policyScriptPath, `#!/bin/sh\nexec "${nodePath}" "${clientTarget}" "$@"\n`, "utf8");
		fs.chmodSync(policyScriptPath, 0o555);
	}
	fs.copyFileSync(scriptPath, path.join(execOverlayDir, "git"));
	fs.chmodSync(path.join(execOverlayDir, "git"), 0o555);
	const targets = resolveGitPolicyTargets(hostGitPath, execPath);
	const helperTargets = resolveGitHelperTargets(hostGitPath, execPath, targets);
	return { scriptPath, clientPath, policyRootTarget, deniedScriptPath, networkPolicyDirs: { host: hostPolicyDir, none: nonePolicyDir }, execOverlayPath: execOverlayDir, execPath, hostGitPath, targets, helperTargets };
}

/** Remove inherited Git redirection variables before any isolated setup command. */
export function sanitizeGitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	return removeGitEnvironment(env);
}

function canonicalPath(candidate: string): string {
	let current = path.resolve(candidate);
	const suffix: string[] = [];
	// realpath(2) only resolves an existing path. Resolve the longest existing
	// ancestor first, then append the non-existent suffix so a symlink cannot
	// hide a future writable mount beneath the parent Git metadata.
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(candidate);
		suffix.unshift(path.basename(current));
		current = parent;
	}
	try {
		return path.join(fs.realpathSync.native(current), ...suffix);
	} catch {
		return path.join(path.resolve(current), ...suffix);
	}
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
	return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Reject a mount that is the parent, the directory, or a child of protected parent Git metadata. */
export function validateIsolatedMounts(
	parentGitPaths: string | readonly string[],
	mounts: readonly string[],
	mode: "read-only" | "writable" = "writable",
): void {
	const protectedPaths = (Array.isArray(parentGitPaths) ? parentGitPaths : [parentGitPaths]).map(canonicalPath);
	for (const candidate of mounts) {
		const resolved = path.resolve(candidate);
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

function resolveIdentity(cwd: string): { userName: string; userEmail: string } {
	const name = readGitConfigValue(cwd, "user.name");
	const email = readGitConfigValue(cwd, "user.email");
	if (!name || !email) {
		const missing = [!name ? "user.name" : undefined, !email ? "user.email" : undefined].filter(Boolean).join(" and ");
		throw new Error(`isolated Git requires parent Git identity; missing ${missing}. Configure git user.name and user.email before launch.`);
	}
	if (/[\r\n]/.test(name) || /[\r\n]/.test(email)) throw new Error("isolated Git parent identity contains a newline and cannot be copied safely");
	return { userName: name, userEmail: email };
}

function ensureBubblewrap(platform: NodeJS.Platform, command: string): void {
	if (platform !== "linux") throw new Error("isolated Git requires Linux Bubblewrap; unsupported platform");
	const available = spawnSync(command, ["--version"], {
		encoding: "utf8",
		timeout: ISOLATED_GIT_TIMEOUT_MS,
		maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES,
	});
	if (available.error) throw new Error(`isolated Git Bubblewrap probe rejected: ${available.error.message}`);
	if (available.status !== 0) throw new Error("isolated Git requires Bubblewrap (bwrap); refusing to run without the sandbox");
}

function safeRunSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function writePrivateGitConfig(worktree: IsolatedGitWorktree): void {
	const configPath = path.join(worktree.gitDir, "config");
	// Use Git's config writer for user-controlled values. Raw interpolation
	// would parse values such as `A # B` as comments and silently change the
	// identity used by child commits.
	fs.writeFileSync(configPath, "", "utf8");
	const set = (key: string, value: string): void => {
		checkedGit(worktree.worktreePath, ["config", "--file", configPath, key, value], undefined, worktree.runtime.gitEnv);
	};
	set("core.repositoryformatversion", "0");
	set("core.filemode", "true");
	set("core.bare", "false");
	set("core.worktree", worktree.worktreePath);
	set("core.logallrefupdates", "false");
	set("core.hooksPath", "/dev/null");
	set("core.pager", "cat");
	set("core.editor", ":");
	set("core.sequenceEditor", ":");
	set("user.name", worktree.userName);
	set("user.email", worktree.userEmail);
	set("credential.helper", "");
	set("commit.gpgsign", "false");
	set("tag.gpgSign", "false");
	// The child may write refs, indexes, and objects, but the policy itself is
	// immutable. The Bubblewrap invocation also overlays this file read-only.
	fs.chmodSync(configPath, 0o444);
}

function privatePack(baseGitDir: string, parentCwd: string, baseCommit: string): void {
	const packed = spawnSync("git", ["-C", parentCwd, "pack-objects", "--revs", "--stdout"], {
		input: `${baseCommit}\n`,
		encoding: null,
		env: removeGitEnvironment(),
		timeout: ISOLATED_GIT_TIMEOUT_MS,
		maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES,
	});
	if (packed.status !== 0 || !packed.stdout || packed.stdout.length === 0) {
		const detail = packed.error instanceof Error ? packed.error.message : packed.stderr?.toString();
		throw new Error(`isolated Git base pack rejected: ${(detail || "failed to construct sanitized Git base").trim()}`);
	}
	const indexed = spawnSync("git", ["-C", baseGitDir, "index-pack", "--stdin"], {
		input: packed.stdout,
		encoding: "utf8",
		env: removeGitEnvironment(),
		timeout: ISOLATED_GIT_TIMEOUT_MS,
		maxBuffer: ISOLATED_GIT_MAX_BUFFER_BYTES,
	});
	if (indexed.status !== 0) throw new Error((indexed.stderr || "failed to index sanitized Git base").trim());
}

function createWorktree(runtime: IsolatedGitRuntime, index: number, agent?: string, runSetupHook = true): IsolatedGitWorktree {
	if (runtime.worktrees.some((candidate) => candidate.index === index)) throw new Error(`isolated Git worktree index ${index} already exists`);
	if (!Number.isInteger(index) || index < 0) throw new Error("isolated Git worktree index must be a non-negative integer");
	const worktreePath = path.join(runtime.root, "worktrees", String(index));
	const gitDir = path.join(runtime.root, "metadata", String(index));
	const policyToken = randomUUID();
	const policyTokenPath = path.join(runtime.root, "policy-tokens", String(index));
	fs.mkdirSync(worktreePath, { recursive: true });
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(path.dirname(policyTokenPath), { recursive: true });
	fs.writeFileSync(policyTokenPath, `${policyToken}\n`, "utf8");
	fs.chmodSync(policyTokenPath, 0o400);
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
		policyToken,
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
	checkedGit(worktreePath, ["checkout", "-f", `refs/heads/isolated-${index}`], undefined, runtime.gitEnv);
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
	readonly root: string;
	readonly cwd: string;
	readonly repositoryRoot: string;
	readonly baseCommit: string;
	readonly baseGitDir: string;
	readonly commonGitDir: string;
	readonly parentGitPaths: string[];
	readonly userName: string;
	readonly userEmail: string;
	readonly gitEnv: Record<string, string | undefined>;
	readonly bwrapCommand: string;
	readonly network: string;
	readonly profile: string;
	readonly fallback: string;
	readonly runId: string;
	/** Unique per-runtime suffix for artifacts sharing caller run metadata. */
	readonly instanceId: string;
	readonly gitPolicy: GitPolicyOverlay;
	private readonly gitPolicyServer: GitPolicyServerHandle;
	readonly extraReadOnlyMounts: string[];
	readonly extraWritableMounts: string[];
	readonly worktreeSetupHook?: ReturnType<typeof resolveWorktreeSetupHook>;
	readonly worktrees: IsolatedGitWorktree[] = [];
	private readonly exportedWorktrees = new Set<number>();
	/** Set when a terminal export failed; unexported worktrees still preserve the runtime path. */
	exportFailed = false;
	/** A timed-out nested stop fence blocks export until a later stop proof succeeds. */
	exportFenceFailed = false;
	/** Hook teardown was not proven; runtime/worktrees must remain recoverable. */
	hookTeardownFailed = false;
	readonly runtimeManaged = true;

	constructor(options: IsolatedGitRuntimeOptions) {
		const cwd = path.resolve(options.cwd);
		const provider = options.provider ?? "bubblewrap";
		const bwrapCommand = options.bwrapCommand ?? "bwrap";
		if (provider !== "bubblewrap") throw new Error(`isolated Git does not support sandbox provider '${provider}'`);
		if (options.fallback === "none") throw new Error("isolated Git refuses fallback none; it cannot run without Bubblewrap");
		ensureBubblewrap(options.platform ?? process.platform, bwrapCommand);
		const commonGitDir = resolveCommonGitDir(cwd);
		const repositoryRoot = resolveRepositoryRoot(cwd);
		const parentGitPaths = resolveParentGitPaths(cwd, commonGitDir);
		// Every caller/resource mount is checked before any mount is created. A
		// read-only bind of parent metadata is still an exposure: isolated children
		// must not see the parent's common store, worktree gitdir, or .git pointer.
		validateIsolatedMounts(parentGitPaths, options.extraReadOnlyMounts ?? [], "read-only");
		validateIsolatedMounts(parentGitPaths, options.extraWritableMounts ?? [], "writable");
		const baseCommit = resolveBaseCommit(cwd, options.baseCommit);
		const identity = resolveIdentity(cwd);
		const resolvedWorktreeSetupHook = resolveWorktreeSetupHook(repositoryRoot, options.worktreeSetupHook);
		const resolvedExtraReadOnlyMounts = [...(options.extraReadOnlyMounts ?? [])].map((candidate) => path.resolve(candidate));
		const resolvedExtraWritableMounts = [...(options.extraWritableMounts ?? [])].map((candidate) => path.resolve(candidate));
		for (const mount of resolvedExtraReadOnlyMounts) {
			if (!fs.existsSync(mount)) throw new Error(`isolated Git read-only mount does not exist: ${mount}`);
		}
		// Validate and prepare caller-owned writable mounts before creating the
		// private runtime or starting its policy server. A deterministic setup
		// error must not require asynchronous process teardown in the constructor.
		for (const mount of resolvedExtraWritableMounts) fs.mkdirSync(mount, { recursive: true });
		const runtimeId = safeRunSegment(options.runId ?? randomUUID());
		const instanceId = randomUUID();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-isolated-git-${runtimeId}-`));
		let policyServer: GitPolicyServerHandle | undefined;
		try {
			this.root = root;
			this.cwd = cwd;
			this.repositoryRoot = repositoryRoot;
			this.baseCommit = baseCommit;
			this.commonGitDir = commonGitDir;
			this.parentGitPaths = parentGitPaths;
			this.userName = identity.userName;
			this.userEmail = identity.userEmail;
			this.worktreeSetupHook = resolvedWorktreeSetupHook;
			this.bwrapCommand = bwrapCommand;
			this.network = options.network ?? "host";
			this.profile = options.profile ?? "host-toolchain";
			this.fallback = options.fallback ?? "fail";
			this.runId = runtimeId;
			this.instanceId = instanceId;
			const hostGitPath = resolveHostGitPath();
			const execPath = resolveGitExecPath(hostGitPath);
			this.gitPolicy = createGitPolicyOverlay(root, hostGitPath, execPath);
			policyServer = startGitPolicyServer(root, hostGitPath, execPath, bwrapCommand, spawn, options.ownerPid);
			this.gitPolicyServer = policyServer;
			this.extraReadOnlyMounts = resolvedExtraReadOnlyMounts;
			this.extraWritableMounts = resolvedExtraWritableMounts;
			this.gitEnv = {
				...removeGitEnvironment(),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_PAGER: "cat",
				GIT_EDITOR: ":",
				GIT_SEQUENCE_EDITOR: ":",
				GIT_ASKPASS: "/bin/false",
				GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
				GIT_OPTIONAL_LOCKS: "0",
				HOME: path.join(root, "home"),
				PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			};
			fs.mkdirSync(path.join(root, "home"), { recursive: true });
			this.baseGitDir = path.join(root, "base");
			fs.mkdirSync(this.baseGitDir, { recursive: true });
			checkedGit(this.baseGitDir, ["init", "--bare"], undefined, this.gitEnv);
			privatePack(this.baseGitDir, cwd, baseCommit);
			checkedGit(this.baseGitDir, ["update-ref", "refs/heads/isolated-base", baseCommit], undefined, this.gitEnv);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const retainedByPolicyFailure = detail.includes("isolated Git runtime retained at");
			// A constructor cannot await child exit/PGID absence. Preserve the root
			// on every startup failure unless no policy child was ever created.
			if (policyServer || retainedByPolicyFailure) {
				if (policyServer && policyServerIdentityMatches(policyServer)) {
					try { process.kill(-policyServer.pid, "SIGTERM"); } catch { /* root remains actionable */ }
				} else if (policyServer?.child && policyServer.child.exitCode == null && policyServer.child.signalCode == null) {
					// Startup identity refusal permits only the active ChildProcess
					// handle. Never signal a bare PID after this handle is reaped.
					try { policyServer.child.kill("SIGTERM"); } catch { /* root remains actionable */ }
				}
				if (retainedByPolicyFailure) throw error;
				throw new Error(`${detail}; isolated Git runtime retained at ${root} because async policy shutdown proof is unavailable`, { cause: error });
			}
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}

	createWorktree(options: { index: number; agent?: string }): IsolatedGitWorktree {
		return createWorktree(this, options.index, options.agent);
	}

	/** Create a recovery-only slot after setup failed; never reruns user setup. */
	createRecoveryWorktree(options: { index: number; agent?: string }): IsolatedGitWorktree {
		return createWorktree(this, options.index, options.agent, false);
	}

	wrapInvocation(
		worktree: IsolatedGitWorktree,
		invocation: SpawnableInvocation,
		resourceMounts: SandboxMount[] = [],
		sandboxConfig?: Pick<ResolvedSandboxConfig, "network" | "profile" | "fallback">,
	): SpawnableInvocation {
		if (worktree.runtime !== this || !this.worktrees.includes(worktree)) {
			throw new Error("isolated Git invocation requires a runtime-managed worktree handle");
		}
		const readOnlyResourcePaths = resourceMounts.filter((mount) => mount.mode === "ro").flatMap((mount) => [mount.source, ...(mount.target ? [mount.target] : [])]);
		const writableResourcePaths = resourceMounts.filter((mount) => mount.mode === "rw").flatMap((mount) => [mount.source, ...(mount.target ? [mount.target] : [])]);
		validateIsolatedMounts(this.parentGitPaths, readOnlyResourcePaths, "read-only");
		validateIsolatedMounts(this.parentGitPaths, writableResourcePaths, "writable");
		const nodeRoot = path.dirname(path.dirname(process.execPath));
		const requestedNetwork = sandboxConfig?.network ?? this.network;
		if (requestedNetwork !== "host" && requestedNetwork !== "none") throw new Error(`isolated Git does not support network policy '${requestedNetwork}'`);
		const policyNetwork = requestedNetwork as "host" | "none";
		const policyMounts: SandboxMount[] = [
			// Only the selected policy client and its network-specific RPC socket
			// are exposed. The host Git executable is held by the policy server
			// outside this PID namespace; no real Git file is mounted into child.
			{ source: this.gitPolicy.networkPolicyDirs[policyNetwork], mode: "ro", target: this.gitPolicy.policyRootTarget },
			{ source: this.gitPolicy.execOverlayPath, mode: "ro", target: this.gitPolicy.execPath },
			...this.gitPolicy.targets.map((target) => ({ source: this.gitPolicy.scriptPath, mode: "ro" as const, target })),
			...this.gitPolicy.helperTargets.map((target) => ({ source: this.gitPolicy.deniedScriptPath, mode: "ro" as const, target })),
		];
		const mounts: SandboxMount[] = [
			{ source: nodeRoot, mode: "ro" },
			{ source: worktree.worktreePath, mode: "rw" },
			{ source: worktree.gitDir, mode: "rw" },
			// Keep policy config immutable while leaving the containing metadata
			// directory writable for refs, indexes, logs, and objects.
			{ source: path.join(worktree.gitDir, "config"), mode: "ro" },
			{ source: this.baseGitDir, mode: "ro" },
			{ source: worktree.gitPointerPath, mode: "ro" },
			// Resource mounts are assembled for the selected child invocation. Do
			// not add runtime-level extras here: a runtime may serve siblings with
			// different mount grants, while only this sanitized base is shared.
			...resourceMounts,
			// Policy overlays are intentionally last so a caller resource mount
			// cannot replace the protected Git entry points.
			...policyMounts,
		];
		const invocationCwd = invocation.cwd ?? worktree.worktreePath;
		if (!isPathWithin(worktree.worktreePath, invocationCwd)) {
			throw new Error(`isolated Git cwd '${path.resolve(invocationCwd)}' is outside the assigned private worktree`);
		}
		const provider = new BubblewrapSandboxProvider({ bwrapCommand: this.bwrapCommand, env: this.gitEnv, unsharePid: true });
		const wrapped = provider.wrapInvocation({
			config: {
				provider: "bubblewrap",
				profile: sandboxConfig?.profile ?? this.profile,
				network: requestedNetwork,
				// Isolated Git never permits Bubblewrap's unsandboxed fallback, even
				// when an enclosing run requested fallback: none.
				fallback: "fail",
				auth: "none",
			},
			invocation: {
				...invocation,
				cwd: invocationCwd,
				// Caller/process Git_* variables are never allowed to override the
				// runtime's private metadata and config policy.
				env: {
					...removeGitEnvironment(invocation.env as NodeJS.ProcessEnv | undefined),
					...this.gitEnv,
					PI_ISOLATED_GIT_POLICY_TOKEN: worktree.policyToken,
				},
			},
			mounts,
		});
		return wrapped.invocation;
	}

	isExported(index: number): boolean {
		return this.exportedWorktrees.has(index);
	}

	markExported(index: number): void {
		if (this.exportedWorktrees.has(index)) throw new Error(`isolated Git worktree ${index} already exported`);
		this.exportedWorktrees.add(index);
		if (this.worktrees.length > 0 && this.worktrees.every((worktree) => this.exportedWorktrees.has(worktree.index))) {
			// A previously failed export has been successfully retried for every
			// worktree; the cleanup gate may now consider this runtime complete.
			this.exportFailed = false;
		}
	}

	markExportFailed(): void {
		this.exportFailed = true;
	}

	markExportFenceFailed(): void {
		this.exportFenceFailed = true;
		this.exportFailed = true;
	}

	markHookTeardownFailed(): void {
		this.hookTeardownFailed = true;
		this.exportFailed = true;
	}

	/** Clear a previously refused stop fence only after a later proof succeeds. */
	markExportFenceResolved(): void {
		this.exportFenceFailed = false;
	}
}

export function createIsolatedGitRuntime(options: IsolatedGitRuntimeOptions): IsolatedGitRuntime {
	return new IsolatedGitRuntime(options);
}

/** Map a parent repository cwd to the same relative location in a private worktree. */
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

function commitSummary(worktree: IsolatedGitWorktree, head: string): string {
	if (head === worktree.baseCommit) return "";
	const ancestry = runGit(worktree.worktreePath, ["merge-base", "--is-ancestor", worktree.baseCommit, head], undefined, worktree.runtime.gitEnv);
	if (ancestry.status !== 0) throw new Error("isolated Git HEAD is not based on the assigned base commit");
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
	const summary = commitSummary(worktree, head);
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
	checkedGit(worktree.worktreePath, ["update-ref", `refs/heads/isolated-${worktree.index}`, head], undefined, runtime.gitEnv);
	if (recovery) checkedGit(worktree.worktreePath, ["update-ref", `refs/isolated/recovery-${worktree.index}`, recovery], undefined, runtime.gitEnv);
	if (stagedSnapshot) checkedGit(worktree.worktreePath, ["update-ref", `refs/isolated/staged-${worktree.index}`, stagedSnapshot], undefined, runtime.gitEnv);
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
	if (!runtime.runtimeManaged) return;
	const allWorktreesExported = runtime.worktrees.length === 0
		|| runtime.worktrees.every((worktree) => runtime.isExported(worktree.index));
	// Stop the policy server only after every private checkout has a verified
	// bundle. A fence refusal or packaging failure keeps the complete runtime
	// alive for operator recovery; even calling the cleanup helper must not tear
	// down that evidence.
	if (!allWorktreesExported || runtime.exportFailed || runtime.exportFenceFailed || runtime.hookTeardownFailed) return;
	const stop = await stopGitPolicyServer(runtime.gitPolicyServer);
	if (!stop.proven) {
		runtime.markExportFailed();
		return;
	}
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
	if (!runtime.runtimeManaged || !fs.existsSync(runtime.root)) return;
	const stop = await stopGitPolicyServer(runtime.gitPolicyServer);
	if (!stop.proven) return;
	fs.rmSync(runtime.root, { recursive: true, force: true });
}
