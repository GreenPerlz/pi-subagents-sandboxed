import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import {
	ackNestedControlRequest,
	claimNestedControlRequest,
	getNestedJournalWorkCounters,
	resetNestedJournalRuntime,
	resetNestedJournalWorkCounters,
	setNestedJournalFaultInjector,
	createNestedRoute,
	hasLiveNestedDescendants,
	hasLiveNestedDescendantsForParent,
	nestedSummaryFromAsyncStatus,
	selectNestedChildrenForParent,
	parseNestedEventRecords,
	mergeNestedRunSnapshots,
	projectNestedEvents,
	resolveNestedParentAddressFromEnv,
	resolveNestedRouteFromEnv,
	resolveNestedRoute,
	resolveRequiredInheritedNestedRouteFromEnv,
	updateAsyncJobNestedProjection,
	updateForegroundNestedProjection,
	validateNestedRouteForRevival,
	waitForNestedDescendantsToStop,
	writeNestedControlRequest,
	writeNestedControlResult,
	writeNestedEventJournalFixtureForTest,
	writeNestedJournalFixtureForTest,
	writeNestedEvent,
	readNestedControlRequests,
	readNestedControlResults,
	readNestedControlResult,
} from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

const routes: Array<{ eventSink: string }> = [];
const savedEnv = {
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
	[SUBAGENT_PARENT_DEPTH_ENV]: process.env[SUBAGENT_PARENT_DEPTH_ENV],
	[SUBAGENT_PARENT_PATH_ENV]: process.env[SUBAGENT_PARENT_PATH_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
};

afterEach(() => {
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function trackRoute(rootRunId = "root-run") {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function child(id: string, state: "queued" | "running" | "complete" | "failed" | "paused", ts: number, parentRunId = "root-run") {
	return {
		id,
		parentRunId,
		parentStepIndex: 1,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 1 }],
		mode: "single" as const,
		state,
		agent: "reviewer",
		agents: ["reviewer"],
		startedAt: 10,
		lastUpdate: ts,
		steps: [{ agent: "leaf", status: state === "running" ? "running" as const : "complete" as const }],
	};
}

describe("nested snapshot fidelity and route authority", () => {
	it("retains rich started fields when a newer partial terminal snapshot arrives", () => {
		const started = child("partial", "running", 10) as any;
		started.cwd = "/work";
		started.model = "model-a";
		started.thinking = "high";
		started.totalTokens = { input: 2, output: 3, total: 5 };
		started.summary = "started summary";
		started.steps = [{ agent: "same", status: "running", model: "model-a", startedAt: 10 }, { agent: "same", status: "running", model: "model-b", startedAt: 11 }];
		const completed = { ...child("partial", "complete", 20), endedAt: 20, steps: [{ agent: "same", status: "complete", endedAt: 20 }] } as any;
		const [merged] = mergeNestedRunSnapshots([started], [completed]);
		assert.equal(merged.cwd, "/work");
		assert.equal(merged.model, "model-a");
		assert.equal(merged.summary, "started summary");
		assert.equal(merged.steps?.[1]?.model, "model-b");
		assert.equal(merged.state, "complete");
	});

	it("uses fresh nested descendants even when the parent snapshot is stale", () => {
		const live = child("fresh-parent", "running", 10) as any;
		const persisted = { ...child("fresh-parent", "complete", 5), children: [{ ...child("fresh-child", "complete", 100), endedAt: 100 }] } as any;
		const [merged] = mergeNestedRunSnapshots([live], [persisted]);
		assert.equal(merged.state, "complete");
		assert.equal(merged.children?.[0]?.id, "fresh-child");
	});

	it("classifies cleaned trusted routes as unavailable and forged routes as invalid", () => {
		const route = trackRoute("authority-root");
		const trusted = resolveNestedRoute("authority-root", route);
		assert.equal(trusted.validity, "trusted");
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		assert.equal(resolveNestedRoute("authority-root", route).validity, "unavailable");
		const ambient = trackRoute("authority-root");
		const forged = { ...ambient, capabilityToken: "forged-token" };
		assert.equal(resolveNestedRoute("authority-root", forged).validity, "invalid");
	});
});

describe("nested event route validation", () => {
	it("resolves nested parent addresses with full inherited path", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "nested-parent";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "3";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
			{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
			{ runId: "../unsafe", stepIndex: 1, agent: "bad" },
			{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
		]);

		assert.deepEqual(resolveNestedParentAddressFromEnv(), {
			parentRunId: "nested-parent",
			parentStepIndex: 2,
			depth: 3,
			path: [
				{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
				{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
			],
		});
	});

	it("ignores unsafe nested parent ids from env", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "../unsafe";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";

		assert.equal(resolveNestedParentAddressFromEnv(), undefined);
	});

	it("resolves only matching contained routes from env", () => {
		const route = trackRoute();
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;

		assert.deepEqual(resolveNestedRouteFromEnv(), route);

		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "wrong-token";
		assert.throws(() => resolveNestedRouteFromEnv(), /capability token/);
		assert.throws(() => resolveRequiredInheritedNestedRouteFromEnv(), /capability token/);
	});

	it("fails closed for partial inherited route metadata", () => {
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "ambient-root";
		assert.throws(() => resolveRequiredInheritedNestedRouteFromEnv(), /route|metadata|does not exist/i);
	});

	it("validates exact live persisted route coordinates and rejects stale or forged metadata", () => {
		const route = trackRoute("revival-root");
		assert.deepEqual(validateNestedRouteForRevival(route), route);
		assert.throws(() => validateNestedRouteForRevival({ ...route, eventSink: path.join(path.dirname(route.eventSink), "other-events") }), /canonical route events|does not exist/);
		assert.throws(() => validateNestedRouteForRevival({ ...route, rootRunId: "other-root" }), /does not match/);
		fs.chmodSync(route.eventSink, 0o755);
		assert.throws(() => validateNestedRouteForRevival(route), /permissions are too broad/);
		fs.chmodSync(route.eventSink, 0o700);
		const routeFile = path.join(path.dirname(route.eventSink), "route.json");
		fs.unlinkSync(routeFile);
		fs.symlinkSync(import.meta.filename, routeFile);
		assert.throws(() => validateNestedRouteForRevival(route), /not a trusted regular file/);
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		assert.throws(() => validateNestedRouteForRevival(route), /do not exist|does not exist/);
	});
});

describe("nested event parsing and projection", () => {
	it("projects started, updated, and completed records into async and foreground parent state", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "running", 100),
		});
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 200,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-a", "running", 200), currentTool: "read" },
		});
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "complete", 300),
		});

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.length, 1);
		assert.equal(registry.children[0]?.id, "nested-a");
		assert.equal(registry.children[0]?.state, "complete");
		assert.equal(registry.children[0]?.steps?.[0]?.agent, "leaf");

		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-0", status: "running", index: 0 },
				{ agent: "owner-1", status: "running", index: 1 },
			],
		};
		updateAsyncJobNestedProjection(job);
		assert.equal(job.nestedChildren?.[0]?.id, "nested-a");
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-a");

		const control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never = {
			runId: "root-run",
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		};
		updateForegroundNestedProjection(control);
		assert.equal(control.nestedChildren?.[0]?.id, "nested-a");
		// Terminal observers must see the completed child, not the earlier running
		// projection that was persisted before the detached callback finished.
		assert.equal(control.nestedChildren?.[0]?.state, "complete");
	});

	it("attaches grandchildren to their exact launching step without duplicate direct rendering", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started", ts: 100, parentRunId: "root-run", parentStepIndex: 1,
			child: { ...child("parent-child", "running", 100), steps: [{ agent: "nested-step", status: "running" }] },
		});
		writeNestedEvent(route, {
			type: "subagent.nested.started", ts: 200, parentRunId: "parent-child", parentStepIndex: 0,
			child: { ...child("grandchild", "running", 200, "parent-child"), parentStepIndex: 0, depth: 2, path: [{ runId: "root-run", stepIndex: 1 }, { runId: "parent-child", stepIndex: 0 }] },
		});
		const parent = projectNestedEvents(route).children[0];
		assert.equal(parent?.children, undefined);
		assert.equal(parent?.steps?.[0]?.children?.[0]?.id, "grandchild");
		assert.equal(parent?.steps?.[0]?.children?.length, 1);
	});

	it("unions stale snapshots while retaining terminal and sibling evidence", () => {
		const stale = [child("first", "running", 100), child("second", "running", 100)];
		const fresh = [{ ...child("first", "complete", 200), teardownUnproven: false }];
		const merged = mergeNestedRunSnapshots(stale, fresh);
		assert.deepEqual(merged.map((item) => item.id), ["first", "second"]);
		assert.equal(merged[0]?.state, "complete");
	});

	it("attaches root children to visible step slices by original step index", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 3,
			child: { ...child("nested-visible", "running", 100), parentStepIndex: 3, path: [{ runId: "root-run", stepIndex: 3 }] },
		});
		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-2", status: "running", index: 2 },
				{ agent: "owner-3", status: "running", index: 3 },
			],
		};

		updateAsyncJobNestedProjection(job);

		assert.equal(job.steps?.[0]?.children, undefined);
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-visible");
	});

	it("ignores corrupt, partial, wrong-token, duplicate, and stale records while preserving terminal state", () => {
		const route = trackRoute();
		fs.writeFileSync(path.join(route.eventSink, "0000000000001-corrupt.json"), "{not json", "utf-8");
		fs.writeFileSync(
			path.join(route.eventSink, "0000000000002-partial.jsonl"),
			`${JSON.stringify({
				type: "subagent.nested.started",
				ts: 50,
				rootRunId: route.rootRunId,
				parentRunId: "root-run",
				parentStepIndex: 1,
				capabilityToken: route.capabilityToken,
				child: child("partial-good", "running", 50),
			})}\n{"type":"subagent.nested.started"`,
			"utf-8",
		);
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-terminal", "complete", 300),
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000400-stale.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 400,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("nested-terminal", "running", 100),
		})}\n`, "utf-8");
		fs.writeFileSync(path.join(route.eventSink, "0000000000500-wrong-token.json"), `${JSON.stringify({
			type: "subagent.nested.started",
			ts: 500,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: "wrong",
			child: child("wrong-token", "running", 500),
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.find((item) => item.id === "partial-good")?.state, "running");
		assert.equal(registry.children.find((item) => item.id === "nested-terminal")?.state, "complete");
		assert.equal(registry.children.some((item) => item.id === "wrong-token"), false);
		assert.equal(hasLiveNestedDescendants(registry.children), true);
	});

	it("detects live descendants attached to terminal step children", () => {
		assert.equal(hasLiveNestedDescendants([{
			...child("terminal-parent", "complete", 300),
			steps: [{
				agent: "owner-step",
				status: "complete",
				children: [{
					...child("running-step-child", "running", 310, "terminal-parent"),
					parentStepIndex: 0,
					path: [{ runId: "terminal-parent", stepIndex: 0 }],
				}],
			}],
		}]), true);
	});

	it("accepts only complete numeric token usage at the nested event boundary", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-valid-tokens", "running", 100), totalTokens: { input: 10, output: 15, total: 25 } },
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000200-invalid-tokens.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 200,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: { ...child("nested-invalid-tokens", "running", 200), totalTokens: { input: 1, output: "bad", total: 1 } },
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);

		assert.deepEqual(registry.children.find((item) => item.id === "nested-valid-tokens")?.totalTokens, { input: 10, output: 15, total: 25 });
		assert.equal(registry.children.find((item) => item.id === "nested-invalid-tokens")?.totalTokens, undefined);
	});

	it("parses only complete jsonl records", () => {
		const route = trackRoute();
		const records = parseNestedEventRecords(`${JSON.stringify({
			type: "subagent.nested.started",
			ts: 100,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("jsonl-good", "running", 100),
		})}\n{"type":"subagent.nested.started"`, route);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.child.id, "jsonl-good");
	});
});

