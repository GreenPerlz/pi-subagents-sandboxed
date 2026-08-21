import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { resolveAggregateState } from "../shared/aggregate-state.ts";
import {
	type Details,
	type IntercomEventBus,
	type NestedRunSummary,
	type PublicNestedRunSummary,
	type SingleResult,
	type SubagentResultIntercomChild,
	type SubagentResultIntercomPayload,
	type SubagentResultStatus,
	type SubagentRunMode,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../shared/types.ts";

export function resolveSubagentResultStatus(input: {
	exitCode?: number;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	cancelled?: boolean;
	detached?: boolean;
	teardownUnproven?: boolean;
}): SubagentResultStatus {
	const state = resolveAggregateState([
		{ state: input.state ?? (input.teardownUnproven ? "running" : input.detached ? "detached" : input.cancelled ? "cancelled" : input.interrupted ? "paused" : typeof input.success === "boolean" ? input.success ? "complete" : "failed" : typeof input.exitCode === "number" ? input.exitCode === 0 ? "complete" : "failed" : "failed"), teardownUnproven: input.teardownUnproven },
		...(input.detached ? [{ state: "detached" }] : []),
		...(input.cancelled ? [{ state: "cancelled" }] : []),
		...(input.interrupted ? [{ state: "paused" }] : []),
	]);
	if (state === "running") return "detached";
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	if (state === "paused") return "paused";
	if (state === "completed") return "completed";
	return "failed";
}

function countStatuses(children: SubagentResultIntercomChild[]): Record<SubagentResultStatus, number> {
	const counts: Record<SubagentResultStatus, number> = {
		completed: 0,
		failed: 0,
		paused: 0,
		cancelled: 0,
		detached: 0,
	};
	for (const child of children) {
		counts[child.status] += 1;
	}
	return counts;
}

function formatStatusCounts(counts: Record<SubagentResultStatus, number>): string {
	const parts = [
		counts.completed ? `${counts.completed} completed` : undefined,
		counts.failed ? `${counts.failed} failed` : undefined,
		counts.paused ? `${counts.paused} paused` : undefined,
		counts.cancelled ? `${counts.cancelled} cancelled` : undefined,
		counts.detached ? `${counts.detached} detached` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(children: SubagentResultIntercomChild[]): SubagentResultStatus {
	const state = resolveAggregateState(children.map((child) => ({ state: child.status, teardownUnproven: child.teardownUnproven })));
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	if (state === "paused") return "paused";
	if (state === "completed") return "completed";
	if (state === "running") return "detached";
	return "failed";
}

function compactNestedRun(run: NestedRunSummary | PublicNestedRunSummary, depth = 0): PublicNestedRunSummary {
	return {
		id: run.id,
		parentRunId: run.parentRunId,
		...(run.parentStepIndex !== undefined ? { parentStepIndex: run.parentStepIndex } : {}),
		...(run.parentAgent ? { parentAgent: run.parentAgent } : {}),
		depth: run.depth,
		path: run.path.slice(0, 4).map((part) => ({
			runId: part.runId,
			...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
			...(part.agent ? { agent: part.agent } : {}),
		})),
		...(run.asyncDir ? { asyncDir: run.asyncDir } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
		...(run.intercomTarget ? { intercomTarget: run.intercomTarget } : {}),
		...(run.ownerIntercomTarget ? { ownerIntercomTarget: run.ownerIntercomTarget } : {}),
		...(run.leafIntercomTarget ? { leafIntercomTarget: run.leafIntercomTarget } : {}),
		...(run.ownerState ? { ownerState: run.ownerState } : {}),
		...(run.mode ? { mode: run.mode } : {}),
		state: run.state,
		...(run.agent ? { agent: run.agent } : {}),
		...(run.agents?.length ? { agents: run.agents.slice(0, 12) } : {}),
		...(run.currentStep !== undefined ? { currentStep: run.currentStep } : {}),
		...(run.chainStepCount !== undefined ? { chainStepCount: run.chainStepCount } : {}),
		...(run.parallelGroups?.length ? { parallelGroups: run.parallelGroups.slice(0, 8) } : {}),
		...(run.activityState ? { activityState: run.activityState } : {}),
		...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
		...(run.currentTool ? { currentTool: run.currentTool } : {}),
		...(run.currentToolStartedAt !== undefined ? { currentToolStartedAt: run.currentToolStartedAt } : {}),
		...(run.currentPath ? { currentPath: run.currentPath } : {}),
		...(run.turnCount !== undefined ? { turnCount: run.turnCount } : {}),
		...(run.toolCount !== undefined ? { toolCount: run.toolCount } : {}),
		...(run.model ? { model: run.model } : {}),
		...(run.totalTokens ? { totalTokens: run.totalTokens } : {}),
		...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		...(run.lastUpdate !== undefined ? { lastUpdate: run.lastUpdate } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.teardownUnproven ? { teardownUnproven: true } : {}),
		...(run.steps?.length ? { steps: run.steps.slice(0, 12).map((step) => ({
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
			...(step.totalTokens ? { totalTokens: step.totalTokens } : {}),
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
			...(step.error ? { error: step.error } : {}),
			...(depth < 2 && step.children?.length ? { children: step.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) } : {}),
		})) } : {}),
		...(depth < 2 && run.children?.length ? { children: run.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) } : {}),
	};
}

export function compactNestedResultChildren(children: Array<NestedRunSummary | PublicNestedRunSummary> | undefined): PublicNestedRunSummary[] | undefined {
	if (!children?.length) return undefined;
	return children.slice(0, 16).map((child) => compactNestedRun(child));
}

export function attachNestedChildrenToResultChildren(
	runId: string,
	children: SubagentResultIntercomChild[],
	nestedChildren: NestedRunSummary[] | undefined,
): SubagentResultIntercomChild[] {
	const compact = compactNestedResultChildren(nestedChildren);
	if (!compact?.length) return children.map((child) => ({ ...child, children: compactNestedResultChildren(child.children) }));
	// Group diagnostics are records, not materialized children. Resolve fallback
	// positions from the canonical flat child sequence so an unindexed diagnostic
	// can never shift every later nested attachment by one slot.
	const isDiagnostic = (child: SubagentResultIntercomChild): boolean => Boolean(child.groupId || child.unindexed);
	const claimedIndexes = new Set(children.filter((child) => !isDiagnostic(child) && child.index !== undefined).map((child) => child.index!));
	let nextCanonicalIndex = 0;
	const resolveCanonicalIndex = (child: SubagentResultIntercomChild): number | undefined => {
		if (isDiagnostic(child)) return undefined;
		if (child.index !== undefined) return child.index;
		while (claimedIndexes.has(nextCanonicalIndex)) nextCanonicalIndex++;
		const resolved = nextCanonicalIndex++;
		claimedIndexes.add(resolved);
		return resolved;
	};
	return children.map((child) => {
		const childIndex = resolveCanonicalIndex(child);
		if (childIndex === undefined) return { ...child, children: compactNestedResultChildren(child.children) };
		const alreadyAttachedIds = new Set(child.children?.map((nested) => nested.id) ?? []);
		const attached = compact.filter((nested) => nested.parentRunId === runId && nested.parentStepIndex === childIndex && !alreadyAttachedIds.has(nested.id));
		const fallbackAttached = children.length === 1
			? compact.filter((nested) => nested.parentRunId === runId && nested.parentStepIndex === undefined && !alreadyAttachedIds.has(nested.id))
			: [];
		const merged = compactNestedResultChildren([...(child.children ?? []), ...attached, ...fallbackAttached]);
		return merged?.length ? { ...child, children: merged } : { ...child, children: undefined };
	});
}

function formatNestedResultLines(children: PublicNestedRunSummary[] | undefined): string[] {
	if (!children?.length) return [];
	const lines = ["Nested subagents:"];
	let remaining = 10;
	const append = (runs: PublicNestedRunSummary[] | undefined, indent: string): void => {
		for (const run of runs ?? []) {
			if (remaining <= 0) {
				lines.push(`${indent}↳ +more nested runs; inspect status for full tree`);
				return;
			}
			remaining--;
			const label = run.agent ?? run.agents?.join("+") ?? run.id;
			lines.push(`${indent}↳ ${label} — ${run.state} [${run.id}]`);
			if (run.sessionFile) lines.push(`${indent}  Session: ${run.sessionFile}`);
			append(run.children, `${indent}  `);
			for (const step of run.steps ?? []) append(step.children, `${indent}    `);
		}
	};
	append(children, "");
	return lines;
}

interface GroupedResultIntercomMessageInput {
	to: string;
	runId: string;
	mode: SubagentRunMode;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	/** Top-level async lifecycle failure; do not derive success from child results. */
	worktreeExecutionError?: string;
	chainSteps?: number;
}

function asyncResumeGuidance(input: {
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
}): string | undefined {
	if (input.source !== "async" || !input.asyncId) return undefined;
	const resumable = input.children.filter((child) => typeof child.sessionPath === "string" && fs.existsSync(child.sessionPath));
	if (input.children.length === 1 && resumable.length === 1) {
		return `Revive: subagent({ action: "resume", id: "${input.asyncId}", message: "..." })`;
	}
	if (resumable.length > 0) {
		const firstIndex = resumable[0]?.index ?? input.children.indexOf(resumable[0]!);
		return `Revive child: subagent({ action: "resume", id: "${input.asyncId}", index: ${firstIndex}, message: "..." })`;
	}
	return "Resume: unavailable; no child session file was persisted.";
}

function formatSubagentResultIntercomMessage(input: {
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	/** Top-level async lifecycle failure; do not derive success from child results. */
	worktreeExecutionError?: string;
	chainSteps?: number;
}): string {
	const counts = countStatuses(input.children);
	const lines: string[] = [
		"subagent results",
		"",
		`Run: ${input.runId}`,
		`Mode: ${input.mode}`,
		`Status: ${input.status}`,
		`Children: ${formatStatusCounts(counts)}`,
	];
	if (input.mode === "chain" && typeof input.chainSteps === "number") {
		lines.push(`Chain steps: ${input.chainSteps}`);
	}
	if (input.asyncId) lines.push(`Async id: ${input.asyncId}`);
	if (input.asyncDir) lines.push(`Async dir: ${input.asyncDir}`);
	if (input.worktreeExecutionError) {
		lines.push("", "Execution error:", input.worktreeExecutionError);
	}
	const resumeGuidance = asyncResumeGuidance(input);
	if (resumeGuidance) lines.push(resumeGuidance);
	if (input.children.some((child) => child.intercomTarget)) {
		lines.push("");
		lines.push(input.source === "async"
			? "Previous intercom targets below identify child sessions used while they were running. Inspect artifacts or session logs if resume is unavailable."
			: "Intercom targets below identify child sessions used while they were running; completed child sessions may no longer be reachable. Inspect artifacts or session logs for follow-up.");
	}

	for (let index = 0; index < input.children.length; index++) {
		const child = input.children[index]!;
		lines.push("");
		lines.push(`${index + 1}. ${child.agent} — ${child.status}`);
		if (child.intercomTarget) lines.push(`${input.source === "async" ? "Previous intercom target" : "Run intercom target"}: ${child.intercomTarget}`);
		if (child.artifactPath) lines.push(`Output artifact: ${child.artifactPath}`);
		if (child.gitBundle) {
			lines.push(`Git bundle: ${child.gitBundle.path}`);
			lines.push(`Git bundle checksum: ${child.gitBundle.checksum}`);
			if (child.gitBundle.bundleSize !== undefined) lines.push(`Git bundle size: ${child.gitBundle.bundleSize} bytes`);
			lines.push(`Git base/head: ${child.gitBundle.base}..${child.gitBundle.head}`);
			if (child.gitBundle.commitSummary) lines.push(`Git commits: ${child.gitBundle.commitSummary}`);
			if (child.gitBundle.recovery) lines.push(`Git recovery snapshot: ${child.gitBundle.recovery}`);
			if (child.gitBundle.stagedSnapshot) lines.push(`Git staged snapshot: ${child.gitBundle.stagedSnapshot}`);
			if (child.gitBundle.stagedTree) lines.push(`Git staged tree: ${child.gitBundle.stagedTree}`);
			if (child.gitBundle.recoveryTree) lines.push(`Git recovery tree: ${child.gitBundle.recoveryTree}`);
			if (child.gitBundle.dirtySummary) lines.push(`Git dirty summary: ${child.gitBundle.dirtySummary}`);
			if (child.gitBundle.terminationState) lines.push(`Git termination: ${child.gitBundle.terminationState}`);
			if (child.gitBundle.payloadSize !== undefined) lines.push(`Git payload size: ${child.gitBundle.payloadSize} bytes`);
			if (child.gitBundle.payloadChecksum) lines.push(`Git payload checksum: ${child.gitBundle.payloadChecksum}`);
			if (child.gitBundle.canonicalPayloadSize !== undefined) lines.push(`Git canonical payload size: ${child.gitBundle.canonicalPayloadSize} bytes`);
			if (child.gitBundle.canonicalPayloadChecksum) lines.push(`Git canonical payload checksum: ${child.gitBundle.canonicalPayloadChecksum}`);
			if (child.gitBundle.incomplete) lines.push("Git recovery is incomplete: a child-authored commit was required.");
		}
		if (child.sessionPath) lines.push(`Session: ${child.sessionPath}`);
		lines.push(...formatNestedResultLines(child.children));
		lines.push("Summary:");
		lines.push(child.summary);
	}

	return lines.join("\n");
}

export function buildSubagentResultIntercomPayload(input: GroupedResultIntercomMessageInput): SubagentResultIntercomPayload {
	const children = input.children.map((child) => ({
		...child,
		summary: child.summary.trim() || "(no output)",
		children: compactNestedResultChildren(child.children),
	}));
	if (input.worktreeExecutionError) {
		// Unindexed group diagnostics must remain diagnostics; lifecycle failure
		// belongs to the first canonical indexed child for revive/projection.
		const canonical = children.find((child) => !child.groupId) ?? children[0];
		if (canonical) canonical.status = "failed";
	}
	const status = input.worktreeExecutionError ? "failed" : resolveGroupedStatus(children);
	const summary = formatStatusCounts(countStatuses(children));
	const firstChild = children.find((child) => !child.groupId) ?? children[0];
	const payload: SubagentResultIntercomPayload = {
		to: input.to,
		runId: input.runId,
		mode: input.mode,
		status,
		summary,
		source: input.source,
		children,
		...(input.asyncId ? { asyncId: input.asyncId } : {}),
		...(input.asyncDir ? { asyncDir: input.asyncDir } : {}),
		...(input.worktreeExecutionError ? { worktreeExecutionError: input.worktreeExecutionError } : {}),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
		...(firstChild?.agent ? { agent: firstChild.agent } : {}),
		...(firstChild?.index !== undefined ? { index: firstChild.index } : {}),
		...(firstChild?.artifactPath ? { artifactPath: firstChild.artifactPath } : {}),
		...(firstChild?.sessionPath ? { sessionPath: firstChild.sessionPath } : {}),
		message: "",
	};
	payload.message = formatSubagentResultIntercomMessage(payload);
	return payload;
}

export async function deliverSubagentResultIntercomEvent(
	events: IntercomEventBus,
	payload: SubagentResultIntercomPayload,
	timeoutMs = 500,
): Promise<boolean> {
	return deliverSubagentIntercomMessageEvent(events, payload.to, payload.message, timeoutMs, payload);
}

export async function deliverSubagentIntercomMessageEvent(
	events: IntercomEventBus,
	to: string,
	message: string,
	timeoutMs = 500,
	extra: Record<string, unknown> = {},
): Promise<boolean> {
	if (typeof events.on !== "function" || typeof events.emit !== "function") return false;
	const requestId = typeof extra.requestId === "string" ? extra.requestId : randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			resolve(delivered);
		};
		unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const delivery = data as { requestId?: unknown; delivered?: unknown };
			if (delivery.requestId !== requestId) return;
			finish(delivery.delivered === true);
		});
		timer = setTimeout(() => finish(false), timeoutMs);
		try {
			events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId });
		} catch {
			finish(false);
		}
	});
}

