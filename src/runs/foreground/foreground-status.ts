import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { ForegroundResumeChild, GitBundleResult, NestedRouteInfo, NestedRunSummary, NestedRouteValidity, SubagentRunMode } from "../../shared/types.ts";
import { resolveNestedRoute } from "../shared/nested-events.ts";
import type { FastModeStatus } from "../../shared/fast-mode.ts";

export type PersistedForegroundState = "queued" | "running" | "complete" | "failed" | "paused" | "cancelled";

export interface PersistedForegroundChild {
	agent: string;
	index: number;
	status: ForegroundResumeChild["status"] | "running" | "pending";
	groupId?: string;
	sessionFile?: string;
	artifactPath?: string;
	model?: string;
	thinking?: string;
	fastMode?: FastModeStatus;
	totalTokens?: ForegroundResumeChild["totalTokens"];
	exitCode?: number;
	detached?: boolean;
	interrupted?: boolean;
	cancelled?: boolean;
	error?: string;
	teardownUnproven?: boolean;
	finalOutput?: string;
	gitBundle?: GitBundleResult;
}

/** A group diagnostic is not a child and therefore has no synthetic index. */
export interface PersistedForegroundGroupDiagnostic {
	agent: string;
	groupId: string;
	unindexed: true;
	status: ForegroundResumeChild["status"] | "running" | "pending";
	index?: never;
	sessionFile?: string;
	error?: string;
	finalOutput?: string;
	gitBundle?: GitBundleResult;
}

export type PersistedForegroundStep = PersistedForegroundChild | PersistedForegroundGroupDiagnostic;

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
	groupDiagnostics?: Array<{ groupId: string; unindexed: true; agent: string; status: string; output?: string; error?: string; finalOutput?: string }>;
	teardownUnproven?: boolean;
	nestedChildren?: NestedRunSummary[];
	nestedRoute?: NestedRouteInfo;
	nestedRouteValidity?: NestedRouteValidity;
	nestedRouteError?: string;
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
		let nestedRoute: PersistedForegroundStatus["nestedRoute"];
		let nestedRouteValidity: NestedRouteValidity = "legacy";
		let nestedRouteError: string | undefined;
		if (raw.nestedRoute !== undefined) {
			nestedRoute = raw.nestedRoute as NestedRouteInfo;
			const resolution = resolveNestedRoute(raw.runId, nestedRoute);
			nestedRouteValidity = resolution.validity;
			nestedRouteError = resolution.error;
		}
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
			...(Array.isArray(raw.groupDiagnostics) ? { groupDiagnostics: raw.groupDiagnostics } : {}),
			...(raw.teardownUnproven === true ? { teardownUnproven: true } : {}),
			...(Array.isArray(raw.nestedChildren) ? { nestedChildren: raw.nestedChildren } : {}),
			...(raw.nestedRoute !== undefined ? { nestedRoute: raw.nestedRoute as NestedRouteInfo } : {}),
			nestedRouteValidity,
			...(nestedRouteError ? { nestedRouteError } : {}),
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
