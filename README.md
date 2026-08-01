<p>
  <img src="https://raw.githubusercontent.com/GreenPerlz/pi-subagents-sandboxed/main/banner.png" alt="pi-subagents-sandboxed" width="1100">
</p>

# pi-subagents-sandboxed

`pi-subagents-sandboxed` lets Pi delegate work to focused child agents, with Bubblewrap sandboxing enabled by default for the packaged agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

## Fork baseline and purpose

This repository is now a standalone fork of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents). It was forked from upstream `pi-subagents` **v0.27.0** (`v0.27.0`, commit `e6484719f88625d55e2c26ec7c3e498cda4fe0e6`) and then diverged into a sandbox-focused package.

This repo should be used as a **replacement for upstream `pi-subagents` when you want local containment for child Pi processes**. It keeps the upstream delegation/orchestration workflows, but adds a sandbox layer so child agents can be given narrower filesystem, auth, network, and write access.

Main changes from the upstream v0.27.0 baseline:

- Renamed/repackaged the extension as `pi-subagents-sandboxed` so it can live as an independent package and repository.
- Added sandbox configuration resolution from settings, agent frontmatter, and per-run `sandbox` options.
- Made the packaged builtin agents request a closed Bubblewrap sandbox by default.
- Added a Bubblewrap provider with a `host-toolchain` profile for local developer machines.
- Added sandbox mount policy for cwd/worktree, child sessions, artifacts, outputs, prompt temp files, extension/runtime paths, and Pi auth JSON.
- Added write inference: `edit`/`write` agents get writable cwd mounts; bash-only/read-only agents stay read-only unless `bashWrite: true` is set.
- Added sandbox propagation through foreground, async, chain, parallel, and dynamic fanout subagent runs.
- Added fail-closed fallback behavior and result/status diagnostics that report whether sandboxing actually happened.
- Added a closed child Pi runtime path for sandboxed children, reducing ambient extension/tool discovery.
- Mounted systemd-resolved DNS state for host networking where needed.
- Mounted `/dev` in Bubblewrap so Node child processes and the built-in bash tool can open `/dev/null`.
- Adjusted bundled orchestration defaults: one parent-owned worktree with inline explore/work/review handoffs, no worker commits, and no implicit repo-local Markdown reports.
- Adjusted bundled work/review defaults and prompt guidance for this sandbox-focused fork.

This is a local safety/containment feature, not a claim of hostile-code-grade isolation. The current goal is: **make packaged subagent delegation safer by default, while preserving explicit opt-outs and configurable access when a run needs broader host access.**

https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1

## Installation

```bash
pi install npm:pi-subagents-sandboxed
```

`pi-subagents-sandboxed` is a replacement fork of `pi-subagents`, not a companion package. Do not install or enable both in the same Pi environment; keep only one `subagent` extension active so slash commands, bundled agents, and the `subagent` tool resolve unambiguously.

That installs the extension and the packaged agents. Because those packaged agents request Bubblewrap by default, install `bwrap` before your first run. If you need an unsandboxed or differently sandboxed run, use a custom agent whose `canBeChangedByAgent` explicitly permits the requested `sandbox.*` fields; do not add a per-run sandbox override to a packaged agent. See the [sandboxing reference](skills/pi-subagents/sandboxing.md).

## Sandboxed subagents

The packaged builtin agents (`explore`, `orchestrator`, `research`, `review`, and `work`) request `bubblewrap` with the `host-toolchain` profile, host networking, `pi-json` auth, fail-closed fallback, and closed package discovery by default. Custom agents or runs with no sandbox provider still use the same child Pi spawn path as upstream `pi-subagents`. A per-run sandbox override is only runnable when every affected agent explicitly permits the requested `sandbox.*` fields.

### Bubblewrap requirements

