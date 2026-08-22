import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SandboxMount, SpawnableInvocation } from "./types.ts";

/** Rights understood by the owner endpoint.  They are deliberately not
 * bearer credentials: a scope is an opaque reference to owner memory. */
export type ScopedGitRights = "writer" | "read-only";
export type ScopedGitNetwork = "host" | "none";

/** Minimal capability carried across a foreground nested launch.  It is only
 * a relative identity inside the fixed /run/pi-scoped-git mount; all worktree,
 * cwd, rights, lease, and endpoint authority stay in the owner process. */
export interface ScopedGitEndpointDescriptor {
	readonly relativeSubtree: string;
}

type InternalScopedGitEndpointDescriptor = ScopedGitEndpointDescriptor & {
	readonly __ownerRelativeSubtree?: string;
	readonly __hostEndpointRoot?: string;
};

function attachDescriptorMetadata(
	descriptor: ScopedGitEndpointDescriptor,
	metadata: { ownerRelativeSubtree?: string; hostEndpointRoot?: string },
): ScopedGitEndpointDescriptor {
	for (const [key, value] of Object.entries({ __ownerRelativeSubtree: metadata.ownerRelativeSubtree, __hostEndpointRoot: metadata.hostEndpointRoot })) {
		if (value !== undefined) Object.defineProperty(descriptor, key, { value, enumerable: false, configurable: false });
	}
	return descriptor;
}

export interface ScopedGitScope {
	readonly runtimeId: string;
	readonly scopeId: string;
	readonly worktree: string;
	readonly cwd: string;
	readonly rights: ScopedGitRights;
	readonly network: ScopedGitNetwork;
	readonly endpointRoot: string;
	readonly endpoint: string;
	/** Host Git's exec directory, which is overlaid atomically in children. */
	readonly execPath: string;
}

export interface ScopedGitEndpointOptions {
	readonly runtimeRoot: string;
	readonly worktree: string;
	readonly cwd?: string;
	readonly rights: ScopedGitRights;
	readonly network?: ScopedGitNetwork;
	readonly runtimeId?: string;
	readonly gitPath?: string;
	/** Owner-only reservation deadline override used by deterministic tests. */
	readonly reservationTimeoutMs?: number;
}

export interface ScopedGitProcessIdentity {
	readonly pid: number;
	readonly startToken: string;
	readonly uid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly argv: readonly string[];
}

export interface ScopedGitEndpointServer {
	readonly scope: ScopedGitScope;
	/** Descriptor is safe to serialize: it contains no host path or authority. */
	readonly descriptor: ScopedGitEndpointDescriptor;
	readonly reserveChild: (options: { cwd?: string; rights?: ScopedGitRights; allowWriter?: boolean }) => ScopedGitEndpointServer;
	/** Delegate the writer lease to one already-spawned child.  The parent lease
	 * remains suspended until the exact process identity has disappeared. */
	readonly delegateWriter: (identity: ScopedGitProcessIdentity, options?: { cwd?: string; descriptor?: ScopedGitEndpointDescriptor }) => ScopedGitEndpointServer & { readonly waitForRelease: Promise<void> };
	readonly invocationMounts: (scope?: ScopedGitScope) => SandboxMount[];
	/** Returns true only after all exact process groups are gone and endpoint evidence is removed. */
	readonly close: () => Promise<boolean>;
}

const TARGET = "/run/pi-scoped-git";
const WRAPPER = `${TARGET}/git`;
const MAX_REQUEST = 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const DEADLINE = 15_000;
const writerLeases = new Map<string, string>();
const randomPart = () => randomBytes(8).toString("hex");

type ReservationState = "pending" | "bound" | "released" | "cancelled";
interface WriterReservation {
	readonly id: string;
	readonly parentScopeId: string;
	readonly childScopeId: string;
	state: ReservationState;
	identity?: ScopedGitProcessIdentity;
	expires?: ReturnType<typeof setTimeout>;
}
interface LeaseState {
	readonly reservations: Map<string, WriterReservation>;
}

function exactIdentityMatches(expected: ScopedGitProcessIdentity, actual: ScopedGitProcessIdentity | undefined): boolean {
	return Boolean(actual && actual.startToken === expected.startToken && actual.uid === expected.uid
		&& actual.ppid === expected.ppid && actual.pgid === expected.pgid
		&& actual.argv.length === expected.argv.length && actual.argv.every((arg, index) => arg === expected.argv[index]));
}

/**
 * A PID disappearing is not enough: a detached child may have left descendants
 * in its private process group, and a reused PID/PGID must fail closed.  Scan
 * /proc for the original group and reject a still-present original PID whose
 * identity changed.  ESRCH is proof only after both checks are clean.
 */
function processGroupGone(identity: ScopedGitProcessIdentity): boolean {
	if (process.platform === "win32") return !processIdentity(identity.pid);
	if (process.platform !== "linux") return false;
	const currentLeader = processIdentity(identity.pid);
	if (currentLeader && !exactIdentityMatches(identity, currentLeader)) return false;
	// Direct API callers may provide a non-detached process. The foreground
	// execution path always supplies a private pgid == pid.
	if (identity.pgid !== identity.pid) return !currentLeader;
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^\d+$/u.test(entry)) continue;
			const member = processIdentity(Number(entry));
			if (member?.pgid === identity.pgid) return false;
		}
	} catch {
		return false;
	}
	return true;
}

