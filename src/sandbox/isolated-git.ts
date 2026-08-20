import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BubblewrapSandboxProvider } from "./bubblewrap.ts";
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
}

export interface IsolatedGitBundle {
	path: string;
	checksum: string;
	base: string;
	head: string;
	commitSummary: string;
	portableMetadata: string;
}

interface PortableBundleMetadata {
	version: 1;
	mode: "isolated";
	base: string;
	head: string;
	commits: Array<{ id: string; subject: string; author: string }>;
}

interface GitCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[], input?: string, extraEnv?: Record<string, string | undefined>): GitCommandResult {
	const env = { ...removeGitEnvironment(), ...extraEnv };
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, env });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function checkedGit(cwd: string, args: string[], input?: string, extraEnv?: Record<string, string | undefined>): string {
	const result = runGit(cwd, args, input, extraEnv);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(detail);
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
	const execPath = spawnSync(hostGitPath, ["--exec-path"], { encoding: "utf8", env: removeGitEnvironment() });
	const gitCore = execPath.status === 0 ? execPath.stdout.trim() : "";
	if (!gitCore.startsWith("/")) throw new Error("isolated Git could not resolve the host Git exec path");
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

const [hostSocketPath, noneSocketPath, runtimeRoot, hostGitPath, bwrapCommand, execPath] = process.argv.slice(1);
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
  const args = [];
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
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: Buffer.from(result.stdout ?? "").toString("base64"),
    stderr: Buffer.from(result.stderr ?? "").toString("base64"),
  };
}

