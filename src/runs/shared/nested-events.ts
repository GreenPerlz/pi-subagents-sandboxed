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

export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	try {
		return resolveNestedRouteFromEnv(env);
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
	// A detached acknowledgement is an update, not terminal truth. The owning
	// process emits a later completed event after its process and descendants stop.
	// Never coerce a running acknowledgement into a terminal state here: doing so
	// makes the stop fence trust an acknowledgement while the child is still live.
	const incomingSteps = event.child.steps?.map((step, index) => {
		const previous = existing?.steps?.[index] ?? existing?.steps?.find((candidate) => candidate.agent === step.agent);
		return previous?.teardownUnproven ? { ...step, teardownUnproven: true } : step;
	});
	const incoming = {
		...event.child,
		...(incomingSteps ? { steps: incomingSteps } : {}),
		...(existing?.teardownUnproven || event.child.teardownUnproven ? { teardownUnproven: true } : {}),
		lastUpdate: event.child.lastUpdate ?? event.ts,
	};
	if (!existing) return incoming;
	const existingUpdate = existing.lastUpdate ?? 0;
	const incomingUpdate = incoming.lastUpdate ?? event.ts;
	if (incomingUpdate < existingUpdate) return existing;
	// An explicit teardown failure is a newer nonterminal truth even if an older
	// terminal event was already projected. Never let that terminal snapshot win.
	if (incoming.teardownUnproven) return { ...existing, ...incoming, lastUpdate: Math.max(existingUpdate, incomingUpdate) };
	if (terminal(existing.state, existing.teardownUnproven) && !terminal(incoming.state, incoming.teardownUnproven)) return existing;
	if (terminal(existing.state, existing.teardownUnproven) && terminal(incoming.state, incoming.teardownUnproven) && incomingUpdate === existingUpdate) return existing;
	return { ...existing, ...incoming, state: incoming.state, lastUpdate: Math.max(existingUpdate, incomingUpdate) };
}

