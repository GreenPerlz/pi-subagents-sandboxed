---
name: work-on-issues
description: Run a general issue-work loop with Pi subagents: gather issues from an issue tracker or local files, order dependencies, batch independent issues into parallel per-issue orchestrator runs, supervise them through intercom/status, integrate successful work serially, and continue until the requested issues are done or blocked.
---

# Work on Issues

This skill runs a general issue execution loop with Pi subagents.

It is intentionally more general than a repo-specific Ralph loop: use it when the parent should collect issues from whatever source is available—GitHub, GitLab, Jira, Linear, local files, or a user-provided spec—decide what can run in parallel, launch one orchestrator per issue, help stuck children, and integrate successful results afterward.

## Required companion skills

Before using this skill, load and follow the `pi-subagents` skill.

For code or behavior issues, also load and follow the `tdd` skill. For docs-only or config-only issues, do not force artificial red tests, but still require appropriate validation.

## When to use

Use this when the user asks to:

- work through issues;
- take a backlog and execute it;
- run multiple issues in parallel when safe;
- keep working until the requested issue set is done;
- supervise orchestrator agents working issue-by-issue;
- merge or integrate successful issue work after child runs finish.

## Inputs

Ask only for missing information that blocks safe execution.

Important inputs:

- issue source:
  - explicit issue numbers/URLs/IDs from the user;
  - a tracker query or tracker project;
  - GitHub, GitLab, Jira, Linear, or another issue tracker;
  - local issue files such as markdown, JSON, YAML, or docs in the repo;
  - a user-provided plan/spec/PRD to treat as the issue list;
- any filters: labels, status, milestone, assignee, directory, max issues, or "only these issues";
- max parallel orchestrators, default `min(3, ready issue count)`;
- integration policy: local merge/cherry-pick, PR-only, patch-only, or worktree-only;
- whether the parent should comment on and/or close completed issues in the upstream tracker;
- sandbox policy, defaulting to repo docs if present, otherwise the packaged bubblewrap policy.

If the user provides specific issues, work **only** on those issues unless they explicitly ask you to discover more.

## Normalize issue inputs

No matter where issues come from, normalize each issue into a working shape:

- identifier: number, slug, filename, or URL;
- source: tracker name, path, or `user-provided`;
- title;
- full body/description;
- comments or follow-up notes if available;
- acceptance criteria;
- validation expectations;
- non-goals;
- blockers/dependencies;
- readiness state;
- close/integration policy if the source defines one.

If a source is weakly structured, create the best faithful normalized summary you can before delegating.

## Core model

- **Parent session**: gathers issues, orders them, decides which ones are parallel-safe, launches one per-issue `orchestrator` child in an isolated worktree, answers blocker questions, checks status when children look stuck, integrates successful work serially, and decides what to do next.
- **`orchestrator` child**: owns exactly one issue in exactly one worktree. It may use nested `explore`, `work`, and `research`/`review` subagents for that issue only.
- **Nested `work`**: the only writer inside the orchestrator worktree.
- **Nested `review`/`research` agents**: read-only validation and critique.

The parent owns the queue and integration. Children own only their assigned issue.

## Hard rules

- Assign each issue to exactly one orchestrator.
- Parallel issue implementation must use `worktree: true`.
- Never run two write-capable issue agents in the same checkout.
- If the repo is dirty and `worktree: true` would be unsafe, stop and ask the user.
- If the user supplied explicit issues, do not pull unrelated backlog items.
- Respect dependencies: if issue A blocks issue B, do not run B before A.
- Be conservative about conflict risk: when in doubt, run fewer issues in parallel.
- Give every orchestrator the full normalized issue context: identifier, source, title, body, comments/notes, acceptance criteria, validation, non-goals, blockers, and integration policy.
- Use sandboxed subagents by default. Do not silently fall back to unsandboxed children.
- Do not merge incomplete or red work.
- Integrate successful issue work serially unless the user explicitly asked for PR-only, patch-only, or worktree-only output.
- If an orchestrator needs a product, architecture, privacy, or scope decision, answer it through supervisor coordination instead of guessing.