function canonical(candidate: string): string {
	const absolute = path.resolve(candidate);
	let current = absolute;
	const suffix: string[] = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return absolute;
		suffix.unshift(path.basename(current));
		current = parent;
	}
	return path.join(fs.realpathSync.native(current), ...suffix);
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(canonical(root), canonical(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function processIdentity(pid: number): ScopedGitProcessIdentity | undefined {
	if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const close = stat.lastIndexOf(")"); const fields = stat.slice(close + 2).split(/\s+/u);
		const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		const uid = fs.statSync(`/proc/${pid}`).uid;
		return { pid, startToken: fields[19]!, ppid: Number(fields[1]), pgid: Number(fields[2]), uid, argv };
	} catch { return undefined; }
}

export function readScopedGitProcessIdentity(pid: number): ScopedGitProcessIdentity | undefined { return processIdentity(pid); }

function processIdentityGone(identity: ScopedGitProcessIdentity): boolean {
	return processGroupGone(identity);
}

function commandName(args: readonly string[]): string {
	// Git global options are deliberately not supported.  In particular, do not
	// skip -C here: accepting it would make the endpoint's authenticated cwd a
	// suggestion rather than a boundary.
	return args.length > 0 && !args[0]!.startsWith("-") ? args[0]! : "";
}

const SAFE_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "diff-index", "diff-tree", "cat-file", "add", "commit"]);
const READ_ONLY_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "diff-index", "diff-tree", "cat-file"]);
const SAFE_OPTIONS: Record<string, Set<string>> = {
	status: new Set(["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-z", "--branch", "--untracked-files", "-u", "--ignored", "--ahead-behind", "--renames", "--find-renames", "--no-renames", "--no-ahead-behind", "--column", "--no-column", "--show-stash", "--no-optional-locks", "--",]),
	diff: new Set(["--cached", "--staged", "--merge", "--index", "--quiet", "--exit-code", "--name-only", "--name-status", "--stat", "--numstat", "--shortstat", "--compact-summary", "--binary", "--full-index", "--abbrev", "--no-abbrev", "--minimal", "--patience", "--histogram", "--no-renames", "--find-renames", "--find-copies", "--diff-algorithm=patience", "--diff-algorithm=histogram", "--submodule", "--no-ext-diff", "--no-textconv", "--",]),
	log: new Set(["--oneline", "--no-patch", "-1", "-n", "--max-count", "--format", "--format=%H%x09%an%x09%s", "--pretty", "--decorate", "--stat", "--name-only", "--name-status", "--follow", "--all", "--first-parent", "--reverse", "--",]),
	show: new Set(["--stat", "--name-only", "--name-status", "--format", "--pretty", "--no-patch", "--raw", "--patch", "--text", "--",]),
	"rev-parse": new Set(["--verify", "--quiet", "--short", "--symbolic", "--symbolic-full-name", "--abbrev-ref", "--show-prefix", "--show-cdup", "--is-inside-work-tree", "--is-inside-git-dir", "--end-of-options", "--",]),
	"ls-files": new Set(["-z", "--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged", "--killed", "--directory", "--no-empty-directory", "--exclude-standard", "--full-name", "--error-unmatch", "--with-tree", "--",]),
	"diff-index": new Set(["--cached", "--quiet", "--exit-code", "--name-only", "--name-status", "--stat", "--numstat", "--raw", "--",]),
	"diff-tree": new Set(["--root", "--stdin", "--no-commit-id", "--name-only", "--name-status", "--stat", "--numstat", "--raw", "-r", "--recursive", "--",]),
	"cat-file": new Set(["-t", "-s", "-e", "-p", "--batch", "--batch-check", "--batch-command", "--buffer", "--follow-symlinks", "--textconv", "--filters"]),
	add: new Set(["-A", "--all", "-u", "--update", "-n", "--dry-run", "-f", "--force", "--ignore-errors", "--ignore-missing", "--intent-to-add", "--refresh", "--renormalize", "--",]),
	commit: new Set(["-m", "--message", "--no-edit", "--allow-empty", "--allow-empty-message", "--cleanup=strip", "--cleanup=whitespace", "--status", "--no-status", "--quiet", "--dry-run"]),
};
const VALUE_OPTIONS = new Set(["-n", "--max-count", "--format", "--pretty", "--abbrev", "--untracked-files", "--column", "--submodule", "--with-tree", "-m", "--message"]);
const FORBIDDEN_OPTIONS = /^(?:--(?:no-index|output(?:=|$)|pathspec-from-file(?:=|$)|pathspec-file-nul|exec-path(?:=|$)|git-dir(?:=|$)|work-tree(?:=|$)|separate-git-dir(?:=|$)|upload-pack(?:=|$)|receive-pack(?:=|$)|config-env(?:=|$)|ext-diff|textconv|filters|tool(?:=|$)|exec(?:=|$)|pager(?:=|$)|hooks-path(?:=|$)|template(?:=|$)|file(?:=|$)|author(?:=|$)|gpg-sign(?:=|$)|reuse-message(?:=|$)|reedit-message(?:=|$)|fixup(?:=|$)|squash(?:=|$)|amend|force-rebase|force-with-lease|rebase-merges)|-C|-c)$/u;

/** Git's safe owner policy. It is a command/option allowlist, not a blacklist. */
export function validateScopedGitCommand(args: readonly string[], rights: ScopedGitRights): void {
	const command = commandName(args);
	for (const arg of args) {
		if (arg === "-c" || arg.startsWith("-c") || arg === "--config-env" || arg.startsWith("--config-env=")) throw new Error("scoped Git endpoint rejects configuration overrides");
	}
	if (!SAFE_COMMANDS.has(command) || (rights === "read-only" ? !READ_ONLY_COMMANDS.has(command) : false)) throw new Error(`scoped Git endpoint rejects unknown or unavailable command '${command || "(empty)"}'`);
	const options = SAFE_OPTIONS[command]!;
	let afterPathspec = false;
	for (let index = 1; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--") { if (!options.has("--")) throw new Error("scoped Git endpoint rejects pathspec separator"); afterPathspec = true; continue; }
		if (FORBIDDEN_OPTIONS.test(arg) || arg === "-C" || arg.startsWith("-C") || arg === "-c" || arg.startsWith("-c")) throw new Error(`scoped Git endpoint rejects option '${arg}'`);
		if (arg.startsWith("-") && !afterPathspec) {
			const base = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
			if (!options.has(arg) && !options.has(base) && !(command === "commit" && (arg === "-m" || arg === "--message"))) throw new Error(`scoped Git endpoint rejects option '${arg}'`);
			if (VALUE_OPTIONS.has(base) && !arg.includes("=") && index + 1 >= args.length) throw new Error(`scoped Git endpoint option '${arg}' requires a value`);
			if ((base === "--format" || base === "--pretty" || base === "--submodule" || base === "--with-tree" || base === "--abbrev" || base === "--untracked-files" || base === "--column" || base === "-n" || base === "--max-count" || base === "-m" || base === "--message") && !arg.includes("=") ) index += 1;
			continue;
		}
		// Once -- has been seen every remaining token is a pathspec. Before it,
		// only known revision-like tokens are accepted; absolute host paths are
		// never valid endpoint input.
		if (path.isAbsolute(arg) || arg.includes("\\")) throw new Error("scoped Git endpoint rejects absolute or host path arguments");
		if (!afterPathspec && command !== "cat-file" && !/^[A-Za-z0-9._~^:/@{}+%-]+$/u.test(arg)) throw new Error("scoped Git endpoint rejects ambiguous path or revision argument");
	}
	if (command === "commit" && args.some((arg) => arg === "--no-verify" || arg === "--amend")) throw new Error("scoped Git endpoint rejects hook bypass or history rewrite");
}

function cleanGitEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
	Object.assign(env, {
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
		GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
		GIT_CONFIG_KEY_2: "core.sshCommand", GIT_CONFIG_VALUE_2: "false",
		GIT_CONFIG_KEY_3: "credential.helper", GIT_CONFIG_VALUE_3: "",
		GIT_CONFIG_KEY_4: "filter.lfs.process", GIT_CONFIG_VALUE_4: "",
		GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":", GIT_ASKPASS: "/bin/false", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1",
		HOME: "/tmp/pi-scoped-git-home", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	});
	return env;
}

interface LocalConfigSnapshot {
	readonly files: Map<string, { exists: boolean; mode?: number; uid?: number; digest?: string }>;
	readonly aliases: boolean;
	readonly unsafeHelpers: boolean;
}

function localConfigFiles(worktree: string): string[] {
	const gitPointer = path.join(worktree, ".git");
	let gitDir = gitPointer;
	try {
		if (fs.statSync(gitPointer).isFile()) {
			const match = /^gitdir:\s*(.+)\s*$/imu.exec(fs.readFileSync(gitPointer, "utf8"));
			if (match) gitDir = path.resolve(worktree, match[1]!);
		}
	} catch { /* missing metadata is reported by Git */ }
	return [path.join(gitDir, "config"), path.join(gitDir, "config.worktree")];
}

