---
name: pi-subagents
description: |
  Delegate work to packaged or custom subagents with single-agent, chain,
  parallel, async, forked-context, sandboxed, and intercom-coordinated workflows.
  Use for research, implementation handoffs, code review, and multi-step tasks
  where one parent agent stays in control while focused children contribute.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, review fanout, final follow-up `work` launches, and all decisions about what to do with child results.

Packaged builtin agents in this fork:

| Agent | Role |
|---|---|
| `research` | Web/docs research with source-backed findings. |
| `review` | Evidence-backed review of diffs, plans, PRs, issues, and code health. |
| `work` | Single-writer implementation with validation and decision escalation. |

Custom user/project agents and chains may still exist. Use `subagent({ action: "list" })` before relying on any non-packaged agent name.

## Core rules

- Keep one parent decision-maker. Children inspect, research, implement, or review; the parent synthesizes and decides next actions.
- Default issue orchestration owns one isolated worktree in the parent: `explore`, `work`, and fresh `review` run foreground with `async: false`, explorer findings return inline, the worker edits the inherited cwd without committing, and the reviewer inspects the current `git diff`.
- Reuse the parent-owned isolated worktree for nested steps by omitting `worktree`; request a separate worktree only for explicitly authorized parallel writers.
- Prefer fresh context for `review` and `research` runs unless inherited conversation state is explicitly needed.
- Omit `output`, `outputMode: "file-only"`, `progress`, and `reads` by default. Results stay inline and no repo-local context/plan/progress/report Markdown is created unless one of those options is explicitly requested.
- Use `work` for edits, `review` for adversarial checks, and `research` for external facts.
- Do not let ordinary children run nested subagents. A child can call `subagent` only when its resolved builtin tools explicitly include `subagent`; default packaged agents do not.
- Prefer `async: true` for subagent runs by default. Use foreground/synchronous runs mainly when you need the child result immediately in the current turn.

## Common workflows

### Research

Use when external APIs, libraries, docs, standards, ecosystem behavior, or current facts matter.

```typescript
subagent({
  agent: "research",
  task: "Research the current official docs and summarize constraints with sources.",
  async: true
})
```

For broad questions, run 2-3 `research` agents in parallel with distinct angles: official docs, recent changes, and practical tradeoffs.

### Implement then review

For one issue, keep the parent in control of one isolated worktree. Run each nested `explore`, `work`, and fresh `review` with `async: false`; return exploration inline, embed the relevant findings in one worker task, forbid worker commits, then give the reviewer only an abstract handoff and require it to inspect the actual current `git diff`.

```typescript
subagent({
  tasks: [{
    agent: "orchestrator",
    task: "Own exactly this issue in the assigned worktree. Explore inline, embed relevant findings in one same-cwd work task that must not commit, then give a fresh reviewer an abstract handoff and require it to inspect current git diff."
  }]
})
```

After review returns, the orchestrator may launch exactly one follow-up `work` agent for blockers. Do not use nested worktrees or report files for this default loop.

### Review-only

Use a fresh `review` run for current diffs, plans, issues, PRs, or proposed solutions. Ask it to inspect the actual current `git diff` and `git status`, cite file/line evidence, and return concise findings inline. Do not ask it to edit unless the user explicitly wants a writer pass. Prefer async review runs unless the current turn depends on the answer immediately.

```typescript
subagent({
  tasks: [
    { agent: "review", task: "Review the current diff for correctness." },
    { agent: "review", task: "Review the current diff for tests and validation." }
  ],
  async: true
})
```

## Sandboxed defaults

If you need to explain, tune, or modify sandboxing, read [sandboxing.md](sandboxing.md) before changing anything. It covers config precedence, mounts, auth modes, package discovery, writable-vs-read-only behavior, and how implemented Bubblewrap profiles are created/edited in this codebase.

Packaged builtin agents carry their sandbox defaults in agent frontmatter; packaged launches should omit a per-run `sandbox` override. The following shape is for a **custom agent only**, and that agent must declare matching permission (for example, `canBeChangedByAgent: sandbox.*`) before a parent may provide these fields:

```yaml
---
name: sandbox-work
description: Sandboxed implementation agent for a selected issue
canBeChangedByAgent: sandbox.*
---
```

```typescript
sandbox: {
  provider: "bubblewrap",
  profile: "host-toolchain",
  network: "host",
  auth: "pi-json",
  fallback: "fail",
  packageDiscovery: "closed"
}
```

Keep `fallback: "fail"` for safety-critical workflows. Use `sandbox: { provider: "none" }` only when trusted user-global `sandbox.allowSandboxOptOut: true` is configured; custom-agent permission or a per-run/user approval alone cannot authorize unsandboxed execution. Use `extraReadOnlyMounts` for narrow toolchain/input access and `extraWritableMounts` only for caches, outputs, or work directories. Do not invent new profile names in prompts or config; only implemented profiles work.

Parallel sandboxed tasks with write-capable tools require an explicitly authorized isolated worktree; otherwise use read-only review tasks in parallel.

## Per-issue orchestrators

For one issue, use one parent-owned isolated worktree and one `orchestrator` child. Its nested `explore`, `work`, and fresh `review` children inherit that cwd; no nested worktree or repository-local report handoff is needed. The explorer returns inline findings, the parent embeds them in the worker task, and the reviewer inspects the actual current diff.

```typescript
subagent({
  tasks: [{
    agent: "orchestrator",
    label: "Issue #123",
    task: "Orchestrate exactly this issue in the assigned worktree. Keep explore findings inline, pass relevant findings to same-cwd work, forbid commits, and pass an abstract worker handoff to a fresh reviewer that inspects current git diff."
  }],
  async: true
})
```

Only agents whose tools include `subagent` should run nested subagents. `orchestrator` is the intended exception: it may use nested `explore`, `work`, and `review` agents for its assigned issue only. It should use intercom/contact-supervisor sparingly for real blockers or missing decisions, not routine progress. The parent still owns issue selection, worktree ownership, serial integration, and final close decisions.

## Status and control

- `subagent({ action: "status" })` lists active async runs.
- `subagent({ action: "status", id: "..." })` inspects one run.
- `subagent({ action: "interrupt", id: "..." })` soft-interrupts a foreground/background child and leaves it paused where supported.
- `subagent({ action: "resume", id: "...", message: "..." })` follows up with a live or completed child when resumable.
- `subagent({ action: "doctor" })` reports runtime paths, discovery, async support, sessions, and intercom bridge state.

Use interrupts only when a child is genuinely blocked, going off-scope, or the user asks to regain control. Silence during long tool calls or tests can be normal.

## Output and evidence

Ask children to report:

- changed files or inspected files
- commands run and exit codes
- source links for research
- validation evidence
- blockers, risks, and decisions needing parent approval

For deliberately large outputs, use an explicit `output` path with `outputMode: "file-only"` so the parent receives a concise file reference instead of a huge transcript. An omitted output stays inline-only; `file-only` without a path remains an intentional request and may use a generated runtime path. Do not rely on implicit repository-local reports.

## Saved output paths

Saved Markdown is opt-in. Use an explicit `output` path when a report is an intentional project artifact, or use `outputMode: "file-only"` when a generated runtime path is acceptable. Inline runs without an output request create no repo-local report; session logs, async status files, and runner `.log`/`.jsonl` artifacts remain in runtime session/temp areas.

`reads` and `progress` remain supported as explicit/legacy opt-ins. A parent should embed relevant inline findings in the next task for normal orchestration instead of asking children to communicate through context, plan, or progress files.
