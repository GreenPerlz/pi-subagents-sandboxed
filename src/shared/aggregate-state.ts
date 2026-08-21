/** Shared aggregate lifecycle precedence for all run projections. */
export type AggregateState = "failed" | "cancelled" | "paused" | "completed" | "running" | "pending";

export interface AggregateStateInput {
	state?: string;
	teardownUnproven?: boolean;
}

/**
 * Failure and cleanup failure outrank cancellation and pause. A teardown that
 * cannot be proven is deliberately actionable/live, even when its stored state
 * is failed or complete.
 */
export function resolveAggregateState(values: Iterable<AggregateStateInput | string>, fallback: AggregateState = "pending"): AggregateState {
	let hasFailed = false;
	let hasCancelled = false;
	let hasPaused = false;
	let hasCompleted = false;
	let hasRunning = false;
	let hasPending = false;
	let hasTeardownUnproven = false;
	for (const value of values) {
		const state = typeof value === "string" ? value : value.state;
		if (typeof value !== "string" && value.teardownUnproven === true) hasTeardownUnproven = true;
		switch (state) {
			case "failed": hasFailed = true; break;
			case "cancelled": hasCancelled = true; break;
			case "paused": hasPaused = true; break;
			case "complete":
			case "completed": hasCompleted = true; break;
			case "running":
		case "detached": hasRunning = true; break;
			case "queued":
			case "pending": hasPending = true; break;
		}
	}
	// Consume the complete iterable before deciding. A teardown marker on any
	// child keeps the aggregate actionable, even if a later child is terminal.
	if (hasTeardownUnproven) return "running";
	if (hasRunning) return "running";
	if (hasFailed) return "failed";
	if (hasCancelled) return "cancelled";
	if (hasPaused) return "paused";
	if (hasCompleted) return "completed";
	if (hasPending) return "pending";
	return fallback;
}