The MVP sandbox provider is `bubblewrap`, which shells out to `bwrap`. Install Bubblewrap with your OS package manager before running the packaged agents (for example, `sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, or `sudo pacman -S bubblewrap`). If Bubblewrap is missing, sandboxed runs fail closed by default and the error points back to this section and the [sandboxing reference](skills/pi-subagents/sandboxing.md).

The only supported MVP profile is `host-toolchain`. It preserves original host paths and read-only mounts common host toolchain/runtime paths such as `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, and `/etc` where present, plus the Pi/package/temp paths needed to run the child. The child cwd/worktree is mounted read-only or writable according to write inference below.

### Configure sandboxing

Per run (using a custom agent explicitly opted into sandbox overrides; packaged `work` must use its frontmatter defaults):

```ts
subagent({
  agent: "sandbox-work",
  task: "Fix the selected issue",
  sandbox: {
    provider: "bubblewrap",
    profile: "host-toolchain",
    network: "host",
    auth: "pi-json",
    fallback: "fail",
    bashWrite: true,
    extraReadOnlyMounts: ["/opt/project-toolchain"],
    extraWritableMounts: [".cache/subagent-build"],
    packageDiscovery: "project-local"
  }
})
```

Per agent frontmatter (the packaged builtin agents already include these defaults):

```yaml
sandboxProvider: bubblewrap
sandboxProfile: host-toolchain
sandboxNetwork: host
sandboxAuth: pi-json
sandboxFallback: fail
sandboxBashWrite: true
sandboxExtraReadOnlyMounts: /opt/project-toolchain
sandboxExtraWritableMounts: .cache/subagent-build
sandboxPackageDiscovery: project-local
```

The `sandbox-work` example requires a custom agent such as `.pi/agents/sandbox-work.md`:

```yaml
---
name: sandbox-work
description: Implementation agent with explicit sandbox override permission
tools: read, grep, find, ls, bash, edit, write
canBeChangedByAgent: sandbox.*
---
Implement the assigned task without committing.
```

Dedicated subagent settings (`~/.pi/agent/subagents.json` or `.pi/subagents.json`; legacy `settings.json -> subagents` is still read):

```json
{
  "sandbox": {
    "defaultProvider": "bubblewrap",
    "defaultProfile": "host-toolchain",
    "network": "host",
    "auth": "pi-json",
    "fallback": "fail",
    "extraReadOnlyMounts": ["/opt/project-toolchain"],
    "extraWritableMounts": [".cache/subagent-build"],
    "packageDiscovery": "closed"
  }
}
```

Run-level sandbox options override agent frontmatter, which overrides settings defaults. Explicit extra mounts are additive across settings, agent frontmatter, and run options so narrower per-run access can be added without broadening the default profile.

### Sandbox modes and diagnostics

- Provider: `bubblewrap` wraps child Pi invocations with `bwrap`; provider `none` or an omitted provider means no sandbox.
- Profile: `host-toolchain` is for local developer machines that already have the repo toolchain installed on the host.
- Network: `host` is the default so child Pi processes can reach model/API providers; `none` passes Bubblewrap `--unshare-net` for offline tasks.
- Auth: `pi-json` is the default mode and mounts Pi's `auth.json` and `subagents.json` read-only without mounting full `settings.json`; use `env` only when you explicitly want the child process to rely on provider credentials from its environment.
- Fallback: `fail` is the default and refuses to run when Bubblewrap cannot be applied. Explicit `fallback: "none"` runs the original unsandboxed invocation and records a warning/result marker.
- Package discovery: `closed` is the default for sandboxed children and starts child Pi with `--no-extensions`, `--no-prompt-templates`, and `--no-themes`, loading only runtime/explicit extension flags. `project-local` keeps those closed-runtime flags, but the parent resolves project-local Pi package declarations before Bubblewrap, passes their `package.json -> pi.extensions` as explicit `--extension` flags, and mounts those package roots read-only. It reads project `.pi/settings.json` package declarations and the nearest cwd package; it intentionally does not load user/global packages or mount user settings/global npm roots. `ambient` is unsafe/legacy and must be requested explicitly; it can re-enable Pi's normal discovery inside the sandbox and may require broader mounts, so it is not recommended for untrusted work.
- Write inference: agents with `edit` or `write` tools get writable cwd/worktree mounts. `bash` alone stays read-only unless `bashWrite: true` is set. Parallel sandboxed writers require `worktree: true` so each writer gets an isolated writable worktree.
- Extra mounts: use `extraReadOnlyMounts` for installed executables/toolchains or read-only inputs. Use `extraWritableMounts` only for caches, outputs, or work directories that the agent must write. Do **not** mount all of `$HOME`; prefer the narrowest directory that contains the missing executable or failed cache/output path.

Returned result details and async status steps include a `sandbox` diagnostic object for sandboxed executions:

```json
{
  "provider": "bubblewrap",
  "profile": "host-toolchain",
  "network": "host",
  "auth": "pi-json",
  "fallbackMode": "fail",
  "fallbackOccurred": false,
  "mounts": [
    { "path": "/usr", "mode": "ro" },
    { "path": "~/project", "mode": "rw" }
  ]
}
```

When `fallback: "none"` is used because `bwrap` is unavailable, `fallbackOccurred` is `true` and `diagnostics` contains the warning explaining that the run was not sandboxed. If a sandboxed run fails with `execvp <tool>: No such file or directory`, Pi diagnoses whether the tool appears missing on the host or installed on the host but absent from sandbox mounts, then suggests a read-only mount. If a run fails with `EACCES`, `EPERM`, or `EROFS`, Pi explains whether the path is outside the mounted filesystem or under a read-only mount and suggests a writable mount only for cache/output/work paths. Mount lists are redacted before they appear in result details, async status, and run logs.

Agent-assisted safe-access workflow:

1. Re-run the smallest failing command/test inside the sandbox and inspect `details.results[*].sandbox` (or async status/run log) for `diagnostics` and redacted `mounts`.
2. If the diagnostic says a host-installed executable is not mounted, add the narrowest containing directory to `sandbox.extraReadOnlyMounts` in the run options, agent frontmatter, or settings.
3. If the diagnostic says a cache/output/work path is read-only or outside the mounted filesystem, create/use a narrow cache/output/work directory and add only that directory to `sandbox.extraWritableMounts`.
4. Re-run the focused smoke test. Keep `fallback: "fail"`; do not retry unsandboxed except with an explicit user-approved `fallback: "none"`.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi for delegation in plain language:

```text
Use review to review this diff.
```

```text
Use research to check the external API docs and summarize the constraints.
```

```text
Run parallel reviews: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start.

## What happens

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground runs stream in the conversation. Background runs keep working and can be checked later.

Installing the extension does not start an automatic review in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run a review subagent before summarizing.
```

## Good first prompts

These cover most day-to-day use:

```text
Use research to check the external API docs and summarize the constraints.
```

```text
Run parallel reviews on this diff. I want one focused on correctness, one on tests, and one on unnecessary complexity.
```

```text
Have work implement this approved plan. Afterward, run parallel reviews, summarize their feedback, and apply the fixes that make sense.
```

```text
Run a review loop on this change until reviews stop finding fixes worth doing, with a max of 3 rounds.
```

Those are ordinary Pi requests. Pi decides whether to call `subagent`, which agent to use, and whether a chain or parallel run makes sense.

## Common workflows

| Want | Ask naturally |
|------|---------------|
| Research external facts | “Use research to check the API docs and summarize constraints.” |
| Review a diff | “Use review to review this diff.” |
| Run parallel reviews | “Run reviews for correctness, tests, and cleanup.” |
| Implement then review | “Implement this, then review it.” |
| Review until clean | “Run a review loop on this change with a max of 3 rounds.” |
| Execute a plan carefully | “Have work implement this approved plan, then run reviews and apply the feedback.” |
| Run in the background | “Run this in the background.” |
| Browse agents | “Show me the available subagents.” |
| Use a saved workflow | “Run the review chain on this branch.” |
| See running work | “Show active async runs.” |
| Check setup | “Check whether subagents are configured correctly.” |

The extension ships with builtin agents you can use immediately. In this fork, each packaged builtin agent is sandboxed by default. Keep packaged launches on those defaults; use a custom agent with an explicit `sandbox.*` permission when a per-run opt-out or alternate sandbox is intentional.

## Builtin agents in plain English

| Agent | Use it when you want... |
|-------|--------------------------|
| `explore` | Read-only codebase discovery: find the minimal relevant files, tests, call paths, and likely edit points. |
| `orchestrator` | Per-issue nested orchestrator: runs explore/work/review loops in one sandboxed worktree until green or blocked. |
| `research` | Web/docs research with sources: official docs, specs, benchmarks, recent changes, and a concise research brief. |
| `work` | Implementation work. It edits files, validates, and escalates unapproved decisions instead of guessing. |
| `review` | Code review and small fixes. It checks the implementation against the task/plan, tests, edge cases, and simplicity. |

A simple rule of thumb: use `explore` to map the codebase, `research` before you trust external facts, `work` to implement, `review` to check, and `orchestrator` for one-issue nested loops.

## Changing a builtin agent's model

Builtin agents inherit your current Pi default model by default. This keeps new installs from depending on a provider you may not have configured. If you want a role to use a specific model, set an override instead of copying the bundled agent file.

For a one-run model override, use a custom agent whose frontmatter explicitly permits `model`; keep packaged launches on their inherited model. For a persistent override, edit settings. This example pins the review everywhere, adds a backup model for provider failures, and keeps the other builtins on your normal default model:

```json
{
  "subagents": {
    "agentOverrides": {
      "review": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Use `~/.pi/agent/subagents.json` for a user override or `.pi/subagents.json` for a project override. Legacy `~/.pi/agent/settings.json -> subagents` and `.pi/settings.json -> subagents` blocks are still read, but same-scope `subagents.json` wins when both exist. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. If you want a totally different agent, create a user or project agent with the same name; for normal tweaks, prefer overrides.

## Where running subagents show up

Foreground runs stream progress in the conversation while they run.

Background runs keep working after control returns to you. Inspect active runs with `subagent({ action: "status" })`, or a specific run with `subagent({ action: "status", id: "..." })`.

They also show a compact async widget and send completion notifications. Parallel background runs show per-agent progress instead of fake chain steps. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child process.

You can also ask naturally:

```text
Show me the current async runs.
```

If something feels misconfigured, run:

```text
/subagents-doctor
```

or ask:

```text
Check whether subagents and intercom are set up correctly.
```

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. The default implementation loop owns one isolated worktree in the parent and keeps handoffs inline:

```text
parent-owned worktree → explore (inline findings) → work (same cwd, no commit) → fresh review (inspect current git diff) → optional work fix
```

The parent runs nested `explore`, `work`, and `review` foreground with `async: false`, embeds relevant explorer findings in the worker task, then passes only an abstract worker handoff to the fresh reviewer. Omitted-`async` orchestrator loop calls are also kept foreground when `asyncByDefault` is enabled. Do not create `tmp/`, context, plan, or progress Markdown for this loop unless an explicit `output`, `progress`, or `reads` option is intentional. Use the optional prompt shortcuts below when you want the pattern to be repeatable.

Packaged agents use their declared context defaults (`work` is fresh); omit `context` for the safe packaged shape. An explicit `context: "fork"` is runnable only for an agent whose frontmatter permits the `context` override.

Child-safety boundaries are enforced at runtime. Spawned child sessions do not receive the bundled `pi-subagents` skill, and forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results. By default, children do not register the `subagent` tool and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents. The explicit exception is an agent whose resolved builtin `tools` includes `subagent`; that child gets a child-safe `subagent` tool for the fanout work the parent assigned, still bounded by `maxSubagentDepth`.

## Optional shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|--------|------------|
| `/parallel-review` | Launch fresh-context reviews with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled `work`, `review`, and follow-up `work` cycles until clean or capped. |
| `/parallel-research` | Run research passes for external evidence and practical tradeoffs. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviews return.

## Optional pi-intercom companion

`pi-subagents` works without `pi-intercom`. Install `pi-intercom` only if you want child agents to talk back to the parent Pi session while they are running.

```bash
pi install npm:pi-intercom
```

Most users do not call `intercom` directly. After `pi-intercom` is installed, `pi-subagents` can automatically give async/background child agents a private coordination channel back to the parent session. Ordinary foreground/non-async children do not get `contact_supervisor`; if they are blocked, they should return a normal result/error instead of detaching into supervisor coordination. The bridge recognizes the normal `pi install npm:pi-intercom` package install as well as legacy local extension checkouts.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the `work` agent gets blocked or needs a product decision, have it ask me through intercom.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for blocking decisions or clarification, and `reason: "progress_update"` for short non-blocking updates when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. With the intercom bridge active, parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent `subagent` run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets, full child summaries, and compact nested child summaries under the parent child that launched them. For the default issue loop, use the inline child result in the parent task rather than a repo-local handoff file.

If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run:

```text
/subagents-doctor
```

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in the configuration section below.

At this point, you know enough to use the plugin. The rest of this README is reference material for exact command syntax, custom agents, saved chains, worktrees, and configuration.

## Direct commands

Skip this section until you want exact syntax.

| Command | Description |
|---------|-------------|
| `/run <agent> [task]` | Run one agent; omit the task for self-contained agents |
| `/chain agent1 "task1" -> agent2 "task2"` | Run agents in sequence |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel |
| `/run-chain <chainName> -- <task>` | Launch a saved `.chain.md` or `.chain.json` workflow |
| `/subagents-doctor` | Show read-only setup diagnostics |
| `/subagents-settings` | Open a TUI overlay to configure user-scope agent default model, fallback models, and thinking level |

Commands validate agent names locally, support tab completion, and send results back into the conversation.

`/subagents-settings` is TUI-only. Use Tab or ←/→ to switch between user agents and builtin agents, ↑/↓ to move, and Enter to edit. Model choices are limited to the currently available model registry. Builtin changes are saved as user-scope overrides in `~/.pi/agent/subagents.json`, and matching legacy builtin overrides are removed from `~/.pi/agent/settings.json`, rather than modifying bundled agent files.

### Per-step tasks

Use `->` to separate steps and give each step its own task:

```text
/chain research "check current API docs" -> review "review implications for this diff"
/parallel research "find security guidance" -> review "check code style"
```

Both double and single quotes work. You can also use `--` as a delimiter:

```text
/chain research -- check API docs -> review -- analyze auth changes
```

Steps without a task inherit behavior from the execution mode. Chain steps get `{previous}`, the prior step’s output. Parallel steps use the first available task as a fallback.

```text
/chain research "check auth library docs" -> work
# research gets the docs task; work gets research output
```

For a shared task, list agents and place one `--` before the task:

```text
/chain research work -- analyze the auth system
/parallel research review -- check for security issues
```

### Inline per-step config

Append `[key=value,...]` to an agent name to override defaults for that step:

```text
/chain research "check docs and return concise findings" -> work "apply the relevant inline findings"
/run research "summarize the current API docs"
/parallel review "review backend" -> review "review frontend"
```

| Key | Example | Description |
|-----|---------|-------------|
| `output` | `output=reports/research.md` | Explicitly write results to a file. For `/chain` and `/parallel`, relative paths live under the chain directory; for `/run`, relative paths resolve against cwd. Omit it for inline-only results. |
| `outputMode` | `outputMode=file-only` | Return only a concise file reference for intentional saved output instead of full content. `file-only` requests persistence and may use a generated runtime path; default is `inline`. |
| `reads` | `reads=a.md+b.md` | Read files before executing. `+` separates multiple paths. |
| `model` | `model=anthropic/claude-sonnet-4` | Override model for this step. |
| `skills` | `skills=planning+review` | Override injected skills. `+` separates multiple skills. |
| `progress` | `progress` | Enable progress tracking. |

Set `output=false`, `reads=false`, or `skills=false` to disable that behavior explicitly. Do not use `output=false` for file-only returns; use `outputMode=file-only` with an `output` path.

### Background and forked runs

Add `--bg` to run in the background:

```text
/run research "audit relevant docs" --bg
/chain research "analyze auth library docs" -> work "implement approved refactor" --bg
/parallel research "research frontend constraints" -> review "review backend diff" --bg
```

Packaged agents keep their safe fresh-context defaults in these runnable shapes:

```text
/run review "review this diff"
/chain research "check external constraints" -> review "review this branch"
/parallel research "research frontend constraints" -> review "audit backend"
```

`--fork` is an explicit `context` override. Use it only with custom agents whose frontmatter includes `canBeChangedByAgent: context`; do not add it to the packaged `research`, `review`, or `work` examples. Background runs are detached. If the parent agent has other independent work, it should keep working. If it has nothing useful to do until the background result arrives, it should end the turn instead of running sleep or status-polling loops. Pi will deliver the completion when the run finishes.

Use `work` as the single writer for implementation work, then use fresh `review` runs to check the result before applying any follow-up fixes.

## Clarify and launch UI

Chains open a clarify UI by default so you can preview and edit the workflow before it runs. Single and parallel tool calls can opt into the same flow with `clarify: true`; slash commands launch directly.

Common clarify keys:

- `Enter` runs in the foreground, or in the background if background is toggled on
- `Esc` cancels or backs out
- `↑↓` moves between steps or tasks
- `e` edits the task/template
- `m` selects a model
- `t` selects thinking level
- `s` selects skills
- `b` toggles background execution
- `w` edits output/write behavior where supported
- `r` edits reads where supported
- `p` toggles progress tracking where supported
Picker screens use `↑↓`, `Enter`, `Esc`, and type-to-filter. The full-screen editor supports word wrapping, paste, `Esc` to save, and `Ctrl+C` to discard.

## Agents and chains

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in the child Pi process.

Agent locations, lowest to highest priority:

| Scope | Path |
|-------|------|
| Builtin | `~/.pi/agent/extensions/subagent/agents/` |
| User | `~/.pi/agent/agents/**/*.md` |
| Project | `.pi/agents/**/*.md` |

Project discovery also reads legacy `.agents/**/*.md` files. Nested subdirectories are discovered recursively. `.chain.md` files do not define agents. If both `.agents/` and `.pi/agents/` define the same parsed runtime agent name, `.pi/agents/` wins. Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Pi default model unless you set `subagents.agentOverrides.<name>.model`. This package currently ships `explore`, `orchestrator`, `research`, `review`, and `work`.

The `research` builtin uses `web_search`, `fetch_content`, and `get_search_content`; those require [pi-web-access](https://github.com/nicobailon/pi-web-access):

```bash
pi install npm:pi-web-access
```

### Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/subagents.json` (legacy: `~/.pi/agent/settings.json -> subagents`)
- Project: `.pi/subagents.json` (legacy: `.pi/settings.json -> subagents`)

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "review": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides, and a dedicated `subagents.json` beats same-scope legacy settings.

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `disableBuiltins: true` in dedicated `subagents.json` (or legacy `subagents.disableBuiltins: true` in `settings.json`).

### Prompt assembly

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi’s whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|-------|--------|
| `systemPromptMode: append` | Append the agent prompt to Pi’s normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi’s discovered skills catalog. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box.

### Agent frontmatter

See [docs/settings-reference.md](docs/settings-reference.md) for a compact reference covering every persistent setting, agent frontmatter field, acceptance field, and common run option.

A typical agent looks like this:

```yaml
---
name: auditor
# Optional: registers this as code-analysis.auditor while preserving name: auditor
package: code-analysis
description: Focused code auditor
tools: read, grep, find, ls, bash, mcp:chrome-devtools
extensions:
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, chrome-devtools
# output/defaultReads/defaultProgress are explicit legacy opt-ins
interactive: true
maxSubagentDepth: 1
acceptanceSelfReview: true
acceptanceMaxFinalizationTurns: 3
canBeChangedByAgent: output, outputMode, reads, progress
---

Your system prompt goes here.
```

Important fields:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: auditor` and `package: code-analysis` registers as `code-analysis.auditor`; serialization keeps `name` and `package` separate. |
| `tools` | Builtin tool allowlist. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. Ordinary task failures do not trigger fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi’s base prompt. |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks. |
| `inheritSkills` | Keeps or strips Pi’s discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Injects specific skills directly, regardless of `inheritSkills`. |
| `output` | Explicit default single-agent output file; omitted output stays inline-only. |
| `defaultReads` | Explicit opt-in files to read before chain/parallel behavior. |
| `defaultProgress` | Explicit opt-in maintenance of `progress.md`; omitted by default. |
| `interactive` | Parsed for compatibility but not enforced in v1. |
| `maxSubagentDepth` | Tightens nested delegation for this agent’s children. |
| `acceptanceSelfReview` | After initial completion, continue the same session to check and repair the submission against the parent's acceptance criteria. It defaults to `true`; set it to `false` to opt an agent out. |
| `acceptanceMaxFinalizationTurns` | Default self-review budget, an integer from 1 to 10 (default `3`); dormant when self-review is disabled. |
| `canBeChangedByAgent` | Comma-separated exact override paths or segment wildcards (`*`, `acceptance.*`, `sandbox.*`) allowed for parent-provided run overrides; `worktree` permits a shared worktree request. Omitted/empty denies all agent-specific overrides. |

### Tool and extension selection

If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child gets Pi’s normal builtin tools. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.
- `tools: subagent, read`: a child-safe `subagent` tool is available inside that child so it can run explicitly assigned nested fanout.

Direct MCP tools require [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Subagents only receive direct MCP tools when `mcp:` entries are listed in their frontmatter; global `directTools: true` in `mcp.json` is not enough by itself. The generic `mcp` proxy tool can still be used for discovery when available. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools. An `mcp:` entry named `subagent` does not authorize nested fanout; only the builtin `subagent` tool name does.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

## Chain files

Chains are reusable workflows stored separately from agent files. Use `.chain.md` for simple sequential saved chains. Use `.chain.json` when a chain needs dynamic fanout.

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/chains/**/*.chain.md`, `~/.pi/agent/chains/**/*.chain.json` |
| Project | `.pi/chains/**/*.chain.md`, `.pi/chains/**/*.chain.json` |

Nested subdirectories are discovered recursively. If both `.chain.md` and `.chain.json` define the same parsed runtime chain name in the same scope, `.chain.json` wins. If user and project scopes define the same parsed runtime chain name, the project chain wins. Chains support the same optional `package` frontmatter as agents; `name: review-flow` plus `package: code-analysis` runs as `code-analysis.review-flow`.

Example (inline handoff; no repository-local files are created):

```md
---
name: research-work
description: Gather context then implement from inline findings
---

## research
phase: Context
label: Map auth flow

Analyze the codebase for {task}. Return concise findings inline.

## work
phase: Implementation
label: Apply the relevant findings

Implement the approved change using the prior inline findings: {previous}. Do not create a report or progress file unless explicitly requested.
```

Each `.chain.md` `## agent-name` section is a step. Config lines such as `phase`, `label`, `as`, `outputSchema`, `output`, `outputMode`, `reads`, `model`, `skills`, and `progress` go immediately after the header. A blank line separates config from task text. In saved `.chain.md` files, `outputSchema` is a path to a JSON Schema file; direct tool calls and `.chain.json` files can pass the schema object inline.

For `output`, `reads`, `skills`, and `progress`, chain behavior is three-state: omitted inherits from the agent, a value overrides, and `false` disables.

Use `phase` to group related work in status output, `label` for a readable step name, and `as` to store a successful step or parallel task result for later `{outputs.name}` references. Duplicate `as` names, invalid identifiers, and unknown output references fail before child execution.

Dynamic fanout is available only through direct `subagent({ chain: [...] })` JSON or saved `.chain.json` files. It expands an array from a prior structured named output, runs one child template per item, and stores the ordered collection under `collect.as`. The source must be structured output; prose is never parsed. `expand.maxItems` is required, over-limit arrays fail, nested fanout and arbitrary expressions are not supported, and `.chain.md` has no dynamic syntax in this release.

```json
{
  "name": "dynamic-review",
  "description": "Find review targets, fan out reviews, then synthesize.",
  "chain": [
    {
      "agent": "research",
      "task": "Return {\"items\":[{\"path\":\"...\",\"reason\":\"...\"}]} via structured_output.",
      "as": "targets",
      "outputSchema": { "type": "object" }
    },
    {
      "expand": {
        "from": { "output": "targets", "path": "/items" },
        "item": "target",
        "key": "/path",
        "maxItems": 12
      },
      "parallel": {
        "agent": "review",
        "label": "Review {target.path}",
        "task": "Review {target.path}. Reason: {target.reason}",
        "outputSchema": { "type": "object" }
      },
      "collect": { "as": "reviews" },
      "concurrency": 4
    },
    {
      "agent": "work",
      "task": "Synthesize fixes from {outputs.reviews}"
    }
  ]
}
```

Create simple `.chain.md` chains by writing files directly or with the `subagent({ action: "create", config: ... })` management action. Create dynamic `.chain.json` chains by writing the JSON file directly. Run saved chains with natural language or:

```text
/run-chain research-work -- refactor authentication
```

## Chain variables

Task templates support:

| Variable | Description |
|----------|-------------|
| `{task}` | Original task from the first step. |
| `{previous}` | Output from the prior step, or aggregated output from a parallel step. |
| `{chain_dir}` | Path to the chain artifact directory. |
| `{outputs.name}` | Text value from a prior step or completed parallel task with `as: "name"`. |

Parallel outputs are aggregated with clear separators before being passed to the next step:

```text
=== Parallel Task 1 (work) ===
...

=== Parallel Task 2 (work) ===
...
```

## Skills

Skills are `SKILL.md` files injected into an agent’s system prompt.

Discovery uses project-first precedence:

1. `.pi/skills/{name}/SKILL.md`
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. `.pi/settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "research", task: "..." }
{ agent: "research", task: "...", skill: "tmux, safe-bash" }
{ agent: "research", task: "...", skill: false }
```

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

Injected skills use this shape:

```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

Missing skills do not fail execution. The result summary shows a warning.

### Bundled skill

The package bundles a `pi-subagents` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: child subagents never receive it, and their context is explicitly filtered to strip parent-only orchestration instructions.

What the bundled skill covers:
- **Delegation patterns**: when to launch which agent, whether to use single, parallel, chain, or async mode, and whether to use fresh or forked context
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel review, review-loop, parallel research, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for `research` agents
- **Safety boundaries**: child agents must not run subagents unless their resolved builtin tools explicitly include `subagent`, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and prompt shortcuts encode the same workflows in user-facing form.

## Programmatic tool usage

These are the parameters the LLM passes when it calls the `subagent` tool. Most users ask naturally or use slash commands instead.

### Execution examples

```ts
// Single agent
{ agent: "work", task: "refactor auth" }
{ agent: "research", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "research", task: "investigate", output: false }
{ agent: "research", task: "write a large report", output: "reports/research.md", outputMode: "file-only" }

// Packaged agents use their declared fresh-context defaults
{ agent: "work", task: "continue this thread" }

// Parallel
{ tasks: [{ agent: "research", task: "a" }, { agent: "review", task: "b" }] }
{ tasks: [{ agent: "research", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "research", task: "audit frontend" }, { agent: "review", task: "audit backend" }] }

// Chain
{ chain: [
  { agent: "research", task: "Gather context for auth refactor" },
  { agent: "work" },
  { agent: "work" },
  { agent: "review" }
]}

// Chain in the background, suitable for unblocking the main chat
{ chain: [...], async: true }

// Chain with fan-out/fan-in
{ chain: [
  { agent: "research", task: "Gather context", phase: "Context", label: "Map code", as: "context" },
  // Requires the opt-in `parallel-work` agent shown in Worktree isolation.
  { parallel: [
    { agent: "parallel-work", task: "Implement feature A from {outputs.context}", label: "Feature A", as: "featureA" },
    { agent: "parallel-work", task: "Implement feature B from {outputs.context}", label: "Feature B", as: "featureB" }
  ], concurrency: 2, failFast: true, worktree: true },
  { agent: "review", task: "Review {outputs.featureA} and {outputs.featureB}" }
]}

// Dynamic fanout from structured output
{ chain: [
  {
    agent: "research",
    task: "Return review targets as structured_output: { items: [{ path, reason }] }",
    as: "targets",
    outputSchema: { type: "object" }
  },
  {
    expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 12 },
    parallel: { agent: "review", task: "Review {target.path}. Reason: {target.reason}", outputSchema: { type: "object" } },
    collect: { as: "reviews" },
    concurrency: 4
  },
  { agent: "work", task: "Synthesize fixes from {outputs.reviews}" }
] }