describe("nestedSummaryFromAsyncStatus", () => {
	it("carries model from the current step at top level and in steps", () => {
		const status = {
			runId: "run-1",
			mode: "chain" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			currentStep: 1,
			steps: [
				{ agent: "researcher", status: "complete" as const, model: "gpt-4" },
				{ agent: "worker", status: "running" as const, model: "claude-sonnet", tokens: { input: 100, output: 50, total: 150 } },
			],
			totalTokens: { input: 200, output: 100, total: 300 },
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, "claude-sonnet");
		assert.deepEqual(summary.totalTokens, { input: 200, output: 100, total: 300 });
		assert.equal(summary.steps?.length, 2);
		assert.equal(summary.steps?.[0]?.model, "gpt-4");
		assert.equal(summary.steps?.[1]?.model, "claude-sonnet");
		assert.deepEqual(summary.steps?.[1]?.totalTokens, { input: 100, output: 50, total: 150 });
	});

	it("falls back to first step with model when currentStep is undefined", () => {
		const status = {
			runId: "run-1",
			mode: "single" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			steps: [
				{ agent: "worker", status: "running" as const, model: "gemini-pro" },
			],
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, "gemini-pro");
	});

	it("omits model when no step has a model", () => {
		const status = {
			runId: "run-1",
			mode: "single" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			steps: [
				{ agent: "worker", status: "running" as const },
			],
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, undefined);
	});

	it("does not pair run header model with thinking from a different step", () => {
		const status = {
			runId: "run-1",
			mode: "chain" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			currentStep: 1,
			steps: [
				{ agent: "researcher", status: "complete" as const, model: "gpt-4", thinking: "high" },
				{ agent: "worker", status: "running" as const, model: "claude-sonnet" },
			],
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, "claude-sonnet");
		assert.equal(summary.thinking, undefined);
	});

	it("falls back to first step with model and preserves its thinking, not another step's", () => {
		const status = {
			runId: "run-1",
			mode: "single" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			steps: [
				{ agent: "worker", status: "running" as const, model: "gemini-pro" },
				{ agent: "reviewer", status: "pending" as const, thinking: "medium" },
			],
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, "gemini-pro");
		assert.equal(summary.thinking, undefined);
	});

	it("preserves active step thinking when model text later changes", () => {
		const status = {
			runId: "run-1",
			mode: "single" as const,
			state: "running" as const,
			startedAt: 1000,
			lastUpdate: 2000,
			currentStep: 0,
			steps: [
				{ agent: "worker", status: "running" as const, model: "claude-sonnet:high", thinking: "high" },
			],
		};
		const summary = nestedSummaryFromAsyncStatus(status, "/tmp/run-1", {
			id: "run-1",
			parentRunId: "parent-1",
			depth: 1,
			ts: 2000,
		});
		assert.equal(summary.model, "claude-sonnet:high");
		assert.equal(summary.thinking, "high");
	});
});

