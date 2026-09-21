import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../../shared/settings.ts";
import { isAgentOverrideAllowed } from "./agent-override-policy.ts";
import type { AgentOverridePolicyViolation, AgentOverridePolicyParams } from "./agent-override-policy.ts";

/** A trusted invocation root. It must be supplied by the extension context, not a tool request. */
export interface CwdPolicyContext {
	invokingCwd: string;
}

export interface CwdRequest {
	agent: string;
	value: unknown;
	label: string;
}

export interface ResolvedCwd {
	requested: string;
	resolved: string;
	canonical: string;
	implicitAllowed: boolean;
}

export interface CwdPolicyEvaluation {
	violations: AgentOverridePolicyViolation[];
	/** Resolutions captured during authorization, keyed by the raw request label. */
	resolutions: ReadonlyMap<string, ResolvedCwd>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an explicit cwd against the authenticated invocation cwd. Existing
 * directories are canonicalized before containment is tested. This is
 * deliberately fail-closed: malformed, missing, non-directory, and
 * inaccessible paths never become an implicit permission.
 */
export function resolveExplicitCwd(context: CwdPolicyContext, value: unknown): ResolvedCwd | { error: string } {
	if (typeof context.invokingCwd !== "string" || context.invokingCwd.length === 0 || context.invokingCwd.includes("\0")) {
		return { error: "trusted invoking cwd is invalid or contains a NUL byte" };
	}
	if (typeof value !== "string") return { error: "cwd must be a string" };
	if (value.length === 0) return { error: "cwd must not be empty" };
	if (value.includes("\0")) return { error: "cwd contains a NUL byte" };

	let resolved: string;
	let canonicalBase: string;
	try {
		resolved = path.resolve(context.invokingCwd, value);
		canonicalBase = fs.realpathSync.native(context.invokingCwd);
	} catch (error) {
		return { error: `cannot canonicalize cwd or invoking cwd: ${error instanceof Error ? error.message : String(error)}` };
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch (error) {
		return { error: `cwd '${value}' does not exist or is inaccessible: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!stat.isDirectory()) return { error: `cwd '${value}' is not a directory` };

	let canonical: string;
	try {
		canonical = fs.realpathSync.native(resolved);
	} catch (error) {
		return { error: `cannot canonicalize cwd '${value}': ${error instanceof Error ? error.message : String(error)}` };
	}
	const relative = path.relative(canonicalBase, canonical);
	const implicitAllowed = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
	return { requested: value, resolved, canonical, implicitAllowed };
}

function addRequest(requests: CwdRequest[], agent: unknown, value: unknown, label: string): void {
	if (value !== undefined && typeof agent === "string" && agent.length > 0) requests.push({ agent, value, label });
}

/**
 * Collect every cwd occurrence rather than grouping only by agent name. In
 * particular, a repeated agent must not let a safe occurrence mask an unsafe
 * occurrence elsewhere in the same request.
 */
export function collectCwdRequests(params: AgentOverridePolicyParams): CwdRequest[] {
	const requests: CwdRequest[] = [];
	const addTargets = (targets: readonly string[], value: unknown, label: string) => {
		for (const agent of targets) addRequest(requests, agent, value, label);
	};
	const targets: string[] = [];
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		for (const [index, task] of params.tasks.entries()) {
			if (!isRecord(task)) continue;
			if (Object.hasOwn(task, "cwd")) addRequest(requests, task.agent, task.cwd, `tasks[${index}].cwd`);
			targets.push(typeof task.agent === "string" ? task.agent : "");
		}
	} else if (Array.isArray(params.chain) && params.chain.length > 0) {
		for (const [stepIndex, rawStep] of params.chain.entries()) {
			if (!isRecord(rawStep)) continue;
			const step = rawStep as Record<string, unknown>;
			if (isParallelStep(step as unknown as ChainStep)) {
				const parallel = Array.isArray(step.parallel) ? step.parallel : [];
				const names = parallel.map((task) => isRecord(task) && typeof task.agent === "string" ? task.agent : "");
				if (Object.hasOwn(step, "cwd")) addTargets(names, step.cwd, `chain[${stepIndex}].cwd`);
				for (const [taskIndex, rawTask] of parallel.entries()) {
					if (isRecord(rawTask) && Object.hasOwn(rawTask, "cwd")) addRequest(requests, rawTask.agent, rawTask.cwd, `chain[${stepIndex}].parallel[${taskIndex}].cwd`);
				}
				targets.push(...names);
			} else if (isDynamicParallelStep(step as unknown as ChainStep)) {
				const parallel = isRecord(step.parallel) ? step.parallel : undefined;
				const agent = parallel?.agent;
				if (Object.hasOwn(step, "cwd")) addRequest(requests, agent, step.cwd, `chain[${stepIndex}].cwd`);
				if (parallel && Object.hasOwn(parallel, "cwd")) addRequest(requests, agent, parallel.cwd, `chain[${stepIndex}].parallel.cwd`);
				if (typeof agent === "string") targets.push(agent);
			} else {
				if (Object.hasOwn(step, "cwd")) addRequest(requests, step.agent, step.cwd, `chain[${stepIndex}].cwd`);
				if (typeof step.agent === "string") targets.push(step.agent);
			}
		}
	} else if (typeof params.agent === "string") {
		targets.push(params.agent);
	}
	if (Object.hasOwn(params, "cwd")) addTargets(targets, params.cwd, "cwd");
	return requests;
}

export function evaluateCwdPolicy(
	params: AgentOverridePolicyParams,
	agents: readonly AgentConfig[],
	context: CwdPolicyContext,
): CwdPolicyEvaluation {
	const violations: AgentOverridePolicyViolation[] = [];
	const resolutions = new Map<string, ResolvedCwd>();
	for (const request of collectCwdRequests(params)) {
		const agent = agents.find((candidate) => candidate.name === request.agent);
		const resolved = resolveExplicitCwd(context, request.value);
		// Keep the successful resolution produced by authorization. Execution must
		// consume this exact canonical identity rather than resolving the raw alias
		// a second time after another child has run.
		if (!("error" in resolved)) resolutions.set(request.label, resolved);
		// Cwd authorization is deliberately bootstrapped from definitions visible
		// at the trusted invocation root. A definition found only below a requested
		// outside cwd must never be allowed to grant itself access. Missing targets
		// therefore fail closed for malformed or outside requests; an implicit
		// same/descendant request needs no agent permission.
		if (!agent) {
			if ("error" in resolved || !resolved.implicitAllowed) {
				violations.push({ agent: request.agent, paths: ["cwd"], allowed: [] });
			}
			continue;
		}
		if ("error" in resolved) {
			violations.push({ agent: request.agent, paths: ["cwd"], allowed: [...(agent.canBeChangedByAgent ?? [])] });
		} else if (!resolved.implicitAllowed && !isAgentOverrideAllowed(agent, "cwd")) {
			violations.push({ agent: request.agent, paths: ["cwd"], allowed: [...(agent.canBeChangedByAgent ?? [])] });
		}
	}
	return { violations, resolutions };
}

export function validateCwdPolicy(
	params: AgentOverridePolicyParams,
	agents: readonly AgentConfig[],
	context: CwdPolicyContext,
): AgentOverridePolicyViolation[] {
	return evaluateCwdPolicy(params, agents, context).violations;
}

/**
 * Replace every authorized cwd leaf with the canonical identity captured by
 * evaluateCwdPolicy. Non-cwd request fields are copied without interpretation.
 * A missing or mismatched admission fails closed instead of falling back to a
 * fresh filesystem lookup or executing a different value than was authorized.
 */
export function normalizeAuthorizedCwds<T extends AgentOverridePolicyParams>(
	params: T,
	resolutions: ReadonlyMap<string, ResolvedCwd>,
): T | { error: string } {
	let normalizationError: string | undefined;
	const canonicalFor = (label: string, value: unknown): string | undefined => {
		if (typeof value !== "string") {
			normalizationError = `Invalid authorized cwd at ${label}`;
			return undefined;
		}
		const resolved = resolutions.get(label);
		if (!resolved || resolved.requested !== value) {
			normalizationError = `Cwd authorization changed before execution at ${label}`;
			return undefined;
		}
		return resolved.canonical;
	};
	const withCanonicalCwd = (value: unknown, label: string): unknown => {
		if (!isRecord(value) || !Object.hasOwn(value, "cwd") || value.cwd === undefined) return value;
		const cwd = canonicalFor(label, value.cwd);
		return cwd === undefined ? value : { ...value, cwd };
	};
	const normalized = { ...(params as Record<string, unknown>) } as T & Record<string, unknown>;
	if (Object.hasOwn(params, "cwd") && params.cwd !== undefined) {
		const cwd = canonicalFor("cwd", params.cwd);
		if (cwd === undefined) return { error: normalizationError ?? "Invalid authorized cwd" };
		normalized.cwd = cwd;
	}
	if (Array.isArray(params.tasks)) {
		normalized.tasks = params.tasks.map((task, index) => withCanonicalCwd(task, `tasks[${index}].cwd`));
		if (normalizationError) return { error: normalizationError };
	}
	if (Array.isArray(params.chain)) {
		normalized.chain = params.chain.map((rawStep, stepIndex) => {
			if (!isRecord(rawStep)) return rawStep;
			let step = withCanonicalCwd(rawStep, `chain[${stepIndex}].cwd`) as Record<string, unknown>;
			if (isParallelStep(rawStep as unknown as ChainStep) && Array.isArray(step.parallel)) {
				step = {
					...step,
					parallel: step.parallel.map((rawTask, taskIndex) => withCanonicalCwd(rawTask, `chain[${stepIndex}].parallel[${taskIndex}].cwd`)),
				};
			} else if (isDynamicParallelStep(rawStep as unknown as ChainStep) && isRecord(step.parallel)) {
				step = {
					...step,
					parallel: withCanonicalCwd(step.parallel, `chain[${stepIndex}].parallel.cwd`),
				};
			}
			return step;
		});
		if (normalizationError) return { error: normalizationError };
	}
	return normalized;
}