// Strict structured output for reliable handoff data
{ chain: [
  {
    agent: "research",
    task: "Return the key files and risks for {task}",
    as: "scan",
    outputSchema: {
      type: "object",
      required: ["files", "risks"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } }
      }
    }
  },
  { agent: "work", task: "Plan from this scan: {outputs.scan}" }
] }

// Worktree isolation (requires the explicit opt-in project agent shown below)
{ tasks: [
  { agent: "parallel-work", task: "Implement auth" },
  { agent: "parallel-work", task: "Implement API" }
], worktree: true }
```

### Management actions

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents and chains at runtime.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "research" }
{ action: "get", agent: "code-analysis.research" }
{ action: "get", chainName: "review-pipeline" }

{ action: "create", config: {
  name: "Code Research",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code research...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "parallel-research",
  thinking: "high"
}}

{ action: "create", config: {
  name: "review-pipeline",
  description: "Research then review",
  scope: "project",
  steps: [
    { agent: "research", task: "Scan {task}; return concise findings inline" },
    { agent: "review", task: "Review the prior inline findings: {previous}" }
  ]
}}

{ action: "update", agent: "code-analysis.research", config: { model: "openai/gpt-4o" } }
{ action: "update", chainName: "review-pipeline", config: { steps: [...] } }
{ action: "delete", agent: "research" }
{ action: "delete", chainName: "review-pipeline" }
```

