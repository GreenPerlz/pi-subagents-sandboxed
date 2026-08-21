import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import {
	createNestedRoute,
	hasLiveNestedDescendants,
	hasLiveNestedDescendantsForParent,
	nestedSummaryFromAsyncStatus,
	selectNestedChildrenForParent,
	parseNestedEventRecords,
	projectNestedEvents,
	resolveNestedParentAddressFromEnv,
	resolveNestedRouteFromEnv,
	updateAsyncJobNestedProjection,
	updateForegroundNestedProjection,
	waitForNestedDescendantsToStop,
	writeNestedEvent,
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
			assert.equal(result.observed, false);
			assert.equal(result.stopped, true);
			assert.ok(Date.now() - started < 100, "an empty route should not wait for the timeout");
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
