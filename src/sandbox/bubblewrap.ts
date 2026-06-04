import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxMount, SandboxProvider, SandboxWrapInput, SandboxWrapResult, SpawnableInvocation } from "./types.ts";
import { SandboxUnavailableError } from "./types.ts";

const DEFAULT_BWRAP_COMMAND = "bwrap";
const SANDBOX_DOCS_REFERENCE = "See the README Sandboxed subagents section (README.md#sandboxed-subagents) and docs/prd/sandboxed-subagents.md for Bubblewrap setup, network/auth modes, and fallback configuration.";
const HOST_TOOLCHAIN_READONLY_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

export interface BubblewrapProviderDeps {
	bwrapCommand?: string;
	isBubblewrapAvailable?: () => boolean;
	pathExists?: (candidate: string) => boolean;
	realPath?: (filePath: string) => string;
	env?: Record<string, string | undefined>;
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

function addMount(args: string[], mount: SandboxMount, seen?: Set<string>): void {
	const key = `${mount.mode}:${mount.source}`;
	if (seen?.has(key)) return;
	seen?.add(key);
	if (mount.mode === "ro") {
		args.push("--ro-bind", mount.source, mount.source);
		return;
	}
	args.push("--bind", mount.source, mount.source);
}

function nodeInstallRoot(command: string): string | undefined {
	if (!path.isAbsolute(command)) return undefined;
	const commandDir = path.dirname(command);
	if (path.basename(command) !== "node" || path.basename(commandDir) !== "bin") return undefined;
	return path.dirname(commandDir);
}

function addEnvironment(args: string[], env: SpawnableInvocation["env"]): void {
	if (!env) return;
	args.push("--clearenv");
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		args.push("--setenv", key, value);
	}
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

	constructor(deps: BubblewrapProviderDeps = {}) {
		this.bwrapCommand = deps.bwrapCommand ?? DEFAULT_BWRAP_COMMAND;
		this.isBubblewrapAvailable = deps.isBubblewrapAvailable ?? (() => commandExists(this.bwrapCommand, deps.env));
		this.pathExists = deps.pathExists ?? fs.existsSync;
		this.realPath = deps.realPath ?? ((p) => fs.realpathSync(p));
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
		const seenMounts = new Set<string>();
		for (const source of HOST_TOOLCHAIN_READONLY_PATHS) {
			if (this.pathExists(source)) addMount(args, { source, mode: "ro" }, seenMounts);
		}
		args.push("--dev", "/dev");
		if (network === "host") {
			const dnsMount = systemdResolvedMount(this.pathExists, this.realPath);
			if (dnsMount) addMount(args, { source: dnsMount, mode: "ro" }, seenMounts);
		}
		const nodeRoot = nodeInstallRoot(input.invocation.command);
		if (nodeRoot && this.pathExists(nodeRoot)) addMount(args, { source: nodeRoot, mode: "ro" }, seenMounts);
		for (const mount of input.mounts ?? []) {
			addMount(args, mount, seenMounts);
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
			},
			diagnostics: [],
			fallbackOccurred: false,
		};
	}
}
