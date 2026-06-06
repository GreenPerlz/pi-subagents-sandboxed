import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { ForegroundResumeChild, NestedRunSummary, SubagentRunMode } from "../../shared/types.ts";

export type PersistedForegroundState = "queued" | "running" | "complete" | "failed" | "paused";

export interface PersistedForegroundStep {
	agent: string;
	index: number;
	status: ForegroundResumeChild["status"] | "running" | "pending";
	sessionFile?: string;
	artifactPath?: string;
}

export interface PersistedForegroundStatus {
	runId: string;
	sessionId?: string;
	cwd?: string;
	mode: SubagentRunMode;
	state: PersistedForegroundState;
	startedAt?: number;
	updatedAt: number;
	currentAgent?: string;
	currentIndex?: number;
	currentTool?: string;
	sessionFile?: string;
	children: PersistedForegroundStep[];
	nestedChildren?: NestedRunSummary[];
	statusFile?: string;
}

export interface ListPersistedForegroundOptions {
	sessionId?: string;
	cwd?: string;
	limit?: number;
}

export function foregroundRunDir(root: string, runId: string): string {
	return path.join(root, runId);
}

export function foregroundStatusPath(root: string, runId: string): string {
	return path.join(foregroundRunDir(root, runId), "status.json");
}

export function writePersistedForegroundStatus(root: string, status: PersistedForegroundStatus): void {
	const { statusFile: _statusFile, ...payload } = status;
	writeAtomicJson(foregroundStatusPath(root, status.runId), payload);
}

function readPersistedForegroundStatus(statusFile: string): PersistedForegroundStatus | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as Partial<PersistedForegroundStatus>;
		if (!raw.runId || !raw.mode || !raw.state || typeof raw.updatedAt !== "number") return undefined;
		return {
			runId: raw.runId,
			...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
			...(raw.cwd ? { cwd: raw.cwd } : {}),
			mode: raw.mode,
			state: raw.state,
			...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
			updatedAt: raw.updatedAt,
			...(raw.currentAgent ? { currentAgent: raw.currentAgent } : {}),
			...(typeof raw.currentIndex === "number" ? { currentIndex: raw.currentIndex } : {}),
			...(raw.currentTool ? { currentTool: raw.currentTool } : {}),
			...(raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
			children: Array.isArray(raw.children) ? raw.children : [],
			...(Array.isArray(raw.nestedChildren) ? { nestedChildren: raw.nestedChildren } : {}),
			statusFile,
		};
	} catch {
		return undefined;
	}
}

function matchesScope(status: PersistedForegroundStatus, options: ListPersistedForegroundOptions): boolean {
	if (options.sessionId && status.sessionId) return status.sessionId === options.sessionId;
	if (options.cwd && status.cwd) return status.cwd === options.cwd;
	if (status.sessionId) return false;
	if (status.cwd) return false;
	return true;
}

export function listPersistedForegroundRuns(root: string, options: ListPersistedForegroundOptions = {}): PersistedForegroundStatus[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const limit = options.limit ?? 25;
	return entries
		.map((entry) => readPersistedForegroundStatus(path.join(root, entry, "status.json")))
		.filter((status): status is PersistedForegroundStatus => Boolean(status) && matchesScope(status, options))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, limit);
}
