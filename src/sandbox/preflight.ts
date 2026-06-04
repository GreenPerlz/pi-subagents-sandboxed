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
 * Check whether git works in a sandboxed worktree when `.git` is a pointer file.
 * If the referenced gitdir is outside the sandbox root AND outside all extra mount
 * roots, the check fails with an actionable message about required mount exceptions.
 */
export function checkGitWorktreePointer(cwd: string, options: { sandboxRoot: string; extraMountRoots?: string[]; requireGitWorktree?: boolean }): GitWorktreePointerResult {
	const gitPath = path.join(cwd, ".git");

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(gitPath);
	} catch {
		if (options.requireGitWorktree) {
			return { ok: false, error: `No .git found at ${cwd}; expected a git worktree.` };
		}
		// No .git at all — nothing to check.
		return { ok: true };
	}

	// If .git is a regular directory, git works directly.
	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		return { ok: true };
	}

	// .git is a file (pointer) or symlink — read it.
	let content: string;
	try {
		content = fs.readFileSync(gitPath, "utf-8").trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot read .git pointer file: ${message}` };
	}

	// Git worktree pointer files start with "gitdir:"
	if (!content.startsWith("gitdir:")) {
		// Not a pointer file; treat as ok (could be a submodule or other format).
		return { ok: true };
	}

	const gitdir = content.replace(/^gitdir:\s*/, "").trim();
	const resolvedGitdir = path.resolve(cwd, gitdir);
	const resolvedSandboxRoot = path.resolve(options.sandboxRoot);

	// Check if the gitdir is inside the sandbox root.
	if (isWithinAnyRoot(resolvedGitdir, [resolvedSandboxRoot])) {
		return { ok: true, pointerGitdir: resolvedGitdir };
	}

	// Check if the gitdir is inside any of the extra mount roots.
	const extraRoots = (options.extraMountRoots ?? []).map((r) => path.resolve(r));
	if (isWithinAnyRoot(resolvedGitdir, extraRoots)) {
		return { ok: true, pointerGitdir: resolvedGitdir };
	}

	return {
		ok: false,
		pointerGitdir: resolvedGitdir,
		error: `Git worktree .git pointer references gitdir outside sandbox mount: ${resolvedGitdir} is outside ${resolvedSandboxRoot}. Either mount the gitdir read-only in the sandbox (sandbox.extraReadOnlyMounts) or move the worktree so its gitdir is inside the sandbox root.`,
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
			lines.push(`  git worktree pointer: ok${worktree.pointerGitdir ? ` (gitdir: ${worktree.pointerGitdir})` : ""}`);
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
