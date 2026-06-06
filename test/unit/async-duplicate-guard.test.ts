import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkAsyncDuplicateLaunch,
	computeAsyncFingerprint,
	formatDuplicateBlockedMessage,
} from "../../src/runs/background/async-duplicate-guard.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

function createMockState(jobs: AsyncJobState[] = []): SubagentState {
	return {
		baseCwd: "/tmp",
		currentSessionId: null,
		asyncJobs: new Map(jobs.map((job) => [job.asyncId, job])),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => true, clear: () => {} },
	};
}

function mockJob(overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: "run-1",
		asyncDir: "/tmp/async/run-1",
		status: "running",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resultText(result: NonNullable<ReturnType<typeof checkAsyncDuplicateLaunch>>): string {
	return (result.content[0] as { text: string }).text;
}

function extractConfirmationToken(text: string): string {
	const match = text.match(/confirmationToken: "([^"]+)"/);
	assert.ok(match, `expected confirmationToken in message: ${text}`);
	return match[1]!;
}

describe("computeAsyncFingerprint", () => {
	it("produces identical fingerprints for equivalent inputs", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(a, b);
	});

	it("differs when mode changes", () => {
		const single = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const parallel = computeAsyncFingerprint({
			mode: "parallel",
			items: [{ kind: "parallel", tasks: [{ agent: "worker", task: "do thing", cwd: "/project" }] }],
			cwd: "/project",
		});
		assert.notEqual(single, parallel);
	});

	it("differs when cwd changes", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project/a" }],
			cwd: "/project/a",
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project/b" }],
			cwd: "/project/b",
		});
		assert.notEqual(a, b);
	});

	it("matches identical top-level async invocations using stable session scope", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-1",
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-1",
		});
		assert.equal(a, b);
	});

	it("differs for top-level async invocations with different session scopes", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-a",
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-b",
		});
		assert.notEqual(a, b);
	});

	it("differs when nested route changes", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			nestedRoute: {
				rootRunId: "parent-a",
				eventSink: "/tmp/a",
				controlInbox: "/tmp/a-ctl",
				capabilityToken: "tok-a",
			},
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			nestedRoute: {
				rootRunId: "parent-b",
				eventSink: "/tmp/b",
				controlInbox: "/tmp/b-ctl",
				capabilityToken: "tok-b",
			},
		});
		assert.notEqual(a, b);
	});

	it("scopes inherited nested invocations by rootRunId so different parents do not collide", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "same-session",
			nestedRoute: {
				rootRunId: "parent-a",
				eventSink: "/tmp/a",
				controlInbox: "/tmp/a-ctl",
				capabilityToken: "tok-a",
			},
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "same-session",
			nestedRoute: {
				rootRunId: "parent-b",
				eventSink: "/tmp/b",
				controlInbox: "/tmp/b-ctl",
				capabilityToken: "tok-b",
			},
		});
		assert.notEqual(a, b);
	});

	it("normalizes whitespace in task text", () => {
		const a = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do  thing", cwd: "/project" }],
			cwd: "/project",
		});
		const b = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(a, b);
	});

	it("includes all agents and tasks in order for chain", () => {
		const fp = computeAsyncFingerprint({
			mode: "chain",
			items: [
				{ kind: "task", agent: "scout", task: "find", cwd: "/project" },
				{ kind: "task", agent: "worker", task: "fix", cwd: "/project" },
				{ kind: "task", agent: "reviewer", task: "review", cwd: "/project" },
			],
			cwd: "/project",
		});
		assert.ok(fp.includes("scout"));
		assert.ok(fp.includes("worker"));
		assert.ok(fp.includes("reviewer"));
		assert.ok(fp.includes("find"));
		assert.ok(fp.includes("fix"));
		assert.ok(fp.includes("review"));
	});

	it("preserves chain topology so parallel group boundaries do not collide with sequential order", () => {
		const parallelThenSeq = computeAsyncFingerprint({
			mode: "chain",
			items: [
				{ kind: "parallel", tasks: [{ agent: "a", task: "ta", cwd: "/p" }, { agent: "b", task: "tb", cwd: "/p" }] },
				{ kind: "task", agent: "c", task: "tc", cwd: "/p" },
			],
			cwd: "/p",
		});
		const seqThenParallel = computeAsyncFingerprint({
			mode: "chain",
			items: [
				{ kind: "task", agent: "a", task: "ta", cwd: "/p" },
				{ kind: "parallel", tasks: [{ agent: "b", task: "tb", cwd: "/p" }, { agent: "c", task: "tc", cwd: "/p" }] },
			],
			cwd: "/p",
		});
		assert.notEqual(parallelThenSeq, seqThenParallel);
	});

	it("differs when per-item cwd changes", () => {
		const a = computeAsyncFingerprint({
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/a" },
					{ agent: "worker", task: "do thing", cwd: "/project/b" },
				],
			}],
			cwd: "/project",
		});
		const b = computeAsyncFingerprint({
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/a" },
					{ agent: "worker", task: "do thing", cwd: "/project/c" },
				],
			}],
			cwd: "/project",
		});
		assert.notEqual(a, b);
	});
});