function localConfigHasUnsafeBehavior(text: string, worktree: string): { aliases: boolean; unsafeHelpers: boolean } {
	let section = "";
	let aliases = false;
	let unsafeHelpers = false;
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const sectionMatch = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\](?:\s*[#;].*)?$/u.exec(line);
		if (sectionMatch) {
			section = sectionMatch[1]!.toLowerCase();
			if (section === "alias") aliases = true;
			if (["remote", "url", "submodule", "include", "includeif", "gpg"].includes(section)) unsafeHelpers = true;
			continue;
		}
		const keyMatch = /^([A-Za-z0-9.-]+)\s*(?:(=)\s*(.*))?$/u.exec(line);
		if (!keyMatch) continue;
		const key = keyMatch[1]!.toLowerCase();
		const value = (keyMatch[3] ?? "").trim().replace(/^"(.*)"$/u, "$1");
		const explicitEmpty = keyMatch[2] === "=" && value === "";
		const fullKey = section ? `${section}.${key}` : key;
		if (fullKey.startsWith("alias.")) aliases = true;
		let configuredWorktreeIsExpected = false;
		if (fullKey === "core.worktree" && path.isAbsolute(value)) {
			try { configuredWorktreeIsExpected = canonical(value) === canonical(worktree); } catch { configuredWorktreeIsExpected = false; }
		}
		if ((fullKey === "diff.external" && !explicitEmpty) || (section === "diff" && ["external", "textconv", "command"].includes(key) && !explicitEmpty)
			|| (section === "credential" && key === "helper" && !explicitEmpty) || (section === "merge" && key === "driver" && !explicitEmpty)
			|| (fullKey === "core.worktree" && !configuredWorktreeIsExpected)
			|| ["core.attributesfile", "core.excludesfile", "core.gitproxy", "core.alternaterefscommand"].includes(fullKey)
			|| (fullKey === "core.bare" && value.toLowerCase() !== "false")
			|| (fullKey === "core.editor" && value !== ":") || (fullKey === "core.sequenceeditor" && value !== ":") || (fullKey === "core.pager" && value !== "cat")
			|| (fullKey === "commit.gpgsign" && value.toLowerCase() !== "false") || (fullKey === "tag.gpgsign" && value.toLowerCase() !== "false")
			|| (fullKey === "core.sshcommand" && value.toLowerCase() !== "false")
			|| (fullKey === "core.fsmonitor" && value.toLowerCase() !== "false")
			|| (fullKey === "core.hookspath" && value !== "/dev/null")
			|| (section === "filter" && ["clean", "smudge", "process", "required"].includes(key) && !explicitEmpty)
			|| fullKey.startsWith("include.") || fullKey.startsWith("includeif.")) unsafeHelpers = true;
	}
	return { aliases, unsafeHelpers };
}

function snapshotLocalConfig(worktree: string): LocalConfigSnapshot {
	const files = new Map<string, { exists: boolean; mode?: number; uid?: number; digest?: string }>(); let aliases = false; let unsafeHelpers = false;
	for (const file of localConfigFiles(worktree)) {
		try {
			const stat = fs.lstatSync(file); const content = fs.readFileSync(file);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("local Git config is not a regular file");
			const behavior = localConfigHasUnsafeBehavior(content.toString("utf8"), worktree);
			aliases ||= behavior.aliases;
			unsafeHelpers ||= behavior.unsafeHelpers;
			files.set(file, { exists: true, mode: stat.mode, uid: stat.uid, digest: content.toString("base64") });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") files.set(file, { exists: false });
			else throw error;
		}
	}
	return { files, aliases, unsafeHelpers };
}

function verifyLocalConfig(snapshot: LocalConfigSnapshot): void {
	for (const [file, expected] of snapshot.files) {
		try {
			const stat = fs.lstatSync(file); const content = fs.readFileSync(file);
			const digest = content.toString("base64");
			if (!expected.exists || stat.isSymbolicLink() || !stat.isFile() || stat.mode !== expected.mode || stat.uid !== expected.uid || digest !== expected.digest) throw new Error("scoped Git local config changed; endpoint is closed fail-closed");
		} catch (error) {
			if (error instanceof Error && error.message.includes("local config changed")) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected.exists) continue;
			throw new Error("scoped Git local config changed; endpoint is closed fail-closed");
		}
	}
	if (snapshot.aliases) throw new Error("scoped Git local aliases are not permitted");
	if (snapshot.unsafeHelpers) throw new Error("scoped Git local helper/filter configuration is not permitted");
}

function validateScopedGitPaths(args: readonly string[], cwd: string): void {
	let after = false;
	for (let index = 1; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--") { after = true; continue; }
		if (arg.startsWith("-")) {
			const base = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
			if (VALUE_OPTIONS.has(base) && !arg.includes("=")) index += 1;
			continue;
		}
		// Every remaining positional token is treated as a repository-relative
		// coordinate. Revisions are harmlessly resolved beneath cwd for this
		// check, while ../path and symlink escapes fail closed.
		if (path.isAbsolute(arg) || arg.includes("\\") || !within(cwd, path.resolve(cwd, arg))) throw new Error("scoped Git endpoint pathspec escapes its canonical cwd");
	}
}

function resolveGitExecPath(gitPath: string): string {
	const candidates = [process.env.GIT_EXEC_PATH, "/usr/lib/git-core", "/usr/libexec/git-core", path.join(path.dirname(gitPath), "../lib/git-core")].filter((candidate): candidate is string => Boolean(candidate));
	const resolved = candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
	if (!resolved) throw new Error("scoped Git endpoint could not resolve Git exec path");
	return path.resolve(resolved);
}

interface TrackedGitProcess {
	readonly child: ReturnType<typeof spawn>;
	readonly identity: ScopedGitProcessIdentity;
	closed: boolean;
}

function privateProcessGroupIdentity(child: ReturnType<typeof spawn>): ScopedGitProcessIdentity {
	if (!child.pid) throw new Error("scoped Git endpoint could not observe child PID");
	const owner = processIdentity(process.pid);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const identity = processIdentity(child.pid);
		if (identity && owner && identity.uid === (process.getuid?.() ?? identity.uid) && identity.pgid === identity.pid && identity.pgid !== owner.pgid) return identity;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
	}
	throw new Error("scoped Git endpoint requires an exact private process group");
}