`create` uses `config.scope`, not `agentScope`. `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter. `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes. To clear optional string fields, including `package`, set them to `false` or `""`.

### Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name for single mode, or target for management actions. |
| `task` | string | - | Task string for single mode. |
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `resume`, or `doctor`. |
| `chainName` | string | - | Chain name for management actions. |
| `config` | object/string | - | Agent or chain config for create/update. |
| `output` | `string \| false` | omitted | Explicitly save a single-agent output file; omitted output is inline-only. `false` disables a configured default. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Return explicit saved output inline or as a concise saved-file reference. `file-only` is an intentional persistence request and may use a generated path when no output path is supplied. |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all. |
| `model` | string | agent default | Override model. Explicit model changes require the target agent to allow `model`. |
| `maxSubagentDepth` | integer | config/agent default | Override nested depth for affected children; each target agent must allow `maxSubagentDepth`. |
| `tasks` | array | - | Top-level parallel tasks. Supports `agent`, `task`, `cwd`, `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, and `acceptance`. |
| `sandbox` | object | settings/agent default | Per-run sandbox fields; each affected agent must allow the provided `sandbox.<field>` paths. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. It is guarded and every affected agent must permit a shared request. |
| `chain` | array | - | Sequential, static parallel, and dynamic fanout chain steps. Sequential steps and parallel child tasks support `phase`, `label`, `as`, `outputSchema`, and `acceptance` in addition to the usual execution fields. Dynamic fanout uses `expand`, one child `parallel` template, and `collect`; group-level acceptance is not supported because there is no child session to finalize. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `work` defaults to `fresh`; explicit context changes require every affected agent to allow `context`. |
| `chainDir` | string | temp chain dir | Persistent directory for chain artifacts. |
| `clarify` | boolean | true for chains | Show TUI preview/edit flow. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | false | Background execution. For chains, `clarify: true` explicitly keeps the run foreground for the clarify UI. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `share` | boolean | false | Upload session export to GitHub Gist; explicit changes require every affected agent to allow `share`. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | object | omitted | Explicit acceptance contract. Self-review defaults to enabled for all agents with three turns; the target agent or an allowed run override may disable it. |

An explicit `context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. It never silently downgrades to `fresh`; the target agent must permit the override. In multi-agent runs, if any requested agent has `defaultContext: fork` and the launch omits `context`, the whole invocation uses forked context; pass `context: "fresh"` only when every affected agent permits that explicit override.

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging. In chains, later `{previous}` steps receive the same compact reference when the prior step used file-only mode.

