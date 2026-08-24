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

## Implement, integrate, then review

A direct packaged `work` launch writes and commits inside runtime-issued isolated Git. It does **not** leave a diff in the parent checkout. Ask the parent to verify the returned bundle and authored commits, integrate them deliberately, and only then launch a fresh reviewer against the integrated parent tree:

```text
Have work implement and commit this approved plan in isolated Git. Return the bundle and authored commit evidence. Verify and integrate the reviewed authored commits into the parent checkout, then use a fresh review agent on the integrated tree.
```

**1. Run the isolated writer:**

```ts
const result = await subagent({
  agent: "work",
  task: "Implement the approved plan in isolated Git. Commit the authored change, validate it, and return changed files, commands, risks, and Git bundle evidence.",
  async: false
});
```

**2. Stop and integrate:** the trusted parent verifies the returned checksum and bundle, imports the exact reported refs, inspects the authored commits, and deliberately cherry-picks or applies the intended state. This is an ordinary parent Git operation, not another `subagent` call; follow [Git, worktrees & recovery](git-worktrees.md). Do not proceed merely because `result` exists.

**3. Only after integration, launch the fresh reviewer:**

```ts
await subagent({
  agent: "review",
  task: "Inspect the integrated parent history, git diff/status, and affected files. Review correctness, tests, scope, and safety; do not edit.",
  async: false
});
```

A reviewer launched before step 2 cannot see the isolated writer commit in the parent checkout.

The packaged orchestrator can coordinate an inline explore/work/review loop in its one runtime-owned scope, but it still does not replace parent review or integration ownership:

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

When a parent has explicit acceptance criteria, include them in the writer call and require evidence. A child must not claim review or verification it did not perform:

```ts
const result = await subagent({
  agent: "work",
  task: "Implement the approved documentation change in isolated Git and commit it.",
  acceptance: {
    criteria: [{ id: "docs", must: "The site builds strictly and links are valid." }],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"],
    verify: [{ id: "build", command: "mkdocs build --strict" }],
    stopRules: ["Do not alter runtime behavior."]
  },
  async: false
});
```

After the parent verifies and integrates the intended authored commits, launch a separate fresh `review` agent. Setting `acceptance.review.required: true` is appropriate only when that run can actually produce authenticated reviewer evidence; it does not automatically launch an independent reviewer for an ordinary packaged `work` call.

Acceptance permissions are guarded by the target agent's frontmatter. Read the [settings reference](settings-reference.md) for all fields.
