# Handoff: async subprocess cleanup

## Repository

Work is in `/home/greenperl/Projects/pi-subagents-sandboxed`, on `main`. This is the only Git worktree. The repository already had many uncommitted changes before this cleanup work. Do not reset, clean, or commit the whole tree without checking those changes first.

## Incident and root cause

The async workload left descendants alive after interruption or wrapper exit. The process shape was effectively:

```text
async runner -> Bubblewrap -> child Pi -> shell/tool descendants
```

There were two cleanup gaps:

1. The background runner kept one active child interrupt callback. In parallel runs, interrupting the runner reached only the last registered child.
2. Cleanup signalled only the direct child. Bubblewrap, shells, and tools could keep running after that wrapper exited. Bubblewrap also did not have a parent-death rule.

A failed detached-runner spawn could also leave its JSON config file under `/tmp`.

## Why the old parent-stop behavior was insufficient

The extension already had several best-effort shutdown paths:

- Normal session shutdown sends `SIGUSR2` to the detached async runner.
- The runner polls `ownerPid` and tries to pause itself when the owner disappears.
- Stale-run reconciliation repairs persisted state later if a runner is orphaned.

Those mechanisms do not make parent death propagate through the OS. `SIGTERM`, `SIGKILL`, or a parent process exit does not automatically signal its children. The old shutdown code also targeted the runner or direct child PID, not the child’s process group. Detached processes are especially important here: `detached: true` creates a separate process group/session, so terminal or parent signals do not naturally reach the descendants. A stalled or swapped-out event loop can also delay the owner-liveness timer.

The new process-group signalling and Bubblewrap `--die-with-parent` cover the abrupt-exit case, while the existing shutdown paths still handle graceful session shutdown.

## Changes made

### Process groups and descendant cleanup

- `src/runs/background/subagent-runner.ts`
  - Runs child Pi processes with `detached: true` on POSIX.
  - Registers every active child interrupt callback in a `Set`, including parallel and dynamic fanout children.
  - Interrupts all registered children and removes the signal handler during final cleanup.
  - Uses process-group signalling for interrupt, termination, and forced-kill paths.
  - Enables process-group cleanup when post-exit stdio remains open.

- `src/runs/foreground/execution.ts`
  - Applies the same detached process-group and group-signal handling to foreground children.
  - Keeps post-exit cleanup from leaving foreground descendants behind.

- `src/shared/post-exit-stdio-guard.ts`
  - Adds `signalChildProcessGroup()`.
  - On POSIX, a negative child PID targets that detached child’s private process group.
  - Idle and hard stdio cutoffs now terminate the process group before destroying pipes.
  - Direct-child signalling remains the fallback.

- `src/sandbox/bubblewrap.ts`
  - Adds `--die-with-parent`, so Bubblewrap’s wrapped command exits when its runner disappears.

- `src/runs/background/async-execution.ts`
  - Removes the detached-runner config if spawn/exec fails before the runner can remove it.

### Regression coverage

- `test/unit/close-grace-timer.test.ts` verifies that a grandchild in a detached process group is killed after the parent exits while stdio remains open.
- `test/unit/sandbox-bubblewrap.test.ts` verifies `--die-with-parent` is present.
- `test/integration/async-execution.test.ts` covers the async lifecycle and isolated-run cleanup paths already in this working tree.

## Verification

Commands that passed:

```text
npm test
# 1021 tests passed

node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts
# 74 tests passed
```

After the integration run there were no remaining `subagent-runner`, mock Pi, or async config processes/files, and no processes were in D-state.

## Follow-up notes

- The fixes are uncommitted and mixed with the repository’s other existing work. Keep them in place, but review the complete diff before committing.
- There is no separate source checkout for a Pi subagent. The extension imports these `src/runs` modules directly from this repository.
- If a future test reports a surviving descendant, inspect the process group first with `ps -eo pid,ppid,pgid,sid,stat,args` and check whether the child was spawned with `detached: true`.