describe("nested teardown-unproven projections (issue #59)", () => {
	it("preserves per-step teardownUnproven through conversion and merge", () => {
		const route = trackRoute();
		const status = {
			runId: "nested-step-unproven",
			mode: "single" as const,
			state: "complete" as const,
			steps: [{ agent: "leaf", status: "complete" as const, teardownUnproven: true }],
			lastUpdate: 100,
		};
		const converted = nestedSummaryFromAsyncStatus(status, "/tmp/nested-step-unproven", {
			id: status.runId,
			parentRunId: route.rootRunId,
			parentStepIndex: 0,
			depth: 1,
			ts: 100,
		});
		assert.equal(converted.steps?.[0]?.teardownUnproven, true);
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: route.rootRunId,
			parentStepIndex: 0,
			child: { ...converted, state: "complete" },
		});
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 200,
			parentRunId: route.rootRunId,
			parentStepIndex: 0,
			child: { ...converted, state: "complete", lastUpdate: 200, steps: [{ agent: "leaf", status: "complete" }] },
		});
		const projected = projectNestedEvents(route).children;
		assert.equal(projected[0]?.steps?.[0]?.teardownUnproven, true);
		assert.equal(hasLiveNestedDescendants(projected), true, "a terminal-looking parent with an unproven step remains live");
	});
});

