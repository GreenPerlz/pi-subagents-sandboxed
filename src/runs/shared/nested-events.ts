import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	type AsyncJobState,
	type AsyncStatus,
	type NestedRouteInfo,
	type NestedRunSummary,
	type NestedRunState,
	type NestedStepSummary,
	type NestedRouteValidity,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";
import type { FastModeStatus } from "../../shared/fast-mode.ts";
import { isSafeNestedPathId, parseNestedPathEnv, sanitizeNestedPath, type NestedPathEntry } from "./nested-path.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "./pi-args.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const ROUTE_FILE = "route.json";
const REGISTRY_FILE = "registry.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;
// Journals are framed rather than newline-delimited so a torn write can never
// be mistaken for a valid event.  The fixed header also lets readers advance
// by byte offset without enumerating historical files.
const JOURNAL_MAGIC = Buffer.from("PISJRN01", "ascii");
const JOURNAL_VERSION = 1;
const JOURNAL_HEADER_BYTES = 56; // magic(8), version/kind/reserved(4), seq(8), len(4), sha256(32)
const JOURNAL_MAX_BODY_BYTES = MAX_EVENT_BYTES;
const EVENT_JOURNAL = "events.journal";
const CONTROL_JOURNAL = "control-requests.journal";
const RESULT_JOURNAL = "control-results.journal";
const JOURNAL_STATE = ".journal-state.json";
const LEGACY_MANIFEST = ".legacy-import-manifest.json";
const ROUTE_LOCK = ".route.lock";
const COMPACTION_BYTES = 4 * 1024 * 1024;
function compactionThreshold(): number { const value = Number(process.env.PI_NESTED_COMPACTION_BYTES); return Number.isSafeInteger(value) && value > 0 ? value : COMPACTION_BYTES; }
const INDEX_FILE = { control: ".control-index.jsonl", result: ".result-index.jsonl" } as const;
const ACK_FILE = ".control-acked.jsonl";
const EXECUTION_FILE = ".control-execution.jsonl";
const COMPACTION_FILE = ".journal-compaction.json";
const LEGACY_INFLIGHT = ".legacy-import-inflight.json";

/** Test and recovery seam. A fault is raised after the named durable phase. */
export type NestedJournalFaultPhase = "seal" | "new" | "state" | "snapshot" | "cleanup" | "append" | "manifest";
let journalFaultInjector: ((phase: NestedJournalFaultPhase, kind: "event" | "control" | "result") => void) | undefined;
const journalWork = { frames: 0, bytes: 0, readdir: 0 };
export function resetNestedJournalWorkCounters(): void { journalWork.frames = 0; journalWork.bytes = 0; journalWork.readdir = 0; }
export function getNestedJournalWorkCounters(): { frames: number; bytes: number; readdir: number } { return { ...journalWork }; }
export function setNestedJournalFaultInjector(injector: ((phase: NestedJournalFaultPhase, kind: "event" | "control" | "result") => void) | undefined): void {
	journalFaultInjector = injector;
}
/** Test/restart seam; production callers simply omit the route. */
export function resetNestedJournalRuntime(route?: NestedRoute): void { if (route) journalRuntimes.delete(runtimeKey(route)); else journalRuntimes.clear(); }
function journalFault(phase: NestedJournalFaultPhase, kind: "event" | "control" | "result"): void { journalFaultInjector?.(phase, kind); }

type NestedStatusEventType = "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed";
type NestedControlResultEventType = "subagent.nested.control-result";

export type NestedRoute = NestedRouteInfo;

export interface NestedEventRecord {
	type: NestedStatusEventType;
	ts: number;
	rootRunId: string;
	parentRunId: string;
	parentStepIndex?: number;
	capabilityToken: string;
	child: NestedRunSummary;
}

export interface NestedControlResultRecord {
	type: NestedControlResultEventType;
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	ok: boolean;
	message: string;
}

export interface NestedControlRequestRecord {
	type: "subagent.nested.control-request";
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	action: "interrupt" | "resume";
	message?: string;
}

export interface NestedRegistry {
	rootRunId: string;
	updatedAt: number;
	children: NestedRunSummary[];
	processedEvents: string[];
}

export function isSafeNestedId(value: unknown): value is string {
	return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: string): void {
	if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

function assertSafeId(label: string, value: string): void {
	assertSafeNestedId(label, value);
}

function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
	return path.dirname(path.resolve(route.eventSink));
}

function assertTrustedRouteEntry(target: string, kind: "directory" | "file"): void {
	const stat = fs.lstatSync(target);
	if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Nested route ${kind} is not a trusted regular ${kind}: ${target}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Nested route ${kind} is not owned by the current user: ${target}`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`Nested route ${kind} permissions are too broad: ${target}`);
	if (fs.realpathSync(target) !== path.resolve(target)) throw new Error(`Nested route ${kind} resolves through a non-canonical path: ${target}`);
}

function validateRouteShape(route: NestedRoute): void {
	assertSafeId("rootRunId", route.rootRunId);
	assertSafeId("capabilityToken", route.capabilityToken);
	const routeRoot = commonRouteRoot(route);
	if (!containedPath(NESTED_EVENTS_DIR, route.eventSink)) throw new Error("Nested event sink is outside the subagent nested event root.");
	if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox)) throw new Error("Nested control inbox is outside the subagent nested event root.");
	if (path.resolve(route.eventSink) !== path.join(routeRoot, "events")) throw new Error("Nested event sink must be the canonical route events directory.");
	if (path.resolve(route.controlInbox) !== path.join(routeRoot, "controls")) throw new Error("Nested control inbox must be the canonical route controls directory.");
	if (routeRoot !== path.join(path.resolve(NESTED_EVENTS_DIR), `${route.rootRunId}-${route.capabilityToken}`)) throw new Error("Nested route root does not match the root id and capability token.");
}

function validateNestedRouteAuthority(value: unknown, requireOperationalDirectories: boolean): NestedRoute {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted nested route metadata must be an object.");
	const raw = value as Record<string, unknown>;
	for (const field of ["rootRunId", "eventSink", "controlInbox", "capabilityToken"] as const) {
		if (typeof raw[field] !== "string" || raw[field].length === 0) throw new Error(`Persisted nested route metadata is missing ${field}.`);
	}
	const route = {
		rootRunId: raw.rootRunId as string,
		eventSink: raw.eventSink as string,
		controlInbox: raw.controlInbox as string,
		capabilityToken: raw.capabilityToken as string,
	};
	validateRouteShape(route);
	const routeRoot = commonRouteRoot(route);
	if (!fs.existsSync(routeRoot)) throw new Error("Nested route root does not exist.");
	assertTrustedRouteEntry(routeRoot, "directory");
	if (requireOperationalDirectories) {
		if (!fs.existsSync(route.eventSink) || !fs.existsSync(route.controlInbox)) throw new Error("Nested route directories do not exist.");
		assertTrustedRouteEntry(route.eventSink, "directory");
		assertTrustedRouteEntry(route.controlInbox, "directory");
	}
	const routeFile = path.join(routeRoot, ROUTE_FILE);
	let metadata: unknown;
	try {
		assertTrustedRouteEntry(routeFile, "file");
		metadata = JSON.parse(fs.readFileSync(routeFile, "utf8"));
	} catch (error) {
		throw new Error(`Persisted nested route metadata has no readable route.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
		|| (metadata as Record<string, unknown>).rootRunId !== route.rootRunId
		|| (metadata as Record<string, unknown>).capabilityToken !== route.capabilityToken) {
		throw new Error("Persisted nested route metadata does not match the live route.json.");
	}
	return route;
}

/** Strict validation for persisted revival metadata. Never substitute ambient authority. */
export function validateNestedRouteForRevival(value: unknown): NestedRoute {
	return validateNestedRouteAuthority(value, true);
}

export function createNestedRoute(rootRunId: string): NestedRoute {
	assertSafeId("rootRunId", rootRunId);
	const capabilityToken = randomUUID();
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
	const eventSink = path.join(routeRoot, "events");
	const controlInbox = path.join(routeRoot, "controls");
	fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
	fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
	const routeFile = path.join(routeRoot, ROUTE_FILE);
	const routeFd = fs.openSync(routeFile, "wx", 0o600);
	try { fs.writeFileSync(routeFd, `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`, "utf8"); fs.fsyncSync(routeFd); } finally { fs.closeSync(routeFd); }
	fsyncDirectory(routeRoot);
	return { rootRunId, eventSink, controlInbox, capabilityToken };
}

export function resolveNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
	const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
	const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
	const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	return validateNestedRouteAuthority({ rootRunId, eventSink, controlInbox, capabilityToken }, false);
}

/** Resolve a parent route supplied by a child launch.  A partial or forged
 * handoff is an authentication failure, not permission to create a new route. */
export function resolveRequiredInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	const hasRouteMetadata = [
		SUBAGENT_PARENT_EVENT_SINK_ENV,
		SUBAGENT_PARENT_CONTROL_INBOX_ENV,
		SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
		SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
		SUBAGENT_PARENT_RUN_ID_ENV,
		SUBAGENT_PARENT_CHILD_INDEX_ENV,
		SUBAGENT_PARENT_DEPTH_ENV,
		SUBAGENT_PARENT_PATH_ENV,
	].some((key) => Boolean(env[key]));
	if (!hasRouteMetadata) return undefined;
	const route = resolveNestedRouteFromEnv(env);
	if (!route) throw new Error("Inherited nested route metadata is incomplete.");
	return route;
}

/** Best-effort route lookup for status projection paths that have their own
 * fail-closed scope. New child launches must use the required resolver above. */
export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	try {
		return resolveRequiredInheritedNestedRouteFromEnv(env);
	} catch (error) {
		console.error("Ignoring invalid nested subagent event route:", error);
		return undefined;
	}
}

export function resolveNestedParentAddressFromEnv(env: NodeJS.ProcessEnv = process.env): { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] } | undefined {
	const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
	if (!isSafeNestedId(parentRunId)) return undefined;
	const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
	const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
	const depth = Math.min(Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1), MAX_DEPTH);
	const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
	const nestedPath = parsedPath.length ? parsedPath : [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }];
	return { parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth, path: nestedPath };
}

export function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined {
	if (!run.asyncDir) return undefined;
	const resolved = path.resolve(run.asyncDir);
	const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
	const relative = path.relative(nestedRoot, resolved);
	return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}

function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function sanitizeTokenUsage(value: unknown): NestedRunSummary["totalTokens"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = clampNumber(raw.input);
	const output = clampNumber(raw.output);
	const total = clampNumber(raw.total);
	return input !== undefined && output !== undefined && total !== undefined
		? { input, output, total }
		: undefined;
}

function sanitizeState(value: unknown, fallback: NestedRunState): NestedRunState {
	return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "paused" || value === "cancelled"
		? value
		: fallback;
}