Sequential and parallel chain tasks accept `agent`, `task`, `phase`, `label`, `as`, `outputSchema`, `cwd`, `output`, `outputMode`, `reads`, `progress`, `skill`, and `model`. Parallel tasks also accept `count`. Parallel step groups accept `parallel`, `concurrency`, `failFast`, and `worktree`. If `outputSchema` is present, the child must call `structured_output` with schema-valid JSON; prose-only completion or invalid JSON fails the step. Validated structured values are preserved on the step result, and `as` also exposes a compact text representation through `{outputs.name}`.

Status and control actions:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "status", id: "<nested-run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "interrupt", id: "<nested-run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "resume", id: "<nested-run-id>", message: "follow-up for a nested child" })
subagent({ action: "doctor" })
```

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching. Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands. Inside child-safe fanout mode, bare `status` requires an id when no local foreground run is active, so children cannot enumerate unrelated top-level async runs. Bare `interrupt` still targets only the visible top-level run; interrupting a nested run requires its explicit nested id.

`resume` sends the follow-up directly when an async child is still reachable over intercom. After completion, it revives the child by starting a new async child from the stored child session file. Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child. Nested runs can be resumed by nested id when their live route or persisted session metadata is available. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.

## Worktree isolation

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child its own git worktree branched from `HEAD`. For issue orchestration, the default is one parent-owned worktree: launch one `orchestrator` task with `worktree: true`, then let its inline explore → same-cwd work → fresh review loop share that worktree.

```ts
{ tasks: [
  { agent: "orchestrator", task: "Own this one issue in the assigned worktree; relay explorer findings inline, have work edit without committing, then have a fresh reviewer inspect the current git diff." }
], worktree: true }
```

Generic independent parallel work remains available for agents that explicitly opt into the guarded `worktree` override. Packaged `work` intentionally does not grant that override; define a project agent when independent writer worktrees are desired:

```md
<!-- .pi/agents/parallel-work.md -->
---
name: parallel-work
description: Independent worktree writer
tools: read, grep, find, ls, bash, edit, write
sandboxProvider: bubblewrap
sandboxProfile: host-toolchain
sandboxNetwork: host
sandboxAuth: pi-json
sandboxFallback: fail
sandboxPackageDiscovery: closed
defaultContext: fresh
canBeChangedByAgent: worktree
---
Implement the assigned task without committing; leave the diff in the worktree.
```

Then launch the opt-in agent:

```ts
{ tasks: [
  { agent: "parallel-work", task: "Implement auth", count: 2 },
  { agent: "parallel-work", task: "Implement API" }
], worktree: true }