describe("sync-nested-child activity detection (issue #47)", () => {
	it("reports live descendants when a child is running", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: child("worker-nested", "running", 100),
		});
		const registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), true);
	});

	it("reports no live descendants when all children are terminal", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: child("worker-done", "running", 100),
		});
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 200,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: child("worker-done", "complete", 200),
		});
		const registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), false);
	});

	it("reports live descendants through nested step children", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: {
				...child("parent-step", "complete", 200),
				steps: [{
					agent: "step-agent",
					status: "complete",
					children: [{
						...child("step-child", "running", 300, "parent-step"),
						parentStepIndex: 0,
						path: [{ runId: "parent-step", stepIndex: 0 }],
					}],
				}],
			},
		});
		const registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), true);
	});

	it("transitions from live to no-live when nested child completes", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: child("transient-child", "running", 100),
		});
		let registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), true);

		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 200,
			parentRunId: "root-run",
			parentStepIndex: 0,
			child: child("transient-child", "complete", 200),
		});
		registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), false);
	});

	it("reports no live descendants for an empty registry", () => {
		const route = trackRoute();
		const registry = projectNestedEvents(route);
		assert.equal(hasLiveNestedDescendants(registry.children), false);
	});

	it("scopes nested children and live-descendant checks by parent step", () => {
		const runningStep0 = { ...child("nested-step-0", "running", 100, "root-run"), parentStepIndex: 0, path: [{ runId: "root-run", stepIndex: 0 }] };
		const runningStep1 = { ...child("nested-step-1", "running", 110, "root-run"), parentStepIndex: 1, path: [{ runId: "root-run", stepIndex: 1 }] };
		const completeStep0 = { ...child("nested-step-0-complete", "complete", 120, "root-run"), parentStepIndex: 0, path: [{ runId: "root-run", stepIndex: 0 }] };
		const nestedParent = {
			...child("nested-parent", "running", 130, "root-run"),
			parentStepIndex: 0,
			path: [{ runId: "root-run", stepIndex: 0 }],
			children: [{
				...child("grandchild-step-0", "running", 140, "nested-parent"),
				parentStepIndex: 0,
				path: [{ runId: "root-run", stepIndex: 0 }, { runId: "nested-parent", stepIndex: 0 }],
			}],
		};
		const children = [runningStep0, runningStep1, completeStep0, nestedParent];

		assert.deepEqual(selectNestedChildrenForParent(children, "root-run", 0).map((item) => item.id), ["nested-step-0", "nested-step-0-complete", "nested-parent"]);
		assert.deepEqual(selectNestedChildrenForParent(children, "root-run", 1).map((item) => item.id), ["nested-step-1"]);
		assert.deepEqual(selectNestedChildrenForParent(children, "nested-parent", 0).map((item) => item.id), ["grandchild-step-0"]);
		assert.equal(hasLiveNestedDescendantsForParent(children, "root-run", 0), true);
		assert.equal(hasLiveNestedDescendantsForParent(children, "root-run", 1), true);
		assert.equal(hasLiveNestedDescendantsForParent(children, "nested-parent", 0), true);
		assert.equal(hasLiveNestedDescendantsForParent(children, "root-run", 2), false);
	});
});