## Setup checks

1. Confirm the repo and working tree are suitable:

   ```bash
   git remote -v
   git status --short
   ```

2. Confirm available subagents:

   ```typescript
   subagent({ action: "list" })
   ```

   Expected agents:
   - `orchestrator`
   - `work`
   - `review` and/or `research`

3. Confirm sandbox/intercom/runtime health:

   ```typescript
   subagent({ action: "doctor" })
   ```

4. If using a remote tracker, confirm access/auth for that tracker before planning work.

If intercom/contact-supervisor is unavailable, warn the user that children cannot ask live questions and blockers will have to come back as stopped results.

## Sandbox default

Use repo-specific docs if they define a subagent policy. Otherwise use:

```typescript
const issueSandbox = {
  provider: "bubblewrap",
  profile: "host-toolchain",
  network: "host",
  auth: "pi-json",
  fallback: "fail",
  packageDiscovery: "closed"
};
```

## Issue sources

### A. User-specified issues

If the user gives a hand-picked list, resolve and work only that set.

Examples:
- tracker issue IDs or URLs;
- local files like `docs/issues/123.md`;
- a list embedded in the prompt;
- a plan/spec whose sections should be treated as issues.

### B. Remote tracker discovery mode

If the issues live in a remote tracker, query that tracker and then fetch the full body/comments for candidate issues.

Examples include GitHub, GitLab, Jira, Linear, or whatever tracker the repo actually uses.

Use the tracker's native filters when available: open status, labels, readiness, assignee, milestone, sprint, and so on.

### C. Local issue discovery mode

If the issues live in the repo, discover them from files.

Common patterns:
- `docs/issues/**/*.md`
- `issues/**/*.md`
- `backlog/**/*.md`
- `*.json` or `*.yaml` issue exports
- repo docs with one section per issue/slice

Use repo search tools to find the actual source of truth, then read the relevant files fully enough to normalize them.

## Determine eligibility

An issue is eligible only if:

- it is in scope for this run;
- it is still open, pending, or otherwise not already complete;
- it is not already satisfied by current code;
- it does not require immediate human-only action, unavailable credentials, or manual work the agent cannot perform;
- its blockers are resolved or absent;
- its acceptance criteria and validation are specific enough to implement safely, or can be clarified cheaply.

If a requested issue is blocked, keep it in the report, but do not secretly replace it with another issue.

## Ordering and parallelization

Build a conservative dependency/conflict plan.

For each issue:

1. Parse dependencies from:
   - `Blocked by` sections;
   - explicit references like `depends on #123`, filenames, or issue IDs;
   - linked or obvious prerequisite issues.
2. Extract:
   - acceptance criteria;
   - validation contract;
   - non-goals;
   - likely subsystem/files/surfaces touched.
3. Estimate conflict risk.

Issues may run in parallel only when:

- neither blocks the other;
- they do not obviously target the same narrow interface/schema/migration/user flow; and
- merging them afterward is likely to be mechanical rather than architectural.

When uncertain, serialize.

Scheduling policy:

- Preserve explicit user ordering unless dependencies force reordering.
- Otherwise prefer: unblocked, clear-scope, well-specified issues first.
- Recompute eligibility after every completed batch because newly unblocked issues may become runnable.

## Per-batch orchestration

### 1. Prepare one orchestrator handoff per issue

Each handoff should include:

- issue identifier/source/title;
- full problem statement;
- acceptance criteria;
- validation expectations;
- non-goals;
- blockers/dependencies;
- any relevant repo docs/context already discovered;
- parent policy for commits, PRs, patch output, commenting, and closing.

The handoff must clearly state:

- you own exactly one issue;
- stay in the assigned worktree;
- use nested subagents only for this issue;
- ask the supervisor only for real blockers or missing decisions;
- return a concise final summary.

