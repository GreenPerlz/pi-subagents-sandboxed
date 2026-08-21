/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";
import { resolveAggregateState } from "../../shared/aggregate-state.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
	state?: string;
	cancelled?: boolean;
	interrupted?: boolean;
	teardownUnproven?: boolean;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused" | "cancelled";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	cancelled?: boolean;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	teardownUnproven?: boolean;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

export default function registerSubagentNotify(pi: ExtensionAPI): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const agent = result.agent ?? "unknown";
		const summary = typeof result.summary === "string" ? result.summary : "";
		const aggregate = resolveAggregateState([
			{ state: result.state ?? (result.success ? "complete" : result.exitCode === 0 || summary.startsWith("Paused after interrupt.") ? "paused" : "failed"), teardownUnproven: result.teardownUnproven },
			...(result.cancelled ? [{ state: "cancelled" }] : []),
			...(result.results ?? []).flatMap((child) => [
				{ state: child.state ?? (child.success ? "complete" : child.interrupted ? "paused" : child.cancelled ? "cancelled" : "failed"), teardownUnproven: child.teardownUnproven },
				...(child.cancelled ? [{ state: "cancelled" }] : []),
				...(child.interrupted ? [{ state: "paused" }] : []),
			]),
		]);
		// An unproven cleanup is actionable live state, not a completion notice.
		if (aggregate === "running" || aggregate === "pending") return;
		const status = aggregate === "cancelled" ? "cancelled" : aggregate === "paused" ? "paused" : aggregate === "completed" ? "completed" : "failed";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const sessionLine = result.shareUrl
			? `Session: ${result.shareUrl}`
			: result.shareError
				? `Session share error: ${result.shareError}`
				: result.sessionFile
					? `Session file: ${result.sessionFile}`
					: undefined;

		const displaySummary = summary.trim() ? summary : "(no output)";
		const content = [
			`Background task ${status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
