# Issue #15 reproduction: ralph-orchestrator runaway nested workers

This fixture documents a deterministic, safe reproduction of the runaway pattern reported in issue #15. It does **not** launch real Pi subagents; it models the relevant tool-contract and async-launch states in an isolated temporary git repository so the failure can be inspected without risking nested worker fanout.

Run:

```sh
node scripts/reproduce-issue-15.mjs
```

The script creates `/tmp/pi-issue-15-repro-*`, initializes a clean git repo, emits event logs, and writes `issue-15-repro-log.json` inside the temp repo.

## What the scenario demonstrates

1. `ralph-orchestrator` attempts a malformed nested `subagent` call:
   - `{ tasks: [{ agent: "worker" }], async: true }`
   - The parallel task is missing the required `task` string.
2. The simulated tool contract rejects the call before any worker starts.
3. The orchestrator prompt behavior is then reproduced by retrying another nested `subagent` call after the validation failure instead of halting or asking for supervision.
4. Two well-formed `async: true` single-worker calls are launched back-to-back.
5. The second async launch records `activeWorkersBefore: 1`, proving more than one worker can be started before the first completes when the parent/orchestrator keeps calling the tool.

Representative log excerpt:

```text
01 safe_fixture_ready {"repoDir":"/tmp/pi-issue-15-repro-..."}
02 nested_subagent_attempt {"by":"ralph-orchestrator","note":"malformed parallel task: missing required task string",...}
03 validation_failed {"by":"subagent tool contract","reason":"tool-contract validation failure: tasks[0] requires string agent and task"}
04 nested_subagent_attempt {"by":"ralph-orchestrator","note":"runaway retry after validation failure with the same malformed call",...}
05 validation_failed {"by":"subagent tool contract","reason":"tool-contract validation failure: tasks[0] requires string agent and task"}
06 nested_subagent_attempt {"by":"ralph-orchestrator","note":"first well-formed async worker launch",...}
07 async_start {"runId":"issue15-worker-1","agent":"worker","async":true,"activeWorkersBefore":0,"activeWorkersAfter":1}
08 nested_subagent_attempt {"by":"ralph-orchestrator","note":"second async launch before first worker completion",...}
09 async_start {"runId":"issue15-worker-2","agent":"worker","async":true,"activeWorkersBefore":1,"activeWorkersAfter":2}
```

## Root cause analysis

- **Prompt failure:** `ralph-orchestrator` can continue issuing nested `subagent` calls after a malformed nested call or validation failure. The prompt-level failure is the lack of a stop/escalate behavior after the tool says the nested call is invalid.
- **Tool-contract validation failure:** malformed parameters are rejected before child launch. In the fixture, `tasks[0].task` is missing, so no worker starts for those attempts.
- **Async launch behavior:** `async: true` returns after the background worker is started, not after it completes. If the orchestrator makes another nested call immediately, another worker can start while the first is still running.
- **Sandbox/worktree failures:** not involved in this reproduction. The fixture initializes a clean temp git repo and does not inject sandbox or worktree setup errors. Those failures may be noisy in real runs, but they are distinct from the repeated parent-side nested-launch behavior.

## Recommended fix path

Create follow-up implementation issues around a parent-side nested-launch guard rather than changing the reproduction fixture:

1. Add a `ralph-orchestrator`/nested-subagent launch ledger keyed by parent session/run, target agent, normalized task shape, and async state.
2. On tool-contract validation failure from a nested `subagent` call, mark the parent/orchestrator as needing attention or force a supervisor decision before allowing another nested launch attempt.
3. Before `async: true` launch, check the ledger for an equivalent running child and either return the existing run id/status or reject with an actionable guardrail message.
4. Surface the intervention point in logs/status: after `validation_failed` and before retry/duplicate `async_start`.
5. Keep sandbox/worktree setup diagnostics separate so they do not mask whether the duplicate launch happened before or after child setup.

Validation commands used for this reproduction:

```sh
node scripts/reproduce-issue-15.mjs
node --experimental-strip-types --test test/unit/issue-15-reproduction.test.ts
```
