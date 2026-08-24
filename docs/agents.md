# Packaged and custom agents

## Packaged agents

| Agent | Default role and access |
| --- | --- |
| `explore` | Finds relevant files, symbols, tests, and call paths. Read-only Git; no edits. |
| `research` | Uses web/docs tools to return sourced research. Read-only Git. Install `pi-web-access` when those tools are unavailable. |
| `review` | Reviews a diff, plan, or implementation and reports evidence. Read-only Git; do not treat it as a writer. |
| `work` | Implements an approved task, validates it, and escalates unapproved decisions. Isolated Git by default. |
| `orchestrator` | Coordinates explore → work → review for one issue. Isolated Git by default and bounded nested delegation. |

Packaged `explore`, `research`, and `review` use Bubblewrap, `host-toolchain`, host networking, Pi JSON auth, closed package discovery, and `fallback: fail`. Packaged `work` and `orchestrator` use the same sandbox defaults but `sandboxGitMode: isolated`. Direct launches receive one managed isolated worktree; nested calls inherit the parent's scoped endpoint.

!!! note "The name is not authority"
    A child called `work` is not automatically allowed to integrate its result. The parent remains the integration owner; inspect the result and recovery bundle before applying it.

## Custom agents

Create a project agent in `.pi/agents/<name>.md` or a user agent in `~/.pi/agent/agents/<name>.md`:

```yaml
---
name: focused-review
description: Review one subsystem without edits
tools: read, grep, find, ls, bash
sandboxProvider: bubblewrap
sandboxGitMode: read-only
sandboxProfile: host-toolchain
sandboxNetwork: host
sandboxAuth: pi-json
sandboxFallback: fail
sandboxPackageDiscovery: closed
defaultContext: fresh
canBeChangedByAgent: output, acceptance.criteria, acceptance.evidence
---
Inspect the assigned subsystem and return concise evidence. Do not edit files.
```

Project agents override same-named user and packaged agents. Keep custom agents read-only unless the role truly needs writing.

For a writer, declare the required tools (`edit`/`write`), choose `sandboxGitMode: isolated` deliberately, and tell the child whether it must commit. Do not combine isolated Git with parent-managed `worktree: true`; see [Git, worktrees & recovery](git-worktrees.md).

## Permission boundaries

`canBeChangedByAgent` is an allowlist for guarded run overrides. Omitted or empty means no agent-specific overrides. `canOptOutOfWorktree: true` only permits the narrowing `worktree: false` request when the trusted user-global ceiling also allows it; it does not grant host-Git or sandbox opt-out authority.

Useful fields include:

- `tools`: builtin tools, plus explicitly allowed `subagent` for nested delegation.
- `defaultContext`: usually `fresh` for focused children.
- `inheritProjectContext` and `inheritSkills`: opt into inherited instructions/catalogue intentionally.
- `sandbox*`: agent-level sandbox defaults; narrower run options still require permission.
- `acceptanceSelfReview` and `acceptanceMaxFinalizationTurns`: same-session checking after completion.

For the complete field-by-field list, use the [settings reference](settings-reference.md). To change packaged defaults without copying the agent, use `agentOverrides` in settings.