async function waitForTrackedProcessGone(tracked: TrackedGitProcess): Promise<boolean> {
	const deadline = Date.now() + DEADLINE;
	while (Date.now() < deadline) {
		if (processGroupGone(tracked.identity)) { tracked.closed = true; return true; }
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const gone = processGroupGone(tracked.identity);
	tracked.closed = gone;
	return gone;
}

async function terminateTrackedProcess(tracked: TrackedGitProcess): Promise<boolean> {
	if (tracked.closed) return true;
	const current = processIdentity(tracked.identity.pid);
	// Once the leader is gone, a reused PID/PGID cannot be distinguished from
	// an old descendant with the available kernel identity. Never signal it;
	// asynchronously wait for the originally observed group to disappear.
	if (!current) return waitForTrackedProcessGone(tracked);
	if (!exactIdentityMatches(tracked.identity, current) || current.pgid !== tracked.identity.pgid || current.pgid !== current.pid) return false;
	try { process.kill(-tracked.identity.pgid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
	return waitForTrackedProcessGone(tracked);
}

function runGitAsync(gitPath: string, cwd: string, args: readonly string[], input: Buffer, active: Set<TrackedGitProcess>): Promise<{ status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try { child = spawn(gitPath, args, { cwd, detached: true, env: cleanGitEnvironment(), stdio: ["pipe", "pipe", "pipe"] }); }
		catch (error) { resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: error instanceof Error ? error : new Error(String(error)) }); return; }
		// Spawn failures are emitted asynchronously and may arrive before identity
		// capture completes; keep them handled while the fail-closed path proves exit.
		child.on("error", () => {});
		let identity: ScopedGitProcessIdentity;
		try { identity = privateProcessGroupIdentity(child); }
		catch (error) {
			const pid = child.pid;
			if (!pid) { resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: error instanceof Error ? error : new Error(String(error)) }); return; }
			// Identity capture itself is part of teardown proof. Keep a conservative
			// expected private-group record until that numeric group is absent; never
			// signal a group whose exact leader identity was not authenticated.
			const fallback = processIdentity(pid) ?? { pid, startToken: "unproven", uid: process.getuid?.() ?? -1, ppid: process.pid, pgid: pid, argv: [] };
			const unproven: TrackedGitProcess = { child, identity: fallback, closed: false }; active.add(unproven);
			try { child.kill("SIGTERM"); } catch { /* disappearance proof below is authoritative */ }
			void waitForTrackedProcessGone(unproven).then((proven) => {
				if (proven) active.delete(unproven);
				const message = error instanceof Error ? error.message : String(error);
				resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error(proven ? message : `scoped Git endpoint process teardown unproven: ${message}`) });
			});
			return;
		}
		const tracked: TrackedGitProcess = { child, identity, closed: false }; active.add(tracked);
		const stdout: Buffer[] = [], stderr: Buffer[] = []; let outputBytes = 0; let outputExceeded = false; let settled = false;
		const finish = (result: { status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }, proven = true) => { if (!settled) { settled = true; if (proven) active.delete(tracked); resolve(result); } };
		const boundedOutput = () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		const timer = setTimeout(() => {
			void terminateTrackedProcess(tracked).then((proven) => {
				finish({ status: null, ...boundedOutput(), error: new Error(proven ? "scoped Git endpoint command timed out" : "scoped Git endpoint process teardown unproven") }, proven);
			});
		}, DEADLINE);
		const capture = (target: Buffer[], chunk: Buffer | string) => {
			if (outputExceeded) return;
			const value = Buffer.from(chunk);
			const remaining = Math.max(0, MAX_OUTPUT - outputBytes);
			if (remaining > 0) target.push(value.subarray(0, remaining));
			outputBytes += value.length;
			if (outputBytes <= MAX_OUTPUT) return;
			outputExceeded = true; clearTimeout(timer); child.stdout.pause(); child.stderr.pause();
			void terminateTrackedProcess(tracked).then((proven) => finish({ status: null, ...boundedOutput(), error: new Error(proven ? "scoped Git endpoint output exceeded limit" : "scoped Git endpoint process teardown unproven after output exceeded limit") }, proven));
		};
		child.stdout.on("data", (chunk) => capture(stdout, chunk)); child.stderr.on("data", (chunk) => capture(stderr, chunk));
		child.once("error", (error) => { clearTimeout(timer); if (outputExceeded) return; void waitForTrackedProcessGone(tracked).then((proven) => finish({ status: null, ...boundedOutput(), error: proven ? error : new Error(`scoped Git endpoint process teardown unproven: ${error.message}`) }, proven)); });
		child.once("close", (status) => { clearTimeout(timer); if (outputExceeded) return; void waitForTrackedProcessGone(tracked).then((proven) => finish({ status, ...boundedOutput(), error: proven ? undefined : new Error("scoped Git endpoint process group disappearance unproven") }, proven)); });
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

function resolveScopedGitExecPath(): string {
	return resolveGitExecPath("git");
}

function prepareExecOverlay(endpointRoot: string, execPath: string): void {
	const overlay = path.join(endpointRoot, "git-exec");
	fs.mkdirSync(overlay, { recursive: true, mode: 0o700 });
	// Every entry below the host exec path is hidden by this directory bind.
	// Populate the denied entry points before Bubblewrap sees the read-only
	// destination; no child-time file creation is needed beneath the bind.
	fs.writeFileSync(path.join(overlay, "git"), wrapperSource(), { mode: 0o555 });
	const denied = "#!/bin/sh\nprintf '%s\\n' 'scoped Git endpoint rejects direct helper' >&2\nexit 126\n";
	for (const entry of fs.readdirSync(execPath)) {
		if (!entry.startsWith("git-")) continue;
		const target = path.join(overlay, entry);
		if (!fs.existsSync(target)) fs.writeFileSync(target, denied, { mode: 0o555 });
	}
}

function redactEndpointText(value: string, selected: ScopedGitScope, runtimeRoot?: string): string {
	return value.split(selected.worktree).join(".").split(selected.endpointRoot).join("<scoped-endpoint>").split(runtimeRoot ?? "\0").join("<scoped-runtime>").replace(/\/tmp\/pi-scoped-git(?:-[^\s/]+)?(?:\/[^\s]*)?/gu, "<scoped-runtime>");
}

function scopeFor(options: ScopedGitEndpointOptions, endpointRoot: string, endpoint: string, execPath: string): ScopedGitScope {
	const worktree = canonical(options.worktree);
	const cwd = canonical(options.cwd ?? worktree);
	if (!within(worktree, cwd)) throw new Error("scoped Git endpoint cwd escapes its canonical worktree");
	return Object.freeze({
		runtimeId: options.runtimeId ?? randomUUID(), scopeId: randomUUID(), worktree, cwd,
		rights: options.rights, network: options.network ?? "host", endpointRoot, endpoint, execPath,
	});
}

function wrapperSource(): string {
	const node = JSON.stringify(process.execPath);
	const client = `${TARGET}/client.mjs`;
	return `#!/bin/sh\nexec ${node} ${client} "$@"\n`;
}

function clientSource(): string {
	return `import fs from "node:fs"; import net from "node:net";\nconst chunks=[]; let n=0; const b=Buffer.allocUnsafe(65536);\nwhile(true){const r=fs.readSync(0,b,0,b.length,null);if(!r)break;n+=r;if(n>${MAX_REQUEST})throw Error("request too large");chunks.push(Buffer.from(b.subarray(0,r)));}\nconst request=JSON.stringify({args:process.argv.slice(2),input:Buffer.concat(chunks,n).toString("base64")})+"\\n"; const started=Date.now(); let done=false; function connect(){ const socket=net.createConnection("${TARGET}/endpoint"); let data=""; socket.setEncoding("utf8"); socket.on("data", chunk => data += chunk); socket.on("error", error => { if(!done && Date.now()-started<${DEADLINE}) return setTimeout(connect,10); if(done)return; done=true; process.stderr.write(String(error)); process.exitCode=126; }); socket.on("end", () => { if(done)return; done=true; try { const result=JSON.parse(data); process.stdout.write(Buffer.from(result.stdout||"","base64")); process.stderr.write(Buffer.from(result.stderr||"","base64")); process.exitCode=result.status; } catch (error) { process.stderr.write(String(error)); process.exitCode=126; } }); socket.end(request); } connect();\n`;
}