function attachChild(children: NestedRunSummary[], event: NestedEventRecord): NestedRunSummary[] {
	let updated = false;
	const walk = (items: NestedRunSummary[]): NestedRunSummary[] => items.map((item) => {
		if (item.id === event.parentRunId) {
			const existingChildren = item.children ?? [];
			const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
			const nextChild = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
			const nextChildren = childIndex >= 0
				? existingChildren.map((child, index) => index === childIndex ? nextChild : child)
				: [...existingChildren, nextChild];
			updated = true;
			return { ...item, children: nextChildren.slice(0, MAX_CHILDREN), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
		}
		if (!item.children?.length) return item;
		const nextChildren = walk(item.children);
		return nextChildren === item.children ? item : { ...item, children: nextChildren };
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
		const pending: Record<string, NestedControlRequestRecord> = {};
		if (raw.pendingRequests && typeof raw.pendingRequests === "object") for (const [id, value] of Object.entries(raw.pendingRequests as Record<string, unknown>)) {
			const request = parseControlRequest(JSON.stringify(value), route); if (request) pending[id] = request;
		}
		const results: Record<string, NestedControlResultRecord> = {};
		if (raw.results && typeof raw.results === "object") for (const [id, value] of Object.entries(raw.results as Record<string, unknown>)) {
			const result = parseControlResult(JSON.stringify(value), route); if (result) results[id] = result;
		}
		return {
			version: 1, generation: number("generation"), eventReadOffset: number("eventReadOffset"), eventWriteOffset: number("eventWriteOffset"), eventSequence: number("eventSequence"), eventReadSequence: number("eventReadSequence"),
			controlReadOffset: number("controlReadOffset"), controlWriteOffset: number("controlWriteOffset"), controlSequence: number("controlSequence"), controlReadSequence: number("controlReadSequence"),
			resultReadOffset: number("resultReadOffset"), resultWriteOffset: number("resultWriteOffset"), resultSequence: number("resultSequence"), resultReadSequence: number("resultReadSequence"),
			pendingRequests: pending,
			ackedRequests: Array.isArray(raw.ackedRequests) ? raw.ackedRequests.filter((v): v is string => isSafeNestedId(v)).slice(-4096) : [],
			results,
			deliveredResults: Array.isArray(raw.deliveredResults) ? raw.deliveredResults.filter((v): v is string => isSafeNestedId(v)).slice(-4096) : [],
		};
	} catch (error) { throw new Error(`Nested journal state is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}
function writeState(route: NestedRoute, state: JournalState): void { durableWrite(statePath(route), `${JSON.stringify(state)}\n`); }

function linuxStartToken(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		return fields[19]; // field 22, after pid and comm
	} catch { return undefined; }
}
function withRouteLock<T>(route: NestedRoute, fn: () => T): T {
	const lock = path.join(routeRoot(route), ROUTE_LOCK);
	const identity = { pid: process.pid, uid: typeof process.getuid === "function" ? process.getuid() : 0, startToken: linuxStartToken(process.pid) ?? `${process.pid}-${process.ppid}` };
	for (;;) {
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			try { fs.writeFileSync(path.join(lock, "owner"), `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 }); } catch { fs.rmSync(lock, { recursive: true, force: true }); throw new Error("Unable to publish nested route lock identity."); }
			try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); fsyncDirectory(routeRoot(route)); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const st = fs.lstatSync(lock); if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error("Nested route lock is not trusted.");
				const ownerFile = path.join(lock, "owner");
				const ownerStat = fs.lstatSync(ownerFile);
				if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || (ownerStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && ownerStat.uid !== process.getuid())) throw new Error("Nested route lock owner is not trusted.");
				const raw = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { pid?: unknown; uid?: unknown; startToken?: unknown };
				if (typeof raw.pid !== "number" || typeof raw.uid !== "number" || typeof raw.startToken !== "string") throw new Error("Nested route lock identity is ambiguous.");
				if (raw.uid !== identity.uid) throw new Error("Nested route lock belongs to another user.");
				stale = linuxStartToken(raw.pid) !== raw.startToken;
			} catch (lockError) { throw lockError instanceof Error ? lockError : new Error(String(lockError)); }
			if (!stale) throw new Error("Nested route is busy.");
			fs.rmSync(lock, { recursive: true, force: false });
		}
	}
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
function importLegacy(route: NestedRoute): void {
	if (fs.existsSync(manifestPath(route))) { trustedDataFile(manifestPath(route)); return; }
	withRouteLock(route, () => {
		if (fs.existsSync(manifestPath(route))) return;
		let state = readState(route);
		for (const [kind, records] of [["event", legacyRecords(route, "event")], ["control", legacyRecords(route, "control")], ["result", legacyRecords(route, "result")]] as const) {
			for (const record of records) {
				if (kind === "event") { state.eventSequence++; state.eventWriteOffset += appendJournal(route, kind, record, state.eventSequence); }
				else if (kind === "control") { state.controlSequence++; state.controlWriteOffset += appendJournal(route, kind, record, state.controlSequence); }
				else { state.resultSequence++; state.resultWriteOffset += appendJournal(route, kind, record, state.resultSequence); }
			}
		}
		writeState(route, state); durableWrite(manifestPath(route), `${JSON.stringify({ version: 1, importedAt: Date.now(), legacyFilesUntouched: true })}\n`);
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
		let state = readState(route); let registry = readNestedRegistry(route); let changed = false;
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
		writeState(route, state);
		if (statSize(journalPath(route, "event")) >= COMPACTION_BYTES && state.eventReadOffset === state.eventWriteOffset) compactEvents(route, state, registry);
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
			frames.push({ sequence: seq, record, nextOffset: next }); previous = seq; position = next;
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
	for (const frame of delta.frames) {
		if (kind === "control") { const request = parseControlRequest(JSON.stringify(frame.record), route); if (request) state.pendingRequests[request.requestId] = request; }
		if (kind === "result") { const result = parseControlResult(JSON.stringify(frame.record), route); if (result) state.results[result.requestId] ??= result; }
	}
}
function compactEvents(route: NestedRoute, state: JournalState, registry: NestedRegistry): void {
	const file = journalPath(route, "event"); if (!fs.existsSync(file)) return; trustedDataFile(file);
	const sealed = `${file}.sealed.${state.generation + 1}`; fs.renameSync(file, sealed); fsyncDirectory(routeRoot(route)); ensureJournal(file);
	state.generation++; state.eventReadOffset = 0; state.eventWriteOffset = 0; writeState(route, state); fsyncDirectory(routeRoot(route));
}

export function writeNestedEvent(route: NestedRoute, event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory"); const record: NestedEventRecord = { ...event, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseRecord(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested event record failed validation.");
	withRouteLock(route, () => { const state = readState(route); reconcileWriterCursor(route, state, "event"); state.eventSequence++; state.eventWriteOffset += appendJournal(route, "event", sanitized, state.eventSequence); writeState(route, state); });
}

export function writeNestedControlRequest(route: NestedRoute, request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">): string {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertSafeId("requestId", request.requestId); assertSafeId("targetRunId", request.targetRunId); const record: NestedControlRequestRecord = { type: "subagent.nested.control-request", ...request, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseControlRequest(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested control request failed validation.");
	return withRouteLock(route, () => { const state = readState(route); reconcileWriterCursor(route, state, "control"); const existing = state.pendingRequests[sanitized.requestId]; if (existing && JSON.stringify(existing) !== JSON.stringify(sanitized)) throw new Error("Conflicting nested control request for requestId."); if (!existing && !state.ackedRequests.includes(sanitized.requestId)) { state.controlSequence++; const bytes = appendJournal(route, "control", sanitized, state.controlSequence); state.controlWriteOffset += bytes; state.pendingRequests[sanitized.requestId] = sanitized; writeState(route, state); } const marker = path.join(route.controlInbox, `${sanitized.requestId}.compat`); let markerFd: number; try { markerFd = fs.openSync(marker, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return marker; } try { fs.writeFileSync(markerFd, "journal-request\\n", "utf8"); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); } fsyncDirectory(route.controlInbox); return marker; });
}

