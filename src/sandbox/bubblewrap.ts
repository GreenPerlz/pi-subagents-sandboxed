import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxMount, SandboxProvider, SandboxWrapInput, SandboxWrapResult, SpawnableInvocation } from "./types.ts";
import { SandboxUnavailableError } from "./types.ts";

const DEFAULT_BWRAP_COMMAND = "bwrap";
const SANDBOX_DOCS_REFERENCE = "See the README Sandboxed subagents section (README.md#sandboxed-subagents) and docs/prd/sandboxed-subagents.md for Bubblewrap setup, network/auth modes, and fallback configuration.";
const HOST_TOOLCHAIN_READONLY_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
const WSL_RESOLVER_PATH = "/mnt/wsl/resolv.conf";

export interface PinnedSandboxMounts {
	mounts: SandboxMount[];
	fds: number[];
}

/** Pin read-only mount sources to open inodes until Bubblewrap starts. */
export function pinReadonlySandboxMounts(mounts: readonly SandboxMount[], firstChildFd = 3): PinnedSandboxMounts {
	const fds: number[] = [];
	try {
		const pinned = mounts.map((mount) => {
			if (mount.mode !== "ro") return mount;
			const target = mount.target ?? mount.source;
			const canonicalSource = fs.realpathSync.native(mount.source);
			const expected = fs.statSync(canonicalSource);
			const fd = fs.openSync(canonicalSource, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			const childFd = firstChildFd + fds.length;
			fds.push(fd);
			const opened = fs.fstatSync(fd);
			if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
				throw new Error(`Read-only sandbox mount changed while it was being pinned: ${mount.source}`);
			}
			if (canonicalSource === WSL_RESOLVER_PATH && !resolverStatIsTrusted(opened)) {
				throw new Error(`WSL resolver mount source became unsafe while it was being pinned: ${WSL_RESOLVER_PATH}`);
			}
			return { source: `/proc/self/fd/${childFd}`, target, mode: "ro" as const };
		});
		return { mounts: pinned, fds };
	} catch (error) {
		for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
		throw error;
	}
}

export function closePinnedSandboxFds(fds: readonly number[] | undefined): void {
	for (const fd of fds ?? []) { try { fs.closeSync(fd); } catch {} }
}

export interface BubblewrapProviderDeps {
	bwrapCommand?: string;
	isBubblewrapAvailable?: () => boolean;
	pathExists?: (candidate: string) => boolean;
	realPath?: (filePath: string) => string;
	env?: Record<string, string | undefined>;
	/** Isolate the child PID namespace so host processes and their roots are not inspectable. */
	unsharePid?: boolean;
	/** Test seam for validating resolver source metadata. */
	lstat?: (filePath: string) => fs.Stats;
}

function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function commandExists(command: string, env: Record<string, string | undefined> = process.env): boolean {
	if (path.isAbsolute(command) || command.includes(path.sep)) {
		return isExecutable(command);
	}

	const pathValue = env.PATH;
	if (!pathValue) return false;
	return pathValue.split(path.delimiter).some((dir) => isExecutable(path.join(dir, command)));
}

function addMount(args: string[], mount: SandboxMount, seen?: Set<string>, diagnosticMounts?: SandboxMount[]): void {
	const target = mount.target ?? mount.source;
	const key = `${mount.mode}:${mount.source}:${target}`;
	if (seen?.has(key)) return;
	seen?.add(key);
	diagnosticMounts?.push({ source: mount.source, mode: mount.mode, ...(mount.target ? { target: mount.target } : {}) });
	if (mount.mode === "ro") {
		args.push("--ro-bind", mount.source, target);
		return;
	}
	args.push("--bind", mount.source, target);
}

function nodeInstallRoot(command: string): string | undefined {
	if (!path.isAbsolute(command)) return undefined;
	const commandDir = path.dirname(command);
	if (path.basename(command) !== "node" || path.basename(commandDir) !== "bin") return undefined;
	return path.dirname(commandDir);
}