function prepareEndpointFiles(endpointRoot: string, execPath: string): void {
	fs.writeFileSync(path.join(endpointRoot, "git"), wrapperSource(), { mode: 0o555 });
	fs.writeFileSync(path.join(endpointRoot, "git-helper-denied"), "#!/bin/sh\nprintf '%s\\n' 'scoped Git endpoint rejects direct helper' >&2\nexit 126\n", { mode: 0o555 });
	fs.writeFileSync(path.join(endpointRoot, "client.mjs"), clientSource(), { mode: 0o444 });
	prepareExecOverlay(endpointRoot, execPath);
}

/** Create an owner-owned endpoint and a monotonic child-scope hierarchy. */
export function createScopedGitEndpoint(options: ScopedGitEndpointOptions): ScopedGitEndpointServer {
	const runtimeRoot = canonical(options.runtimeRoot);
	const endpointRoot = path.join(runtimeRoot, "scopes", randomPart());
	let acquiredWriterLease: { worktree: string; scopeId: string } | undefined;
	try {
	fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(endpointRoot, { recursive: true, mode: 0o700 });
	const endpoint = path.join(endpointRoot, "endpoint");
	if (process.platform !== "win32" && Buffer.byteLength(endpoint) >= 108) throw new Error("scoped Git endpoint socket path exceeds the platform limit");
	const gitPath = options.gitPath ?? "git";
	const execPath = resolveGitExecPath(gitPath);
	const scope = scopeFor(options, endpointRoot, endpoint, execPath);
	if (scope.rights === "writer") {
		if (writerLeases.has(scope.worktree)) throw new Error("scoped Git writer lease is already held for this canonical worktree");
		writerLeases.set(scope.worktree, scope.scopeId);
		acquiredWriterLease = { worktree: scope.worktree, scopeId: scope.scopeId };
	}
	const scopes = new Map<string, ScopedGitScope>([[scope.scopeId, scope]]);
	const servers: net.Server[] = [];
	const connections = new Set<net.Socket>();
	const activeProcesses = new Set<TrackedGitProcess>();
	const configSnapshot = snapshotLocalConfig(scope.worktree);
	let closed = false;
	let teardownUnproven = false;
	const leaseState: LeaseState = { reservations: new Map() };
	const revokedScopes = new Set<string>();
	const reservationTimeoutMs = Number.isFinite(options.reservationTimeoutMs) && options.reservationTimeoutMs !== undefined && options.reservationTimeoutMs >= 0 ? options.reservationTimeoutMs : DEADLINE;
	const reservationsFor = (parentScopeId: string) => [...leaseState.reservations.values()].filter((reservation) => reservation.parentScopeId === parentScopeId && (reservation.state === "pending" || reservation.state === "bound"));
	const reservationForChild = (childScopeId: string) => [...leaseState.reservations.values()].find((reservation) => reservation.childScopeId === childScopeId && (reservation.state === "pending" || reservation.state === "bound"));
	const addReservation = (parentScopeId: string, childScopeId: string): WriterReservation => {
		const reservation: WriterReservation = { id: randomUUID(), parentScopeId, childScopeId, state: "pending" };
		reservation.expires = setTimeout(() => { if (reservation.state === "pending") releaseReservation(reservation, "cancelled"); }, reservationTimeoutMs);
		reservation.expires.unref?.();
		leaseState.reservations.set(reservation.id, reservation);
		return reservation;
	};
	const releaseReservation = (reservation: WriterReservation, state: ReservationState): void => {
		if (reservation.expires) clearTimeout(reservation.expires);
		reservation.state = state;
		revokedScopes.add(reservation.childScopeId);
		leaseState.reservations.delete(reservation.id);
	};
	const bindReservation = (selected: ScopedGitScope, identity: ScopedGitProcessIdentity): WriterReservation => {
		const reservation = reservationForChild(selected.scopeId);
		if (!reservation || reservation.state !== "pending") throw new Error("scoped Git writer reservation is missing or already bound");
		const ownerIdentity = processIdentity(process.pid);
		if (identity.ppid !== process.pid || !ownerIdentity || identity.uid !== ownerIdentity.uid || identity.pgid !== identity.pid || identity.pgid === ownerIdentity.pgid) throw new Error("scoped Git delegated process identity does not name a private child group");
		const captured = processIdentity(identity.pid);
		if (!exactIdentityMatches(identity, captured)) throw new Error("scoped Git delegated process identity could not be proven");
		reservation.identity = identity;
		reservation.state = "bound";
		return reservation;
	};
	const waitForReservationRelease = (reservation: WriterReservation): Promise<void> => new Promise((resolve) => {
		const poll = () => {
			if (reservation.state === "cancelled" || reservation.state === "released") { resolve(); return; }
			if (reservation.identity && processGroupGone(reservation.identity)) { releaseReservation(reservation, "released"); resolve(); return; }
			setTimeout(poll, 25);
		};
		poll();
	});
	const create = (selected: ScopedGitScope): ScopedGitEndpointServer => {
		const server = net.createServer({ allowHalfOpen: true }, (connection) => {
			connections.add(connection);
			connection.once("close", () => connections.delete(connection));
			let data = ""; let bytes = 0;
			const timer = setTimeout(() => connection.destroy(), DEADLINE);
			connection.setEncoding("utf8");
			connection.on("data", async (chunk) => {
				bytes += Buffer.byteLength(chunk, "utf8");
				if (bytes > MAX_REQUEST) { connection.destroy(); return; }
				data += chunk;
				const newline = data.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timer); connection.removeAllListeners("data");
				try {
					const request = JSON.parse(data.slice(0, newline)) as { op?: unknown; cwd?: unknown; rights?: unknown; args?: unknown; input?: unknown };
					if (revokedScopes.has(selected.scopeId)) throw new Error("scoped Git endpoint scope has expired or been released");
					if (request.op === "delegate-writer") {
						const body = request as unknown as { descriptor?: ScopedGitEndpointDescriptor; identity?: ScopedGitProcessIdentity };
						if (selected.rights !== "writer" || !body.identity || !body.descriptor) throw new Error("scoped Git writer delegation requires a writer scope and identity");
						const requestedRelative = path.normalize(body.descriptor.relativeSubtree);
						if (path.isAbsolute(requestedRelative) || requestedRelative === ".." || requestedRelative.startsWith(`..${path.sep}`)) throw new Error("scoped Git delegated descriptor escapes its fixed subtree");
						const requestedRoot = path.resolve(selected.endpointRoot, requestedRelative);
						// A serialized descriptor may carry the owner-relative coordinate
						// while the request is already connected to the selected child
						// endpoint. Accept only that exact subtree basename (or '.') and
						// never resolve arbitrary host paths.
						const sameSelectedSubtree = requestedRelative === "." || path.basename(requestedRelative) === path.basename(selected.endpointRoot);
						const target = sameSelectedSubtree ? selected : [...scopes.values()].find((candidate) => candidate.endpointRoot === requestedRoot);
						if (!target || target.scopeId !== selected.scopeId || target.rights !== "writer") throw new Error("scoped Git delegated descriptor is not the reserved child scope");
						const reservation = bindReservation(selected, body.identity);
						void waitForReservationRelease(reservation);
						connection.end(JSON.stringify({ ok: true }) + "\n"); return;
					}
					if (request.op === "child-status") {
						const body = request as unknown as { descriptor?: ScopedGitEndpointDescriptor };
						if (!body.descriptor || typeof body.descriptor.relativeSubtree !== "string") throw new Error("scoped Git child status requires the owner descriptor");
						const requestedRelative = path.normalize(body.descriptor.relativeSubtree);
						if (path.isAbsolute(requestedRelative) || requestedRelative === ".." || requestedRelative.startsWith(`..${path.sep}`)) throw new Error("scoped Git child status descriptor escapes its fixed subtree");
						const requestedRoot = path.resolve(selected.endpointRoot, requestedRelative);
						const child = [...scopes.values()].find((candidate) => candidate.endpointRoot === requestedRoot);
						const reservation = child ? reservationForChild(child.scopeId) : undefined;
						connection.end(JSON.stringify({ ok: true, released: !reservation }) + "\n"); return;
					}
					if (request.op === "cancel-child") {
						const body = request as unknown as { descriptor?: ScopedGitEndpointDescriptor };
						if (!body.descriptor || typeof body.descriptor.relativeSubtree !== "string") throw new Error("scoped Git writer reservation cancellation requires the owner descriptor");
						const requestedRelative = path.normalize(body.descriptor.relativeSubtree);
						if (path.isAbsolute(requestedRelative) || requestedRelative === ".." || requestedRelative.startsWith(`..${path.sep}`)) throw new Error("scoped Git reservation descriptor escapes its fixed subtree");
						const requestedRoot = path.resolve(selected.endpointRoot, requestedRelative);
						const child = [...scopes.values()].find((candidate) => candidate.endpointRoot === requestedRoot);
						const reservation = child ? [...leaseState.reservations.values()].find((candidate) => candidate.parentScopeId === selected.scopeId && candidate.childScopeId === child!.scopeId && candidate.state === "pending") : undefined;
						if (!reservation) throw new Error("scoped Git writer reservation cannot be cancelled");
						releaseReservation(reservation, "cancelled");
						connection.end(JSON.stringify({ ok: true }) + "\n"); return;
					}
					if (request.op === "validate-child") {
						const rights = request.rights === "writer" ? "writer" : "read-only";
						if (rights === "writer" && selected.rights !== "writer") throw new Error("scoped Git child cannot widen rights");
						const requestedCwd = typeof request.cwd === "string" && request.cwd ? (path.isAbsolute(request.cwd) ? request.cwd : path.join(selected.cwd, request.cwd)) : selected.cwd;
						const childCwd = canonical(requestedCwd);
						if (!within(selected.cwd, childCwd)) throw new Error("scoped Git child cwd widens its parent scope");
						connection.end(JSON.stringify({ ok: true }) + "\n"); return;
					}
					if (request.op === "reserve-child") {
						const rights = request.rights === "writer" ? "writer" : "read-only";
						if (rights === "writer" && selected.rights !== "writer") throw new Error("scoped Git child cannot widen rights");
						if (rights === "writer" && reservationsFor(selected.scopeId).length > 0) throw new Error("scoped Git writer lease is already delegated from this scope");
						const requestedCwd = typeof request.cwd === "string" && request.cwd ? (path.isAbsolute(request.cwd) ? request.cwd : path.join(selected.cwd, request.cwd)) : selected.cwd;
						const childCwd = canonical(requestedCwd);
						if (!within(selected.cwd, childCwd)) throw new Error("scoped Git child cwd widens its parent scope");
						const childRoot = path.join(selected.endpointRoot, randomPart()); fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
						const child = scopeFor({ ...options, runtimeId: selected.runtimeId, worktree: selected.worktree, cwd: childCwd, rights, network: selected.network }, childRoot, path.join(childRoot, "endpoint"), selected.execPath);
						prepareEndpointFiles(childRoot, selected.execPath); scopes.set(child.scopeId, child); create(child);
						if (rights === "writer") addReservation(selected.scopeId, child.scopeId);
						// Rebound descriptors are relative to the newly-mounted subtree.
						const childRelative = path.relative(selected.endpointRoot, childRoot) || ".";
						connection.end(JSON.stringify({ descriptor: { relativeSubtree: childRelative }, ownerRelativeSubtree: childRelative }) + "\n"); return;
					}
					if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string") || typeof request.input !== "string") throw new Error("invalid scoped Git request");
					const args = request.args as string[];
					if (selected.rights === "writer" && reservationsFor(selected.scopeId).length > 0 && !["status", "diff", "log"].includes(commandName(args))) throw new Error("scoped Git writer is suspended during delegated execution");
					verifyLocalConfig(configSnapshot);
					validateScopedGitCommand(args, selected.rights);
					validateScopedGitPaths(args, selected.cwd);
					const input = Buffer.from(request.input, "base64");
					if (input.length > MAX_REQUEST) throw new Error("scoped Git input is too large");
					const result = await runGitAsync(gitPath, selected.cwd, args, input, activeProcesses);
					if (result.error?.message.includes("teardown unproven") || result.error?.message.includes("disappearance unproven")) teardownUnproven = true;
					const stdout = result.stdout; const stderr = result.stderr;
					const responseStderr = result.error ? Buffer.concat([stderr, Buffer.from(`scoped Git endpoint: ${result.error.message}`)]) : stderr;
					const response = JSON.stringify({ status: result.status ?? 1, stdout: Buffer.from(redactEndpointText(stdout.toString(), selected, runtimeRoot)).toString("base64"), stderr: Buffer.from(redactEndpointText(responseStderr.toString(), selected, runtimeRoot)).toString("base64") }) + "\n"; connection.end(response);
				} catch (error) { const message = redactEndpointText(error instanceof Error ? error.message : String(error), selected, runtimeRoot); connection.end(JSON.stringify({ status: 126, error: message, stdout: "", stderr: Buffer.from(message).toString("base64") }) + "\n"); }
			});
		});
		servers.push(server); server.listen(selected.endpoint);
		// Recovery endpoints may intentionally outlive a failed foreground run;
		// do not keep the owner process alive solely because the socket is open.
		server.unref();
		const relativeSubtree = path.relative(endpointRoot, selected.endpointRoot) || ".";
		const descriptor = Object.freeze(attachDescriptorMetadata({ relativeSubtree }, { hostEndpointRoot: selected.endpointRoot }));
		return {
			scope: selected,
			descriptor,
			reserveChild: ({ cwd, rights = selected.rights, allowWriter = false }) => {
				if (rights === "writer" && selected.rights !== "writer") throw new Error("scoped Git child cannot widen rights");
				if (rights === "writer" && reservationsFor(selected.scopeId).length > 0) throw new Error("scoped Git writer lease is already delegated from this scope");
				if (rights === "writer" && !allowWriter) throw new Error("scoped Git writer reservation requires explicit delegation");
				const childCwd = canonical(cwd ?? selected.cwd);
				if (!within(selected.cwd, childCwd)) throw new Error("scoped Git child cwd widens its parent scope");
				const childRoot = path.join(selected.endpointRoot, randomPart()); fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
				const child = scopeFor({ ...options, runtimeId: selected.runtimeId, worktree: selected.worktree, cwd: childCwd, rights, network: selected.network }, childRoot, path.join(childRoot, "endpoint"), selected.execPath);
				prepareEndpointFiles(childRoot, selected.execPath);
				scopes.set(child.scopeId, child);
				if (rights === "writer") addReservation(selected.scopeId, child.scopeId);
				return create(child);
			},
			delegateWriter: (identity, childOptions = {}) => {
				if (selected.rights !== "writer") throw new Error("scoped Git writer delegation requires a writer scope");
				if (reservationsFor(selected.scopeId).length > 0 && !childOptions.descriptor) throw new Error("scoped Git writer lease is already delegated from this scope");
				const childCwd = canonical(childOptions.cwd ?? selected.cwd);
				if (!within(selected.cwd, childCwd)) throw new Error("scoped Git child cwd widens its parent scope");
				let child: ScopedGitScope | undefined;
				if (childOptions.descriptor) {
					const requestedRoot = path.resolve(endpointRoot, childOptions.descriptor.relativeSubtree);
					child = [...scopes.values()].find((candidate) => candidate.endpointRoot === requestedRoot);
					if (!child || child.rights !== "writer" || !within(selected.cwd, child.cwd)) throw new Error("scoped Git delegated descriptor is not a narrowed writer scope");
				}
			if (!child) {
				const childRoot = path.join(selected.endpointRoot, randomPart());
				fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
				child = scopeFor({ ...options, runtimeId: selected.runtimeId, worktree: selected.worktree, cwd: childCwd, rights: "writer", network: selected.network }, childRoot, path.join(childRoot, "endpoint"), selected.execPath);
				prepareEndpointFiles(childRoot, selected.execPath);
				scopes.set(child.scopeId, child);
				addReservation(selected.scopeId, child.scopeId);
			}
			const reservation = bindReservation(child, identity);
			const waitForRelease = waitForReservationRelease(reservation);
			const childServer = create(child) as ScopedGitEndpointServer & { waitForRelease: Promise<void> };
			Object.defineProperty(childServer, "waitForRelease", { value: waitForRelease });
			return childServer;
			},
			invocationMounts: (mountScope = selected) => scopedGitMounts(mountScope),
			close: async () => {
				if (closed && !teardownUnproven) return true;
				closed = true;
				// A previous close attempt may have failed while an exact process
				// group was still alive. Recompute proof from current tracked state.
				teardownUnproven = false;
				// Pending reservations have a bounded lifetime and are cancelled by
				// owner close. Bound reservations remain evidence until their exact
				// private group disappears; a leader exit is never sufficient.
				for (const reservation of [...leaseState.reservations.values()]) {
					if (reservation.state === "pending") releaseReservation(reservation, "cancelled");
				}
				for (const active of [...activeProcesses]) {
					if (!await terminateTrackedProcess(active)) teardownUnproven = true;
					else activeProcesses.delete(active);
				}
				for (const reservation of [...leaseState.reservations.values()]) {
					if (reservation.identity && !processGroupGone(reservation.identity)) {
						const deadline = Date.now() + DEADLINE;
						while (Date.now() < deadline && !processGroupGone(reservation.identity)) await new Promise((resolve) => setTimeout(resolve, 25));
						if (!processGroupGone(reservation.identity)) teardownUnproven = true;
						else releaseReservation(reservation, "released");
					}
				}
			for (const connection of connections) connection.destroy();
			for (const active of servers.splice(0)) await new Promise<void>((resolve) => {
					if (!active.listening) { resolve(); return; }
					active.close(() => resolve());
				});
				if (teardownUnproven || activeProcesses.size > 0 || [...leaseState.reservations.values()].some((reservation) => reservation.identity && !processGroupGone(reservation.identity))) return false;
				if (writerLeases.get(scope.worktree) === scope.scopeId) writerLeases.delete(scope.worktree);
				fs.rmSync(endpointRoot, { recursive: true, force: true });
				try {
					const scopesRoot = path.join(runtimeRoot, "scopes");
					if (fs.readdirSync(scopesRoot).length === 0) fs.rmdirSync(scopesRoot);
					if (fs.readdirSync(runtimeRoot).length === 0) fs.rmdirSync(runtimeRoot);
				} catch { /* another scoped owner may still be active */ }
				return true;
			},
		};
	};
	// The wrapper and every denied helper are immutable before any bind.
	prepareEndpointFiles(endpointRoot, execPath);
	const result = create(scope);
	return result;
	} catch (error) {
		if (acquiredWriterLease && writerLeases.get(acquiredWriterLease.worktree) === acquiredWriterLease.scopeId) writerLeases.delete(acquiredWriterLease.worktree);
		fs.rmSync(endpointRoot, { recursive: true, force: true });
		try {
			const scopesRoot = path.join(runtimeRoot, "scopes");
			if (fs.existsSync(scopesRoot) && fs.readdirSync(scopesRoot).length === 0) fs.rmdirSync(scopesRoot);
			if (fs.existsSync(runtimeRoot) && fs.readdirSync(runtimeRoot).length === 0) fs.rmdirSync(runtimeRoot);
		} catch { /* another scoped owner may still be active */ }
		throw error;
	}
}

