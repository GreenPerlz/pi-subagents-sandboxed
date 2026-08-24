# Async, nested runs, reload, and control

## Start and observe background work

Add `--bg` to a slash command or pass `async: true`:

```text
/run research audit the external API --bg
```

```ts
const result = await subagent({
  agent: "research",
  task: "Audit the external API and return sourced constraints.",
  async: true
});
```

The initial response identifies the run. Use status by exact id:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
```

Async state is persisted under the runtime temporary scope (`async-subagent-runs/<id>/status.json` and `events.jsonl`), with child session files in the configured session directory. Completion is delivered to the originating session; status and run logs retain child outcomes, nested paths, and sandbox/Git diagnostics.

## Control and revival

```ts
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "Focus on the error-handling path." })
```

`interrupt` is a pause-oriented control for detached async runs; there is no public async cancellation producer today. `cancelled` may appear from foreground `AbortSignal` paths or persisted reconciliation, but it is not an async cancellation API.

While a child is reachable over intercom, `resume` sends a follow-up. After completion, it revives the child from its persisted `.jsonl` session by starting a new process; it does not restart the old OS process. Multi-child foreground/async runs may require `index`:

```ts
subagent({ action: "resume", id: "<run-id>", index: 1, message: "Re-check the failing test." })
```

Revival requires a persisted session. A missing or inaccessible session is a recovery problem, not a reason to claim the old process is alive.

## Reload and stale-run recovery

The extension reconciles persisted runs after reload/startup. A detached child is not considered terminal merely because the parent UI disappeared. Process-group cleanup, Bubblewrap `--die-with-parent`, owner-liveness checks, and stale-run reconciliation cover graceful shutdown and abrupt owner exit. If an isolated worktree export fails, the runtime preserves an actionable path and the original execution error.

Use `/subagents-doctor` or `subagent({ action: "doctor" })` for read-only setup and route diagnostics. See [Troubleshooting & doctor](troubleshooting.md).

## Nested delegation

Only agents whose resolved `tools` explicitly include `subagent` can fan out. Depth limits are inherited monotonically; a nested child cannot loosen an inherited limit. Nested runs appear under the parent status tree and can be addressed with an explicit nested id. In child-safe fanout mode, a bare status request cannot enumerate unrelated top-level runs.

A nested route is an execution route, not Git authority. Nested writers inherit the parent's scoped Git endpoint and do not create another managed worktree. The outer parent still owns integration, recovery, and cleanup. For a bounded nested workflow:

```ts
await subagent({
  agent: "orchestrator",
  task: "Run explore, one work writer, and a fresh review for this issue; stop on decisions.",
  async: false
});
```

## Notifications and intercom

With `pi-intercom` installed and enabled, eligible async/background children can receive a private coordination channel. Children should use `contact_supervisor` with `reason: "need_decision"` for blocking decisions and `progress_update` only for meaningful non-blocking changes. Do not invent a supervisor target or send routine completion handoffs.