function addEnvironment(args: string[], env: SpawnableInvocation["env"]): void {
	// Git redirection variables are ambient authority: without stripping them,
	// GIT_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY can bypass the protected
	// checkout metadata mounts. When no explicit environment was supplied,
	// preserve the provider's historical inherited environment and remove only
	// those Git keys; explicit environments are rebuilt from non-Git entries.
	if (!env) {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) args.push("--unsetenv", key);
		}
		return;
	}
	args.push("--clearenv");
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("GIT_")) continue;
		if (value === undefined) continue;
		args.push("--setenv", key, value);
	}
}

function resolverStatIsTrusted(stat: fs.Stats): boolean {
	if (!stat.isFile() || stat.isSymbolicLink()) return false;
	if ((stat.mode & 0o022) !== 0) return false;
	if (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid()) return false;
	return true;
}

function resolverSourceIsTrusted(source: string, lstat: (filePath: string) => fs.Stats): boolean {
	try {
		// Resolver data is host input. Never follow a replacement symlink and do
		// not expose a writable secret through a read-only bind.
		return resolverStatIsTrusted(lstat(source));
	} catch {
		return false;
	}
}

function wslResolverMount(
	pathExists: (candidate: string) => boolean,
	realPath: (filePath: string) => string,
	lstat: (filePath: string) => fs.Stats,
): string | undefined {
	if (!pathExists("/etc/resolv.conf")) return undefined;
	let resolved: string;
	try {
		resolved = realPath("/etc/resolv.conf");
	} catch {
		return undefined;
	}
	if (resolved !== WSL_RESOLVER_PATH || !pathExists(WSL_RESOLVER_PATH)) return undefined;
	let canonicalSource: string;
	try { canonicalSource = realPath(WSL_RESOLVER_PATH); } catch { return undefined; }
	if (canonicalSource !== WSL_RESOLVER_PATH || !resolverSourceIsTrusted(WSL_RESOLVER_PATH, lstat)) return undefined;
	return WSL_RESOLVER_PATH;
}

function systemdResolvedMount(pathExists: (candidate: string) => boolean, realPath: (filePath: string) => string): string | undefined {
	if (!pathExists("/etc/resolv.conf")) return undefined;
	let resolved: string;
	try {
		resolved = realPath("/etc/resolv.conf");
	} catch {
		return undefined;
	}
	if (!resolved.startsWith("/run/systemd/resolve/")) return undefined;
	const mountPath = "/run/systemd/resolve";
	return pathExists(mountPath) ? mountPath : undefined;
}

export class BubblewrapSandboxProvider implements SandboxProvider {
	private readonly bwrapCommand: string;
	private readonly isBubblewrapAvailable: () => boolean;
	private readonly pathExists: (candidate: string) => boolean;
	private readonly realPath: (filePath: string) => string;
	private readonly lstat: (filePath: string) => fs.Stats;
	private readonly unsharePid: boolean;

	constructor(deps: BubblewrapProviderDeps = {}) {
		this.bwrapCommand = deps.bwrapCommand ?? DEFAULT_BWRAP_COMMAND;
		this.isBubblewrapAvailable = deps.isBubblewrapAvailable ?? (() => commandExists(this.bwrapCommand, deps.env));
		this.pathExists = deps.pathExists ?? fs.existsSync;
		this.realPath = deps.realPath ?? ((p) => fs.realpathSync(p));
		this.lstat = deps.lstat ?? ((p) => fs.lstatSync(p));
		this.unsharePid = deps.unsharePid ?? false;
	}