function sanitizeParallelGroups(value: unknown, stepCount = MAX_STEPS, chainStepCount = MAX_STEPS): NestedRunSummary["parallelGroups"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const boundedStepCount = Math.min(MAX_STEPS, Math.max(0, Math.floor(stepCount)));
	const boundedChainStepCount = Math.min(MAX_STEPS, Math.max(0, Math.floor(chainStepCount)));
	const groups = value.slice(0, MAX_STEPS).flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const start = raw.start;
		const count = raw.count;
		const stepIndex = raw.stepIndex;
		if (typeof start !== "number" || typeof count !== "number" || typeof stepIndex !== "number"
			|| !Number.isSafeInteger(start) || !Number.isSafeInteger(count) || !Number.isSafeInteger(stepIndex)
			|| start < 0 || count <= 0 || stepIndex < 0 || stepIndex >= boundedChainStepCount
			|| start + count > boundedStepCount) return [];
		return [{ start, count, stepIndex }];
	});
	return groups.length ? groups.sort((left, right) => left.stepIndex - right.stepIndex || left.start - right.start) : undefined;
}

function sanitizeGroupDiagnostics(value: unknown): NestedRunSummary["groupDiagnostics"] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.slice(0, MAX_STEPS).flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const groupId = stringValue(raw.groupId, 128);
		const agent = stringValue(raw.agent, 128);
		const status = raw.status === "failed" || raw.status === "complete" || raw.status === "paused" || raw.status === "cancelled" ? raw.status : undefined;
		if (!groupId || !agent || !status) return [];
		return [{ groupId, unindexed: true as const, agent, status,
			...(stringValue(raw.output, 4096) ? { output: stringValue(raw.output, 4096) } : {}),
			...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
			...(stringValue(raw.finalOutput, 4096) ? { finalOutput: stringValue(raw.finalOutput, 4096) } : {}),
		}];
	});
}

function sanitizeFastMode(value: unknown): FastModeStatus | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.requested !== true) return undefined;
	const eligible = raw.eligible === true || raw.eligible === false || raw.eligible === "unknown" ? raw.eligible : "unknown";
	const active = raw.active === true || raw.active === false || raw.active === "unknown" ? raw.active : "unknown";
	return { requested: true, eligible, active, ...(stringValue(raw.model, 128) ? { model: stringValue(raw.model, 128) } : {}) };
}

