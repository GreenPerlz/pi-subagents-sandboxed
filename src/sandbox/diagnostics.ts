import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedSandboxConfig, SandboxDiagnostic, SandboxMount, SandboxMountDiagnostic, SandboxResultDetails, SandboxWrapResult } from "./types.ts";

const SECRET_PATH_PARTS = new Set(["auth.json", "token", "tokens", "secret", "secrets", "key", "keys", ".ssh", ".aws", ".gnupg"]);

export interface SandboxFailureDiagnosticInput {
	stderr?: string;
	error?: string;
	mounts?: SandboxMount[];
	cwd?: string;
	pathExists?: (candidate: string) => boolean;
	resolveHostExecutable?: (command: string) => string | undefined;
}

function redactMountPath(filePath: string): string {
	const home = os.homedir();
	let redacted = filePath;
	if (home && (redacted === home || redacted.startsWith(`${home}${path.sep}`))) {
		redacted = `~${redacted.slice(home.length)}`;
	}
	const parts = redacted.split(path.sep);
	const secretIndex = parts.findIndex((part) => SECRET_PATH_PARTS.has(part.toLowerCase()));
	if (secretIndex >= 0) {
		return [...parts.slice(0, secretIndex), "<redacted>"].join(path.sep) || "<redacted>";
	}
	return redacted;
}

function redactMounts(mounts: SandboxMountDiagnostic[] | undefined): SandboxMountDiagnostic[] | undefined {
	if (!mounts || mounts.length === 0) return undefined;
	return mounts.map((mount) => ({ ...mount, path: redactMountPath(mount.path) }));
}

export function sandboxResultDetails(config: ResolvedSandboxConfig, wrapResult?: Pick<SandboxWrapResult, "diagnostics" | "fallbackOccurred" | "mounts">): SandboxResultDetails {
	const diagnostics = wrapResult?.diagnostics?.length ? wrapResult.diagnostics : undefined;
	const mounts = redactMounts(wrapResult?.mounts);
	return {
		provider: config.provider,
		...(config.gitMode !== undefined ? { gitMode: config.gitMode } : {}),
		profile: config.profile ?? "host-toolchain",
		network: config.network ?? "host",
		auth: config.auth ?? "pi-json",
		fallbackMode: config.fallback ?? "fail",
		fallbackOccurred: wrapResult?.fallbackOccurred === true,
		...(diagnostics ? { diagnostics: diagnostics.map((diagnostic): SandboxDiagnostic => ({ ...diagnostic })) } : {}),
		...(mounts ? { mounts } : {}),
	};
}

function defaultPathExists(candidate: string): boolean {
	return fs.existsSync(candidate);
}