{ chain: [
  { agent: "research", task: "Gather context" },
  { parallel: [
    { agent: "parallel-work", task: "Implement feature A from {previous}" },
    { agent: "parallel-work", task: "Implement feature B from {previous}" }
  ], worktree: true },
  { agent: "review", task: "Review all changes from {previous}" }
]}
```

Requirements:

- run inside a git repo
- working tree must be clean
- `node_modules/` is symlinked into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout

After a worktree parallel step completes, the runtime captures per-agent diff stats and full patch files before any intercom receipt or `finally` cleanup. The captured patch directory is included in the inline result and grouped intercom message, so the parent can apply that patch after the temporary worktrees are removed. Worktrees and temp branches are then cleaned up in `finally` blocks; do not rely on the child cwd still existing.

## Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`.

### `asyncByDefault`

```json
{ "asyncByDefault": true }
```

Makes top-level calls use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

### `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single, parallel, and chain runs into background mode and bypasses clarify UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

### `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

### `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.pi/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

### `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Per-agent `maxSubagentDepth` can tighten the limit for that agent’s child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent`; at the cap, execution fanout is blocked instead of silently hiding nested work.

### `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

Controls whether subagents receive runtime intercom coordination instructions and whether `intercom` and `contact_supervisor` are auto-added to async/background child tool allowlists when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.