describe("nested descendant termination fence", () => {
	it("does not delay cleanup when no descendant is present", async () => {
		const route = createNestedRoute("nested-fence-empty");
		try {
			const started = Date.now();
			const result = await waitForNestedDescendantsToStop(route, route.rootRunId, 0, { timeoutMs: 1_000, pollMs: 10 });
			assert.equal(result.observed, true);
			assert.equal(result.stopped, true);
			assert.ok(Date.now() - started < 100, "an empty route should not wait for the timeout");
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("accepts a descendant that is already terminal on the first projection", async () => {
		const route = createNestedRoute("nested-fence-terminal-first");
		try {
			writeNestedEvent(route, { type: "subagent.nested.completed", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
				id: "nested-fence-terminal-child", parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1,
				path: [{ runId: route.rootRunId, stepIndex: 0 }], state: "complete", agent: "worker",
			} });
			const result = await waitForNestedDescendantsToStop(route, route.rootRunId, 0, { timeoutMs: 100, pollMs: 5 });
			assert.deepEqual(result, { observed: true, stopped: true });
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("refuses export when a descendant never reaches terminal state", async () => {
		const route = createNestedRoute("nested-fence-timeout");
		try {
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
				id: "nested-fence-timeout-child", parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1,
				path: [{ runId: route.rootRunId, stepIndex: 0 }], state: "running", agent: "worker",
			} });
			const result = await waitForNestedDescendantsToStop(route, route.rootRunId, 0, { timeoutMs: 25, pollMs: 5 });
			assert.equal(result.observed, true);
			assert.equal(result.stopped, false);
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("waits for a terminal descendant event instead of trusting activity snapshots", async () => {
		const route = createNestedRoute("nested-fence-root");
		try {
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
				id: "nested-fence-child", parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1,
				path: [{ runId: route.rootRunId, stepIndex: 0 }], state: "running", agent: "worker",
			} });
			const started = Date.now();
			const waiting = waitForNestedDescendantsToStop(route, route.rootRunId, 0, { timeoutMs: 1_000, pollMs: 10 });
			setTimeout(() => writeNestedEvent(route, { type: "subagent.nested.completed", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
				id: "nested-fence-child", parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1,
				path: [{ runId: route.rootRunId, stepIndex: 0 }], state: "complete", agent: "worker",
			} }), 60);
			const result = await waiting;
			assert.equal(result.observed, true);
			assert.equal(result.stopped, true);
			assert.ok(Date.now() - started >= 50, "fence must wait for descendant terminal state");
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});
});

describe("framed nested journals", () => {
	it("repairs a torn tail while retaining immutable evidence and resumes at the next frame", () => {
		const route = trackRoute("framed-tail");
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 1, parentRunId: route.rootRunId, child: child("framed-child", "running", 1) });
		projectNestedEvents(route);
		const journal = path.join(route.eventSink, "events.journal");
		fs.appendFileSync(journal, Buffer.from([0x50, 0x49, 0x53]));
		projectNestedEvents(route);
		assert.ok(fs.readdirSync(route.eventSink).some((entry) => entry.includes(".torn.")));
		writeNestedEvent(route, { type: "subagent.nested.completed", ts: 2, parentRunId: route.rootRunId, child: child("framed-child", "complete", 2) });
		assert.equal(projectNestedEvents(route).children[0]?.state, "complete");
	});

	it("keeps control retries idempotent and advances request acknowledgement durably", () => {
		const route = trackRoute("framed-control");
		const request = { ts: 1, requestId: "framed-request", targetRunId: "nested-child", action: "interrupt" as const };
		writeNestedControlRequest(route, request);
		writeNestedControlRequest(route, request);
		assert.equal(readNestedControlRequests(route).length, 1);
		writeNestedControlResult(route, { ts: 2, requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "done" });
		writeNestedControlResult(route, { ts: 2, requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "done" });
		assert.equal(readNestedControlResults(route).length, 1);
		ackNestedControlRequest(route, request.requestId);
		assert.equal(readNestedControlRequests(route).length, 0);
	});

	it("recovers a result journal append after a crash before index and state", () => {
		const route = trackRoute("result-append-recovery");
		const request = { ts: 1, requestId: "result-recovery-request", targetRunId: "nested-child", action: "interrupt" as const };
		writeNestedControlRequest(route, request);
		assert.equal(claimNestedControlRequest(route, request.requestId), "new");
		setNestedJournalFaultInjector((phase, kind) => { if (phase === "append" && kind === "result") throw new Error("crash-after-result-append"); });
		assert.throws(() => writeNestedControlResult(route, { ts: 2, requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "durable" }), /crash-after-result-append/);
		setNestedJournalFaultInjector(undefined);
		resetNestedJournalRuntime(route);
		assert.equal(claimNestedControlRequest(route, request.requestId), "completed");
		assert.deepEqual(readNestedControlResult(route, request.requestId)?.message, "durable");
		ackNestedControlRequest(route, request.requestId);
		assert.equal(readNestedControlRequests(route).length, 0);
	});

	it("recovers a durable result from a fresh child process without replay", async () => {
		const route = trackRoute("fresh-result-recovery");
		const request = { ts: 1, requestId: "fresh-result-request", targetRunId: "nested-child", action: "interrupt" as const };
		writeNestedControlRequest(route, request);
		const script = `import { writeNestedControlResult } from ${JSON.stringify(path.resolve("src/runs/shared/nested-events.ts"))}; const route=JSON.parse(process.argv[1]); writeNestedControlResult(route,{ts:2,requestId:"fresh-result-request",targetRunId:"nested-child",ok:true,message:"child-durable"});`;
		const childProcess = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, JSON.stringify(route)], { stdio: ["ignore", "pipe", "pipe"] });
		const [code] = await once(childProcess, "close");
		assert.equal(code, 0);
		resetNestedJournalRuntime(route);
		assert.equal(claimNestedControlRequest(route, request.requestId), "completed");
		assert.equal(readNestedControlResult(route, request.requestId)?.message, "child-durable");
	});
});