export function scopedGitInvocation(scope: ScopedGitScope, invocation: SpawnableInvocation, mounts: SandboxMount[] = []): SpawnableInvocation {
	if (canonical(invocation.cwd ?? scope.cwd) !== scope.cwd) throw new Error("scoped Git invocation cwd does not match its endpoint scope");
	return { ...invocation, command: WRAPPER, cwd: scope.cwd, env: { ...invocation.env, PATH: "/run/pi-scoped-git", SCOPED_GIT_ENDPOINT: TARGET }, };
}

/** Ask the owner endpoint for one dynamically-created narrower subtree. */
export async function validateScopedGitChildDescriptor(descriptor: ScopedGitEndpointDescriptor, options: { cwd?: string; rights?: ScopedGitRights } = {}): Promise<void> {
	if (!descriptor || typeof descriptor.relativeSubtree !== "string") throw new Error("invalid scoped Git endpoint descriptor");
	const relative = path.normalize(descriptor.relativeSubtree);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("scoped Git endpoint descriptor escapes its fixed subtree");
	const hostRoot = (descriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	if (!hostRoot) return;
	const endpoint = path.join(hostRoot, "endpoint");
	await new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(endpoint); let data = "";
		socket.setEncoding("utf8"); socket.on("data", (chunk) => data += chunk); socket.on("error", reject);
		socket.on("end", () => { try { const result = JSON.parse(data) as { ok?: boolean; error?: string }; if (!result.ok) throw new Error(result.error ?? "scoped Git child validation failed"); resolve(); } catch (error) { reject(error); } });
		socket.end(JSON.stringify({ op: "validate-child", cwd: options.cwd, rights: options.rights }) + "\n");
	});
}

