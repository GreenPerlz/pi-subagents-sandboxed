import assert from "node:assert/strict";
import test from "node:test";
import { formatAsyncRunnerIdentity, checkExpectedAsyncRunnerPid, isExpectedAsyncRunnerPid } from "../../src/runs/background/pid-identity.ts";

const runner = "/tmp/src/subagent-runner.ts";
const config = "/tmp/async-cfg-run-a.json";
const identity = formatAsyncRunnerIdentity(runner, config, "run-a", "start-a", 1000);
const cmdline = (value: string[] | undefined) => () => value;
const start = () => "start-a";
const uid = () => 1000;

test("persisted PID identity requires exact runner/config argv entries", () => {
	assert.equal(isExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(["node", runner, config]), "linux", start, uid), true);
	assert.equal(isExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(["node", runner, "/tmp/async-cfg-run-b.json"]), "linux", start, uid), false);
	assert.equal(isExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(["node", `${runner}-evil`, config]), "linux", start, uid), false);
	assert.equal(isExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(["node", runner, config, "--same-uid-suffix-impostor"]), "linux", start, uid), false);
	assert.equal(isExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(undefined), "linux", start, uid), false);
	assert.equal(checkExpectedAsyncRunnerPid(42, "run-a", undefined, cmdline(["node", runner, config]), "linux", start, uid).ok, false);
	assert.equal(checkExpectedAsyncRunnerPid(42, "run-a", identity, cmdline(["node", runner, config]), "darwin", start, uid).ok, false);
});