function createServer(socketPath, network) {
  try { fs.unlinkSync(socketPath); } catch {}
  return net.createServer((connection) => {
    let data = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      connection.removeAllListeners("data");
      let response;
      try { response = { ok: true, result: run(JSON.parse(data.slice(0, newline)), network) }; }
      catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      connection.end(JSON.stringify(response) + "\n");
    });
  }).listen(socketPath);
}
const servers = [createServer(hostSocketPath, "host"), createServer(noneSocketPath, "none")];
process.on("SIGTERM", () => { for (const server of servers) server.close(); process.exit(0); });
`;

const GIT_POLICY_CLIENT_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";
const socketPath = "/tmp/pi-isolated-git-runtime/server.sock";
try {
  const input = fs.readFileSync(0);
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

function startGitPolicyServer(root: string, hostGitPath: string, execPath: string, bwrapCommand: string): GitPolicyServerHandle {
	const hostSocketPath = path.join(root, "git-policy-host", "server.sock");
	const noneSocketPath = path.join(root, "git-policy-none", "server.sock");
	const server = spawn(process.execPath, [
		"--input-type=module",
		"--eval",
		GIT_POLICY_SERVER_SOURCE,
		hostSocketPath,
		noneSocketPath,
		root,
		hostGitPath,
		bwrapCommand,
		execPath,
	], { stdio: "ignore", detached: true });
	server.unref();
	const deadline = Date.now() + 2000;
	while ((!fs.existsSync(hostSocketPath) || !fs.existsSync(noneSocketPath)) && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	if (!fs.existsSync(hostSocketPath) || !fs.existsSync(noneSocketPath)) {
		try { process.kill(server.pid ?? -1, "SIGTERM"); } catch {}
		throw new Error("isolated Git policy server failed to start");
	}
	return { pid: server.pid ?? -1, socketPath: hostSocketPath };
}

function stopGitPolicyServer(server: GitPolicyServerHandle | undefined): void {
	if (!server || server.pid < 0) return;
	try {
		// The server can be synchronously blocked in a nested Git invocation;
		// use SIGKILL so cleanup never leaves a detached owner of the runtime.
		process.kill(server.pid, "SIGKILL");
	} catch {
		// The server may already have exited after runtime cleanup.
	}
}

function createGitPolicyOverlay(root: string, hostGitPath: string, execPath: string): GitPolicyOverlay {
	const policyDir = path.join(root, "git-policy");
	const execOverlayDir = path.join(policyDir, "git-exec");
	const scriptPath = path.join(policyDir, "git-policy.sh");
	const deniedScriptPath = path.join(policyDir, "git-helper-denied.sh");
	const clientPath = path.join(policyDir, "git-policy-client.mjs");
	const hostPolicyDir = path.join(root, "git-policy-host");
	const nonePolicyDir = path.join(root, "git-policy-none");
	fs.mkdirSync(execOverlayDir, { recursive: true });
	fs.mkdirSync(hostPolicyDir, { recursive: true });
	fs.mkdirSync(nonePolicyDir, { recursive: true });
	fs.writeFileSync(clientPath, GIT_POLICY_CLIENT_SOURCE, "utf8");
	fs.chmodSync(clientPath, 0o444);
	const nodePath = process.execPath.replaceAll('"', '\\"');
	const clientTarget = `${GIT_POLICY_ROOT_TARGET}/git-policy-client.mjs`;
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
	return { scriptPath, clientPath, deniedScriptPath, networkPolicyDirs: { host: hostPolicyDir, none: nonePolicyDir }, execOverlayPath: execOverlayDir, execPath, hostGitPath, targets, helperTargets };
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
	const available = spawnSync(command, ["--version"], { encoding: "utf8" });
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
	});
	if (packed.status !== 0 || !packed.stdout || packed.stdout.length === 0) {
		throw new Error((packed.stderr?.toString() || "failed to construct sanitized Git base").trim());
	}
	const indexed = spawnSync("git", ["-C", baseGitDir, "index-pack", "--stdin"], {
		input: packed.stdout,
		encoding: "utf8",
		env: removeGitEnvironment(),
	});
	if (indexed.status !== 0) throw new Error((indexed.stderr || "failed to index sanitized Git base").trim());
}

function createWorktree(runtime: IsolatedGitRuntime, index: number): IsolatedGitWorktree {
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
	// The pointer is deliberately immutable in the child mount. Metadata remains writable.
	fs.chmodSync(gitPointerPath, 0o444);
	runtime.worktrees.push(worktree);
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
	readonly worktrees: IsolatedGitWorktree[] = [];
	private readonly exportedWorktrees = new Set<number>();
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
		const resolvedExtraReadOnlyMounts = [...(options.extraReadOnlyMounts ?? [])].map((candidate) => path.resolve(candidate));
		const resolvedExtraWritableMounts = [...(options.extraWritableMounts ?? [])].map((candidate) => path.resolve(candidate));
		for (const mount of resolvedExtraReadOnlyMounts) {
			if (!fs.existsSync(mount)) throw new Error(`isolated Git read-only mount does not exist: ${mount}`);
		}
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
			this.bwrapCommand = bwrapCommand;
			this.network = options.network ?? "host";
			this.profile = options.profile ?? "host-toolchain";
			this.fallback = options.fallback ?? "fail";
			this.runId = runtimeId;
			this.instanceId = instanceId;
			const hostGitPath = resolveHostGitPath();
			const execPath = resolveGitExecPath(hostGitPath);
			this.gitPolicy = createGitPolicyOverlay(root, hostGitPath, execPath);
			policyServer = startGitPolicyServer(root, hostGitPath, execPath, bwrapCommand);
			this.gitPolicyServer = policyServer;
			this.extraReadOnlyMounts = resolvedExtraReadOnlyMounts;
			this.extraWritableMounts = resolvedExtraWritableMounts;
			for (const mount of this.extraWritableMounts) fs.mkdirSync(mount, { recursive: true });
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
			stopGitPolicyServer(policyServer);
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}

	createWorktree(options: { index: number }): IsolatedGitWorktree {
		return createWorktree(this, options.index);
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
			{ source: this.gitPolicy.networkPolicyDirs[policyNetwork], mode: "ro", target: GIT_POLICY_ROOT_TARGET },
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

	markExported(index: number): void {
		if (this.exportedWorktrees.has(index)) throw new Error(`isolated Git worktree ${index} already exported`);
		this.exportedWorktrees.add(index);
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

export function createIsolatedGitWorktree(runtime: IsolatedGitRuntime, options: { index: number }): IsolatedGitWorktree {
	if (!runtime.runtimeManaged) throw new Error("isolated Git requires a runtime-managed worktree handle");
	return runtime.createWorktree(options);
}

function commitSummary(worktree: IsolatedGitWorktree, head: string): string {
	return checkedGit(worktree.worktreePath, ["log", "--format=%H%x09%an%x09%s", `${worktree.baseCommit}..${head}`], undefined, worktree.runtime.gitEnv).trim();
}

function portableBundleMetadata(worktree: IsolatedGitWorktree, head: string, summary: string): PortableBundleMetadata {
	const commits = summary.split("\n").filter(Boolean).map((line) => {
		const [id, author, ...subject] = line.split("\t");
		return { id: id ?? "", author: author ?? "", subject: subject.join("\t") };
	});
	return { version: 1, mode: "isolated", base: worktree.baseCommit, head, commits };
}

export function exportIsolatedGitBundle(runtime: IsolatedGitRuntime, options: { outputDir: string; worktree: IsolatedGitWorktree }): IsolatedGitBundle {
	if (options.worktree.runtime !== runtime || !runtime.worktrees.includes(options.worktree)) {
		throw new Error("isolated Git bundle export requires a runtime-managed worktree handle");
	}
	const status = runGit(options.worktree.worktreePath, ["status", "--porcelain"], undefined, runtime.gitEnv);
	if (status.status !== 0) throw new Error(status.stderr.trim() || "cannot inspect isolated Git worktree");
	if (status.stdout.trim()) throw new Error("isolated Git bundle export requires a clean successful worktree");
	const head = checkedGit(options.worktree.worktreePath, ["rev-parse", "HEAD"], undefined, runtime.gitEnv).trim();
	const summary = commitSummary(options.worktree, head);
	if (!summary) throw new Error("isolated Git bundle export requires at least one authored commit");
	const metadata = portableBundleMetadata(options.worktree, head, summary);
	const portableMetadata = JSON.stringify(metadata);
	fs.mkdirSync(options.outputDir, { recursive: true });
	const bundlePath = path.join(options.outputDir, `isolated-success-${runtime.runId}-${runtime.instanceId}-${options.worktree.index}-${head}.bundle`);
	// Git bundle headers do not accept arbitrary comments. Store the portable
	// metadata as a private blob/ref so it is embedded in the verified bundle.
	const metadataBlob = checkedGit(options.worktree.worktreePath, ["hash-object", "-w", "--stdin"], portableMetadata, runtime.gitEnv).trim();
	checkedGit(options.worktree.worktreePath, ["update-ref", "refs/isolated/metadata", metadataBlob], undefined, runtime.gitEnv);
	// Worktree setup starts detached so it cannot accidentally update a shared
	// branch. Materialize the detached successful HEAD as a private export ref
	// only after the child has finished, keeping the parent untouched.
	checkedGit(options.worktree.worktreePath, ["update-ref", `refs/heads/isolated-${options.worktree.index}`, head], undefined, runtime.gitEnv);
	// Export only authored commits after the assigned base. The negative
	// revision makes the base a bundle prerequisite rather than packaging its
	// history or exposing the private base ref.
	checkedGit(options.worktree.worktreePath, ["bundle", "create", bundlePath, `refs/heads/isolated-${options.worktree.index}`, `^${options.worktree.baseCommit}`, "refs/isolated/metadata"], undefined, runtime.gitEnv);
	runtime.markExported(options.worktree.index);
	const checksum = createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
	return { path: bundlePath, checksum, base: options.worktree.baseCommit, head, commitSummary: summary, portableMetadata };
}

export function cleanupIsolatedGitRuntime(runtime: IsolatedGitRuntime): void {
	if (!runtime.runtimeManaged) return;
	stopGitPolicyServer(runtime.gitPolicyServer);
	fs.rmSync(runtime.root, { recursive: true, force: true });
}
