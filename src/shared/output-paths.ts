import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function sanitizeSegment(value: string): string {
	return value
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "unknown";
}

function resolveBaseCwd(runtimeCwd: string, requestedCwd?: string): string {
	if (!requestedCwd) return runtimeCwd;
	return path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(runtimeCwd, requestedCwd);
}

function resolveGitTopLevel(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
	if (result.status !== 0) return undefined;
	const toplevel = result.stdout.trim();
	return toplevel || undefined;
}

function addNumericSuffix(filePath: string, attempt: number): string {
	const ext = path.extname(filePath);
	const stem = ext ? filePath.slice(0, -ext.length) : filePath;
	return `${stem}-${attempt}${ext}`;
}

export function isRelativeOutputTarget(output: string | boolean | undefined): output is string {
	return typeof output === "string" && output.length > 0 && output !== "false" && output !== "true" && !path.isAbsolute(output);
}

export function hasReadOnlyToolset(tools: string[] | undefined): boolean {
	return !tools?.includes("edit") && !tools?.includes("write");
}

export function shouldPersistSavedOutput(params: {
	output: string | boolean | undefined;
	outputMode?: "inline" | "file-only";
	tools?: string[];
}): boolean {
	return params.output !== false && params.output !== "false";
}

export function resolveSavedOutputDir(runtimeCwd: string, requestedCwd?: string): string {
	const baseCwd = resolveBaseCwd(runtimeCwd, requestedCwd);
	const repoRoot = resolveGitTopLevel(baseCwd);
	// Only preserved markdown reports go in repo-local tmp/. Session logs, async status,
	// and runner output logs continue to live in the existing runtime temp/session dirs.
	return path.join(repoRoot ?? baseCwd, "tmp");
}

export function resolveSavedOutputPath(options: {
	runtimeCwd: string;
	requestedCwd?: string;
	agent: string;
	runId: string;
	index?: number;
}): string {
	const dir = resolveSavedOutputDir(options.runtimeCwd, options.requestedCwd);
	const parts = [sanitizeSegment(options.agent), sanitizeSegment(options.runId)];
	if (options.index !== undefined) parts.push(String(options.index));
	return path.join(dir, `${parts.join("-")}.md`);
}

export function buildSavedOutputHeader(options: {
	agent: string;
	runId: string;
	index?: number;
	savedAt?: string;
}): string {
	const savedAt = options.savedAt ?? new Date().toISOString();
	const lines = [
		"# Saved subagent output",
		"",
		`- agent: \`${options.agent}\``,
		`- runId: \`${options.runId}\``,
		...(options.index !== undefined ? [`- index: \`${options.index}\``] : []),
		`- savedAt: \`${savedAt}\``,
		"",
		"---",
		"",
	];
	return lines.join("\n");
}

export function writeSavedOutput(options: {
	targetPath: string;
	agent: string;
	runId: string;
	index?: number;
	content: string;
}): { savedPath: string; savedContent: string } {
	const header = buildSavedOutputHeader({ agent: options.agent, runId: options.runId, index: options.index });
	const savedContent = `${header}${options.content}`;
	fs.mkdirSync(path.dirname(options.targetPath), { recursive: true });

	let attempt = 0;
	while (true) {
		const candidate = attempt === 0 ? options.targetPath : addNumericSuffix(options.targetPath, attempt);
		let fd: number | undefined;
		try {
			fd = fs.openSync(candidate, "wx");
			fs.writeFileSync(fd, savedContent, "utf-8");
			return { savedPath: candidate, savedContent };
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (code === "EEXIST") {
				attempt++;
				continue;
			}
			throw error;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
}