Bridge activation also requires `pi-intercom` to be installed and enabled through `pi install npm:pi-intercom` or a legacy local extension checkout, a targetable current session name or fallback alias, and `pi-intercom` in any explicit agent `extensions` allowlist.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, generic `intercom` as fallback plumbing, and avoid routine completion handoffs.

### `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms.

### `externalTerminal`

Configure an external terminal emulator to open selected subagent sessions from the `/subagents` overlay.

```json
{
  "externalTerminal": {
    "command": "kitty",
    "args": ["-e", "pi", "--session", "{sessionFile}", "--cwd", "{cwd}"]
  }
}
```

Fields:

- `command`: Terminal emulator command. Must be an absolute path or a name resolvable on `PATH`.
- `args`: Optional argument list. Use `{sessionFile}` and `{cwd}` as placeholders; they are replaced with the selected subagent's best available session file and the base working directory. Arguments are passed as an array to `child_process.spawn`, so no shell escaping is needed.

Behavior:

- The `/subagents` overlay shows an `o open terminal` hint when a terminal command is configured.
- Press `o` on a selected run in list view or on a detail pane target to launch the terminal.
- If the selected run has no usable session file yet, the overlay shows a transient message explaining why the handoff is unavailable.
- If the terminal launch fails (command not found, session file missing, spawn error), the overlay stays open and falls back to the in-overlay viewer.
- Terminal processes are launched with `detached: true` so they outlive the parent Pi session.

Limitations:

- Terminal handoff requires a real child `sessionFile`. It is unavailable if the selected run or detail target has no `sessionFile`, regardless of whether the terminal command uses the `{sessionFile}` placeholder.
- Placeholder substitution is literal; `{sessionFile}` and `{cwd}` are the only supported replacements.
- The feature is overlay-only; text-mode status does not offer terminal handoff.

