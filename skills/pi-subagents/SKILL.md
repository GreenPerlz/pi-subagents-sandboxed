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
- Use one writer at a time against the active checkout. Parallel writers require `worktree: true`.
- Prefer fresh context for `review` and `research` runs unless inherited conversation state is explicitly needed.
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

Use one `work` to implement the accepted scope, then fresh `review` agents to inspect the actual diff. Prefer launching the workflow async unless you explicitly need the result inline.

```typescript
subagent({
  chain: [
    { agent: "work", task: "Implement the approved change and validate it." },
    {
      parallel: [
        { agent: "review", task: "Review the resulting diff for correctness and regressions." },
        { agent: "review", task: "Review tests, validation, and edge cases." },
        { agent: "review", task: "Review simplicity, maintainability, and unnecessary complexity." }
      ]
    }
  ],
  async: true
})
```

After reviews return, synthesize fixes worth doing now. If fixes are accepted, launch exactly one `work` agent to apply them.

### Review-only

Use fresh `review` runs for current diffs, plans, issues, PRs, or proposed solutions. Ask for file/line evidence and concise findings. Do not ask them to edit unless the user explicitly wants a writer pass. Prefer async review runs unless the current turn depends on the answer immediately.

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

Packaged builtin agents request a closed Bubblewrap `host-toolchain` sandbox by default:

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

Keep `fallback: "fail"` for safety-critical workflows. Use `sandbox: { provider: "none" }` only when the user explicitly approves an unsandboxed exception. Use `extraReadOnlyMounts` for narrow toolchain/input access and `extraWritableMounts` only for caches, outputs, or work directories. Do not invent new profile names in prompts or config; only implemented profiles work.

Parallel sandboxed tasks with write-capable tools require `worktree: true`; otherwise use read-only review tasks in parallel.

## Per-issue orchestrators

For parallel issue work, prefer one parent session plus per-issue `orchestrator` children. For a reusable parent workflow, use the `work-on-issues` skill.

```typescript
subagent({
  tasks: [
    { agent: "orchestrator", label: "Issue #123", task: "Orchestrate exactly this issue: ...", output: "tmp/issues/issue-123.md", outputMode: "file-only" },
    { agent: "orchestrator", label: "Issue #124", task: "Orchestrate exactly this issue: ...", output: "tmp/issues/issue-124.md", outputMode: "file-only" }
  ],
  concurrency: 2,
  worktree: true,
  context: "fresh",
  async: true,
  sandbox: { provider: "bubblewrap", profile: "host-toolchain", network: "host", auth: "pi-json", fallback: "fail", packageDiscovery: "closed" }
})
```

Only agents whose tools include `subagent` should run nested subagents. `orchestrator` is the intended exception: it may use nested `explore`, `work`, and `review` agents for its assigned issue only. It should use intercom/contact-supervisor sparingly for real blockers or missing decisions, not routine progress. The parent still owns issue selection, parallel batch planning, serial integration of successful worktree commits/PRs, and final close decisions.

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

For large outputs, use `outputMode: "file-only"` so the parent receives a concise file reference instead of a huge transcript. Read-only flows can auto-save to repo-local `tmp/` even without an explicit `output` path; explicit `output` is still fine when you want a stable working file too.

## Saved output paths

When subagent output is being preserved for later inspection, prefer the runtime's
repo-local `tmp/` area and keep `tmp/` in `.gitignore`.

Current convention:

- saved reports go under the current worktree or cwd `tmp/` directory
- each run creates a fresh markdown file like `tmp/<agent>-<runId>.md`
- parallel/chain siblings may add an index or numeric collision suffix
- saved files include run identity metadata so later work/review loops are traceable
- session logs, async status files, and runner `.log`/`.jsonl` artifacts remain in the runtime session/temp areas, not repo `tmp/`

This keeps review/explore outputs out of tracked repo files while
preserving per-run history for debugging and follow-up passes.
