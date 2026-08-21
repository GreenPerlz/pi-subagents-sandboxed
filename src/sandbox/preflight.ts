import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GhAuthResult {
	available: boolean;
	skipped?: boolean;
	error?: string;
}

export interface GitProbeResult {
	ok: boolean;
	skipped?: boolean;
	gitdir?: string;
	error?: string;
	stdout?: string;
	stderr?: string;
}

export interface GitWorktreePointerResult {
	ok: boolean;
	skipped?: boolean;
	pointerGitdir?: string;
	commonGitdir?: string;
	autoMountGitdir?: string;
	autoMountCommonGitdir?: string;
	error?: string;
}

export interface GitWorktreePointerDetectionResult {
	ok: boolean;
	pointerGitdir?: string;
	commonGitdir?: string;
	error?: string;
}

export interface PreflightCheckResult {
	passed: boolean;
	ghAuth: GhAuthResult;
	gitProbe: GitProbeResult;
	worktree: GitWorktreePointerResult;
	/** Blocking errors that should prevent execution. */
	errors: string[];
	/** Informational warnings reported but not blocking. */
	warnings: string[];
	summary: string;
}

export interface ExecResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export interface PreflightDeps {
	/** Override for gh auth execution (for testing). */
	ghAuth?: { execSync: () => ExecResult };
	/** Override for git probe execution (for testing). */
	gitProbe?: { execSync: () => ExecResult };
	/** Override for worktree check result (for testing). */
	worktreeOverride?: { ok: boolean };
}

export interface PreflightInput {
	cwd: string;
	sandboxRoot: string;
	/** Extra mount roots from resolved sandbox config (extraReadOnlyMounts + extraWritableMounts). */
	extraMountRoots?: string[];
	ghAuth?: PreflightDeps["ghAuth"];
	gitProbe?: PreflightDeps["gitProbe"];
	worktreeOverride?: PreflightDeps["worktreeOverride"];
	skipGhAuth?: boolean;
	skipGitProbe?: boolean;
	skipWorktree?: boolean;
	/** When true, require the cwd to be a git worktree; missing .git is a failure. */
	requireGitWorktree?: boolean;
}

/**
 * Check whether `gh auth` is available by running `gh auth status`.
 * Returns a structured result indicating availability and any error.
 */
export function checkGhAuthAvailability(deps: { execSync: () => ExecResult } = defaultGhAuthDeps()): GhAuthResult {
	const result = deps.execSync();

	if (result.error) {
		const message = result.error.message;
		if (message.includes("ENOENT") || message.includes("not found") || message.includes("spawn")) {
			return { available: false, error: `gh is not installed or not found in PATH: ${message}` };
		}
		return { available: false, error: `gh auth check failed: ${message}` };
	}

	if (result.status === 0) {
		return { available: true };
	}

	const stderr = result.stderr?.trim() ?? "";
	const detail = stderr || `exit code ${result.status}`;
	return { available: false, error: `gh auth unavailable in sandbox: ${detail}` };
}

/**
 * Probe that git actually works in the given cwd by running
 * `git -C <cwd> rev-parse --git-dir`. This catches broken/inaccessible
 * gitdirs, missing git binary, and pointer-file worktrees that satisfy path
 * containment but still fail under git.
 *
 * When default deps are used and there is no .git, the probe passes silently.
 * When deps are injected, the caller controls the behavior completely.
 */