### `overlayShortcut`

Configure a keyboard shortcut to open the `/subagents` overlay directly in TUI mode.

```json
{
  "overlayShortcut": "ctrl+shift+s"
}
```

Behavior:

- The shortcut is registered only when `overlayShortcut` is explicitly set.
- In TUI mode, pressing the shortcut opens the same overlay as typing `/subagents`.
- In non-TUI modes, the shortcut shows an informational notification and does nothing else.
- No default shortcut is provided to avoid conflicts with existing keybindings.

Supported key identifiers include single keys (`f12`, `escape`), modifiers (`ctrl+s`, `alt+s`), and combined modifiers (`ctrl+shift+s`, `alt+ctrl+s`). Use the Pi keybindings documentation or `~/.pi/agent/keybindings.json` for reference.

## Files, logs, and observability

Each chain run may use a user-scoped runtime directory like:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

The default inline workflow does not create repository-local context, plan, progress, or report Markdown. Explicit `output`, `reads`, or `progress` settings may create intentional files in the configured/runtime location; directories older than 24 hours are cleaned up on extension startup. These runtime/session debug artifacts are separate from repo-local output reports.

Debug artifacts live under `{sessionDir}/subagent-artifacts/` or a user-scoped temp artifact directory. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent’s current leaf. That is a real session fork, not an injected summary.

Async completions notify only the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to render completion notifications.

Async runs write:

```text
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` powers the widget and `subagent({ action: "status" })` output. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata. Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

## Acceptance Gates

`acceptance` is an explicit contract. Omit it for lightweight runs. Set it on single runs, top-level parallel task items, sequential chain steps, static parallel task items, and dynamic fanout child templates when the child must prove the work meets concrete criteria. Do not set it on static parallel groups or dynamic fanout aggregate groups; those groups do not own a same-session child turn.

If you are coming from Codex Goals, `acceptance` is the subagent equivalent for one delegated run. When a user says `/goal`, “goal”, “active goal”, “continue until evidence says done”, or “verify against a goal”, translate that into an acceptance contract: `criteria` are the target, `evidence` and `verify` are proof, `stopRules` are constraints, `selfReview` can override the target agent default, and `maxFinalizationTurns` is its loop budget. Self-review defaults to enabled for all agents with three turns; set `acceptanceSelfReview: false` in an agent definition to opt out.

```ts
{
  agent: "work",
  task: "Implement the fix",
  acceptance: {
    criteria: ["Patch the bug without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    verify: [{ id: "focused", command: "npm test", timeoutMs: 120000 }],
    maxFinalizationTurns: 3
  }
}
```

When `acceptance` is present, the child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block. When self-review is enabled, the runtime continues the same persisted child session with a bounded acceptance finalization prompt so the child can repair omissions and return the final report; when disabled, the initial response is evaluated once. Missing or malformed required reports reject the run.

Public acceptance config is evidence-driven. There is no public `level` field and no `acceptance: "checked"` shorthand. Runtime provenance is derived from what actually happened:

- `attested`: the child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required criteria, required evidence, and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `reviewed`: an independent review result is present.
- `rejected`: attestation, structural checks, verification, review, or finalization failed.

Self-review finalization never counts as `reviewed`, and it never counts as `verified` unless configured runtime verification commands actually pass. The visible child output remains the initial answer; finalization reports and residual risks are stored in the acceptance ledger and async/status details.

### Per-agent override policy

Every explicit agent-specific run override is checked against the target agent's `canBeChangedByAgent` frontmatter list before any child starts. Guarded paths include `cwd`, `context`, `model`, `skills` (`skill` maps here), `output`, `outputMode`, `reads`, `progress`, `outputSchema`, `share`, `worktree`, `maxSubagentDepth`, each provided `acceptance.<field>`, and each provided `sandbox.<field>`. Use exact entries or segment-aware wildcards such as `*`, `acceptance.*`, and `sandbox.*`; substring matches are not used. Management rejects patterns that cannot match the guarded surface, and malformed manually-authored patterns fail closed rather than being normalized. A shared top-level override—including `worktree: true`—must be allowed by every affected agent. Clarify-TUI edits made by a human are applied after this raw-request preflight and are not treated as agent-generated overrides.

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Press `Ctrl+O` to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done research → running review`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "research", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Subagents can call `subagent` only when their resolved builtin tools explicitly include `subagent`. That is meant for delegated fanout agents, not ordinary work/review children. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session → subagent → sub-subagent. Deeper calls are blocked with guidance to complete the current task directly. Nested runs appear in the parent status widget and `status` output as a tree, and `status`, `interrupt`, and `resume` can target a nested run by its id.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices and persisted for async runs. With `pi-intercom`, needs-attention notices and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.

## Prompt-template integration

`pi-subagents` works standalone through natural language, the `subagent` tool, slash commands, and the packaged prompt shortcuts listed near the top of this README. If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), you can also wrap subagent delegation in your own reusable prompt templates.

Example:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to `browser-screenshoter` with `/tmp/screenshots` as cwd, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

For more reusable workflows on top of subagents, including `/chain-prompts` and compare-style prompts such as `/best-of-n`, install `pi-prompt-template-model` separately and copy the examples you want into `~/.pi/agent/prompts/`.

## Runtime files

The main runtime files are:

| File | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension registration, tool registration, message/render wiring. |
| `src/agents/agents.ts` | Agent and chain discovery, frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, chain, management, status, interrupt, and doctor actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling. |
| `src/runs/background/subagent-runner.ts` | Detached async runner. |
| `src/runs/background/async-execution.ts` | Background launch support. |
| `src/runs/background/async-status.ts` | Status discovery and formatting for async runs. |
| `src/runs/foreground/chain-execution.ts` / `src/agents/chain-serializer.ts` | Chain orchestration and `.chain.md` parsing. |
| `src/shared/settings.ts` | Chain behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime intercom bridge instructions and diagnostics. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` | Unit and loader-based integration tests. |
