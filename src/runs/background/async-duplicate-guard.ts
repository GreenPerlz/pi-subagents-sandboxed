/**
 * Guard against duplicate async subagent launches.
 *
 * If the same parent/orchestrator tries to launch a materially equivalent async
 * child/workflow while an equivalent child is already active, do not spawn
 * another process. An explicit confirmation token + reason can override the
 * block.
 */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AsyncJobState,
	Details,
	NestedRouteInfo,
	SubagentRunMode,
	SubagentState,
} from "../../shared/types.ts";

interface FingerprintTask {
	agent: string;
	task: string;
	cwd: string;
}

export type FingerprintItem =
	| { kind: "task"; agent: string; task: string; cwd: string }
	| { kind: "parallel"; tasks: FingerprintTask[] };

interface AsyncDuplicateGuardInput {
	mode: SubagentRunMode;
	items: FingerprintItem[];
	cwd: string;
	sessionId?: string | null;
	nestedRoute?: NestedRouteInfo;
	confirmationToken?: string;
	confirmationReason?: string;
}

function isJobActive(job: AsyncJobState): boolean {
	return job.status === "queued" || job.status === "running";
}

function normalizeTaskText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function buildFingerprint(input: AsyncDuplicateGuardInput): string {
	const parts: string[] = ["async-dup-guard", input.mode, input.cwd];
	if (input.nestedRoute) {
		parts.push(input.nestedRoute.rootRunId);
	} else if (input.sessionId) {
		parts.push(`session:${input.sessionId}`);
	} else {
		parts.push("no-session");
	}
	for (const item of input.items) {
		if (item.kind === "task") {
			parts.push(`agent:${item.agent}`);
			parts.push(`task:${normalizeTaskText(item.task)}`);
			parts.push(`cwd:${item.cwd}`);
		} else if (item.kind === "parallel") {
			parts.push("parallel[");
			for (const task of item.tasks) {
				parts.push(`agent:${task.agent}`);
				parts.push(`task:${normalizeTaskText(task.task)}`);
				parts.push(`cwd:${task.cwd}`);
			}
			parts.push("]");
		}
	}
	return parts.join("|");
}

function findExistingActiveRun(
	state: SubagentState,
	fingerprint: string,
): AsyncJobState | undefined {
	for (const job of state.asyncJobs.values()) {
		if (!isJobActive(job)) continue;
		if (job.duplicateFingerprint === fingerprint) return job;
	}
	return undefined;
}

const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

function pruneExpiredConfirmationTokens(state: SubagentState, now = Date.now()): void {
	const tokens = state.asyncDuplicateConfirmations;
	if (!tokens) return;
	for (const [token, entry] of tokens.entries()) {
		if (entry.expiresAt <= now) tokens.delete(token);
	}
}

function reserveConfirmationToken(state: SubagentState, fingerprint: string, existingRunId: string, now = Date.now()): string {
	state.asyncDuplicateConfirmations ??= new Map();
	for (const [token, entry] of state.asyncDuplicateConfirmations.entries()) {
		if (entry.fingerprint === fingerprint && entry.existingRunId === existingRunId && entry.expiresAt > now) return token;
	}
	const token = `dup-${randomUUID().slice(0, 8)}`;
	state.asyncDuplicateConfirmations.set(token, {
		fingerprint,
		existingRunId,
		createdAt: now,
		expiresAt: now + CONFIRMATION_TOKEN_TTL_MS,
	});
	return token;
}

function consumeConfirmationToken(state: SubagentState, token: string, fingerprint: string, now = Date.now()): boolean {
	const entry = state.asyncDuplicateConfirmations?.get(token);
	if (!entry) return false;
	if (entry.expiresAt <= now || entry.fingerprint !== fingerprint) {
		state.asyncDuplicateConfirmations?.delete(token);
		return false;
	}
	state.asyncDuplicateConfirmations?.delete(token);
	return true;
}

export function formatDuplicateBlockedMessage(
	existingRunId: string,
	existingStatus: string,
	confirmationToken: string,
	reason?: string,
): string {
	return [
		`Duplicate async run blocked. A materially equivalent async run is already active.`,
		reason ? `Reason: ${reason}` : undefined,
		`Existing run: ${existingRunId} (${existingStatus})`,
		`Use subagent({ action: "status", id: "${existingRunId}" }) to check progress.`,
		`To intentionally launch a second equivalent async run, call again with confirmationToken: "${confirmationToken}" and a non-empty confirmationReason.`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function checkAsyncDuplicateLaunch(
	state: SubagentState,
	input: AsyncDuplicateGuardInput,
): AgentToolResult<Details> | null {
	const fingerprint = buildFingerprint(input);
	const existing = findExistingActiveRun(state, fingerprint);
	if (!existing) return null;

	pruneExpiredConfirmationTokens(state);
	const token = typeof input.confirmationToken === "string" ? input.confirmationToken.trim() : "";
	const reason = typeof input.confirmationReason === "string" ? input.confirmationReason.trim() : "";
	if (token && reason && consumeConfirmationToken(state, token, fingerprint)) return null;

	const confirmationToken = reserveConfirmationToken(state, fingerprint, existing.asyncId);
	const blockReason = token && reason
		? "Provided confirmationToken is invalid, expired, already used, or does not match this duplicate launch."
		: token && !reason
			? "confirmationReason is required when confirmationToken is provided."
			: !token && reason
				? "confirmationToken is required when confirmationReason is provided."
				: undefined;

	return {
		content: [
			{
				type: "text",
				text: formatDuplicateBlockedMessage(
					existing.asyncId,
					existing.status,
					confirmationToken,
					blockReason,
				),
			},
		],
		isError: true,
		details: { mode: input.mode, results: [] },
	};
}

export function computeAsyncFingerprint(
	input: AsyncDuplicateGuardInput,
): string {
	return buildFingerprint(input);
}