export function checkGitProbe(cwd: string, deps?: { execSync: () => ExecResult }, options?: { requireGitWorktree?: boolean }): GitProbeResult {
	const resolvedDeps = deps ?? defaultGitProbeDeps(cwd, options);
	const result = resolvedDeps.execSync();

	if (result.error) {
		const message = result.error.message;
		if (message.includes("ENOENT") || message.includes("not found") || message.includes("spawn")) {
			return {
				ok: false,
				error: `git is not installed or not found in PATH: ${message}`,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		}
		return {
			ok: false,
			error: `git probe failed: ${message}`,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}

	if (result.status !== 0) {
		const stderr = result.stderr?.trim() ?? "";
		const stdout = result.stdout?.trim() ?? "";
		const detail = stderr || stdout || `exit code ${result.status}`;
		return {
			ok: false,
			error: `git cannot operate on worktree at ${cwd}: ${detail}`,
			stdout,
			stderr,
		};
	}

	const gitdir = result.stdout?.trim() ?? "";
	return {
		ok: true,
		gitdir: gitdir || undefined,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * Detect and validate a Git linked-worktree `.git` pointer file.
 * Returns the real gitdir path only for pointer-file worktrees; normal `.git`
 * directories, non-git directories, and non-pointer files return ok with no path.
 */
export function detectGitWorktreePointerGitdir(cwd: string, options: { requireGitWorktree?: boolean } = {}): GitWorktreePointerDetectionResult {
	const resolvedCwd = path.resolve(cwd);
	const gitPath = path.join(resolvedCwd, ".git");

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(gitPath);
	} catch {
		if (options.requireGitWorktree) {
			return { ok: false, error: `No .git found at ${resolvedCwd}; expected a git worktree.` };
		}
		return { ok: true };
	}

	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		return { ok: true };
	}

	let content: string;
	try {
		content = fs.readFileSync(gitPath, "utf-8").trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot read .git pointer file at ${gitPath}: ${message}` };
	}

	if (!content.startsWith("gitdir:")) {
		return { ok: true };
	}

	const gitdir = content.replace(/^gitdir:\s*/, "").trim();
	if (!gitdir) {
		return { ok: false, error: `Unsafe Git worktree .git pointer at ${gitPath}: gitdir is empty.` };
	}
	if (gitdir.includes("\0")) {
		return { ok: false, error: `Unsafe Git worktree .git pointer at ${gitPath}: gitdir contains a NUL byte.` };
	}

	const resolvedGitdir = path.resolve(resolvedCwd, gitdir);
	let realGitdir: string;
	try {
		realGitdir = fs.realpathSync.native(resolvedGitdir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, pointerGitdir: resolvedGitdir, error: `Git worktree .git pointer references missing or inaccessible gitdir: ${resolvedGitdir} (${message})` };
	}

	let gitdirStat: fs.Stats;
	try {
		gitdirStat = fs.statSync(realGitdir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, pointerGitdir: realGitdir, error: `Git worktree .git pointer references inaccessible gitdir: ${realGitdir} (${message})` };
	}
	if (!gitdirStat.isDirectory()) {
		return { ok: false, pointerGitdir: realGitdir, error: `Git worktree .git pointer references non-directory gitdir: ${realGitdir}` };
	}

	const unsafeGitdirError = validateGitMountRoot(realGitdir, resolvedCwd, "Git worktree .git pointer", "gitdir");
	if (unsafeGitdirError) return { ok: false, pointerGitdir: realGitdir, error: unsafeGitdirError };

	const commonGitdirResult = detectGitdirCommondir(realGitdir, resolvedCwd);
	if (!commonGitdirResult.ok) return { ok: false, pointerGitdir: realGitdir, commonGitdir: commonGitdirResult.commonGitdir, error: commonGitdirResult.error };

	return { ok: true, pointerGitdir: realGitdir, commonGitdir: commonGitdirResult.commonGitdir };
}

function detectGitdirCommondir(gitdir: string, resolvedCwd: string): GitWorktreePointerDetectionResult {
	const commondirPath = path.join(gitdir, "commondir");
	if (!fs.existsSync(commondirPath)) return { ok: true };

	let content: string;
	try {
		content = fs.readFileSync(commondirPath, "utf-8").trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot read Git worktree commondir at ${commondirPath}: ${message}` };
	}

	if (!content) {
		return { ok: false, error: `Unsafe Git worktree commondir at ${commondirPath}: commondir is empty.` };
	}
	if (content.includes("\0")) {
		return { ok: false, error: `Unsafe Git worktree commondir at ${commondirPath}: commondir contains a NUL byte.` };
	}

	const resolvedCommondir = path.resolve(gitdir, content);
	let realCommondir: string;
	try {
		realCommondir = fs.realpathSync.native(resolvedCommondir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, commonGitdir: resolvedCommondir, error: `Git worktree commondir references missing or inaccessible common gitdir: ${resolvedCommondir} (${message})` };
	}

	let commonStat: fs.Stats;
	try {
		commonStat = fs.statSync(realCommondir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, commonGitdir: realCommondir, error: `Git worktree commondir references inaccessible common gitdir: ${realCommondir} (${message})` };
	}
	if (!commonStat.isDirectory()) {
		return { ok: false, commonGitdir: realCommondir, error: `Git worktree commondir references non-directory common gitdir: ${realCommondir}` };
	}

	const unsafeCommondirError = validateGitMountRoot(realCommondir, resolvedCwd, "Git worktree commondir", "common gitdir");
	if (unsafeCommondirError) return { ok: false, commonGitdir: realCommondir, error: unsafeCommondirError };

	return { ok: true, commonGitdir: realCommondir };
}

function validateGitMountRoot(candidate: string, resolvedCwd: string, subject: string, label: string): string | undefined {
	const root = path.parse(candidate).root;
	if (candidate === root || isWithinAnyRoot(resolvedCwd, [candidate])) {
		return `Unsafe ${subject} references overly broad ${label} mount root: ${candidate}`;
	}
	return undefined;
}

/**
 * Check whether git works in a sandboxed worktree when `.git` is a pointer file.
 * External linked-worktree gitdirs are accepted because launch mounts the narrow
 * referenced gitdir read-only by default.
 */
export function checkGitWorktreePointer(cwd: string, options: { sandboxRoot: string; extraMountRoots?: string[]; requireGitWorktree?: boolean }): GitWorktreePointerResult {
	const detection = detectGitWorktreePointerGitdir(cwd, { requireGitWorktree: options.requireGitWorktree });
	if (!detection.ok) return detection;
	if (!detection.pointerGitdir) return { ok: true };

	const resolvedGitdir = detection.pointerGitdir;
	const resolvedCommonGitdir = detection.commonGitdir;
	const resolvedSandboxRoot = path.resolve(options.sandboxRoot);
	const extraRoots = (options.extraMountRoots ?? []).map((r) => path.resolve(r));
	const mountRoots = [resolvedSandboxRoot, ...extraRoots];
	const alreadyMounted = isWithinAnyRoot(resolvedGitdir, mountRoots);
	const commonAlreadyMounted = resolvedCommonGitdir ? isWithinAnyRoot(resolvedCommonGitdir, mountRoots) : true;

	return {
		ok: true,
		pointerGitdir: resolvedGitdir,
		...(resolvedCommonGitdir ? { commonGitdir: resolvedCommonGitdir } : {}),
		...(alreadyMounted ? {} : { autoMountGitdir: resolvedGitdir }),
		...(resolvedCommonGitdir && !commonAlreadyMounted ? { autoMountCommonGitdir: resolvedCommonGitdir } : {}),
	};
}

/**
 * Check whether `candidate` is within at least one of the given `roots`.
 */
function isWithinAnyRoot(candidate: string, roots: string[]): boolean {
	for (const root of roots) {
		const relative = path.relative(root, candidate);
		if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
			return true;
		}
	}
	return false;
}