describe("checkAsyncDuplicateLaunch", () => {
	it("allows launch when no active job matches fingerprint", () => {
		const state = createMockState([]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("blocks duplicate single async worker", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.match(
			(result!.content[0] as { text: string }).text,
			/Duplicate async run blocked/,
		);
		assert.match(
			(result!.content[0] as { text: string }).text,
			/run-a/,
		);
	});

	it("blocks duplicate top-level async invocations using stable session scope", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-1",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-1",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.match(
			(result!.content[0] as { text: string }).text,
			/Duplicate async run blocked/,
		);
		assert.match(
			(result!.content[0] as { text: string }).text,
			/run-a/,
		);
	});

	it("does not collide top-level duplicates across different sessions", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-a",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			sessionId: "sess-b",
		});
		assert.equal(result, null);
	});

	it("permits second launch only with the generated token and reason", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const blocked = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.ok(blocked);
		const token = extractConfirmationToken(resultText(blocked));
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: token,
			confirmationReason: "I need a second instance",
		});
		assert.equal(result, null);
	});

	it("blocks when generated token is reused after a permitted launch", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const blocked = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.ok(blocked);
		const token = extractConfirmationToken(resultText(blocked));
		assert.equal(checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: token,
			confirmationReason: "I need a second instance",
		}), null);
		const reused = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: token,
			confirmationReason: "I need a third instance",
		});
		assert.ok(reused);
		assert.equal(reused!.isError, true);
		assert.match(resultText(reused!), /invalid|expired|used|match/i);
	});

	it("blocks when invalid token is present with reason", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: "ack",
			confirmationReason: "I need a second instance",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.match(resultText(result!), /invalid|expired|used|match/i);
	});

	it("blocks when token is present but reason is missing", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: "ack",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
	});

	it("blocks when reason is present but token is missing", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationReason: "I need a second instance",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
	});

	it("blocks when token is empty string", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
			confirmationToken: "",
			confirmationReason: "reason",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
	});

	it("allows launch when existing job is complete", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "complete", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("allows launch when existing job is failed", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "failed", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("allows launch when existing job is paused", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "paused", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("does not block distinct task", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do other thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("does not block distinct agent", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "reviewer", task: "do thing", cwd: "/project" }],
			cwd: "/project",
		});
		assert.equal(result, null);
	});

	it("does not block distinct cwd", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project/a" }],
			cwd: "/project/a",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "single",
			items: [{ kind: "task", agent: "worker", task: "do thing", cwd: "/project/b" }],
			cwd: "/project/b",
		});
		assert.equal(result, null);
	});

	it("does not treat repeated agents within same invocation as duplicate", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "chain",
			items: [
				{ kind: "task", agent: "worker", task: "step 1", cwd: "/project" },
				{ kind: "task", agent: "worker", task: "step 2", cwd: "/project" },
			],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "chain",
			items: [
				{ kind: "task", agent: "worker", task: "step 1", cwd: "/project" },
				{ kind: "task", agent: "worker", task: "step 2", cwd: "/project" },
			],
			cwd: "/project",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
	});

	it("does not block parallel vs chain when flattened agents/tasks would match but topology differs", () => {
		const chainFp = computeAsyncFingerprint({
			mode: "chain",
			items: [
				{ kind: "parallel", tasks: [{ agent: "a", task: "t", cwd: "/p" }, { agent: "b", task: "t", cwd: "/p" }] },
				{ kind: "task", agent: "c", task: "t", cwd: "/p" },
			],
			cwd: "/p",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: chainFp }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "chain",
			items: [
				{ kind: "task", agent: "a", task: "t", cwd: "/p" },
				{ kind: "parallel", tasks: [{ agent: "b", task: "t", cwd: "/p" }, { agent: "c", task: "t", cwd: "/p" }] },
			],
			cwd: "/p",
		});
		assert.equal(result, null);
	});

	it("blocks when per-child cwd matches and everything else matches", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/child-a" },
					{ agent: "reviewer", task: "do thing", cwd: "/project/child-b" },
				],
			}],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/child-a" },
					{ agent: "reviewer", task: "do thing", cwd: "/project/child-b" },
				],
			}],
			cwd: "/project",
		});
		assert.ok(result);
		assert.equal(result!.isError, true);
	});

	it("does not block when per-child cwd differs in parallel", () => {
		const fingerprint = computeAsyncFingerprint({
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/child-a" },
					{ agent: "reviewer", task: "do thing", cwd: "/project/child-b" },
				],
			}],
			cwd: "/project",
		});
		const state = createMockState([
			mockJob({ asyncId: "run-a", status: "running", duplicateFingerprint: fingerprint }),
		]);
		const result = checkAsyncDuplicateLaunch(state, {
			mode: "parallel",
			items: [{
				kind: "parallel",
				tasks: [
					{ agent: "worker", task: "do thing", cwd: "/project/child-a" },
					{ agent: "reviewer", task: "do thing", cwd: "/project/child-c" },
				],
			}],
			cwd: "/project",
		});
		assert.equal(result, null);
	});
});

describe("formatDuplicateBlockedMessage", () => {
	it("includes run id and status", () => {
		const msg = formatDuplicateBlockedMessage("run-123", "running", "dup-token");
		assert.match(msg, /run-123/);
		assert.match(msg, /running/);
	});

	it("mentions confirmation token and reason", () => {
		const msg = formatDuplicateBlockedMessage("run-123", "running", "dup-token");
		assert.match(msg, /confirmationToken/);
		assert.match(msg, /dup-token/);
		assert.match(msg, /confirmationReason/);
	});
});
