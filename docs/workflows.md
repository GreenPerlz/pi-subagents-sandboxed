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

## Implement, review, integrate

A direct packaged `work` launch writes and commits inside a runtime-issued isolated
Git scope. It does **not** leave a diff in the canonical parent checkout. The
worker must never stage or commit that canonical checkout; the runtime-owned
scope is the authorized writing scope.

### Direct writer: export, validate, review, then integrate

The direct worker returns only after its original private scope has been exported
and removed. Because that scope is gone, the trusted parent must complete the
review setup before asking a fresh observer to review:

1. **Run the isolated writer.** Have `work` implement and commit the approved
   change in its private scope.
2. **Verify the returned bundle and prerequisites.** The parent checks the
   checksum, authored refs, base, and acceptance prerequisites. This verifies
   evidence; it is not integration into the canonical checkout.
3. **Import for review into a disposable validation checkout.** The parent
   imports the authored refs into an available disposable validation checkout
   solely for validation and review. This review import is separate from canonical
   integration and must not modify the canonical parent checkout.
4. **Review the imported authored state.** A fresh observation-only reviewer
   inspects `git log <base>..HEAD`, the authored-head tree, and
   `git diff <base>...HEAD`, plus `git status`, the index diff, and the working
   tree diff, in that disposable checkout. A clean working tree after a commit
   is not evidence that there is nothing to review.
5. **Accept, then integrate.** Only after acceptance validation and the fresh
   review pass does the trusted parent deliberately import/cherry-pick/apply the
   intended authored state into the canonical checkout. The parent may remove
   the disposable validation checkout afterward. Review verification/import and
   canonical integration are different operations.

A direct launch therefore has this ordering, even though the private scope is
no longer available when the child result is delivered:

```text
work authors commit in private isolated scope
runtime exports authored refs and removes that private scope
parent verifies bundle and prerequisites
parent imports authored refs into disposable validation checkout
fresh observer reviews authored base-to-HEAD history/tree and remaining diff there
trusted parent validates acceptance and integrates into canonical checkout
```

### Nested orchestrator: review before outer export

The packaged orchestrator can coordinate an inline explore/work/review loop in
its one runtime-owned scope. Its nested steps inherit one scoped Git context,
serialize writers, and do not create nested worktrees, so the fresh observer can
review that authored scope before the outer runtime exports and removes it. The
trusted parent still verifies the exported bundle and performs canonical
integration only after acceptance; this is not a reason to launch a direct
reviewer in an already removed child scope:

```text
orchestrator explores inline
scoped work writer authors commit
fresh observer reviews authored history/tree/base diff in inherited scope
runtime completes acceptance and required teardown/export
trusted parent verifies exported bundle and deliberately integrates canonical state
```

For either workflow, the fresh reviewer is observation-only and may report
findings but may not edit, stage, commit, or integrate. Handoffs remain inline;
stop for a real decision or blocker, not an arbitrary fixed loop count.

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

After the runtime exports the authored bundle, the trusted parent verifies it and imports it into a disposable validation checkout. A fresh observer reviews the authored history/tree plus any remaining diff there, followed by acceptance; only then does the trusted parent integrate the intended authored commits into the canonical parent checkout. Setting `acceptance.review.required: true` is appropriate only when that run can actually produce authenticated reviewer evidence; it does not automatically launch an independent reviewer for an ordinary packaged `work` call.

Acceptance permissions are guarded by the target agent's frontmatter. Read the [settings reference](settings-reference.md) for all fields.
