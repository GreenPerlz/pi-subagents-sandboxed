# Mental model and execution modes

## The mental model

Pi is the **parent**. A subagent is a child Pi session with a focused prompt, selected tools, an agent definition, a working directory, and a resolved sandbox policy. The child reports a result; the parent decides what to trust, apply, integrate, or ask next.

An agent definition is Markdown: YAML frontmatter describes identity, tools, model/context defaults, permissions, and sandbox settings; the body is the child system prompt. A run resolves settings in this order:

1. run options (only where the agent permits the override),
2. agent frontmatter,
3. extension defaults.

The child does not automatically gain authority merely because it can see a parent route or because it is nested. See the [agent-facing integration contract](agent-contract.md).

## Choose an execution mode

| Mode | Use it for | Main property |
| --- | --- | --- |
| Single | One focused question or change | One child result |
| Chain | Research → implementation → review | Later steps receive prior output (`{previous}`) |
| Parallel | Independent audits or bounded tasks | Concurrent children; writers need explicit isolation |
| Dynamic fanout | A bounded list discovered by an earlier step | Materializes bounded children and collects results |
| Async/background | Work that can continue after the parent turn | Inspect with `status`; persisted result and session |
| Nested | An agent explicitly allowed to delegate | Child runs appear under the parent run; depth and tools remain bounded |

Natural language is usually enough:

```text
Research the API constraints, have work implement the approved change, then use review on the diff.
```

Exact commands:

```text
/run research check the current API documentation
/chain research "check constraints" -> review "review this diff"
/parallel review "check correctness" -> review "check tests"
/run research "audit the docs" --bg
```

## Foreground versus background

Foreground runs stream results to the current session. Background runs are detached and keep working after control returns; `asyncByDefault` can make top-level calls background when `async` is omitted. Use `async: false` when an orchestrator must receive one result before constructing the next handoff.

`context: fresh` starts an independent child session. `context: fork` branches from a parent session and is a guarded override; do not assume it is allowed for packaged agents.

## A safe orchestration shape

For implementation work, keep one parent-owned checkout and use inline handoffs:

```text
parent-owned worktree → explore (read-only) → work (single writer) → fresh review → optional fix
```

Avoid creating repo-local reports just to pass context unless an explicit `output`, `reads`, or `progress` option requires one. The [workflows](workflows.md) page has concrete prompts and tool calls.
