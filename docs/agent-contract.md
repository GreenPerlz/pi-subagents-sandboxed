# Agent-facing integration contract

This contract is for parent and child agents. It is intentionally explicit so a child can work without guessing authority.

## Before launch

- [ ] Restate the task, scope, and success evidence.
- [ ] Choose the narrowest packaged/custom role: explore for discovery, work for edits, review for inspection, research for sourced external facts.
- [ ] Give a writer one clear checkout and avoid concurrent writes to the same path.
- [ ] Keep packaged sandbox and Git defaults unless a trusted, permitted override is required.
- [ ] Bound nested fanout with `maxSubagentDepth`; enable `subagent` only for agents that need it.
- [ ] Decide whether output should be inline; request files only intentionally with `output`, `reads`, or `progress`.

## While working

- [ ] Treat inherited instructions and the assigned task as constraints, not permission to invent APIs or decisions.
- [ ] Read only the files needed for the task; report evidence with paths and commands.
- [ ] Re-run focused checks inside the effective sandbox when diagnosing access failures.
- [ ] Use the narrowest read-only mount for a host tool and the narrowest writable mount for a cache/output/work path.
- [ ] Escalate an unapproved product, architecture, scope, or safety decision with `contact_supervisor` and `reason: "need_decision"`; do not guess.
- [ ] Send `progress_update` only when a meaningful discovery changes the plan. Do not send routine completion handoffs.

## Before completion

- [ ] Validate the requested behavior and report exact commands/results.
- [ ] Report changed files, residual risks, and any incomplete work.
- [ ] Keep read-only/review agents read-only.
- [ ] For an isolated writer, author only the intended commits and leave the isolated checkout clean when the contract requires it.
- [ ] Distinguish child-authored commits from runtime packaging/recovery commits.
- [ ] Return the sandbox diagnostic and Git bundle reference when available; do not claim isolation without evidence.

## Integration handoff

The parent owns canonical Git integration. A child must not:

- cherry-pick into, merge, reset, or rewrite the parent checkout;
- treat a nested route or intercom connection as Git authority;
- combine `sandboxGitMode: isolated` with parent-managed `worktree: true`;
- widen inherited mounts, network, credentials, package discovery, or depth limits;
- hide failures because a recovery bundle or temporary worktree exists.

The parent should inspect bundles, verify checksums/refs, review authored commits and recovery state, integrate deliberately, run tests, and preserve the original error if export failed. A failure is evidence to recover, not permission to discard.

## Minimal completion report

```text
Implemented: <behavior or explicit blocker>
Changed files: <paths>
Validation: <commands and results>
Sandbox/Git: <effective diagnostics and bundle reference>
Open risks: <remaining uncertainty>
Recommended parent action: <review, integrate, recover, or decide>
```
