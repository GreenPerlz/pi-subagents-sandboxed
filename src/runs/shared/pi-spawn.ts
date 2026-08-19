import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_CHILD_RUNTIME_PACKAGE = "pi-subagent-runtime";

let testEntrypointOverride: string | undefined;

export function setPiSpawnEntrypointOverrideForTests(entrypoint: string | undefined): void {
	testEntrypointOverride = entrypoint;
}

export function getPiSpawnEntrypointOverrideForTests(): string | undefined {
	return testEntrypointOverride;
}

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CHILD_RUNTIME_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	entrypointOverride?: string;
	existsSync?: (filePath: string) => boolean;
	isExecutable?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	env?: Record<string, string | undefined>;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
	/**
	 * Prefer an absolute Node + Pi CLI script invocation instead of relying on
	 * `pi` in PATH. This is useful for sandboxed runs where the user's shell
	 * wrapper and PATH entries may not be mounted inside the sandbox.
	 */
	preferNodeCli?: boolean;
}

interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function isNodeRuntime(command: string): boolean {
	return /^node(?:\.exe)?$/i.test(path.basename(command));
}

export function resolveNodeRuntime(deps: PiSpawnDeps = {}): string | undefined {
	const configuredRuntime = deps.execPath ?? process.execPath;
	if (isNodeRuntime(configuredRuntime)) return configuredRuntime;

	const isExecutable = deps.isExecutable ?? ((filePath: string) => {
		try {
			fs.accessSync(filePath, (deps.platform ?? process.platform) === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
			return fs.statSync(filePath).isFile();
		} catch {
			return false;
		}
	});
	const env = deps.env ?? process.env;
	const pathValue = env.PATH;
	if (!pathValue) return undefined;
	const extensions = (deps.platform ?? process.platform) === "win32"
		? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
		: [""];
	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = path.join(directory, `node${extension.toLowerCase()}`);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

export function resolvePiPackageBin(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));

	try {
		const resolvePackageJson = deps.resolvePackageJson ?? (() => {
			const root = deps.piPackageRoot;
			if (root) return path.join(root, "package.json");
			const packageRoot = deps.resolvePackageEntry
				? findPiPackageRootFromEntry(deps.resolvePackageEntry())
				: resolveInstalledPiPackageRoot();
			if (!packageRoot) throw new Error(`Could not resolve ${PI_CHILD_RUNTIME_PACKAGE} package root`);
			return path.join(packageRoot, "package.json");
		});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string"
			? binField
			: binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		// Package-bin resolution is optional; falling back to `pi` lets PATH handle execution.
		return undefined;
	}

	return undefined;
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			return argvPath;
		}
	}

	return resolvePiPackageBin(deps);
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const platform = deps.platform ?? process.platform;
	const existsSync = deps.existsSync ?? fs.existsSync;
	const argv1 = deps.argv1 ?? process.argv[1];
	const injectedEntrypoint = deps.entrypointOverride && isRunnableNodeScript(normalizePath(deps.entrypointOverride), existsSync)
		? normalizePath(deps.entrypointOverride)
		: undefined;
	const piCliPath = deps.preferNodeCli
		? (injectedEntrypoint ?? resolvePiPackageBin(deps))
		: platform === "win32"
			? resolveWindowsPiCliScript(deps)
			: undefined;

	if (deps.preferNodeCli && !piCliPath) {
		throw new Error(`Could not resolve the private ${PI_CHILD_RUNTIME_PACKAGE} CLI`);
	}

	if (piCliPath) {
		const nodeRuntime = resolveNodeRuntime(deps);
		if (!nodeRuntime) {
			throw new Error(`Could not find a Node runtime for ${PI_CHILD_RUNTIME_PACKAGE}`);
		}
		return {
			command: nodeRuntime,
			args: [piCliPath, ...args],
		};
	}

	return { command: "pi", args };
}