function sanitizeStep(input: unknown, depth: number): NestedStepSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	const agent = stringValue(raw.agent, 128);
	if (!agent) return undefined;
	const status = raw.status === "pending" || raw.status === "running" || raw.status === "complete" || raw.status === "completed" || raw.status === "failed" || raw.status === "paused" || raw.status === "cancelled"
		? raw.status
		: "pending";
	return {
		agent,
		status,
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(stringValue(raw.model, 128) ? { model: stringValue(raw.model, 128) } : {}),
		...(sanitizeFastMode(raw.fastMode) ? { fastMode: sanitizeFastMode(raw.fastMode) } : {}),
		...(stringValue(raw.thinking, 128) ? { thinking: stringValue(raw.thinking, 128) } : {}),
		...(sanitizeTokenUsage(raw.totalTokens) ? { totalTokens: sanitizeTokenUsage(raw.totalTokens) } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(stringValue(raw.finalOutput, 4096) ? { finalOutput: stringValue(raw.finalOutput, 4096) } : {}),
		...(raw.gitBundle && typeof raw.gitBundle === "object" ? { gitBundle: raw.gitBundle as NestedStepSummary["gitBundle"] } : {}),
		...(raw.teardownUnproven === true ? { teardownUnproven: true } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}

export function sanitizeSummary(input: unknown, depth = 0): NestedRunSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId)) return undefined;
	const pathParts = sanitizeNestedPath(raw.path);
	const steps = Array.isArray(raw.steps)
		? raw.steps.map((step) => sanitizeStep(step, depth + 1)).filter((step): step is NestedStepSummary => Boolean(step)).slice(0, MAX_STEPS)
		: undefined;
	const totalTokens = sanitizeTokenUsage(raw.totalTokens);
	return {
		id: raw.id,
		parentRunId: raw.parentRunId,
		...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
		...(stringValue(raw.parentAgent, 128) ? { parentAgent: stringValue(raw.parentAgent, 128) } : {}),
		depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
		path: pathParts,
		state: sanitizeState(raw.state, "running"),
		...(stringValue(raw.asyncDir, 2048) ? { asyncDir: stringValue(raw.asyncDir, 2048) } : {}),
		...(stringValue(raw.cwd, 2048) ? { cwd: stringValue(raw.cwd, 2048) } : {}),
		...(clampNumber(raw.pid) !== undefined && clampNumber(raw.pid)! > 0 && Number.isInteger(clampNumber(raw.pid)) ? { pid: clampNumber(raw.pid) } : {}),
		...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(stringValue(raw.intercomTarget, 256) ? { intercomTarget: stringValue(raw.intercomTarget, 256) } : {}),
		...(stringValue(raw.ownerIntercomTarget, 256) ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) } : {}),
		...(stringValue(raw.leafIntercomTarget, 256) ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) } : {}),
		...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown" ? { ownerState: raw.ownerState } : {}),
		...(stringValue(raw.controlInbox, 2048) ? { controlInbox: stringValue(raw.controlInbox, 2048) } : {}),
		...(stringValue(raw.capabilityToken, 128) ? { capabilityToken: stringValue(raw.capabilityToken, 128) } : {}),
		...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain" ? { mode: raw.mode } : {}),
		...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
		...(Array.isArray(raw.agents) ? { agents: raw.agents.map((agent) => stringValue(agent, 128)).filter((agent): agent is string => Boolean(agent)).slice(0, MAX_STEPS) } : {}),
		...(clampNumber(raw.currentStep) !== undefined ? { currentStep: clampNumber(raw.currentStep) } : {}),
		...(clampNumber(raw.chainStepCount) !== undefined ? { chainStepCount: clampNumber(raw.chainStepCount) } : {}),
		...(sanitizeParallelGroups(raw.parallelGroups, steps?.length ?? MAX_STEPS, clampNumber(raw.chainStepCount) ?? MAX_STEPS) ? { parallelGroups: sanitizeParallelGroups(raw.parallelGroups, steps?.length ?? MAX_STEPS, clampNumber(raw.chainStepCount) ?? MAX_STEPS) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(stringValue(raw.model, 128) ? { model: stringValue(raw.model, 128) } : {}),
		...(sanitizeFastMode(raw.fastMode) ? { fastMode: sanitizeFastMode(raw.fastMode) } : {}),
		...(stringValue(raw.thinking, 128) ? { thinking: stringValue(raw.thinking, 128) } : {}),
		...(totalTokens ? { totalTokens } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(clampNumber(raw.lastUpdate) !== undefined ? { lastUpdate: clampNumber(raw.lastUpdate) } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(stringValue(raw.summary, 4096) ? { summary: stringValue(raw.summary, 4096) } : {}),
		...(stringValue(raw.finalOutput, 4096) ? { finalOutput: stringValue(raw.finalOutput, 4096) } : {}),
		...(sanitizeGroupDiagnostics(raw.groupDiagnostics) ? { groupDiagnostics: sanitizeGroupDiagnostics(raw.groupDiagnostics) } : {}),
		...(raw.teardownUnproven === true ? { teardownUnproven: true } : {}),
		...(steps && steps.length > 0 ? { steps } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}

function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.started" && raw.type !== "subagent.nested.updated" && raw.type !== "subagent.nested.completed") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.parentRunId)) return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined) return undefined;
	const child = sanitizeSummary(raw.child);
	if (!child || child.id === route.rootRunId) return undefined;
	const routedChild: NestedRunSummary = {
		...child,
		controlInbox: route.controlInbox,
		capabilityToken: route.capabilityToken,
		ownerState: child.ownerState ?? "unknown",
	};
	return {
		type: raw.type,
		ts,
		rootRunId: route.rootRunId,
		parentRunId: raw.parentRunId,
		...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
		capabilityToken: route.capabilityToken,
		child: routedChild,
	};
}

export function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[] {
	if (!content.includes("\n")) {
		const record = parseRecord(content.trim(), route);
		return record ? [record] : [];
	}
	return content.split("\n")
		.slice(0, content.endsWith("\n") ? undefined : -1)
		.map((line) => line.trim() ? parseRecord(line, route) : undefined)
		.filter((event): event is NestedEventRecord => Boolean(event));
}

function terminal(state: NestedRunState, teardownUnproven = false): boolean {
	return !teardownUnproven && (state === "complete" || state === "failed" || state === "paused" || state === "cancelled");
}

function mergeSummary(existing: NestedRunSummary | undefined, event: NestedEventRecord): NestedRunSummary {
	const incoming = { ...event.child, lastUpdate: event.child.lastUpdate ?? event.ts };
	return mergeNestedRunSummary(existing, incoming);
}

function nestedFreshness(run: NestedRunSummary | undefined): number {
	if (!run) return 0;
	return Math.max(run.lastUpdate ?? 0, run.startedAt ?? 0, run.endedAt ?? 0,
		...(run.steps ?? []).map((step) => Math.max(step.startedAt ?? 0, step.endedAt ?? 0, step.lastActivityAt ?? 0,
			...mergeNestedRunFreshness(step.children))),
		...mergeNestedRunFreshness(run.children));
}
function mergeNestedRunFreshness(children: NestedRunSummary[] | undefined): number[] {
	return (children ?? []).map((child) => nestedFreshness(child));
}

/** Merge a partial snapshot without allowing omitted rich fields to erase an earlier record. */
function mergeNestedRunSummary(existing: NestedRunSummary | undefined, incoming: NestedRunSummary): NestedRunSummary {
	if (!existing) return incoming;
	const existingUpdate = nestedFreshness(existing);
	const incomingUpdate = nestedFreshness(incoming);
	const incomingIsNewer = incomingUpdate >= existingUpdate;
	const existingTerminal = nestedTerminal(existing.state, existing.teardownUnproven);
	const incomingTerminal = nestedTerminal(incoming.state, incoming.teardownUnproven);
	const state = existing.teardownUnproven || incoming.teardownUnproven
		? (incoming.teardownUnproven ? incoming.state : existing.state)
		: existingTerminal && !incomingTerminal ? existing.state
			: incomingTerminal && !existingTerminal ? incoming.state
			: incomingIsNewer ? incoming.state : existing.state;
	// Steps are canonical by position/index. Repeated agent names are legal and
	// must never cause a later record to attach to the first matching agent.
	const stepCount = Math.max(existing.steps?.length ?? 0, incoming.steps?.length ?? 0);
	const steps = stepCount ? Array.from({ length: stepCount }, (_, index) => {
		const next = incoming.steps?.[index];
		const previous = existing.steps?.[index];
		if (!next) return previous!;
		return mergeNestedStepSnapshots(previous, next, incomingUpdate);
	}).filter((step): step is NestedStepSummary => Boolean(step)) : undefined;
	const children = mergeNestedRunSnapshots(existing.children, incoming.children);
	const stepChildren = steps?.flatMap((step) => step.children ?? []) ?? [];
	const attachedIds = new Set(stepChildren.map((child) => child.id));
	return {
		...existing,
		...(incomingIsNewer ? incoming : {}),
		state,
		lastUpdate: Math.max(existing.lastUpdate ?? 0, incoming.lastUpdate ?? 0),
		...(existing.teardownUnproven || incoming.teardownUnproven ? { teardownUnproven: true } : {}),
		...(steps ? { steps } : {}),
		...(children.length || stepChildren.length ? { children: children.filter((child) => !attachedIds.has(child.id)) } : {}),
	};
}

function mergeNestedStepSnapshots(existing: NestedStepSummary | undefined, incoming: NestedStepSummary, sourceUpdate = 0): NestedStepSummary {
	if (!existing) return incoming;
	const existingUpdate = Math.max(existing.startedAt ?? 0, existing.endedAt ?? 0, existing.lastActivityAt ?? 0);
	const incomingUpdate = Math.max(sourceUpdate, incoming.startedAt ?? 0, incoming.endedAt ?? 0, incoming.lastActivityAt ?? 0);
	const incomingIsNewer = incomingUpdate >= existingUpdate;
	const existingTerminal = nestedTerminal(existing.status as NestedRunState, existing.teardownUnproven);
	const incomingTerminal = nestedTerminal(incoming.status as NestedRunState, incoming.teardownUnproven);
	const status = existing.teardownUnproven || incoming.teardownUnproven
		? (incoming.teardownUnproven ? incoming.status : existing.status)
		: existingTerminal && !incomingTerminal ? existing.status
			: incomingTerminal && !existingTerminal ? incoming.status
			: incomingIsNewer ? incoming.status : existing.status;
	const children = mergeNestedRunSnapshots(existing.children, incoming.children);
	return {
		...existing,
		...(incomingIsNewer ? incoming : {}),
		status,
		...(existing.teardownUnproven || incoming.teardownUnproven ? { teardownUnproven: true } : {}),
		...(children.length || existing.children || incoming.children ? { children } : {}),
	};
}

function attachChild(children: NestedRunSummary[], event: NestedEventRecord): NestedRunSummary[] {
	let updated = false;
	const addToParent = (item: NestedRunSummary): NestedRunSummary => {
		const nextChild = mergeSummary(undefined, event);
		const stepIndex = event.parentStepIndex;
		if (stepIndex !== undefined && item.steps?.[stepIndex]) {
			const step = item.steps[stepIndex];
			const existing = step.children ?? [];
			const childIndex = existing.findIndex((child) => child.id === event.child.id);
			const legacyExisting = item.children?.find((child) => child.id === event.child.id);
			const merged = mergeSummary(childIndex >= 0 ? existing[childIndex] : legacyExisting, event);
			const stepChildren = childIndex >= 0
				? existing.map((child, index) => index === childIndex ? merged : child)
				: [...existing, merged];
			// A child routed to a known launching step must not also be rendered
			// through the legacy direct-children slot.
			const directChildren = (item.children ?? []).filter((child) => child.id !== event.child.id);
			return { ...item, children: directChildren.length ? directChildren : undefined, steps: item.steps.map((candidate, index) => index === stepIndex ? { ...candidate, children: stepChildren.slice(0, MAX_CHILDREN) } : candidate), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
		}
		const existingChildren = item.children ?? [];
		const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
		const merged = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
		const nextChildren = childIndex >= 0
			? existingChildren.map((child, index) => index === childIndex ? merged : child)
			: [...existingChildren, nextChild];
		return { ...item, children: nextChildren.slice(0, MAX_CHILDREN), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
	};
	const walk = (items: NestedRunSummary[]): NestedRunSummary[] => items.map((item) => {
		if (item.id === event.parentRunId) { updated = true; return addToParent(item); }
		const nested = [ ...(item.children ?? []), ...(item.steps?.flatMap((step) => step.children ?? []) ?? []) ];
		if (!nested.length) return item;
		const nextChildren = item.children ? walk(item.children) : item.children;
		const nextSteps = item.steps?.map((step) => step.children?.length ? { ...step, children: walk(step.children) } : step);
		return nextChildren !== item.children || nextSteps !== item.steps ? { ...item, ...(nextChildren ? { children: nextChildren } : {}), ...(nextSteps ? { steps: nextSteps } : {}) } : item;
	});
	const next = walk(children);
	if (updated) return next;
	const childIndex = next.findIndex((child) => child.id === event.child.id);
	const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
	return childIndex >= 0
		? next.map((child, index) => index === childIndex ? nextChild : child)
		: [...next, nextChild].slice(0, MAX_CHILDREN);
}

export function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry {
	return {
		...registry,
		updatedAt: Math.max(registry.updatedAt, event.ts),
		children: attachChild(registry.children, event),
	};
}

function nestedTerminal(state: NestedRunState | NestedStepSummary["status"] | undefined, teardownUnproven = false): boolean {
	return !teardownUnproven && (state === "complete" || state === "completed" || state === "failed" || state === "paused" || state === "cancelled");
}

/** Monotonic union used when a status snapshot and the durable route both exist. */
export function mergeNestedRunSnapshots(...snapshots: Array<NestedRunSummary[] | undefined>): NestedRunSummary[] {
	const byId = new Map<string, NestedRunSummary>();
	for (const snapshot of snapshots) for (const incoming of snapshot ?? []) {
		const existing = byId.get(incoming.id);
		byId.set(incoming.id, existing ? mergeNestedRunSummary(existing, incoming) : incoming);
	}
	return [...byId.values()].slice(0, MAX_CHILDREN);
}

function parseControlRequest(content: string, route: NestedRoute): NestedControlRequestRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined; let parsed: unknown; try { parsed = JSON.parse(content); } catch { return undefined; }
	if (!parsed || typeof parsed !== "object") return undefined; const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-request" || raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId) || (raw.action !== "interrupt" && raw.action !== "resume")) return undefined; const ts = clampNumber(raw.ts); if (ts === undefined) return undefined;
	return { type: "subagent.nested.control-request", ts, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken, requestId: raw.requestId, targetRunId: raw.targetRunId, action: raw.action, ...(stringValue(raw.message, 16_000) ? { message: stringValue(raw.message, 16_000) } : {}) };
}
function parseControlResult(content: string, route: NestedRoute): NestedControlResultRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined; let parsed: unknown; try { parsed = JSON.parse(content); } catch { return undefined; }
	if (!parsed || typeof parsed !== "object") return undefined; const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-result" || raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId) || typeof raw.ok !== "boolean") return undefined; const ts = clampNumber(raw.ts); if (ts === undefined) return undefined;
	return { type: "subagent.nested.control-result", ts, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken, requestId: raw.requestId, targetRunId: raw.targetRunId, ok: raw.ok, message: stringValue(raw.message, 16_000) ?? (raw.ok ? "Control request completed." : "Control request failed.") };
}
export interface NestedRunMatch {
	rootRunId: string;
	route: NestedRoute;
	run: NestedRunSummary;
}
export interface NestedRunResolutionScope {
	routes: NestedRoute[];
	descendantOf?: { parentRunId: string; parentStepIndex?: number };
}
export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
	assertSafeId("rootRunId", rootRunId); let entries: string[];
	try { entries = fs.readdirSync(NESTED_EVENTS_DIR); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	for (const entry of entries) { if (!entry.startsWith(`${rootRunId}-`)) continue; const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try { assertTrustedRouteEntry(routeRoot, "directory"); const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf8")) as { rootRunId?: unknown; capabilityToken?: unknown }; if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string") continue; const route = { rootRunId, eventSink: path.join(routeRoot, "events"), controlInbox: path.join(routeRoot, "controls"), capabilityToken: metadata.capabilityToken }; validateRouteShape(route); return route; } catch { continue; }
	}
	return undefined;
}
export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined { const route = findNestedRouteForRootId(rootRunId); return route ? projectNestedEvents(route) : undefined; }

/** Resolve persisted authority without silently substituting another root's route. */
export interface NestedRouteResolution {
	route?: NestedRoute;
	validity: NestedRouteValidity;
	error?: string;
}
export function resolveNestedRoute(rootRunId: string, persisted?: NestedRouteInfo, options: { routeRequired?: boolean } = {}): NestedRouteResolution {
	if (persisted === undefined) {
		if (options.routeRequired) return { validity: "unavailable", error: "Persisted nested route metadata is required but unavailable." };
		// Ambient lookup is retained only for genuinely legacy statuses that did
		// not persist or require a route binding.
		const route = findNestedRouteForRootId(rootRunId);
		return { route, validity: route ? "trusted" : "legacy" };
	}
	try {
		if (persisted.rootRunId !== rootRunId) throw new Error("Persisted nested route root does not match the requested run root.");
		// First validate coordinates and route identity even when the route was
		// cleaned up. A correctly shaped but absent route is unavailable, not forged.
		validateRouteShape(persisted);
		const root = commonRouteRoot(persisted);
		if (!fs.existsSync(root)) return { validity: "unavailable", error: "Persisted nested route was cleaned up." };
		validateNestedRouteAuthority(persisted, true);
		return { route: persisted, validity: "trusted" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Only disappearance of the whole trusted route root is cleanup. Missing
		// metadata or child directories inside an existing root are malformed and
		// must fail closed as invalid rather than masquerading as unavailable.
		if (message.includes("route root does not exist")) return { validity: "unavailable", error: message };
		return { validity: "invalid", error: message };
	}
}
export function resolveExactNestedRoute(rootRunId: string, persisted?: NestedRouteInfo, options: { routeRequired?: boolean } = {}): NestedRoute | undefined {
	const result = resolveNestedRoute(rootRunId, persisted, options);
	if (result.validity === "invalid") throw new Error(result.error ?? "Persisted nested route is invalid.");
	return result.route;
}
export function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined {
	for (const child of children ?? []) { if (child.id === id) return child; const nested = findNestedRun(child.children, id) ?? findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id); if (nested) return nested; } return undefined;
}
function collectNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = []): NestedRunSummary[] { for (const child of children ?? []) { output.push(child); collectNestedRuns(child.children, output); collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output); } return output; }
function collectScopedNestedRuns(children: NestedRunSummary[] | undefined, scope: NestedRunResolutionScope["descendantOf"], output: NestedRunSummary[] = []): NestedRunSummary[] {
	if (!scope) return collectNestedRuns(children, output);
	for (const child of children ?? []) { if (child.parentRunId === scope.parentRunId && (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) { collectNestedRuns([child], output); continue; } collectScopedNestedRuns(child.children, scope, output); collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output); }
	return output;
}
function listNestedRoutes(): NestedRoute[] {
	let entries: string[]; try { entries = fs.readdirSync(NESTED_EVENTS_DIR); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const routes: NestedRoute[] = []; for (const entry of entries) { const routeRoot = path.join(NESTED_EVENTS_DIR, entry); try { assertTrustedRouteEntry(routeRoot, "directory"); const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf8")) as { rootRunId?: unknown; capabilityToken?: unknown }; if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string") continue; const route = { rootRunId: metadata.rootRunId, eventSink: path.join(routeRoot, "events"), controlInbox: path.join(routeRoot, "controls"), capabilityToken: metadata.capabilityToken }; validateRouteShape(route); routes.push(route); } catch { continue; } } return routes;
}
export function findNestedRunMatchesById(id: string, options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {}): NestedRunMatch[] {
	assertSafeId("id", id); const matches: NestedRunMatch[] = []; for (const route of options.scope?.routes ?? listNestedRoutes()) { try { const registry = projectNestedEvents(route); for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) if (options.prefix ? run.id.startsWith(id) : run.id === id) matches.push({ rootRunId: route.rootRunId, route, run }); } catch { continue; } } return matches;
}
export function findNestedRunById(id: string): { rootRunId: string; run: NestedRunSummary } | undefined { const match = findNestedRunMatchesById(id)[0]; return match ? { rootRunId: match.rootRunId, run: match.run } : undefined; }

