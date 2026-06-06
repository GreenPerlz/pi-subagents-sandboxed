import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { computeAsyncFingerprint } from "../../src/runs/background/async-duplicate-guard.ts";
import { createNestedRoute, nestedRouteEnv } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";

const savedEnv: Record<string, string | undefined> = {
	[SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
	[SUBAGENT_FANOUT_CHILD_ENV]: process.env[SUBAGENT_FANOUT_CHILD_ENV],
};

const tempDirs: string[] = [];

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const set = listeners.get(channel) ?? new Set();
			set.add(handler);
			listeners.set(channel, set);
			return () => {
				set.delete(handler);
				if (set.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
		},
	};
}

describe("issue #35 fanout child duplicate async guard", () => {
	it("blocks a second equivalent nested async launch after the first is tracked", async () => {
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		const route = createNestedRoute("root-issue-35-" + Date.now());
		for (const [key, value] of Object.entries(nestedRouteEnv(route))) {
			process.env[key] = value;
		}
		process.env.SUBAGENT_PARENT_RUN_ID_ENV = route.rootRunId;

		const events = createEventBus();
		let registeredTool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> } | undefined;
		const fakePi = {
			events,
			registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) {
				registeredTool = tool as typeof registeredTool & { execute: (...args: unknown[]) => Promise<unknown> };
			},
			getSessionName() {
				return undefined;
			},
		};

		registerFanoutChildSubagentExtension(fakePi as any);
		assert.ok(registeredTool, "subagent tool should be registered");

		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId() {
					return "session-test";
				},
				getSessionFile() {
					return null;
				},
			},
			modelRegistry: {
				getAvailable() {
					return [];
				},
			},
		};

		const asyncDir = path.join(os.tmpdir(), `pi-issue-35-${Date.now()}`);
		tempDirs.push(asyncDir);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({ state: "running" }),
		);

		const fingerprint = computeAsyncFingerprint({
			mode: "single",
			items: [{ kind: "task", agent: "reviewer", task: "review code", cwd: ctx.cwd }],
			cwd: ctx.cwd,
			nestedRoute: route,
		});

		// Simulate a prior nested async launch by emitting the started event
		const runId = `run-first-${Date.now()}`;
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: runId,
			pid: 12345,
			mode: "single",
			agent: "reviewer",
			task: "review code",
			cwd: ctx.cwd,
			asyncDir,
			nestedRoute: route,
			duplicateFingerprint: fingerprint,
		});

		// Attempt an equivalent second launch
		const result = await registeredTool!.execute(
			"second-launch",
			{ agent: "reviewer", task: "review code", async: true },
			new AbortController().signal,
			undefined,
			ctx as any,
		);

		assert.equal(result.isError, true, "expected duplicate block to return an error");
		const text = result.content?.[0]?.text ?? "";
		assert.match(text, /Duplicate async run blocked/, "expected duplicate block message");
		assert.match(text, new RegExp(runId), "expected reference to existing run id");
		assert.match(text, /confirmationToken/, "expected confirmation token to be offered");
	});
});
