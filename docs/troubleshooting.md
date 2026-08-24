# Troubleshooting and doctor

Start with the read-only doctor action:

```text
/subagents-doctor
```

```ts
subagent({ action: "doctor" })
```

It reports setup and discovery diagnostics without changing configuration. Then inspect the exact run status and result details.

## Common symptoms

### `bwrap` is missing or sandbox setup fails

Install Bubblewrap and verify `bwrap --version`. Packaged agents use `fallback: fail`, so a missing provider should stop the child rather than silently run on the host. Do not solve this by setting `provider: none`; that is a trusted user-global opt-out.

### A tool is not found inside the child

Re-run the smallest failing command and inspect the sandbox diagnostic. If the tool exists on the host but is not mounted, add only its containing directory to `extraReadOnlyMounts`. If it is not installed on the host, install it outside the child and retry.

### Writes fail with `EACCES`, `EPERM`, or `EROFS`

Check both tool/write inference and Git mode. `edit`/`write` agents get writable cwd access; bash-only agents need explicit trusted `sandboxBashWrite: true`. For a cache or output, use a narrow `extraWritableMounts` path. Do not make the whole home directory writable.

### The child cannot call another agent

Nested delegation requires `subagent` in the resolved child tool allowlist, plus a remaining `maxSubagentDepth`. A visible nested route does not bypass those checks. Packaged `explore`, `research`, `review`, and `work` are intentionally not general nested fanout agents.

### Async work appears stalled

Use `subagent({ action: "status", id: "..." })`. Needs-attention notices may suggest status, interrupt, or a follow-up. `interrupt` is pause-oriented for detached runs; use `resume` with a message when the session is reachable or persisted. See [async lifecycle](async-lifecycle.md).

### Completion disappeared after reload

Look up the persisted run and configured session directory. Startup reconciliation repairs stale projections, while revival requires the child `.jsonl` session. A missing session cannot be revived; use preserved output or Git recovery evidence instead.

### An isolated writer failed

Read the original error and the returned `gitBundle` metadata. Verify the bundle with ordinary Git tools, inspect authored commits separately from runtime recovery commits, and use the preserved worktree path if export failed. The parent—not the child—decides whether to cherry-pick or apply a reviewed patch.

### Parallel work conflicts

Do not run writers in one checkout. Use parent-managed `worktree: true` only for agents that explicitly permit it, or use isolated Git without `worktree: true`. Ensure the parent checkout is clean before parent-managed worktrees are created.

## Evidence to collect

When reporting a problem, include:

- agent name and execution mode,
- exact command/tool call and run id,
- doctor output and `status` details,
- sandbox provider/profile/fallback diagnostics (including whether fallback occurred),
- Git mode and bundle path/checksum if present,
- the original error and the smallest reproducible command.

Redacted mount paths are intentional. Do not paste auth files, full environment dumps, or broad home-directory listings into a report.