function registryPath(route: NestedRoute): string {
	return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

function routeRoot(route: NestedRoute): string { return commonRouteRoot(route); }
function journalPath(route: NestedRoute, kind: "event" | "control" | "result"): string {
	return kind === "control"
		? path.join(route.controlInbox, CONTROL_JOURNAL)
		: path.join(route.eventSink, kind === "event" ? EVENT_JOURNAL : RESULT_JOURNAL);
}
function statePath(route: NestedRoute): string { return path.join(routeRoot(route), JOURNAL_STATE); }
function manifestPath(route: NestedRoute): string { return path.join(routeRoot(route), LEGACY_MANIFEST); }

interface JournalState {
	version: 1;
	generation: number;
	eventReadOffset: number;
	eventWriteOffset: number;
	eventSequence: number;
	eventReadSequence: number;
	controlReadOffset: number;
	controlWriteOffset: number;
	controlSequence: number;
	controlReadSequence: number;
	resultReadOffset: number;
	resultWriteOffset: number;
	resultSequence: number;
	resultReadSequence: number;
	pendingRequests: Record<string, NestedControlRequestRecord>;
	ackedRequests: string[];
	results: Record<string, NestedControlResultRecord>;
	deliveredResults: string[];
}

interface JournalRuntime {
	state: JournalState;
	pending: Map<string, NestedControlRequestRecord>;
	acked: Set<string>;
	results: Map<string, NestedControlResultRecord>;
	claimed: Set<string>;
	loaded: boolean;
}
const journalRuntimes = new Map<string, JournalRuntime>();
function runtimeKey(route: NestedRoute): string { return routeRoot(route); }

function emptyJournalState(): JournalState {
	return { version: 1, generation: 0, eventReadOffset: 0, eventWriteOffset: 0, eventSequence: 0, eventReadSequence: 0, controlReadOffset: 0, controlWriteOffset: 0, controlSequence: 0, controlReadSequence: 0, resultReadOffset: 0, resultWriteOffset: 0, resultSequence: 0, resultReadSequence: 0, pendingRequests: {}, ackedRequests: [], results: {}, deliveredResults: [] };
}

function fsyncDirectory(dir: string): void {
	try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* directory fsync is unavailable on some platforms */ }
}
function durableWrite(file: string, content: string, mode = 0o600): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
	const fd = fs.openSync(tmp, "wx", mode);
	try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(tmp, file);
	fsyncDirectory(dir);
}
function trustedDataFile(file: string): void {
	if (!fs.existsSync(file)) return;
	assertTrustedRouteEntry(file, "file");
	const stat = fs.statSync(file);
	if (stat.size > 64 * 1024 * 1024) throw new Error(`Nested journal/state is too large: ${file}`);
}
function readState(route: NestedRoute): JournalState {
	const file = statePath(route);
	if (!fs.existsSync(file)) return emptyJournalState();
	trustedDataFile(file);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		if (raw.version !== 1 || typeof raw.generation !== "number") throw new Error("invalid journal state version");
		const number = (key: string) => typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0 ? raw[key] as number : 0;
		// State is deliberately metadata-only. Older state files carried the
		// complete maps; accepting them here keeps upgrades lossless, while new
		// writes never make an idle poll parse/rewrite historical records.
		return {
			version: 1, generation: number("generation"), eventReadOffset: number("eventReadOffset"), eventWriteOffset: number("eventWriteOffset"), eventSequence: number("eventSequence"), eventReadSequence: number("eventReadSequence"),
			controlReadOffset: number("controlReadOffset"), controlWriteOffset: number("controlWriteOffset"), controlSequence: number("controlSequence"), controlReadSequence: number("controlReadSequence"),
			resultReadOffset: number("resultReadOffset"), resultWriteOffset: number("resultWriteOffset"), resultSequence: number("resultSequence"), resultReadSequence: number("resultReadSequence"),
			pendingRequests: {},
			ackedRequests: Array.isArray(raw.ackedRequests) ? raw.ackedRequests.filter((v): v is string => isSafeNestedId(v)) : [],
			results: {},
			deliveredResults: Array.isArray(raw.deliveredResults) ? raw.deliveredResults.filter((v): v is string => isSafeNestedId(v)) : [],
		};
	} catch (error) { throw new Error(`Nested journal state is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}
function writeState(route: NestedRoute, state: JournalState, kind: "event" | "control" | "result" = "event"): void {
	const metadata = { ...state, pendingRequests: undefined, results: undefined, ackedRequests: undefined };
	delete (metadata as Partial<JournalState>).pendingRequests;
	delete (metadata as Partial<JournalState>).results;
	durableWrite(statePath(route), `${JSON.stringify(metadata)}\n`);
	journalFault("state", kind);
}
function indexPath(route: NestedRoute, kind: "control" | "result"): string { return path.join(routeRoot(route), INDEX_FILE[kind]); }
function ackPath(route: NestedRoute): string { return path.join(routeRoot(route), ACK_FILE); }
function executionPath(route: NestedRoute): string { return path.join(routeRoot(route), EXECUTION_FILE); }
function loadExecutions(route: NestedRoute, runtime: JournalRuntime): void { const file = executionPath(route); if (!fs.existsSync(file)) return; trustedDataFile(file); for (const id of fs.readFileSync(file, "utf8").split("\n")) if (isSafeNestedId(id)) runtime.claimed.add(id); }
function appendExecution(route: NestedRoute, requestId: string): void { const file = executionPath(route); ensureJournal(file); const fd = fs.openSync(file, "a", 0o600); try { fs.writeFileSync(fd, `${requestId}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDirectory(routeRoot(route)); }
function appendAck(route: NestedRoute, requestId: string): void { const file = ackPath(route); ensureJournal(file); const fd = fs.openSync(file, "a", 0o600); try { fs.writeFileSync(fd, `${requestId}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDirectory(routeRoot(route)); }
function loadAcks(route: NestedRoute, runtime: JournalRuntime): void { const file = ackPath(route); if (!fs.existsSync(file)) return; trustedDataFile(file); for (const id of fs.readFileSync(file, "utf8").split("\n")) if (isSafeNestedId(id)) runtime.acked.add(id); }
function appendIndex(route: NestedRoute, kind: "control" | "result", value: object): void {
	const file = indexPath(route, kind); ensureJournal(file);
	const fd = fs.openSync(file, "a", 0o600); try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fsyncDirectory(routeRoot(route));
}
function loadIndex(route: NestedRoute, kind: "control" | "result", runtime: JournalRuntime): void {
	const file = indexPath(route, kind);
	if (!fs.existsSync(file)) return;
	trustedDataFile(file);
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			if (kind === "control") { const request = parseControlRequest(line, route); if (request) runtime.pending.set(request.requestId, request); }
			else { const result = parseControlResult(line, route); if (result) runtime.results.set(result.requestId, result); }
		} catch { /* immutable index evidence remains available in the journal */ }
	}
}
function reconcileResultJournal(route: NestedRoute, runtime: JournalRuntime): void {
	const state = runtime.state;
	const delta = readFramesRelaxed<NestedControlResultRecord>(route, "result", state.resultWriteOffset, state.resultSequence);
	if (!delta.frames.length) return;
	state.resultWriteOffset = delta.end;
	state.resultSequence = delta.frames[delta.frames.length - 1]!.sequence;
	for (const frame of delta.frames) {
		const result = parseControlResult(JSON.stringify(frame.record), route);
		if (!result) continue;
		const prior = runtime.results.get(result.requestId);
		if (prior && JSON.stringify(prior) !== JSON.stringify(result)) throw new Error(`Conflicting nested control result for requestId '${result.requestId}'.`);
		runtime.results.set(result.requestId, result);
		if (!prior) appendIndex(route, "result", result);
	}
	writeState(route, state, "result");
}
function runtimeFor(route: NestedRoute): JournalRuntime {
	const key = runtimeKey(route); const prior = journalRuntimes.get(key); if (prior?.loaded) { reconcileCompaction(route, prior); reconcileResultJournal(route, prior); return prior; }
	const state = readState(route);
	const runtime: JournalRuntime = { state, pending: new Map(), acked: new Set(state.ackedRequests), results: new Map(), claimed: new Set(), loaded: true };
	reconcileCompaction(route, runtime);
	loadAcks(route, runtime); loadExecutions(route, runtime); loadIndex(route, "control", runtime);
	// The result journal is authoritative. Recover its durable tail before
	// consulting the derived result index, which may lag a crash.
	journalRuntimes.set(key, runtime);
	reconcileResultJournal(route, runtime);
	loadIndex(route, "result", runtime);
	// Upgrade old state files without making them hot forever: import their
	// maps once into the append-only indexes, then subsequent state is compact.
	const old = JSON.parse(fs.existsSync(statePath(route)) ? fs.readFileSync(statePath(route), "utf8") : "{}") as Record<string, unknown>;
	if (old.pendingRequests && typeof old.pendingRequests === "object") for (const value of Object.values(old.pendingRequests as Record<string, unknown>)) { const request = parseControlRequest(JSON.stringify(value), route); if (request && !runtime.pending.has(request.requestId)) { runtime.pending.set(request.requestId, request); appendIndex(route, "control", request); } }
	if (old.results && typeof old.results === "object") for (const value of Object.values(old.results as Record<string, unknown>)) { const result = parseControlResult(JSON.stringify(value), route); if (result && !runtime.results.has(result.requestId)) { runtime.results.set(result.requestId, result); appendIndex(route, "result", result); } }
	journalRuntimes.set(key, runtime); return runtime;
}

function linuxStartToken(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		return fields.length > 19 && /^\d+$/.test(fields[19]!) ? fields[19] : undefined;
	} catch { return undefined; }
}
function publishRouteLock(root: string, lock: string, identity: { pid: number; uid: number; startToken: string; token: string }): void {
	// The directory is the no-replace lock primitive. Publish its owner through
	// an atomically linked, fully written file so contenders can observe either
	// no owner yet (brief contention) or the complete identity, never partial JSON.
	fs.mkdirSync(lock, { mode: 0o700 });
	const owner = path.join(lock, "owner");
	const pending = path.join(lock, `.owner.${identity.token}.pending`);
	let pendingExists = false;
	try {
		const fd = fs.openSync(pending, "wx", 0o600);
		pendingExists = true;
		try { fs.writeFileSync(fd, `${JSON.stringify(identity)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		// link(2) is atomic and fails if an unexpected owner already exists.
		fs.linkSync(pending, owner);
		fs.unlinkSync(pending);
		pendingExists = false;
		fsyncDirectory(lock);
		fsyncDirectory(root);
	} catch (error) {
		if (pendingExists) { try { fs.unlinkSync(pending); } catch { /* retain uncertain evidence */ } }
		// Retain the lock directory on publication failure. Deleting an identity
		// that was not proven would weaken fail-closed ownership semantics.
		throw error;
	}
}
function withRouteLock<T>(route: NestedRoute, fn: () => T): T {
	const root = routeRoot(route);
	const lock = path.join(root, ROUTE_LOCK);
	const startToken = linuxStartToken(process.pid);
	if (typeof process.getuid !== "function" || !startToken) throw new Error("Nested route locking requires Linux exact process identity proof.");
	const identity = { pid: process.pid, uid: process.getuid(), startToken, token: randomUUID() };
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			publishRouteLock(root, lock, identity);
			try { return fn(); } finally {
				// Never remove a replacement lock. The owner token is the release
				// capability, not merely the pathname.
				try { const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")) as { token?: unknown }; if (owner.token === identity.token) { fs.rmSync(lock, { recursive: true, force: false }); fsyncDirectory(routeRoot(route)); } } catch { /* replacement or crash: leave it untouched */ }
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const st = fs.lstatSync(lock); if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== identity.uid) throw new Error("Nested route lock is not trusted.");
				const ownerFile = path.join(lock, "owner"); const ownerStat = fs.lstatSync(ownerFile);
				if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || (ownerStat.mode & 0o077) !== 0 || ownerStat.uid !== identity.uid) throw new Error("Nested route lock owner is not trusted.");
				const raw = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { pid?: unknown; uid?: unknown; startToken?: unknown; token?: unknown };
				if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0 || !Number.isInteger(raw.uid) || (raw.uid as number) < 0 || typeof raw.startToken !== "string" || !/^\d+$/.test(raw.startToken) || typeof raw.token !== "string" || !isSafeNestedId(raw.token)) throw new Error("Nested route lock identity is ambiguous.");
				if (raw.uid !== identity.uid) throw new Error("Nested route lock belongs to another user.");
				const observed = linuxStartToken(raw.pid as number); if (!observed) throw new Error("Nested route lock identity cannot be proven exactly.");
				stale = observed !== raw.startToken;
			} catch (lockError) {
				// The owner may have released between EEXIST and inspection.
				// Treat that narrow race as contention, never as a dropped record.
				if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, 1 + attempt));
					continue;
				}
				throw lockError instanceof Error ? lockError : new Error(String(lockError));
			}
			if (stale) { try { fs.rmSync(lock, { recursive: true, force: false }); } catch { /* another contender won */ } continue; }
			// A live owner gets bounded backoff rather than dropping a journal
			// operation immediately.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100, 2 + attempt * 2));
		}
	}
	throw new Error("Nested route remained busy after bounded lock contention retries.");
}

