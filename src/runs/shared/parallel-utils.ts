import type { DynamicCollectSpec, DynamicExpandSpec } from "../../shared/settings.ts";
import type { JsonSchemaObject, ResolvedAcceptanceConfig } from "../../shared/types.ts";
import type { ResolvedSandboxConfig } from "../../sandbox/types.ts";

export interface RunnerSubagentStep {
	agent: string;
	/** Discovery source is security-sensitive; never infer packaged role by name. */
	source?: import("../../agents/agents.ts").AgentSource;
	task: string;
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
	cwd?: string;
	model?: string;
	/** Requested setting; eligibility is evaluated for each model candidate. */
	fastMode?: boolean;
	fastModeCandidates?: Array<import("../../shared/fast-mode.ts").FastModeStatus | undefined>;
	thinking?: string;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	sessionFile?: string;
	maxSubagentDepth?: number;
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	structuredOutputSchema?: JsonSchemaObject;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	sandbox?: ResolvedSandboxConfig;
	/** Explicit authorized provider:none diagnostic; not an execution authority. */
	hostGitDiagnostic?: boolean;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	/** Trusted parent preflight result; never accepted from model-generated input. */
	worktreeOptOutAuthorized?: boolean;
}

export interface DynamicRunnerGroup {
	expand: DynamicExpandSpec;
	parallel: RunnerSubagentStep;
	collect: DynamicCollectSpec;
	concurrency?: number;
	worktree?: boolean;
	/** Trusted parent preflight result; never accepted from model-generated input. */
	worktreeOptOutAuthorized?: boolean;
	failFast?: boolean;
	phase?: string;
	label?: string;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function isDynamicRunnerGroup(step: RunnerStep): step is DynamicRunnerGroup {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else if (isDynamicRunnerGroup(step)) {
			continue;
		} else {
			flat.push(step);
		}
	}
	return flat;
}

/**
 * A callback rejection which retains the results that already settled.  The
 * public rejection reason remains available as `reason`; callers that need to
 * project a partial parallel run can use `partialResults` without replacing
 * successful siblings with synthetic failures.
 */
export class MapConcurrentError<R> extends Error {
	readonly reason: unknown;
	readonly cause: unknown;
	readonly partialResults: Array<R | undefined>;
	readonly rejectionIndex?: number;

	constructor(reason: unknown, partialResults: Array<R | undefined>, rejectionIndex?: number) {
		super(reason instanceof Error ? reason.message : String(reason));
		this.name = "MapConcurrentError";
		this.reason = reason;
		this.cause = reason;
		this.partialResults = partialResults;
		this.rejectionIndex = rejectionIndex;
		if (reason instanceof Error && reason.stack) this.stack = reason.stack;
	}
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: Array<R | undefined> = new Array(items.length);
	let next = 0;

	let firstError: unknown;
	let firstErrorIndex: number | undefined;
	let hasFirstError = false;
	let rejected = false;
	async function worker(_workerIndex: number): Promise<void> {
		while (!rejected && next < items.length) {
			const i = next++;
			try {
				results[i] = await fn(items[i], i);
			} catch (error) {
				// Stop assigning queued work as soon as one callback rejects. Already
				// started children still settle before the caller can export or clean
				// an isolated runtime. Preserve the first rejection, including an
				// intentionally rejected undefined value.
				if (!hasFirstError) {
					firstError = error;
					firstErrorIndex = i;
					hasFirstError = true;
				}
				rejected = true;
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)),
	);
	if (rejected) {
		// Always wrap, including primitive/undefined rejections. The original value
		// remains available by identity as both `reason` and `cause`, alongside all
		// callbacks that settled before the rejection became visible.
		throw new MapConcurrentError(firstError, results, firstErrorIndex);
	}
	return results as R[];
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.exitCode === -1
					? "SKIPPED"
					: r.exitCode !== 0 && r.exitCode !== null
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