export function readNestedControlRequests(route: NestedRoute): Array<NestedControlRequestRecord & { filePath: string }> {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); importLegacy(route);
	return withRouteLock(route, () => { const state = readState(route); const delta = readFramesRelaxed<NestedControlRequestRecord>(route, "control", state.controlReadOffset, state.controlReadSequence); state.controlReadOffset = delta.end; if (delta.frames.length) state.controlReadSequence = delta.frames[delta.frames.length - 1]!.sequence; for (const frame of delta.frames) { const request = parseControlRequest(JSON.stringify(frame.record), route); if (request && !state.ackedRequests.includes(request.requestId)) state.pendingRequests[request.requestId] = request; } writeState(route, state); return Object.values(state.pendingRequests).filter((request) => !state.ackedRequests.includes(request.requestId)).sort((a, b) => a.ts - b.ts).map((request) => ({ ...request, filePath: path.join(route.controlInbox, `${request.requestId}.compat`) })); });
}

export function writeNestedControlResult(route: NestedRoute, result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">): void {
	validateRouteShape(route); assertSafeId("requestId", result.requestId); assertSafeId("targetRunId", result.targetRunId); const record: NestedControlResultRecord = { type: "subagent.nested.control-result", ...result, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken }; const sanitized = parseControlResult(JSON.stringify(record), route); if (!sanitized) throw new Error("Nested control result failed validation.");
	withRouteLock(route, () => { const state = readState(route); reconcileWriterCursor(route, state, "result"); const prior = state.results[sanitized.requestId]; if (prior) { if (JSON.stringify(prior) !== JSON.stringify(sanitized)) throw new Error("Conflicting nested control result for requestId."); return; } state.resultSequence++; state.resultWriteOffset += appendJournal(route, "result", sanitized, state.resultSequence); state.results[sanitized.requestId] = sanitized; writeState(route, state); });
}

/** A result must be durable before a request is acknowledged. */
export function ackNestedControlRequest(route: NestedRoute, requestId: string, legacyFilePath?: string): void {
	validateRouteShape(route); assertTrustedRouteEntry(route.controlInbox, "directory"); assertSafeId("requestId", requestId); withRouteLock(route, () => { const state = readState(route); if (!state.ackedRequests.includes(requestId)) state.ackedRequests.push(requestId); delete state.pendingRequests[requestId]; state.ackedRequests = state.ackedRequests.slice(-4096); writeState(route, state); if (legacyFilePath && path.basename(legacyFilePath) !== CONTROL_JOURNAL && containedPath(route.controlInbox, legacyFilePath)) { try { const stat = fs.lstatSync(legacyFilePath); if (stat.isFile()) fs.unlinkSync(legacyFilePath); } catch { /* evidence may already have been removed */ } } });
}

export function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[] {
	validateRouteShape(route); assertTrustedRouteEntry(route.eventSink, "directory"); importLegacy(route);
	return withRouteLock(route, () => { const state = readState(route); const delta = readFramesRelaxed<NestedControlResultRecord>(route, "result", state.resultReadOffset, state.resultReadSequence); state.resultReadOffset = delta.end; if (delta.frames.length) state.resultReadSequence = delta.frames[delta.frames.length - 1]!.sequence; for (const frame of delta.frames) { const result = parseControlResult(JSON.stringify(frame.record), route); if (result) state.results[result.requestId] ??= result; } writeState(route, state); return Object.values(state.results); });
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
	job.nestedChildren = registry.children;
	attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}

export function updateForegroundNestedProjection(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): void {
	if (!control.nestedRoute) return;
	const registry = projectNestedEvents(control.nestedRoute);
	control.nestedChildren = registry.children;
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
		lastUpdate: status.lastUpdate ?? fallback.ts,
		...(status.teardownUnproven ? { teardownUnproven: true } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
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