function frameKind(kind: "event" | "control" | "result"): number { return kind === "event" ? 1 : kind === "control" ? 2 : 3; }
function makeFrame(kind: "event" | "control" | "result", sequence: number, record: object): Buffer {
	const body = Buffer.from(JSON.stringify(record), "utf8");
	if (body.length > JOURNAL_MAX_BODY_BYTES) throw new Error("Nested journal record exceeds the maximum size.");
	const header = Buffer.alloc(JOURNAL_HEADER_BYTES);
	JOURNAL_MAGIC.copy(header, 0); header.writeUInt8(JOURNAL_VERSION, 8); header.writeUInt8(frameKind(kind), 9); header.writeUInt16BE(0, 10);
	header.writeBigUInt64BE(BigInt(sequence), 12); header.writeUInt32BE(body.length, 20); createHash("sha256").update(body).digest().copy(header, 24);
	return Buffer.concat([header, body]);
}
function ensureJournal(file: string): void {
	if (fs.existsSync(file)) { trustedDataFile(file); return; }
	const fd = fs.openSync(file, "wx", 0o600); fs.closeSync(fd); fsyncDirectory(path.dirname(file));
}
function appendJournal(route: NestedRoute, kind: "event" | "control" | "result", record: object, sequence: number): number {
	const file = journalPath(route, kind); ensureJournal(file); const frame = makeFrame(kind, sequence, record);
	const fd = fs.openSync(file, "a", 0o600); try { fs.writeFileSync(fd, frame); if (typeof fs.fdatasyncSync === "function") fs.fdatasyncSync(fd); else fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDirectory(routeRoot(route));
	legacyFingerprints.set(runtimeKey(route), legacyDirectoryMtime(route));
	return frame.length;
}
interface Framed<T> { sequence: number; record: T; nextOffset: number; }
function readFrames<T>(route: NestedRoute, kind: "event" | "control" | "result", offset: number, expectedSequence: number): { frames: Framed<T>[]; end: number; sequence: number } {
	const file = journalPath(route, kind); if (!fs.existsSync(file)) return { frames: [], end: 0, sequence: expectedSequence };
	trustedDataFile(file); const stat = fs.statSync(file); if (offset > stat.size) throw new Error("Nested journal cursor is ahead of its journal.");
	const fd = fs.openSync(file, "r"); const frames: Framed<T>[] = []; let position = offset; let sequence = expectedSequence; let badAt: number | undefined;
	try {
		while (position < stat.size) {
			if (stat.size - position < JOURNAL_HEADER_BYTES) { badAt = position; break; }
			const header = Buffer.alloc(JOURNAL_HEADER_BYTES); fs.readSync(fd, header, 0, header.length, position);
			const length = header.readUInt32BE(20); const seqBig = header.readBigUInt64BE(12); const seq = Number(seqBig);
			if (!header.subarray(0, 8).equals(JOURNAL_MAGIC) || header.readUInt8(8) !== JOURNAL_VERSION || header.readUInt8(9) !== frameKind(kind) || !Number.isSafeInteger(seq) || seq !== sequence + 1 || length > JOURNAL_MAX_BODY_BYTES) { badAt = position; break; }
			const next = position + JOURNAL_HEADER_BYTES + length; if (next > stat.size) { badAt = position; break; }
			const body = Buffer.alloc(length); fs.readSync(fd, body, 0, length, position + JOURNAL_HEADER_BYTES);
			if (!createHash("sha256").update(body).digest().equals(header.subarray(24, 56))) { badAt = position; break; }
			try { frames.push({ sequence: seq, record: JSON.parse(body.toString("utf8")) as T, nextOffset: next }); } catch { badAt = position; break; }
			sequence = seq; position = next;
		}
	} finally { fs.closeSync(fd); }
	if (badAt !== undefined) {
		// Preserve every ambiguous byte as immutable evidence, then repair the
		// active journal to the last verified frame. This is safe at restart and
		// permits the next append to make progress without replaying a torn tail.
		const evidence = `${file}.torn.${Date.now()}-${randomUUID()}`;
		const raw = fs.readFileSync(file).subarray(badAt);
		if (raw.length) durableWrite(evidence, raw.toString("base64") + "\n");
		const truncate = fs.openSync(file, "r+"); try { fs.ftruncateSync(truncate, badAt); fs.fsyncSync(truncate); } finally { fs.closeSync(truncate); } fsyncDirectory(routeRoot(route));
		position = badAt;
	}
	return { frames, end: position, sequence };
}

function legacyRecords(route: NestedRoute, kind: "event" | "control" | "result"): Array<NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord> {
	const dir = kind === "event" || kind === "result" ? route.eventSink : route.controlInbox;
	let entries: string[]; try { entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort(); } catch { return []; }
	const records: Array<NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord> = [];
	for (const entry of entries) {
		const file = path.join(dir, entry); if (!containedPath(dir, file)) continue;
		try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue; const content = fs.readFileSync(file, "utf8");
			const lines = content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content];
			for (const line of lines) { const parsed = kind === "event" ? parseRecord(line, route) : kind === "control" ? parseControlRequest(line, route) : parseControlResult(line, route); if (parsed) records.push(parsed); }
		} catch { /* malformed legacy evidence is left untouched */ }
	}
	return records;
}
interface LegacyManifest { version: 2; complete: boolean; files: Record<string, { hash: string; records: string[] }>; directoryMtime: string }
const legacyFingerprints = new Map<string, string>();
function legacyDirectoryMtime(route: NestedRoute): string {
	try { const a = fs.statSync(route.eventSink).mtimeMs.toString(); const b = fs.statSync(route.controlInbox).mtimeMs.toString(); return `${a}:${b}`; } catch { return "missing"; }
}
function readLegacyManifest(route: NestedRoute): LegacyManifest | undefined {
	if (!fs.existsSync(manifestPath(route))) return undefined;
	trustedDataFile(manifestPath(route));
	try {
		const value = JSON.parse(fs.readFileSync(manifestPath(route), "utf8")) as Partial<LegacyManifest>;
		if (value.version !== 2 || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || typeof value.directoryMtime !== "string") throw new Error("invalid legacy import manifest");
		for (const [file, entry] of Object.entries(value.files)) {
			if (!containedPath(routeRoot(route), file) || !entry || typeof entry !== "object" || typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Array.isArray(entry.records) || entry.records.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw new Error("invalid legacy import manifest entry");
		}
		return { version: 2, complete: value.complete === true, files: value.files as LegacyManifest["files"], directoryMtime: value.directoryMtime };
	} catch (error) { throw new Error(`Legacy migration manifest is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}
function legacyCandidates(route: NestedRoute): Array<{ kind: "event" | "control" | "result"; file: string; hash: string; records: Array<NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord> }> {
	const output: Array<{ kind: "event" | "control" | "result"; file: string; hash: string; records: Array<NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord> }> = [];
	for (const [kind, dir] of [["event", route.eventSink], ["control", route.controlInbox], ["result", route.eventSink]] as const) {
		let entries: string[];
		try { journalWork.readdir++; entries = fs.readdirSync(dir).filter((entry) => (entry.endsWith(".json") || entry.endsWith(".jsonl")) && !entry.startsWith("." )).sort(); } catch { continue; }
		for (const entry of entries) {
			const file = path.join(dir, entry); if (!containedPath(dir, file)) continue;
			try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 64 * 1024 * 1024) continue; const content = fs.readFileSync(file, "utf8");
				const records: Array<NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord> = [];
				for (const line of (content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content])) { const parsed = kind === "event" ? parseRecord(line, route) : kind === "control" ? parseControlRequest(line, route) : parseControlResult(line, route); if (parsed) records.push(parsed); }
				output.push({ kind, file, hash: createHash("sha256").update(content).digest("hex"), records });
			} catch { /* malformed legacy evidence is left untouched and auditable */ }
		}
	}
	return output;
}
function importLegacy(route: NestedRoute): void {
	const existing = readLegacyManifest(route);
	if (existing?.complete) {
		const current = legacyDirectoryMtime(route); const key = runtimeKey(route);
		if (legacyFingerprints.get(key) === current) return;
		// A completed migration is immutable. A later legacy file (or a changed
		// source) is ambiguous and must fail closed rather than replaying it.
		const candidates = legacyCandidates(route); const known = new Set(Object.keys(existing.files));
		const late = candidates.find((candidate) => !known.has(candidate.file) || existing.files[candidate.file]?.hash !== candidate.hash);
		if (late) throw new Error(`Legacy file arrived after migration; refusing untracked replay: ${late.file}`);
		legacyFingerprints.set(key, current); return;
	}
	withRouteLock(route, () => {
		const priorManifest = readLegacyManifest(route);
		if (priorManifest?.complete) return;
		let state = readState(route);
		const manifest: LegacyManifest = priorManifest ?? { version: 2, complete: false, files: {}, directoryMtime: legacyDirectoryMtime(route) };
		const candidates = legacyCandidates(route);
		const byFile = new Map<string, typeof candidates[number]>();
		for (const candidate of candidates) {
			const prior = byFile.get(candidate.file);
			// Event and result classifications share eventSink; retain the parsed
			// classification rather than letting the empty alternate classification win.
			if (!prior || candidate.records.length > prior.records.length) byFile.set(candidate.file, candidate);
		}
		// Every persisted file entry must still be present and byte-identical.
		// This protects a restart from silently continuing over changed evidence.
		for (const [file, prior] of Object.entries(manifest.files)) {
			const candidate = byFile.get(file);
			if (!candidate || candidate.hash !== prior.hash) throw new Error(`Legacy migration evidence changed or disappeared: ${file}`);
			const candidateDigests = new Set(candidate.records.map((record) => createHash("sha256").update(JSON.stringify(record)).digest("hex")));
			if (prior.records.some((digest) => !candidateDigests.has(digest))) throw new Error(`Legacy migration record fingerprint changed: ${file}`);
		}
		for (const candidate of candidates) {
			const prior = manifest.files[candidate.file];
			// Event and result legacy records share a directory. Once a file has
			// been classified, an empty parse under the other kind must not erase
			// its durable progress.
			if (!candidate.records.length && prior) continue;
			const digests = candidate.records.map((record) => createHash("sha256").update(JSON.stringify(record)).digest("hex"));
			const imported = [...(prior?.records ?? [])];
			if (prior && prior.hash !== candidate.hash) throw new Error(`Legacy migration evidence changed: ${candidate.file}`);
			for (let index = 0; index < candidate.records.length; index++) {
				const record = candidate.records[index]!; const digest = digests[index]!;
				if (imported.includes(digest)) continue;
				const alreadyAppended = readFramesRelaxed<Record<string, unknown>>(route, candidate.kind, 0, 0).frames.some((frame) => createHash("sha256").update(JSON.stringify(frame.record)).digest("hex") === digest);
				if (alreadyAppended) {
					reconcileWriterCursor(route, state, candidate.kind); imported.push(digest);
					try { fs.unlinkSync(path.join(routeRoot(route), LEGACY_INFLIGHT)); } catch {}
				} else {
					durableWrite(path.join(routeRoot(route), LEGACY_INFLIGHT), `${JSON.stringify({ file: candidate.file, kind: candidate.kind, digest })}\n`);
					if (candidate.kind === "event") { state.eventSequence++; state.eventWriteOffset += appendJournal(route, candidate.kind, record, state.eventSequence); }
					else if (candidate.kind === "control") { state.controlSequence++; state.controlWriteOffset += appendJournal(route, candidate.kind, record, state.controlSequence); appendIndex(route, "control", record); }
					else { state.resultSequence++; state.resultWriteOffset += appendJournal(route, candidate.kind, record, state.resultSequence); appendIndex(route, "result", record); }
					imported.push(digest); try { fs.unlinkSync(path.join(routeRoot(route), LEGACY_INFLIGHT)); } catch {}
				}
				// Publish each record's fingerprint while complete remains false. A
				// restart can therefore resume without replaying an already durable record.
				manifest.files[candidate.file] = { hash: candidate.hash, records: [...imported] };
				writeState(route, state, candidate.kind);
				durableWrite(manifestPath(route), `${JSON.stringify(manifest)}\n`); journalFault("manifest", candidate.kind);
			}
			manifest.files[candidate.file] = { hash: candidate.hash, records: [...imported] };
			durableWrite(manifestPath(route), `${JSON.stringify(manifest)}\n`);
		}
		manifest.complete = true; manifest.directoryMtime = legacyDirectoryMtime(route); durableWrite(manifestPath(route), `${JSON.stringify(manifest)}\n`); legacyFingerprints.set(runtimeKey(route), manifest.directoryMtime);
	});
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	try {
		trustedDataFile(registryPath(route));
		const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf8")) as NestedRegistry;
		return { rootRunId: route.rootRunId, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0, children: Array.isArray(parsed.children) ? parsed.children.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child)) : [], processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.filter((item): item is string => typeof item === "string") : [] };
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] }; }
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory"); importLegacy(route);
	return withRouteLock(route, () => {
		const runtime = runtimeFor(route); let state = runtime.state; let registry = readNestedRegistry(route); let changed = false;
		// The reader cursor is independent from the writer sequence: an active
		// parent commonly polls while children append. This bounded pass starts at
		// the persisted byte offset and never enumerates or reparses old frames.
		const delta = readFramesRelaxed<NestedEventRecord>(route, "event", state.eventReadOffset, state.eventReadSequence);
		const frames = delta.frames;
		state.eventReadOffset = delta.end;
		if (frames.length) { state.eventSequence = Math.max(state.eventSequence, ...frames.map((frame) => frame.sequence)); state.eventReadSequence = frames[frames.length - 1]!.sequence; }
		state.eventWriteOffset = Math.max(state.eventWriteOffset, statSize(journalPath(route, "event")));
		for (const frame of frames) {
			const event = parseRecord(JSON.stringify(frame.record), route); if (!event) continue; registry = applyNestedEvent(registry, event); changed = true;
		}
		if (state.eventReadOffset !== state.eventWriteOffset) { state.eventWriteOffset = Math.max(state.eventWriteOffset, state.eventReadOffset); }
		if (changed) { registry = { ...registry, processedEvents: [] }; durableWrite(registryPath(route), `${JSON.stringify(registry)}\n`); }
		if (frames.length || state.eventReadOffset !== state.eventWriteOffset) writeState(route, state, "event");
		if (statSize(journalPath(route, "event")) >= compactionThreshold() && state.eventReadOffset === state.eventWriteOffset) compactJournal(route, state, registry, "event", runtime);
		return registry;
	});
}
function statSize(file: string): number { try { return fs.statSync(file).size; } catch { return 0; } }
function readFramesRelaxed<T>(route: NestedRoute, kind: "event" | "control" | "result", offset: number, expectedSequence = 0): { frames: Framed<T>[]; end: number } {
	const file = journalPath(route, kind); if (!fs.existsSync(file)) return { frames: [], end: 0 }; trustedDataFile(file); const stat = fs.statSync(file); if (offset > stat.size) throw new Error("journal cursor ahead");
	const fd = fs.openSync(file, "r"); const frames: Framed<T>[] = []; let position = offset; let previous = expectedSequence; let badAt: number | undefined;
	try {
		while (position < stat.size) {
			if (stat.size - position < JOURNAL_HEADER_BYTES) { badAt = position; break; }
			const h = Buffer.alloc(JOURNAL_HEADER_BYTES); fs.readSync(fd, h, 0, h.length, position); const length = h.readUInt32BE(20); const seq = Number(h.readBigUInt64BE(12)); const next = position + JOURNAL_HEADER_BYTES + length;
			if (!h.subarray(0, 8).equals(JOURNAL_MAGIC) || h.readUInt8(8) !== JOURNAL_VERSION || h.readUInt8(9) !== frameKind(kind) || !Number.isSafeInteger(seq) || seq <= previous || length > JOURNAL_MAX_BODY_BYTES || next > stat.size) { badAt = position; break; }
			const body = Buffer.alloc(length); fs.readSync(fd, body, 0, length, position + JOURNAL_HEADER_BYTES); if (!createHash("sha256").update(body).digest().equals(h.subarray(24, 56))) { badAt = position; break; }
			let record: T; try { record = JSON.parse(body.toString("utf8")) as T; } catch { badAt = position; break; }
			frames.push({ sequence: seq, record, nextOffset: next }); journalWork.frames++; journalWork.bytes += JOURNAL_HEADER_BYTES + length; previous = seq; position = next;
		}
	} finally { fs.closeSync(fd); }
	if (badAt !== undefined) {
		const tail = fs.readFileSync(file).subarray(badAt); if (tail.length) durableWrite(`${file}.torn.${Date.now()}-${randomUUID()}`, tail.toString("base64") + "\n");
		const truncate = fs.openSync(file, "r+"); try { fs.ftruncateSync(truncate, badAt); fs.fsyncSync(truncate); } finally { fs.closeSync(truncate); } fsyncDirectory(routeRoot(route)); position = badAt;
	}
	return { frames, end: position };
}
function reconcileWriterCursor(route: NestedRoute, state: JournalState, kind: "event" | "control" | "result"): void {
	const offsetKey = kind === "event" ? "eventWriteOffset" : kind === "control" ? "controlWriteOffset" : "resultWriteOffset";
	const sequenceKey = kind === "event" ? "eventSequence" : kind === "control" ? "controlSequence" : "resultSequence";
	const offset = state[offsetKey]; const size = statSize(journalPath(route, kind));
	if (size <= offset) return;
	const delta = readFramesRelaxed<Record<string, unknown>>(route, kind, offset, state[sequenceKey]);
	state[offsetKey] = delta.end; if (delta.frames.length) state[sequenceKey] = delta.frames[delta.frames.length - 1]!.sequence;
	const runtime = journalRuntimes.get(runtimeKey(route));
	for (const frame of delta.frames) {
		if (kind === "control") { const request = parseControlRequest(JSON.stringify(frame.record), route); if (request && runtime) { runtime.pending.set(request.requestId, request); appendIndex(route, "control", request); } }
		if (kind === "result") { const result = parseControlResult(JSON.stringify(frame.record), route); if (result && runtime) { runtime.results.set(result.requestId, result); appendIndex(route, "result", result); } }
	}
}
function compactJournal(route: NestedRoute, state: JournalState, snapshot: NestedRegistry | undefined, kind: "event" | "control" | "result", runtime: JournalRuntime): void {
	const file = journalPath(route, kind); if (!fs.existsSync(file) || statSize(file) === 0) return; trustedDataFile(file);
	const generation = state.generation + 1; const sealed = `${file}.sealed.${generation}`;
	const plan = path.join(routeRoot(route), COMPACTION_FILE);
	// The plan is the recovery authority. Until snapshot publication is durable,
	// a sealed generation is never discarded and can be merged back on restart.
	durableWrite(plan, `${JSON.stringify({ version: 1, kind, generation, file, sealed, phase: "planned" })}\n`); journalFault("seal", kind);
	if (!fs.existsSync(sealed)) { fs.renameSync(file, sealed); fsyncDirectory(routeRoot(route)); }
	journalFault("seal", kind);
	durableWrite(plan, `${JSON.stringify({ version: 1, kind, generation, file, sealed, phase: "sealed" })}\n`);
	ensureJournal(file); journalFault("new", kind);
	if (kind === "event" && snapshot) durableWrite(registryPath(route), `${JSON.stringify(snapshot)}\n`);
	if (kind === "control") durableWrite(indexPath(route, "control"), [...runtime.pending.values()].map((value) => JSON.stringify(value)).join("\n") + (runtime.pending.size ? "\n" : ""));
	if (kind === "result") durableWrite(indexPath(route, "result"), [...runtime.results.values()].map((value) => JSON.stringify(value)).join("\n") + (runtime.results.size ? "\n" : ""));
	journalFault("snapshot", kind);
	state.generation = generation;
	if (kind === "event") { state.eventReadOffset = 0; state.eventWriteOffset = 0; }
	if (kind === "control") { state.controlReadOffset = 0; state.controlWriteOffset = 0; }
	if (kind === "result") { state.resultReadOffset = 0; state.resultWriteOffset = 0; }
	writeState(route, state, kind); durableWrite(plan, `${JSON.stringify({ version: 1, kind, generation, file, sealed, phase: "published" })}\n`);
	journalFault("cleanup", kind);
	try { fs.unlinkSync(sealed); } catch { /* cleanup is retried by reconciliation */ }
	fsyncDirectory(routeRoot(route)); legacyFingerprints.set(runtimeKey(route), legacyDirectoryMtime(route)); try { fs.unlinkSync(plan); } catch { /* evidence remains for next recovery */ }
}
function reconcileCompaction(route: NestedRoute, runtime: JournalRuntime): void {
	const planFile = path.join(routeRoot(route), COMPACTION_FILE); if (!fs.existsSync(planFile)) return;
	trustedDataFile(planFile); let plan: { kind?: "event" | "control" | "result"; file?: string; sealed?: string; phase?: string };
	try { plan = JSON.parse(fs.readFileSync(planFile, "utf8")); } catch { throw new Error("Nested journal compaction plan is corrupt; refusing ambiguous recovery."); }
	if (!plan.kind || !plan.file || !plan.sealed || !containedPath(routeRoot(route), plan.file) || !containedPath(routeRoot(route), plan.sealed)) throw new Error("Nested journal compaction plan is unsafe.");
	if (plan.phase === "published" && fs.existsSync(plan.file)) { try { fs.unlinkSync(plan.sealed); } catch {} fs.unlinkSync(planFile); fsyncDirectory(routeRoot(route)); return; }
	// No published snapshot: restore the sealed bytes as the active prefix,
	// preserving the sealed file as immutable evidence until the next publish.
	if (fs.existsSync(plan.sealed)) {
		const active = fs.existsSync(plan.file) ? fs.readFileSync(plan.file) : Buffer.alloc(0);
		const merged = Buffer.concat([fs.readFileSync(plan.sealed), active]);
		const temp = `${plan.file}.${randomUUID()}.recovery`; const fd = fs.openSync(temp, "wx", 0o600); try { fs.writeFileSync(fd, merged); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, plan.file); fsyncDirectory(routeRoot(route));
	}
	try { fs.unlinkSync(planFile); } catch {}
}

export function writeNestedEvent(route: NestedRoute, event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory"); const record: NestedEventRecord = { ...event, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseRecord(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested event record failed validation.");
	withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; reconcileWriterCursor(route, state, "event"); state.eventSequence++; state.eventWriteOffset += appendJournal(route, "event", sanitized, state.eventSequence); writeState(route, state, "event"); });
}

export function writeNestedControlRequest(route: NestedRoute, request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">): string {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertSafeId("requestId", request.requestId); assertSafeId("targetRunId", request.targetRunId); const record: NestedControlRequestRecord = { type: "subagent.nested.control-request", ...request, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseControlRequest(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested control request failed validation.");
	return withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; reconcileWriterCursor(route, state, "control"); const existing = runtime.pending.get(sanitized.requestId); if (existing && JSON.stringify(existing) !== JSON.stringify(sanitized)) throw new Error("Conflicting nested control request for requestId."); if (!existing && !runtime.acked.has(sanitized.requestId)) { state.controlSequence++; const bytes = appendJournal(route, "control", sanitized, state.controlSequence); state.controlWriteOffset += bytes; runtime.pending.set(sanitized.requestId, sanitized); appendIndex(route, "control", sanitized); writeState(route, state, "control"); } const marker = path.join(route.controlInbox, `${sanitized.requestId}.compat`); let markerFd: number; try { markerFd = fs.openSync(marker, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return marker; } try { fs.writeFileSync(markerFd, "journal-request\\n", "utf8"); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); } fsyncDirectory(route.controlInbox); legacyFingerprints.set(runtimeKey(route), legacyDirectoryMtime(route)); return marker; });
}

export function readNestedControlRequests(route: NestedRoute): Array<NestedControlRequestRecord & { filePath: string }> {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); importLegacy(route);
	return withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; const delta = readFramesRelaxed<NestedControlRequestRecord>(route, "control", state.controlReadOffset, state.controlReadSequence); state.controlReadOffset = delta.end; if (delta.frames.length) state.controlReadSequence = delta.frames[delta.frames.length - 1]!.sequence; for (const frame of delta.frames) { const request = parseControlRequest(JSON.stringify(frame.record), route); if (request && !runtime.acked.has(request.requestId)) runtime.pending.set(request.requestId, request); } if (delta.frames.length) writeState(route, state, "control"); if (statSize(journalPath(route, "control")) >= compactionThreshold() && state.controlReadOffset === state.controlWriteOffset) compactJournal(route, state, undefined, "control", runtime); return [...runtime.pending.values()].filter((request) => !runtime.acked.has(request.requestId)).map((request) => ({ ...request, filePath: path.join(route.controlInbox, `${request.requestId}.compat`) })); });
}

export function writeNestedControlResult(route: NestedRoute, result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route); assertSafeId("requestId", result.requestId); assertSafeId("targetRunId", result.targetRunId); const record: NestedControlResultRecord = { type: "subagent.nested.control-result", ...result, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseControlResult(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested control result failed validation.");
	withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; reconcileWriterCursor(route, state, "result"); const prior = runtime.results.get(sanitized.requestId); if (prior) { if (JSON.stringify(prior) !== JSON.stringify(sanitized)) throw new Error("Conflicting nested control result for requestId."); return; } state.resultSequence++; state.resultWriteOffset += appendJournal(route, "result", sanitized, state.resultSequence); journalFault("append", "result"); runtime.results.set(sanitized.requestId, sanitized); appendIndex(route, "result", sanitized); writeState(route, state, "result"); if (statSize(journalPath(route, "result")) >= compactionThreshold() && state.resultReadOffset === state.resultWriteOffset) compactJournal(route, state, undefined, "result", runtime); });
}

/** Test-only durable event fixture seam: publishes a complete journal in one fsync batch. */
export function writeNestedEventJournalFixtureForTest(route: NestedRoute, events: Array<Omit<NestedEventRecord, "rootRunId" | "capabilityToken">>): void {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory");
	const records = events.map((event) => { const parsed = parseRecord(JSON.stringify({ ...event, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }), route); if (!parsed) throw new Error("Invalid event fixture record."); return parsed; });
	withRouteLock(route, () => {
		const runtime = runtimeFor(route); const state = runtime.state; const file = journalPath(route, "event"); ensureJournal(file); const fd = fs.openSync(file, "a", 0o600); let offset = statSize(file); let sequence = state.eventSequence;
		try { for (const record of records) { sequence++; const frame = makeFrame("event", sequence, record); fs.writeFileSync(fd, frame); offset += frame.length; } if (typeof fs.fdatasyncSync === "function") fs.fdatasyncSync(fd); else fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fsyncDirectory(routeRoot(route)); state.eventSequence = sequence; state.eventWriteOffset = offset; writeState(route, state, "event");
	});
}

/** Test-only durable fixture seam: publishes a complete control/result journal
 * in one fsync batch so durability-reader benchmarks do not spend minutes
 * constructing historical evidence through individual production writes. */
export function writeNestedJournalFixtureForTest(route: NestedRoute, count: number): void {
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("Fixture count must be a non-negative safe integer.");
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertTrustedRouteEntry(route.eventSink, "directory");
	withRouteLock(route, () => {
		const runtime = runtimeFor(route); const state = runtime.state;
		const requests = Array.from({ length: count }, (_, index) => ({ type: "subagent.nested.control-request" as const, ts: index, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken, requestId: `request-${index}`, targetRunId: "nested-child", action: "interrupt" as const }));
		const results = requests.map((request) => ({ type: "subagent.nested.control-result" as const, ts: request.ts, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken, requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "done" }));
		const batch = (kind: "control" | "result", records: object[]): { offset: number; sequence: number } => {
			const file = journalPath(route, kind); ensureJournal(file); const fd = fs.openSync(file, "a", 0o600); let offset = statSize(file); let sequence = kind === "control" ? state.controlSequence : state.resultSequence;
			try { for (const record of records) { sequence++; const frame = makeFrame(kind, sequence, record); fs.writeFileSync(fd, frame); offset += frame.length; } if (typeof fs.fdatasyncSync === "function") fs.fdatasyncSync(fd); else fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDirectory(routeRoot(route)); return { offset, sequence };
		};
		const control = batch("control", requests); const result = batch("result", results);
		for (const request of requests) runtime.pending.set(request.requestId, request);
		for (const value of results) { const parsed = parseControlResult(JSON.stringify(value), route); if (parsed) runtime.results.set(parsed.requestId, parsed); }
		const acked = requests.map((request) => request.requestId); durableWrite(ackPath(route), acked.map((id) => `${id}\n`).join("")); runtime.acked = new Set(acked);
		durableWrite(indexPath(route, "control"), requests.map((value) => `${JSON.stringify(value)}\n`).join("")); durableWrite(indexPath(route, "result"), results.map((value) => `${JSON.stringify(value)}\n`).join(""));
		state.controlSequence = control.sequence; state.controlWriteOffset = control.offset; state.controlReadOffset = control.offset; state.controlReadSequence = control.sequence; state.resultSequence = result.sequence; state.resultWriteOffset = result.offset; state.resultReadOffset = 0; state.resultReadSequence = 0; state.ackedRequests = acked; writeState(route, state, "result");
	});
}

/** Claim the side-effect window durably. A restart seeing a claim without a
 * result must fail closed rather than execute the side effect a second time. */
export function claimNestedControlRequest(route: NestedRoute, requestId: string): "new" | "claimed" | "completed" {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertSafeId("requestId", requestId);
	return withRouteLock(route, () => { const runtime = runtimeFor(route); if (runtime.results.has(requestId)) return "completed"; if (runtime.claimed.has(requestId)) return "claimed"; runtime.claimed.add(requestId); appendExecution(route, requestId); return "new"; });
}

/** Return the exact durable result for a request. This deliberately consults
 * the journal-reconciled runtime rather than reparsing legacy request files. */
export function readNestedControlResult(route: NestedRoute, requestId: string): NestedControlResultRecord | undefined {
	validateRouteShape(route); assertSafeId("requestId", requestId);
	return withRouteLock(route, () => runtimeFor(route).results.get(requestId));
}

/** A result must be durable before a request is acknowledged. */
export function ackNestedControlRequest(route: NestedRoute, requestId: string, legacyFilePath?: string): void {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertSafeId("requestId", requestId); withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; const request = runtime.pending.get(requestId); const result = runtime.results.get(requestId); if (!request) { if (runtime.acked.has(requestId)) return; throw new Error(`Cannot acknowledge unknown nested control request '${requestId}'.`); } if (!result || result.targetRunId !== request.targetRunId) throw new Error(`Cannot acknowledge nested control request '${requestId}' before a durable matching result.`); runtime.acked.add(requestId); appendAck(route, requestId); runtime.pending.delete(requestId); writeState(route, state, "control"); /* Legacy request files remain immutable evidence. */ });
}

export function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[] {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory"); importLegacy(route);
	return withRouteLock(route, () => { const runtime = runtimeFor(route); const state = runtime.state; const delta = readFramesRelaxed<NestedControlResultRecord>(route, "result", state.resultReadOffset, state.resultReadSequence); state.resultReadOffset = delta.end; if (delta.frames.length) { state.resultReadSequence = delta.frames[delta.frames.length - 1]!.sequence; for (const frame of delta.frames) { const result = parseControlResult(JSON.stringify(frame.record), route); if (result) runtime.results.set(result.requestId, result); } writeState(route, state, "result"); } if (statSize(journalPath(route, "result")) >= compactionThreshold() && state.resultReadOffset === state.resultWriteOffset) compactJournal(route, state, undefined, "result", runtime); return [...runtime.results.values()]; });
}

export function nestedRouteEnv(route: NestedRoute): Record<string, string> {
	return {
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
	};
}

export function attachRootChildrenToSteps<T extends { children?: NestedRunSummary[]; index?: number }>(rootRunId: string, steps: T[] | undefined, children: NestedRunSummary[] | undefined): void {
	if (!steps?.length) return;
	for (const step of steps) {
		step.children = undefined;
	}
	if (!children?.length) return;
	for (const child of children) {
		if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
		const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
		if (!step) continue;
		step.children ??= [];
		step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(0, MAX_CHILDREN);
	}
}

export function updateAsyncJobNestedProjection(job: AsyncJobState): void {
	if (!job.nestedRoute) return;
	const registry = projectNestedEvents(job.nestedRoute);
	job.nestedChildren = mergeNestedRunSnapshots(job.nestedChildren, registry.children);
	attachRootChildrenToSteps(job.asyncId, job.steps, job.nestedChildren);
}

export function updateForegroundNestedProjection(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): void {
	if (!control.nestedRoute) {
		control.nestedRouteValidity = control.nestedRouteRequired ? "unavailable" : "legacy";
		control.nestedRouteError = control.nestedRouteRequired ? "Persisted nested route metadata is required but unavailable." : undefined;
		return;
	}
	const resolution = resolveNestedRoute(control.runId, control.nestedRoute, { routeRequired: control.nestedRouteRequired === true });
	control.nestedRouteValidity = resolution.validity;
	control.nestedRouteError = resolution.error;
	if (!resolution.route) return;
	try {
		const registry = projectNestedEvents(resolution.route);
		control.nestedChildren = mergeNestedRunSnapshots(control.nestedChildren, registry.children);
	} catch (error) {
		// Keep the last persisted children visible, but retain the failed read as
		// explicit evidence so overlays never fall back to ambient lookup.
		control.nestedRouteValidity = "unavailable";
		control.nestedRouteError = error instanceof Error ? error.message : String(error);
	}
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
	if (!children?.length) return false;
	for (const child of children) {
		if (!terminal(child.state, child.teardownUnproven)) return true;
		if (child.steps?.some((step) => step.teardownUnproven === true)) return true;
		if (hasLiveNestedDescendants(child.children)) return true;
		if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}

export function selectNestedChildrenForParent(
	children: NestedRunSummary[] | undefined,
	parentRunId: string,
	parentStepIndex?: number,
): NestedRunSummary[] {
	if (!children?.length) return [];
	const matches: NestedRunSummary[] = [];
	const walk = (items: NestedRunSummary[] | undefined): void => {
		for (const child of items ?? []) {
			if (child.parentRunId === parentRunId && (parentStepIndex === undefined || child.parentStepIndex === parentStepIndex)) {
				matches.push(child);
			}
			walk(child.children);
			walk(child.steps?.flatMap((step) => step.children ?? []));
		}
	};
	walk(children);
	return matches;
}

export function hasLiveNestedDescendantsForParent(
	children: NestedRunSummary[] | undefined,
	parentRunId: string,
	parentStepIndex?: number,
): boolean {
	return hasLiveNestedDescendants(selectNestedChildrenForParent(children, parentRunId, parentStepIndex));
}

/**
 * Fence terminal parent cleanup/export on the nested route's terminal events.
 * Activity snapshots are useful for UI, but are not proof that a descendant has
 * stopped. This deliberately waits for the descendant projection to become
 * terminal before callers remove a runtime-managed checkout.
 */
export async function waitForNestedDescendantsToStop(
	route: NestedRouteInfo | undefined,
	parentRunId: string,
	parentStepIndex?: number,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ observed: boolean; stopped: boolean }> {
	// No route means no nested authority was issued, so absence is itself a
	// proven terminal state. When a route exists, one successful projection is
	// observation even if every descendant was already terminal on first poll.
	if (!route) return { observed: true, stopped: true };
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs !== undefined && options.timeoutMs >= 0 ? options.timeoutMs : 30_000;
	const pollMs = Number.isFinite(options.pollMs) && options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 25;
	const deadline = Date.now() + timeoutMs;
	let observed = false;
	while (true) {
		let live = false;
		try {
			const registry = projectNestedEvents(route);
			observed = true;
			live = hasLiveNestedDescendantsForParent(registry.children, parentRunId, parentStepIndex);
		} catch {
			// A malformed or unavailable route cannot prove termination. Keep the
			// fence active until its bounded deadline rather than exporting early.
			live = true;
		}
		if (live) observed = true;
		else return { observed, stopped: true };
		if (Date.now() >= deadline) return { observed, stopped: false };
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

export function nestedSummaryFromAsyncStatus(status: AsyncStatus, asyncDir: string, fallback: { id: string; parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }>; mode?: SubagentRunMode; ts: number }): NestedRunSummary {
	const activeStep = status.currentStep !== undefined ? status.steps?.[status.currentStep] : undefined;
	const modelStep = activeStep?.model ? activeStep : status.steps?.find((step) => step.model);
	const model = modelStep?.model;
	const thinking = modelStep?.thinking;
	return {
		id: status.runId || fallback.id,
		parentRunId: fallback.parentRunId,
		...(fallback.parentStepIndex !== undefined ? { parentStepIndex: fallback.parentStepIndex } : {}),
		depth: fallback.depth,
		path: fallback.path ?? [{ runId: fallback.parentRunId, ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}) }],
		asyncDir,
		...(status.cwd ? { cwd: status.cwd } : {}),
		...(status.pid ? { pid: status.pid } : {}),
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		mode: status.mode ?? fallback.mode,
		state: status.state,
		...(status.steps?.length ? { agents: status.steps.map((step) => step.agent).slice(0, MAX_STEPS) } : {}),
		...(sanitizeParallelGroups(status.parallelGroups, status.steps?.length ?? MAX_STEPS, status.chainStepCount ?? MAX_STEPS) ? { parallelGroups: sanitizeParallelGroups(status.parallelGroups, status.steps?.length ?? MAX_STEPS, status.chainStepCount ?? MAX_STEPS) } : {}),
		...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(status.activityState ? { activityState: status.activityState } : {}),
		...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
		...(status.currentTool ? { currentTool: status.currentTool } : {}),
		...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
		...(status.currentPath ? { currentPath: status.currentPath } : {}),
		...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
		...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.startedAt !== undefined ? { startedAt: status.startedAt } : { startedAt: fallback.ts }),
		...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
		...(status.error ? { error: status.error } : {}),
		...(status.finalOutput !== undefined ? { finalOutput: status.finalOutput.slice(0, 4096) } : {}),
		lastUpdate: status.lastUpdate ?? fallback.ts,
		...(status.teardownUnproven ? { teardownUnproven: true } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
		...(sanitizeGroupDiagnostics(status.groupDiagnostics) ? { groupDiagnostics: sanitizeGroupDiagnostics(status.groupDiagnostics) } : {}),
		...(status.steps?.length ? { steps: status.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.activityState ? { activityState: step.activityState } : {}),
			...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.fastMode ? { fastMode: step.fastMode } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
			...(step.tokens ? { totalTokens: step.tokens } : {}),
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
			...(step.error ? { error: step.error } : {}),
			...(step.finalOutput !== undefined ? { finalOutput: step.finalOutput.slice(0, 4096) } : {}),
			...(step.gitBundle ? { gitBundle: step.gitBundle } : {}),
			...(step.teardownUnproven ? { teardownUnproven: true } : {}),
		})).slice(0, MAX_STEPS) } : {}),
	};
}

export function nestedArtifactEnv(rootRunId: string, parentRunId: string): Record<string, string> {
	return {
		PI_SUBAGENT_NESTED_ROOT_RUN_ID: rootRunId,
		PI_SUBAGENT_NESTED_PARENT_RUN_ID: parentRunId,
	};
}

export function isTopLevelAsyncDir(asyncDir: string): boolean {
	const resolved = path.resolve(asyncDir);
	return containedPath(ASYNC_DIR, resolved) && !containedPath(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), resolved);
}

export function nestedResultsPath(rootRunId: string, id: string): string {
	assertSafeId("rootRunId", rootRunId);
	assertSafeId("id", id);
	return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