export async function reserveScopedGitChildDescriptor(descriptor: ScopedGitEndpointDescriptor, options: { cwd?: string; rights?: ScopedGitRights } = {}): Promise<ScopedGitEndpointDescriptor> {
	if (!descriptor || typeof descriptor.relativeSubtree !== "string") throw new Error("invalid scoped Git endpoint descriptor");
	const relative = path.normalize(descriptor.relativeSubtree);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("scoped Git endpoint descriptor escapes its fixed subtree");
	const hostRoot = (descriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	const endpoint = hostRoot ? path.join(hostRoot, "endpoint") : path.join(TARGET, relative, "endpoint");
	return await new Promise((resolve, reject) => {
		const socket = net.createConnection(endpoint); let data = "";
		socket.setEncoding("utf8"); socket.on("data", (chunk) => data += chunk); socket.on("error", reject);
		socket.on("end", () => { try {
			const result = JSON.parse(data) as { descriptor?: ScopedGitEndpointDescriptor; ownerRelativeSubtree?: string; error?: string };
			if (!result.descriptor) throw new Error(result.error ?? "scoped Git child reservation failed");
			if (result.ownerRelativeSubtree) {
				const ownerRoot = (descriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
				attachDescriptorMetadata(result.descriptor, {
					ownerRelativeSubtree: result.ownerRelativeSubtree,
					hostEndpointRoot: ownerRoot ? path.join(ownerRoot, result.ownerRelativeSubtree) : undefined,
				});
			}
			resolve(result.descriptor);
		} catch (error) { reject(error); } });
		socket.end(JSON.stringify({ op: "reserve-child", cwd: options.cwd, rights: options.rights }) + "\n");
	});
}

export async function cancelScopedGitChildDescriptor(ownerDescriptor: ScopedGitEndpointDescriptor, childDescriptor: ScopedGitEndpointDescriptor): Promise<void> {
	for (const descriptor of [ownerDescriptor, childDescriptor]) if (!descriptor || typeof descriptor.relativeSubtree !== "string" || path.isAbsolute(descriptor.relativeSubtree)) throw new Error("invalid scoped Git endpoint descriptor");
	const ownerRelative = path.normalize(ownerDescriptor.relativeSubtree);
	const childRelative = path.normalize((childDescriptor as ScopedGitEndpointDescriptor & { __ownerRelativeSubtree?: string }).__ownerRelativeSubtree ?? childDescriptor.relativeSubtree);
	if ([ownerRelative, childRelative].some((relative) => relative === ".." || relative.startsWith(`..${path.sep}`))) throw new Error("scoped Git endpoint descriptor escapes its fixed subtree");
	const ownerHostRoot = (ownerDescriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	const endpoint = ownerHostRoot ? path.join(ownerHostRoot, "endpoint") : path.join(TARGET, ownerRelative, "endpoint");
	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + DEADLINE;
		const connect = () => {
			let data = "";
			const socket = net.createConnection(endpoint);
			socket.setEncoding("utf8"); socket.on("data", (chunk) => data += chunk);
			socket.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ECONNREFUSED" && Date.now() < deadline) return setTimeout(connect, 10);
				reject(error);
			});
			socket.on("end", () => { try { const result = JSON.parse(data) as { ok?: boolean; error?: string }; if (!result.ok) throw new Error(result.error ?? "scoped Git writer reservation cancellation failed"); resolve(); } catch (error) { reject(error); } });
			socket.end(JSON.stringify({ op: "cancel-child", descriptor: { relativeSubtree: childRelative } }) + "\n");
		};
		connect();
	});
}