function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultResolveHostExecutable(command: string): string | undefined {
	if (path.isAbsolute(command) || command.includes(path.sep)) return isExecutable(command) ? command : undefined;
	const pathValue = process.env.PATH;
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(path.delimiter)) {
		const candidate = path.join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function containsPath(mount: SandboxMount, candidate: string): boolean {
	const source = path.resolve(mount.source);
	const resolved = path.resolve(candidate);
	return resolved === source || resolved.startsWith(`${source}${path.sep}`);
}

function deepestMount(mounts: SandboxMount[] | undefined, candidate: string): SandboxMount | undefined {
	return (mounts ?? [])
		.filter((mount) => containsPath(mount, candidate))
		.sort((a, b) => path.resolve(b.source).length - path.resolve(a.source).length)[0];
}

function isPathMountedWritable(mounts: SandboxMount[] | undefined, candidate: string): boolean {
	return deepestMount(mounts, candidate)?.mode === "rw";
}

function executableParentSuggestion(executablePath: string): string {
	return path.dirname(executablePath);
}

function parseExecvpTarget(text: string): string | undefined {
	const match = text.match(/execvp\s+([^:\n]+):\s+No such file or directory/i);
	return match?.[1]?.trim();
}

function parseAccessFailure(text: string): { code: "EACCES" | "EPERM" | "EROFS"; path?: string } | undefined {
	const codeMatch = text.match(/\b(EACCES|EPERM|EROFS)\b/i);
	if (!codeMatch) return undefined;
	const quotedPath = text.match(/["']([^"'\n]+)["']/)?.[1];
	return { code: codeMatch[1]!.toUpperCase() as "EACCES" | "EPERM" | "EROFS", ...(quotedPath ? { path: quotedPath } : {}) };
}

function nearestExistingPath(candidate: string, pathExists: (candidate: string) => boolean): string {
	let current = path.resolve(candidate);
	if (!path.extname(current) && pathExists(current)) return current;
	current = path.dirname(current);
	while (current !== path.dirname(current)) {
		if (pathExists(current)) return current;
		current = path.dirname(current);
	}
	return path.dirname(path.resolve(candidate));
}

export function diagnoseSandboxFailure(input: SandboxFailureDiagnosticInput): SandboxDiagnostic[] {
	const text = [input.error, input.stderr].filter(Boolean).join("\n");
	if (!text.trim()) return [];
	const mounts = input.mounts ?? [];
	const pathExists = input.pathExists ?? defaultPathExists;
	const resolveHostExecutable = input.resolveHostExecutable ?? defaultResolveHostExecutable;
	const diagnostics: SandboxDiagnostic[] = [];

	const execTarget = parseExecvpTarget(text);
	if (execTarget) {
		const hostExecutable = resolveHostExecutable(execTarget);
		if (!hostExecutable) {
			diagnostics.push({
				level: "error",
				message: `Sandbox executable lookup failed for '${execTarget}'. It does not appear to be installed on the host or visible in the host PATH used by Pi, so adding a sandbox mount is unlikely to help; install the tool on the host or use an absolute installed tool path.`,
			});
			return diagnostics;
		}
		const mounted = deepestMount(mounts, hostExecutable);
		if (!mounted) {
			const suggestion = executableParentSuggestion(hostExecutable);
			diagnostics.push({
				level: "error",
				message: `Sandbox executable lookup failed for '${execTarget}'. The executable exists on the host at '${hostExecutable}' but is not mounted in the sandbox. Suggested least-privilege fix: add a read-only sandbox mount such as sandbox.extraReadOnlyMounts: ["${suggestion}"] (or the narrowest toolchain directory that contains the executable), then rerun the focused smoke test.`,
			});
			return diagnostics;
		}
		diagnostics.push({
			level: "error",
			message: `Sandbox executable lookup failed for '${execTarget}' even though host path '${hostExecutable}' is covered by a ${mounted.mode === "ro" ? "read-only" : "writable"} sandbox mount '${mounted.source}'. Check PATH inside the child process and any interpreter/shebang dependencies; keep toolchain mounts read-only.`,
		});
		return diagnostics;
	}

	const accessFailure = parseAccessFailure(text);
	if (accessFailure) {
		const failedPath = accessFailure.path;
		if (!failedPath) {
			diagnostics.push({
				level: "error",
				message: `Sandbox filesystem access failed with ${accessFailure.code}, but Pi could not identify the affected path from stderr. Inspect the redacted sandbox.mounts list in the result/status payload and add only the narrow read-only or writable mount needed for the failing path.`,
			});
			return diagnostics;
		}
		const mounted = deepestMount(mounts, failedPath);
		const writable = isPathMountedWritable(mounts, failedPath);
		const existingSuggestion = nearestExistingPath(failedPath, pathExists);
		if (mounted?.mode === "ro" && !writable) {
			diagnostics.push({
				level: "error",
				message: `Sandbox filesystem access failed with ${accessFailure.code} for '${failedPath}'. The path is under read-only sandbox mount '${mounted.source}', so writes are denied. Suggested least-privilege fix: if this path is a cache/output/work directory, add the narrowest writable sandbox mount such as sandbox.extraWritableMounts: ["${existingSuggestion}"]; otherwise keep it read-only and redirect output to an already writable work/output path.`,
			});
			return diagnostics;
		}
		if (!mounted) {
			const hostExists = pathExists(failedPath) || pathExists(existingSuggestion);
			diagnostics.push({
				level: "error",
				message: `Sandbox filesystem access failed with ${accessFailure.code} for '${failedPath}'. The path is outside the mounted sandbox filesystem${hostExists ? " but appears to exist on the host" : " and may also be absent on the host"}. Suggested least-privilege fix: add sandbox.extraReadOnlyMounts for read-only inputs/toolchains, or sandbox.extraWritableMounts: ["${existingSuggestion}"] only when this is a cache/output/work directory that the agent must write, then rerun the focused smoke test.`,
			});
			return diagnostics;
		}
		diagnostics.push({
			level: "error",
			message: `Sandbox filesystem access failed with ${accessFailure.code} for '${failedPath}', which is covered by writable sandbox mount '${mounted.source}'. Check host permissions/ownership or parent directory existence rather than broadening sandbox mounts.`,
		});
	}

	return diagnostics;
}