function stripSingleResultOutputs(result: SingleResult): SingleResult {
	return {
		...result,
		messages: undefined,
		finalOutput: undefined,
		truncation: undefined,
	};
}

export function stripDetailsOutputsForIntercomReceipt(details: Details): Details {
	return {
		...details,
		results: details.results.map(stripSingleResultOutputs),
	};
}

export function formatSubagentResultReceipt(input: {
	mode: SubagentRunMode;
	runId: string;
	payload: SubagentResultIntercomPayload;
}): string {
	const counts = countStatuses(input.payload.children);
	const modeLabel = input.mode === "single"
		? "single subagent result"
		: input.mode === "parallel"
			? "parallel subagent results"
			: "chain subagent results";
	const lines = [
		`Delivered ${modeLabel} via intercom.`,
		`Run: ${input.runId}`,
		`Children: ${formatStatusCounts(counts)}`,
	];

	const nonCompletedChildren = input.payload.children.filter((child) => child.status === "failed" || child.status === "paused" || child.status === "cancelled" || child.status === "detached");
	if (input.payload.worktreeExecutionError || nonCompletedChildren.length > 0) {
		lines.push("Errors:");
		if (input.payload.worktreeExecutionError) lines.push(`- ${input.payload.worktreeExecutionError}`);
		for (const child of nonCompletedChildren) {
			// Failure and interruption reasons are carried in the child summary
			// when no bundle was produced (for example packaging/finalization
			// failure). Preserve them for paused children as well as failures.
			lines.push(`- ${child.agent}: ${child.summary}`);
		}
	}

	const bundles = input.payload.children.filter((child) => child.gitBundle);
	if (bundles.length > 0) {
		lines.push("Git bundles:");
		for (const child of bundles) {
			const bundle = child.gitBundle!;
			lines.push(`- ${child.agent} [${child.status}]: ${bundle.path} (${bundle.checksum}, ${bundle.bundleSize ?? "?"} bytes) ${bundle.base}..${bundle.head}`);
			if (bundle.recovery) lines.push(`  recovery: ${bundle.recovery}`);
			if (bundle.dirtySummary) lines.push(`  dirty summary: ${bundle.dirtySummary}`);
			if (bundle.payloadChecksum) lines.push(`  payload checksum/size: ${bundle.payloadChecksum} / ${bundle.payloadSize ?? "?"} bytes`);
			if (bundle.canonicalPayloadChecksum) lines.push(`  canonical payload checksum/size: ${bundle.canonicalPayloadChecksum} / ${bundle.canonicalPayloadSize ?? "?"} bytes`);
			if (bundle.terminationState) lines.push(`  termination: ${bundle.terminationState}`);
			if (bundle.incomplete) lines.push("  recovery incomplete: authored commit required");
		}
	}

	const artifacts = input.payload.children.filter((child) => typeof child.artifactPath === "string");
	if (artifacts.length > 0) {
		lines.push("Artifacts:");
		for (const child of artifacts) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.artifactPath}`);
		}
	}

	const intercomTargets = input.payload.children.filter((child) => typeof child.intercomTarget === "string");
	if (intercomTargets.length > 0) {
		lines.push("Run intercom targets (may be inactive after completion):");
		for (const child of intercomTargets) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.intercomTarget}`);
		}
	}

	const sessions = input.payload.children.filter((child) => typeof child.sessionPath === "string");
	if (sessions.length > 0) {
		lines.push("Sessions:");
		for (const child of sessions) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.sessionPath}`);
		}
	}

	lines.push("Full grouped output was sent over intercom.");
	return lines.join("\n");
}