export async function waitForScopedGitProcessGone(identity: ScopedGitProcessIdentity): Promise<void> {
	const deadline = Date.now() + DEADLINE;
	while (!processGroupGone(identity)) {
		if (Date.now() >= deadline) throw new Error("scoped Git delegated process group disappearance unproven");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Wait until the owner has observed and released the exact child reservation. */
export async function waitForScopedGitChildRelease(ownerDescriptor: ScopedGitEndpointDescriptor, childDescriptor: ScopedGitEndpointDescriptor): Promise<void> {
	const ownerHostRoot = (ownerDescriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	if (!ownerHostRoot) return;
	const ownerRelative = path.normalize(ownerDescriptor.relativeSubtree);
	const childRelative = path.normalize((childDescriptor as ScopedGitEndpointDescriptor & { __ownerRelativeSubtree?: string }).__ownerRelativeSubtree ?? childDescriptor.relativeSubtree);
	if ([ownerRelative, childRelative].some((relative) => relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error("scoped Git child release descriptor escapes its fixed subtree");
	const endpoint = path.join(ownerHostRoot, "endpoint");
	const deadline = Date.now() + DEADLINE;
	while (Date.now() < deadline) {
		const released = await new Promise<boolean>((resolve, reject) => {
			let data = "";
			const socket = net.createConnection(endpoint);
			socket.setEncoding("utf8"); socket.on("data", (chunk) => data += chunk);
			socket.on("error", reject);
			socket.on("end", () => { try { const result = JSON.parse(data) as { ok?: boolean; released?: boolean; error?: string }; if (!result.ok) throw new Error(result.error ?? "scoped Git child release status failed"); resolve(result.released === true); } catch (error) { reject(error); } });
			socket.end(JSON.stringify({ op: "child-status", descriptor: { relativeSubtree: childRelative } }) + "\n");
		});
		if (released) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("scoped Git child reservation release unproven");
}

export async function delegateScopedGitWriterDescriptor(descriptor: ScopedGitEndpointDescriptor, identity: ScopedGitProcessIdentity): Promise<void> {
	if (!descriptor || typeof descriptor.relativeSubtree !== "string" || path.isAbsolute(descriptor.relativeSubtree)) throw new Error("invalid scoped Git endpoint descriptor");
	const relative = path.normalize(descriptor.relativeSubtree);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("scoped Git endpoint descriptor escapes its fixed subtree");
	const hostRoot = (descriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	const endpoint = hostRoot ? path.join(hostRoot, "endpoint") : path.join(TARGET, relative, "endpoint");
	await new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(endpoint); let data = "";
		socket.setEncoding("utf8"); socket.on("data", (chunk) => data += chunk); socket.on("error", reject);
		socket.on("end", () => { try { const result = JSON.parse(data) as { ok?: boolean; error?: string }; if (!result.ok) throw new Error(result.error ?? "scoped Git writer delegation failed"); resolve(); } catch (error) { reject(error); } });
		socket.end(JSON.stringify({ op: "delegate-writer", descriptor, identity }) + "\n");
	});
}

export function scopedGitDescriptorMounts(descriptor: ScopedGitEndpointDescriptor): SandboxMount[] {
	if (!descriptor || typeof descriptor.relativeSubtree !== "string" || descriptor.relativeSubtree.includes("\0") || path.isAbsolute(descriptor.relativeSubtree)) throw new Error("invalid scoped Git endpoint descriptor");
	const relative = path.normalize(descriptor.relativeSubtree);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("scoped Git endpoint descriptor escapes its fixed subtree");
	const hostRoot = (descriptor as InternalScopedGitEndpointDescriptor).__hostEndpointRoot;
	const sourceRoot = hostRoot ?? path.join(TARGET, relative);
	return [
		{ source: sourceRoot, mode: "ro", target: TARGET },
		{ source: path.join(sourceRoot, "git-exec"), mode: "ro", target: resolveScopedGitExecPath() },
		{ source: path.join(sourceRoot, "git"), mode: "ro", target: "/usr/bin/git" },
		{ source: path.join(sourceRoot, "git"), mode: "ro", target: "/bin/git" },
	];
}

export function scopedGitMounts(scope: ScopedGitScope): SandboxMount[] {
	// The endpoint's prepared exec directory is one coherent overlay. Do not
	// add helper file mounts beneath it: Bubblewrap cannot create those targets
	// after the destination directory has become read-only.
	return [
		{ source: scope.endpointRoot, mode: "ro", target: TARGET },
		{ source: path.join(scope.endpointRoot, "git-exec"), mode: "ro", target: scope.execPath },
		{ source: path.join(scope.endpointRoot, "git"), mode: "ro", target: "/usr/bin/git" },
		{ source: path.join(scope.endpointRoot, "git"), mode: "ro", target: "/bin/git" },
	];
}

export const SCOPED_GIT_ENDPOINT_TARGET = TARGET;
export const SCOPED_GIT_WRAPPER_TARGET = WRAPPER;