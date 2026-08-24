# Common workflows

Natural-language requests are the preferred interface. The tool-call forms below are useful for agents and integrations that need explicit structure.

## Explore before changing

```text
Use explore to find the smallest relevant files and tests for the authentication bug. Return findings inline; do not edit.
```

```ts
await subagent({
  agent: "explore",
  task: "Find the smallest relevant files, tests, and call paths for the authentication bug. Return findings inline; do not edit.",
  async: false
});
```

## Implement, then review

```text
Have work implement this approved plan in the current checkout. After it finishes, use a fresh review agent to inspect the actual diff. Do not commit or integrate without my review.
```

```ts
await subagent({
  agent: "work",
  task: "Implement the approved plan in the current checkout. Validate it and return changed files, commands, and risks.",
  async: false
});
await subagent({
  agent: "review",
  task: "Inspect the current git diff and status. Review correctness, tests, scope, and safety; do not edit.",
  async: false
});
```

The packaged orchestrator can coordinate this pattern, but it still does not replace parent review or integration ownership:

```text
Have orchestrator own this issue: explore first, have work implement, then have a fresh review inspect the diff. Keep the handoffs inline and stop on an unapproved decision.
```

## Research with sources

```text
Use research to check the official API docs and summarize constraints with links. Do not modify the repository.
```

Research requires the web-access tools supplied by `pi-web-access` when they are not already available.

## Parallel read-only audits

```text
Run parallel reviews: one for correctness, one for tests, and one for unnecessary complexity. Keep all agents read-only.
```

```ts
await subagent({
  tasks: [
    { agent: "review", task: "Review correctness of the current diff." },
    { agent: "review", task: "Review test coverage and edge cases." }
  ],
  concurrency: 2,
  async: false
});
```

Do not run multiple writers against one checkout. For independent writers, use either parent-managed worktrees or isolated Git, never both in one launch; see [Git, worktrees & recovery](git-worktrees.md).

## Chains and saved workflows

```text
/chain research "check external constraints" -> work "implement the approved change" -> review "inspect the diff"
/parallel research "research frontend constraints" -> review "audit backend"
/run-chain review-chain -- review the current branch
```

A chain passes the previous result through `{previous}` unless a step supplies another task. Keep task-specific output inline unless persistence is intentional. Use `output`, `outputMode: file-only`, `reads`, or `progress` only when the workflow needs files.

## Structured acceptance

When a parent has explicit acceptance criteria, include them in the tool call and require evidence. A child must not claim review or verification it did not perform:

```ts
await subagent({
  agent: "work",
  task: "Implement the approved documentation change.",
  acceptance: {
    criteria: [{ id: "docs", must: "The site builds strictly and links are valid." }],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"],
    verify: [{ id: "build", command: "mkdocs build --strict" }],
    review: { agent: "review", focus: "navigation, links, and accuracy", required: true },
    stopRules: ["Do not alter runtime behavior."]
  },
  async: false
});
```

Acceptance permissions are guarded by the target agent's frontmatter. Read the [settings reference](settings-reference.md) for all fields.