### 2. Launch orchestrators in parallel worktrees

Use one `orchestrator` task per issue:

```typescript
subagent({
  tasks: [
    {
      agent: "orchestrator",
      label: "Issue <id>",
      task: "Orchestrate exactly this issue in this isolated worktree.\n\nPrimary context:\n- Source: ...\n- Title: ...\n- Acceptance criteria: ...\n- Validation: ...\n- Non-goals: ...\n- Blockers: ...\n- Parent policy: commit green work, ask on blockers, return concise final summary.",
      output: "tmp/issues/issue-<id>.md",
      outputMode: "file-only",
      progress: true,
      acceptance: {
        criteria: ["This issue is completed or a blocker is reported with evidence"],
        evidence: ["changed files", "validation", "review verdict", "commit or blocker summary"],
        maxFinalizationTurns: 2
      }
    }
  ],
  concurrency: 3,
  worktree: true,
  context: "fresh",
  async: true,
  sandbox: issueSandbox
})
```

Do not edit the parent checkout while issue orchestrators are running.

## Supervision, check-ins, and stuck children

Parent supervision matters.

- Answer orchestrator blocker questions with the minimum decision needed to unblock them.
- Use `subagent({ action: "status" })` and `subagent({ action: "status", id: "..." })` to inspect active runs.
- If a child looks stuck, drifting, or repeatedly failing validation, check status first.
- Use `interrupt` only when necessary, then `resume` with a corrected instruction if the child can continue.
- Keep an eye on control/intercom notices instead of noisy polling loops.
- If a child sends routine chatter, tell it to stop and report only blockers or final results.

## Collect results

Classify each issue result as:

- **completed** — acceptance criteria satisfied, validation green, ready to integrate;
- **blocked** — needs human input, missing access, unresolved dependency, sandbox/tooling problem, or validation cannot be completed safely;
- **partial** — useful progress exists, but not enough to integrate/close confidently;
- **failed** — the child did not produce usable work.

Read saved file-only outputs as needed before integrating.

## Integrate serially

Unless the user asked for PR-only, patch-only, or worktree-only output:

1. Integrate completed issues one at a time.
2. Cherry-pick/merge/apply the orchestrator result into the main checkout.
3. Resolve only mechanical conflicts yourself; escalate risky conflicts.
4. Re-run focused validation after each integration, especially after multiple issue branches land.
5. Update the upstream source of truth when requested or appropriate:
   - tracker comment;
   - tracker close/status update;
   - local issue file note;
   - progress log.
6. Mark the issue done only after successful integration and only when all acceptance criteria are satisfied.

If integrating one completed issue invalidates another worktree's result, reclassify the second issue as needing a rebase/fix pass instead of pretending both are done.

## Continue the loop

After each batch:

- integrate successful work;
- refresh issue state from the real source of truth;
- recompute what is now unblocked and parallel-safe;
- launch the next batch;
- stop only when the requested issue set is done or nothing eligible remains.

If the user gave specific issues, stop when those issues are completed or blocked.

If the user asked for discovery mode, continue until no eligible issues remain.

## Stop conditions

Stop and report instead of guessing when:

- only blocked or HITL issues remain;
- the repo state is unsafe for worktrees;
- sandbox setup fails and no approved exception exists;
- an issue requires a missing product/architecture decision;
- required credentials or external systems are unavailable;
- validation cannot be completed and no acceptable fallback exists.

When discovery mode is exhausted, you may report `COMPLETE`.

## Recommended prompt

```text
/skill:work-on-issues Work through the issues for this repo. If I named specific issues, only do those. Otherwise discover the real issue source—GitHub, GitLab, Jira, Linear, local files, or repo docs—sort dependencies, batch what can safely run in parallel, launch one orchestrator per issue in worktrees, answer blocker questions, integrate successful work serially, and continue until everything eligible is done or blocked.
```
