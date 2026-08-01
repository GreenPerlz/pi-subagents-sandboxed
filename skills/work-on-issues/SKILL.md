---
name: work-on-issues
description: "Run a general issue-work loop with Pi subagents: gather issues from an issue tracker or local files, order dependencies, batch independent issues into parallel per-issue orchestrator runs, supervise them through intercom/status, integrate successful work serially, and continue until the requested issues are done or blocked."
---

# Work on Issues

This skill runs a general issue execution loop with Pi subagents.

The default issue slice is parent-assigned and runtime-managed: one orchestrator gets one isolated worktree for the issue lifetime, returns explorer findings inline, embeds relevant findings in one same-cwd worker task, forbids worker commits, then gives an abstract handoff to a fresh reviewer that inspects the actual current `git diff`. Before the runtime removes that temporary worktree, it captures the worker patch/diff evidence for integration. It is intentionally more general than a repo-specific Ralph loop: use it when the parent should collect issues from whatever source is available—GitHub, GitLab, Jira, Linear, local files, or a user-provided spec—decide what can run in parallel, launch one orchestrator per issue, help stuck children, and integrate successful results afterward.

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

- **Parent session**: gathers issues, orders them, assigns one issue per orchestrator, owns integration, answers blocker questions, checks status when children look stuck, and applies captured patches serially after runtime cleanup.
- **`orchestrator` child**: owns exactly one issue in exactly one parent-assigned runtime worktree for the duration of its run. It relays inline `explore` findings to one same-cwd `work` child, then passes an abstract handoff to a fresh same-cwd `review` child; runtime captures the resulting diff before removing the worktree.
- **Nested `work`**: the only writer inside the orchestrator worktree; it edits directly and must not commit or stage.
- **Nested `review` agents**: read-only validation, critique, and investigation of the actual current diff before patch capture.
- **Runtime patch evidence**: captured patch files and diff summaries are integration artifacts, not repo-local Markdown context handoffs.

The parent owns the queue and integration. Children own only their assigned issue.

## Hard rules

- Assign each issue to exactly one orchestrator.
- Each default issue launch uses one orchestrator task with `worktree: true`; every affected agent must permit the guarded shared worktree request.
- Never run two write-capable issue agents in the same checkout.
- Keep nested explore/work/review children foreground with `async: false` in the orchestrator's inherited cwd; do not create nested worktrees. The runtime also suppresses an ambient `asyncByDefault` for omitted-`async` orchestrator loop calls.
- A dirty repo is acceptable only when it is the explicitly assigned isolated worktree and its existing diff belongs to this issue; do not overwrite unrelated parent work.
- The assigned worktree is temporary runtime state: do not assume its cwd or uncommitted diff remains available after orchestration completes; use the runtime-captured patch/diff returned by the run.
- If the user supplied explicit issues, do not pull unrelated backlog items.
- Respect dependencies: if issue A blocks issue B, do not run B before A.
- Be conservative about conflict risk: when in doubt, run fewer issues in parallel.
- Give every orchestrator the full normalized issue context: identifier, source, title, body, comments/notes, acceptance criteria, validation, non-goals, blockers, and integration policy.
- Do not request `output`, `outputMode: "file-only"`, `progress`, or `reads` for the default loop. Child results stay inline and no repo-local context/plan/progress/report Markdown is created unless explicitly requested.
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
   - `review`

3. Confirm sandbox/intercom/runtime health:

   ```typescript
   subagent({ action: "doctor" })
   ```

4. If using a remote tracker, confirm access/auth for that tracker before planning work.

If intercom/contact-supervisor is unavailable, warn the user that children cannot ask live questions and blockers will have to come back as stopped results.

## Sandbox default

Use repo-specific docs if they define a subagent policy. Packaged agents declare the closed Bubblewrap `host-toolchain` defaults in their frontmatter, so the default issue launch omits `sandbox` and relies on those agent-owned defaults. Add a per-run sandbox override only for an explicitly permitted custom agent; do not weaken the packaged default by adding a redundant override.

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

- you own exactly one issue and one parent-assigned runtime worktree for this run;
- stay in that worktree and keep nested children in its inherited cwd;
- launch nested explore/work/review with `async: false` so each result is available for the next handoff;
- return explorer findings inline, embed relevant findings in the worker task, and do not create report handoff files by default;
- the worker edits the same cwd but must not commit or stage;
- pass only an abstract worker handoff to a fresh reviewer, which must inspect actual current `git diff` before runtime patch capture;
- report the captured patch/diff path or summary for later integration, without treating it as a Markdown context handoff;
- ask the supervisor only for real blockers or missing decisions;
- return a concise final summary.

### 2. Launch one orchestrator in one parent-owned worktree

For the default issue loop, use one orchestrator task and one runtime-created, parent-assigned worktree. Keep the result inline; do not create a repo-local report handoff. The orchestrator's nested children inherit the worktree and share its current diff. Completion captures the reviewed patch/diff before the runtime removes the temporary worktree.

```typescript
subagent({
  tasks: [{
    agent: "orchestrator",
    label: "Issue <id>",
    task: "Orchestrate exactly this issue in this isolated worktree. Return explorer findings inline and embed relevant findings in same-cwd work. Work must edit without committing or staging. Pass only an abstract work handoff to a fresh reviewer, which must inspect actual current git diff.\n\nPrimary context:\n- Source: ...\n- Title: ...\n- Acceptance criteria: ...\n- Validation: ...\n- Non-goals: ...\n- Blockers: ...\n- Parent policy: preserve the reviewed worktree diff and report blockers inline."
  }],
  worktree: true,
  async: true
})
```

Run a second issue only after the first worktree is reviewed/integrated, unless the user explicitly requests multiple independent worktrees and accepts their integration policy. Do not edit the parent checkout while an isolated orchestrator is running.

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

Use the inline result and the runtime-captured worktree patch/diff evidence as the integration handoff. The temporary runtime worktree may already be gone when the result arrives, so do not try to recover a current cwd diff after cleanup. Only inspect an output file when the user explicitly requested `output`/`outputMode: "file-only"`; captured `.patch` files are runtime integration artifacts, not repo-local Markdown context.

## Integrate serially

Unless the user asked for PR-only, patch-only, or worktree-only output:

1. Integrate completed issues one at a time from the reviewed patch captured by runtime (and its diff summary); the worker must not create a commit as a handoff.
2. Preserve/apply that captured patch through the parent-owned integration workflow after runtime cleanup, then resolve only mechanical conflicts; escalate risky conflicts.
3. Re-run focused validation after each integration, especially after multiple issue passes.
4. Update the upstream source of truth when requested or appropriate (tracker comment, tracker status, or local issue source). Do not create a progress/report Markdown handoff by default.
5. Mark the issue done only after successful integration and only when all acceptance criteria are satisfied.

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
/skill:work-on-issues Work through the issues for this repo. If I named specific issues, only do those. Otherwise discover the real issue source—GitHub, GitLab, Jira, Linear, local files, or repo docs—sort dependencies, launch one parent-owned isolated-worktree orchestrator per ready issue (serialize by default), keep explore/work/review handoffs inline, answer blocker questions, integrate reviewed diffs serially, and continue until everything eligible is done or blocked.
```