function defaultGhAuthDeps(): { execSync: () => ExecResult } {
	return {
		execSync: () => {
			try {
				const result = child_process.spawnSync("gh", ["auth", "status"], {
					encoding: "utf-8",
					timeout: 10_000,
				});
				return {
					status: result.status ?? null,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					...(result.error ? { error: result.error } : {}),
				};
			} catch (error) {
				return {
					status: null,
					stdout: "",
					stderr: "",
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		},
	};
}

function defaultGitProbeDeps(cwd: string, options?: { requireGitWorktree?: boolean }): { execSync: () => ExecResult } {
	return {
		execSync: () => {
			// If no .git exists, there is no worktree to probe — pass silently unless required.
			if (!options?.requireGitWorktree) {
				try {
					if (!fs.existsSync(path.join(cwd, ".git"))) {
						return { status: 0, stdout: "", stderr: "" };
					}
				} catch {
					return { status: 0, stdout: "", stderr: "" };
				}
			}
			try {
				const result = child_process.spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
					encoding: "utf-8",
					timeout: 10_000,
					maxBuffer: 8 * 1024 * 1024,
				});
				return {
					status: result.status ?? null,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					...(result.error ? { error: result.error } : {}),
				};
			} catch (error) {
				return {
					status: null,
					stdout: "",
					stderr: "",
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		},
	};
}

/**
 * Run all sandbox preflight checks and return a combined result.
 * The result includes a human-readable summary suitable for orchestrator output/status.
 */
export function runSandboxPreflight(input: PreflightInput): PreflightCheckResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const lines: string[] = ["Preflight checks:"];
	let ghAuth: GhAuthResult;
	let gitProbe: GitProbeResult;
	let worktree: GitWorktreePointerResult;

	// gh auth check — informational only, does not block execution
	if (input.skipGhAuth) {
		ghAuth = { available: true, skipped: true };
		lines.push("  gh auth: skipped");
	} else {
		ghAuth = checkGhAuthAvailability(input.ghAuth);
		if (ghAuth.available) {
			lines.push("  gh auth: available");
		} else {
			lines.push(`  gh auth: ${ghAuth.error}`);
			if (ghAuth.error) warnings.push(ghAuth.error);
		}
	}

	// Git probe — verify git actually works in the cwd
	if (input.skipGitProbe) {
		gitProbe = { ok: true, skipped: true };
		lines.push("  git probe: skipped");
	} else {
		gitProbe = checkGitProbe(input.cwd, input.gitProbe, { requireGitWorktree: input.requireGitWorktree });
		if (gitProbe.ok) {
			lines.push(`  git probe: ok${gitProbe.gitdir ? ` (gitdir: ${gitProbe.gitdir})` : ""}`);
		} else {
			lines.push(`  git probe: ${gitProbe.error}`);
			if (gitProbe.error) errors.push(gitProbe.error);
		}
	}

	// Worktree pointer check — blocking when gitdir is outside sandbox and mounts
	if (input.skipWorktree) {
		worktree = { ok: true, skipped: true };
		lines.push("  git worktree pointer: skipped");
	} else if (input.worktreeOverride) {
		worktree = { ...input.worktreeOverride };
		lines.push(`  git worktree pointer: ${worktree.ok ? "ok" : "failed"}`);
	} else {
		worktree = checkGitWorktreePointer(input.cwd, { sandboxRoot: input.sandboxRoot, extraMountRoots: input.extraMountRoots, requireGitWorktree: input.requireGitWorktree });
		if (worktree.ok) {
			const details = worktree.pointerGitdir
				? ` (gitdir: ${worktree.pointerGitdir}${worktree.autoMountGitdir ? ", auto-mounted read-only" : ""}${worktree.commonGitdir ? `, commondir: ${worktree.commonGitdir}${worktree.autoMountCommonGitdir ? ", auto-mounted read-only" : ""}` : ""})`
				: "";
			lines.push(`  git worktree pointer: ok${details}`);
		} else {
			lines.push(`  git worktree pointer: ${worktree.error}`);
			if (worktree.error) errors.push(worktree.error);
		}
	}

	const passed = errors.length === 0;
	if (passed && warnings.length === 0) {
		lines.unshift("Preflight: all checks passed.");
	} else if (passed) {
		lines.unshift(`Preflight: passed with ${warnings.length} warning(s).`);
	} else {
		lines.unshift(`Preflight: ${errors.length} check(s) failed.`);
	}

	return {
		passed,
		ghAuth,
		gitProbe,
		worktree,
		errors,
		warnings,
		summary: lines.join("\n"),
	};
}