	wrapInvocation(input: SandboxWrapInput): SandboxWrapResult {
		const profile = input.config.profile ?? "host-toolchain";
		if (profile !== "host-toolchain") {
			throw new Error(`Unsupported bubblewrap sandbox profile: ${profile}`);
		}

		if (!this.isBubblewrapAvailable()) {
			if (input.config.fallback === "none") {
				return {
					invocation: input.invocation,
					diagnostics: [{
						level: "warning",
						message: `Bubblewrap sandbox requested but bwrap is unavailable; running without sandbox because fallback is none. ${SANDBOX_DOCS_REFERENCE}`,
					}],
					fallbackOccurred: true,
				};
			}

			throw new SandboxUnavailableError(`Bubblewrap sandbox requested but bwrap is unavailable; refusing to run without sandbox. ${SANDBOX_DOCS_REFERENCE}`);
		}

		const network = input.config.network ?? "host";
		if (network !== "host" && network !== "none") {
			throw new Error(`Unsupported bubblewrap network mode: ${network}`);
		}

		const args: string[] = [];
		const dnsMount = network === "host"
			? wslResolverMount(this.pathExists, this.realPath, this.lstat)
			?? systemdResolvedMount(this.pathExists, this.realPath)
			: undefined;
		const requestedMounts = input.mounts ?? [];
		const aliasesWslResolver = (candidate: string): boolean => {
			if (path.resolve(candidate) === WSL_RESOLVER_PATH) return true;
			try { return this.realPath(candidate) === WSL_RESOLVER_PATH; } catch { return false; }
		};
		const mountsToPin = dnsMount === WSL_RESOLVER_PATH
			? [
				{ source: WSL_RESOLVER_PATH, target: WSL_RESOLVER_PATH, mode: "ro" as const },
				...requestedMounts.filter((mount) => !aliasesWslResolver(mount.source) && !aliasesWslResolver(mount.target ?? mount.source)),
			]
			: requestedMounts;
		const pinned = input.invocation.pinReadonlyMounts
			? pinReadonlySandboxMounts(mountsToPin, 3 + (input.invocation.inheritedFds?.length ?? 0))
			: { mounts: mountsToPin, fds: [] };
		const inheritedFds = [...(input.invocation.inheritedFds ?? []), ...pinned.fds];
		try {
		const seenMounts = new Set<string>();
		const diagnosticMounts: SandboxMount[] = [];
		for (const target of HOST_TOOLCHAIN_READONLY_PATHS) {
			if (!this.pathExists(target)) continue;
			// Bind the canonical directory into the conventional host path. Some
			// Bubblewrap versions do not preserve merged-/usr symlink sources such
			// as /bin -> /usr/bin, leaving the sandbox without /bin/sh.
			const source = this.realPath(target);
			addMount(args, { source, target, mode: "ro" }, seenMounts, diagnosticMounts);
		}
		// Ensure the wrapped command dies if the runner or Bubblewrap wrapper
		// disappears. Without this, a killed runner can leave its Pi/tool tree
		// orphaned on the host.
		args.push("--die-with-parent");
		if (this.unsharePid) args.push("--unshare-pid");
		args.push("--proc", "/proc");
		args.push("--dev", "/dev");
		if (network === "host") {
			if (dnsMount === WSL_RESOLVER_PATH) {
				// bwrap cannot create a missing destination for a file bind. Keep
				// these narrowly scoped to the exact allowlisted WSL target.
				args.push("--dir", "/mnt", "--dir", "/mnt/wsl");
				if (!input.invocation.pinReadonlyMounts) addMount(args, { source: WSL_RESOLVER_PATH, target: WSL_RESOLVER_PATH, mode: "ro" }, seenMounts, diagnosticMounts);
			} else if (dnsMount) {
				addMount(args, { source: dnsMount, mode: "ro" }, seenMounts, diagnosticMounts);
			}
		}
		const nodeRoot = nodeInstallRoot(input.invocation.command);
		if (nodeRoot && this.pathExists(nodeRoot)) addMount(args, { source: nodeRoot, mode: "ro" }, seenMounts, diagnosticMounts);
		for (const mount of pinned.mounts) {
			addMount(args, mount, seenMounts, diagnosticMounts);
		}
		if (network === "none") args.push("--unshare-net");
		if (input.invocation.cwd) args.push("--chdir", input.invocation.cwd);
		addEnvironment(args, input.invocation.env);
		args.push("--", input.invocation.command, ...input.invocation.args);

		return {
			invocation: {
				command: this.bwrapCommand,
				args,
				...(input.invocation.cwd !== undefined ? { cwd: input.invocation.cwd } : {}),
				...(inheritedFds.length ? { inheritedFds } : {}),
			},
			diagnostics: [],
			fallbackOccurred: false,
			mounts: diagnosticMounts.map((mount) => ({ path: mount.source, mode: mount.mode })),
		};
		} catch (error) {
			closePinnedSandboxFds(pinned.fds);
			throw error;
		}
	}
}
