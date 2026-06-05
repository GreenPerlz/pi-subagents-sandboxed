/**
 * External terminal handoff for the /subagents overlay.
 *
 * Launches a configured terminal command with the selected subagent's
 * session file and working directory passed safely as arguments.
 * Avoids shell injection by using spawn with an array of args.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig } from "../shared/types.ts";

export interface TerminalLaunchMetadata {
	sessionFile?: string;
	cwd?: string;
}

export interface ResolvedTerminalCommand {
	command: string;
	args: string[];
}

export interface TerminalLaunchResult {
	success: boolean;
	error?: string;
}

/**
 * Resolve effective terminal command from extension config.
 * Returns undefined when no terminal command is configured.
 */
export function resolveTerminalCommand(
	config?: ExtensionConfig["externalTerminal"],
): ResolvedTerminalCommand | undefined {
	if (!config) return undefined;
	const command = typeof config.command === "string" ? config.command.trim() : "";
	if (!command) return undefined;
	const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === "string") : [];
	return { command, args };
}

/**
 * Build terminal argument list by substituting safe placeholders.
 * Only {sessionFile} and {cwd} are recognized; everything else is passed through unchanged.
 * Paths are passed as literal strings (no shell escaping needed because spawn uses an array).
 */
export function buildTerminalArgs(
	baseArgs: string[],
	metadata: TerminalLaunchMetadata,
): string[] {
	return baseArgs.map((arg) => {
		if (arg === "{sessionFile}") return metadata.sessionFile ?? "";
		if (arg === "{cwd}") return metadata.cwd ?? "";
		return arg;
	});
}

/**
 * Return a human-readable reason why terminal handoff is unavailable,
 * or undefined when it is available.
 */
export function terminalUnavailableReason(
	command: ResolvedTerminalCommand | undefined,
	metadata: TerminalLaunchMetadata,
): string | undefined {
	if (!command) return "No terminal command configured.";
	if (!metadata.sessionFile) {
		return "No session file available for this run yet.";
	}
	if (!isFile(metadata.sessionFile)) {
		return `Session file not found: ${metadata.sessionFile}`;
	}
	return undefined;
}

/**
 * Launch the configured terminal command with the given metadata.
 * Uses spawn with detached:true so the terminal outlives the parent.
 *
 * Returns a Promise so asynchronous spawn errors are captured and callers
 * can react (e.g. fall back to the in-overlay viewer).
 */
export function launchTerminal(
	command: ResolvedTerminalCommand,
	metadata: TerminalLaunchMetadata,
	spawnFn: typeof child_process.spawn = child_process.spawn,
): Promise<TerminalLaunchResult> {
	const args = buildTerminalArgs(command.args, metadata);
	// Filter out empty strings that resulted from missing optional placeholders
	const filteredArgs = args.filter((a) => a !== "");

	// Validate command exists on PATH or is an absolute path
	const resolvedCommand = resolveCommandPath(command.command);
	if (!resolvedCommand) {
		return Promise.resolve({ success: false, error: `Terminal command not found: ${command.command}` });
	}

	// Validate session file exists (always required for handoff)
	const sessionFile = metadata.sessionFile;
	if (!sessionFile) {
		return Promise.resolve({ success: false, error: "No session file available for this run yet." });
	}
	if (!isFile(sessionFile)) {
		return Promise.resolve({ success: false, error: `Session file not found: ${sessionFile}` });
	}

	return new Promise((resolve) => {
		let settled = false;
		const settle = (result: TerminalLaunchResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawnFn(resolvedCommand, filteredArgs, {
			detached: true,
			stdio: "ignore",
			cwd: metadata.cwd || process.cwd(),
		});

		child.on("error", (err) => {
			settle({
				success: false,
				error: `Failed to launch terminal: ${err instanceof Error ? err.message : String(err)}`,
			});
		});

		child.on("spawn", () => {
			child.unref();
			settle({ success: true });
		});

		// Safety net in case neither event fires (should not happen in practice)
		setTimeout(() => settle({ success: true }), 1000);
	});
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommandPath(command: string): string | undefined {
	if (path.isAbsolute(command) || command.includes(path.sep)) {
		return isExecutable(command) ? command : undefined;
	}
	const pathValue = process.env.PATH;
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(path.delimiter)) {
		const candidate = path.join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}