describe("bounded journals and recovery seams", () => {
	it("does not reread historical control/result frames on idle polls", () => {
		const route = trackRoute("bounded-10k");
		writeNestedJournalFixtureForTest(route, 10_000);
		assert.equal(readNestedControlRequests(route).length, 0);
		assert.equal(readNestedControlResults(route).length, 10_000);
		resetNestedJournalRuntime(route);
		assert.equal(readNestedControlRequests(route).length, 0);
		resetNestedJournalWorkCounters();
		assert.equal(readNestedControlRequests(route).length, 0);
		assert.equal(readNestedControlResults(route).length, 10_000);
		assert.deepEqual(getNestedJournalWorkCounters(), { frames: 0, bytes: 0, readdir: 0 });
		writeNestedControlResult(route, { ts: 10_001, requestId: "request-new", targetRunId: "nested-child", ok: true, message: "new" });
		readNestedControlResults(route);
		assert.equal(getNestedJournalWorkCounters().frames, 1);
		assert.equal(getNestedJournalWorkCounters().readdir, 0);
	});

	it("does not reread historical event frames after a 10k checkpoint", () => {
		const route = trackRoute("bounded-events-10k");
		writeNestedEventJournalFixtureForTest(route, Array.from({ length: 10_000 }, (_, index) => ({ type: "subagent.nested.updated" as const, ts: index, parentRunId: route.rootRunId, child: child("event-child", "running", index) })));
		projectNestedEvents(route);
		resetNestedJournalWorkCounters();
		projectNestedEvents(route);
		assert.deepEqual(getNestedJournalWorkCounters(), { frames: 0, bytes: 0, readdir: 0 });
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 10_001, parentRunId: route.rootRunId, child: child("event-child", "running", 10_001) });
		projectNestedEvents(route);
		assert.equal(getNestedJournalWorkCounters().frames, 1);
	});

	it("requires a matching durable result and fails closed after an ambiguous claim", () => {
		const route = trackRoute("ambiguous-control");
		writeNestedControlRequest(route, { ts: 1, requestId: "ambiguous-request", targetRunId: "nested-child", action: "interrupt" });
		assert.throws(() => ackNestedControlRequest(route, "ambiguous-request"), /durable matching result/);
		assert.equal(claimNestedControlRequest(route, "ambiguous-request"), "new");
		resetNestedJournalRuntime(route);
		assert.equal(claimNestedControlRequest(route, "ambiguous-request"), "claimed");
	});

	it("reconciles every compaction fault phase for all journal generations", () => {
		const phases = ["seal", "new", "snapshot", "state", "cleanup"] as const;
		for (const kind of ["event", "control", "result"] as const) for (const phase of phases) {
			const route = trackRoute(`crash-${kind}-${phase}`);
			if (kind === "event") {
				writeNestedEvent(route, { type: "subagent.nested.updated", ts: 1, parentRunId: route.rootRunId, child: child(`child-${kind}-${phase}`, "running", 1) });
				projectNestedEvents(route);
			} else {
				const id = `request-${kind}-${phase}`;
				writeNestedControlRequest(route, { ts: 1, requestId: id, targetRunId: "nested-child", action: "interrupt" });
				if (kind === "result") writeNestedControlResult(route, { ts: 2, requestId: id, targetRunId: "nested-child", ok: true, message: "done" });
				if (kind === "control") readNestedControlRequests(route); else readNestedControlResults(route);
			}
			process.env.PI_NESTED_COMPACTION_BYTES = "1";
			setNestedJournalFaultInjector((current, currentKind) => { if (currentKind === kind && current === phase) throw new Error(`fault-${kind}-${phase}`); });
			assert.throws(() => kind === "event" ? projectNestedEvents(route) : kind === "control" ? readNestedControlRequests(route) : readNestedControlResults(route), /fault-/);
			setNestedJournalFaultInjector(undefined);
			if (kind === "event") assert.equal(projectNestedEvents(route).children[0]?.id, `child-${kind}-${phase}`);
			else if (kind === "control") assert.equal(readNestedControlRequests(route).length, 1);
			else assert.equal(readNestedControlResults(route).length, 1);
			delete process.env.PI_NESTED_COMPACTION_BYTES;
		}
		setNestedJournalFaultInjector(undefined);
	});

	it("imports over 1000 legacy records once and rejects late legacy files", () => {
		const route = trackRoute("legacy-1001");
		const records = Array.from({ length: 1001 }, (_, index) => ({ type: "subagent.nested.updated" as const, ts: index + 1, rootRunId: route.rootRunId, parentRunId: "root-run", parentStepIndex: 1, capabilityToken: route.capabilityToken, child: child("legacy-many", "running", index + 1) }));
		fs.writeFileSync(path.join(route.eventSink, "legacy-many.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
		fs.writeFileSync(path.join(route.eventSink, "legacy-corrupt.json"), "not-json", "utf8");
		fs.writeFileSync(path.join(route.eventSink, "legacy-wrong-token.json"), JSON.stringify({ ...records[0], capabilityToken: "wrong-token" }), "utf8");
		projectNestedEvents(route);
		const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(route.eventSink), ".legacy-import-manifest.json"), "utf8")) as { files: Record<string, { records: string[] }> };
		assert.equal(manifest.files[path.join(route.eventSink, "legacy-many.jsonl")]?.records.length, 1001);
		resetNestedJournalWorkCounters();
		projectNestedEvents(route);
		assert.equal(getNestedJournalWorkCounters().readdir, 0);
		fs.writeFileSync(path.join(route.eventSink, "late-legacy.json"), JSON.stringify(records[0]), "utf8");
		assert.throws(() => projectNestedEvents(route), /Legacy file arrived after migration/);
	});

	it("resumes an incomplete durable manifest after a fresh runtime restart", () => {
		const route = trackRoute("legacy-incomplete-manifest");
		const records = ["one", "two"].map((id, index) => ({ type: "subagent.nested.updated" as const, ts: index + 1, rootRunId: route.rootRunId, parentRunId: "root-run", parentStepIndex: 1, capabilityToken: route.capabilityToken, child: child(`manifest-${id}`, "running", index + 1) }));
		fs.writeFileSync(path.join(route.eventSink, "first.json"), JSON.stringify(records[0]), "utf8");
		fs.writeFileSync(path.join(route.eventSink, "second.json"), JSON.stringify(records[1]), "utf8");
		let crashed = false;
		setNestedJournalFaultInjector((phase, kind) => { if (!crashed && phase === "manifest" && kind === "event") { crashed = true; throw new Error("manifest-crash"); } });
		assert.throws(() => projectNestedEvents(route), /manifest-crash/);
		setNestedJournalFaultInjector(undefined);
		const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(route.eventSink), ".legacy-import-manifest.json"), "utf8")) as { complete: boolean; files: Record<string, { records: string[] }> };
		assert.equal(manifest.complete, false);
		assert.equal(Object.values(manifest.files).reduce((count, file) => count + file.records.length, 0), 1);
		resetNestedJournalRuntime(route);
		const resumed = projectNestedEvents(route);
		assert.equal(resumed.children.filter((item) => item.id.startsWith("manifest-")).length, 2);
		assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(route.eventSink), ".legacy-import-manifest.json"), "utf8")).complete, true);
	});

	it("replays a partially imported mixed legacy file without duplicates", () => {
		const route = trackRoute("legacy-restart");
		const records = Array.from({ length: 5 }, (_, index) => ({ type: "subagent.nested.updated" as const, ts: index + 1, rootRunId: route.rootRunId, parentRunId: "root-run", parentStepIndex: 1, capabilityToken: route.capabilityToken, child: child(`legacy-${index}`, "running", index + 1) }));
		fs.writeFileSync(path.join(route.eventSink, "legacy.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
		let states = 0;
		setNestedJournalFaultInjector((phase, kind) => { if (phase === "state" && kind === "event" && ++states === 1) throw new Error("legacy crash"); });
		assert.throws(() => projectNestedEvents(route), /legacy crash/);
		setNestedJournalFaultInjector(undefined);
		const registry = projectNestedEvents(route);
		assert.equal(registry.children.filter((item) => item.id.startsWith("legacy-")).length, 5);
		resetNestedJournalRuntime(route);
		assert.equal(projectNestedEvents(route).children.filter((item) => item.id.startsWith("legacy-")).length, 5);
		assert.equal(fs.existsSync(path.join(route.eventSink, "legacy.jsonl")), true);
	});
});

describe("nested route lock identity", () => {
	it("fails closed on malformed ownership metadata and recovers only stale exact identities", () => {
		const route = trackRoute("lock-identity");
		const lock = path.join(path.dirname(route.eventSink), ".route.lock");
		fs.mkdirSync(lock, { mode: 0o700 });
		fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: "not-an-integer", uid: process.getuid?.() ?? 0, startToken: "x" }), { mode: 0o600 });
		assert.throws(() => writeNestedEvent(route, { type: "subagent.nested.updated", ts: 1, parentRunId: route.rootRunId, child: child("locked", "running", 1) }), /ambiguous|trusted|identity/);
		fs.rmSync(lock, { recursive: true, force: true });
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 2, parentRunId: route.rootRunId, child: child("locked", "running", 2) });
		assert.equal(projectNestedEvents(route).children[0]?.id, "locked");
	});

	it("retries live lock contention until the owner releases without dropping the append", async () => {
		const route = trackRoute("lock-contention");
		const lock = path.join(path.dirname(route.eventSink), ".route.lock");
		const script = `const fs=require('node:fs'); const lock=process.argv[1]; fs.mkdirSync(lock,{mode:0o700}); const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8'); const close=stat.lastIndexOf(')'); const startToken=stat.slice(close+2).trim().split(/\\s+/)[19]; fs.writeFileSync(lock+'/owner',JSON.stringify({pid:process.pid,uid:process.getuid(),startToken,token:'live-owner-token'}),{mode:0o600}); fs.chmodSync(lock+'/owner',0o600); process.stdout.write('ready'); setTimeout(()=>fs.rmSync(lock,{recursive:true,force:true}),150);`;
		const owner = spawn(process.execPath, ["-e", script, lock], { stdio: ["ignore", "pipe", "inherit"] });
		await once(owner.stdout!, "data");
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 1, parentRunId: route.rootRunId, child: child("contended", "running", 1) });
		await once(owner, "close");
		assert.equal(projectNestedEvents(route).children[0]?.id, "contended");
	});
});
