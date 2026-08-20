# Subagent settings reference

This page is the compact reference for persistent extension settings, agent Markdown frontmatter, acceptance contracts, and common run options. Each setting is described in no more than two sentences; see the main [README](../README.md) for complete examples and workflow guides.

## Configuration locations and precedence

- **User settings:** `~/.pi/agent/subagents.json` applies across projects.
- **Project settings:** `.pi/subagents.json` overrides user settings for that project.
- **Legacy settings:** `settings.json -> subagents` is still read, but a same-scope `subagents.json` wins.
- **Agent definitions:** User agents live in `~/.pi/agent/agents/*.md`, project agents in `.pi/agents/*.md`, and packaged agents in this repository's [`agents/`](../agents) directory. Project agents override same-named user agents, and user/project agents override packaged agents.

## Extension settings (`subagents.json`)

### Execution

- **`asyncByDefault`** — Runs top-level subagent calls in the background when `async` is omitted. An explicit `async: false` still requests foreground execution unless `forceTopLevelAsync` applies.
- **`forceTopLevelAsync`** — Forces top-level execution into the background and disables clarification for that launch. Nested subagent calls are not forced.
- **`defaultSessionDir`** — Sets the default directory for child session logs. A run-level `sessionDir` takes precedence.
- **`maxSubagentDepth`** — Sets the default nesting limit for subagents. Agent and permitted run limits may tighten it, but nested callers cannot loosen an inherited limit.
- **`worktreeSetupHook`** — Points to a repository-relative or absolute executable that prepares each new worktree. Bare command names are rejected so the executed file is explicit.
- **`worktreeSetupHookTimeoutMs`** — Sets the worktree setup hook timeout in milliseconds. A timeout fails worktree setup before children launch.

### Parallel and dynamic fanout

- **`parallel`** — Groups persistent limits and concurrency defaults for top-level parallel execution. Its child fields may still be overridden by permitted run options.
- **`parallel.maxTasks`** — Sets the maximum number of expanded tasks in a top-level parallel run. It defaults to `8`.
- **`parallel.concurrency`** — Sets the default number of parallel tasks that may run simultaneously. A run-level `concurrency` overrides it.
- **`chain`** — Groups persistent defaults for saved and inline chain execution. It currently contains dynamic-fanout configuration.
- **`chain.dynamicFanout.maxItems`** — Caps the number of children materialized by dynamic fanout. A bounded step-level `expand.maxItems` may tighten the run.

### Builtin agents

- **`disableBuiltins`** — Hides all packaged builtin agents from discovery. User and project agents remain available.
- **`agentOverrides`** — Applies small changes to packaged agents without editing their Markdown files. Supported fields are `model`, `fastMode`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`.
- **`agentOverrides.<name>.disabled`** — Hides one packaged agent. Set it to `false` or remove the override to make that agent available again.

### Control and notifications

- **`control`** — Groups attention detection and notification defaults for all runs. A run-level `control` object may override these values.
- **`control.enabled`** — Enables runtime attention tracking and control notifications. It defaults to `true`.
- **`control.needsAttentionAfterMs`** — Marks an inactive running child as needing attention after this many milliseconds. It defaults to `60000`.
- **`control.activeNoticeAfterMs`** — Emits an informational long-running notice after this elapsed time. It defaults to `240000`.
- **`control.activeNoticeAfterTurns`** — Optionally emits a long-running notice after this many child turns. Omit it to disable turn-based notices.
- **`control.activeNoticeAfterTokens`** — Optionally emits a long-running notice after this many tokens. Omit it to disable token-based notices.
- **`control.failedToolAttemptsBeforeAttention`** — Escalates repeated mutating-tool failures after this many attempts. It defaults to `3`.
- **`control.notifyOn`** — Selects `active_long_running`, `needs_attention`, or both for notification. An empty array disables control notifications without disabling state tracking.
- **`control.notifyChannels`** — Selects any of `event`, `async`, and `intercom` as delivery channels. It defaults to all three.

### Intercom and UI

- **`intercomBridge`** — Groups settings for supervisor/child communication injection. It does not itself launch another agent.
- **`intercomBridge.mode`** — Controls supervisor/child intercom injection with `off`, `fork-only`, or `always`. Use the narrowest mode required by the workflow.
- **`intercomBridge.instructionFile`** — Supplies an additional instruction file for bridged child sessions. The file is read by the parent and passed into the child setup.
- **`externalTerminal`** — Groups the command and arguments used to open child sessions outside the Pi TUI. It is inactive until a command is configured.
- **`externalTerminal.command`** — Sets the terminal executable used to open child sessions externally. It may be an absolute path or a command resolvable through `PATH`.
- **`externalTerminal.args`** — Sets terminal arguments and supports `{sessionFile}` and `{cwd}` placeholders. Arguments are passed directly without shell interpolation.
- **`overlayShortcut`** — Registers a TUI shortcut such as `ctrl+shift+s` for the subagent overlay. No shortcut is registered when it is omitted.

### Sandbox defaults

- **`sandbox`** — Groups default sandbox behavior inherited by agents and runs. Agent frontmatter overrides these defaults, and run-level sandbox fields override the agent.
- **`sandbox.defaultProvider`** — Sets the default sandbox provider, normally `bubblewrap`; omitting it also uses Bubblewrap, while an explicit run-level provider `none` opts out.
- **`sandbox.defaultProfile`** — Sets the default sandbox profile, normally `host-toolchain`. The profile determines the base mounts and runtime shape.
- **`sandbox.network`** — Uses `host` for normal network access or `none` for an isolated network namespace. Model/API calls generally require `host`.
- **`sandbox.auth`** — Uses `pi-json` to mount Pi auth files read-only or `env` to rely on inherited credentials. Prefer `pi-json` when supported.
- **`sandbox.trustProject`** — Allows the sandbox policy to trust project-local files and configuration. Leave it false for stricter treatment of project input.
- **`sandbox.fallback`** — Uses `fail` to refuse unsandboxed execution or `none` to continue without the sandbox after setup failure. Packaged agents use fail-closed behavior.
- **`sandbox.extraReadOnlyMounts`** — Adds narrow read-only paths for required tools or inputs. Avoid broad mounts such as the whole home directory.
- **`sandbox.extraWritableMounts`** — Adds narrow writable paths for required caches or outputs. Only grant directories the child must modify.
- **`sandbox.packageDiscovery`** — Uses `closed`, `project-local`, or unsafe legacy `ambient` package discovery. Packaged agents use `closed` by default.

## Agent Markdown frontmatter

### Identity and prompt

- **`name`** — Sets the local agent name and is required. With `package`, the runtime name becomes `package.name`.
- **`package`** — Adds an optional package namespace to the runtime name. It lets packages contain agents with otherwise-colliding local names.
- **`description`** — Provides the short description shown during agent discovery. It should clearly state the agent's role and boundaries.
- **Markdown body** — Everything after the closing `---` is the agent's system prompt. It defines the role, workflow, and behavioral constraints.
- **`systemPromptMode`** — `replace` uses the Markdown body instead of Pi's base prompt, while `append` adds it to the base prompt. Packaged agents normally use `replace`.
- **`inheritProjectContext`** — Keeps inherited project instruction blocks when true. Set false when the handoff should be isolated from project-level context.
- **`inheritSkills`** — Keeps Pi's discovered skills catalog when true. Explicit `skills` still inject named skills even when this is false.
- **`defaultContext`** — Uses `fresh` for an independent child session or `fork` to branch from the parent session by default. A permitted run override may change it.

### Models, tools, and skills

- **`model`** — Sets the agent's default model. If omitted, the child inherits the current/default model selection.
- **`fallbackModels`** — Lists ordered backup models used for retryable provider failures such as auth, quota, timeout, or unavailability. Ordinary task failures do not trigger these fallbacks.
- **`thinking`** — Sets the model thinking level, such as `high`, when supported. It is applied as a model suffix unless one is already present.
- **`fastMode`** — Requests the provider priority service tier for this agent; it is persisted in agent frontmatter and management/builtin overrides, and defaults to off. It is injected for canonical bundled models whose Pi adapter supports priority, currently `openai` and `openai-codex` models using Pi's Responses adapters, including GPT-5.6 Sol, Terra, and Luna. Registry API and base URL must match the bundled catalog, so custom replacements and proxies remain unsupported.
- **`tools`** — Sets the builtin tool allowlist; omitting it gives the child Pi's normal builtin tools. Entries prefixed with `mcp:` select direct MCP tools, and `subagent` explicitly permits bounded nested fanout.
- **`extensions`** — Omitted loads normal extensions, an empty value loads none, and a comma-separated value allowlists extensions. Use explicit extension paths for a closed child runtime.
- **`skill` / `skills`** — Injects one or more named skills into the child. `skills` is the canonical guarded override path used by `canBeChangedByAgent`.

### Files and execution behavior

- **`output`** — Sets an intentional default saved-output filename for single-agent runs. Omitted output is inline-only; a permitted run override may replace or disable the configured path.
- **`defaultReads`** — Opt-in list of files the runtime asks the agent to read before chain or parallel work. Omitted reads do not create or consult context/plan files.
- **`defaultProgress`** — Opt-in maintenance of `progress.md`; it is disabled when omitted, and read-only/review tasks may suppress it when inappropriate.

Session logs, async status, and debug artifacts remain runtime/session data; they are distinct from repo-local saved-output reports, which require an explicit output or file-only request.

- **`interactive`** — Is parsed for compatibility with older definitions. It is not currently enforced by the runtime.
- **`maxSubagentDepth`** — Tightens how deeply this agent's children may delegate. It cannot loosen a stricter inherited limit.

### Acceptance and self-review

- **`acceptanceSelfReview`** — After the subagent says it is complete, it continues in the same session and checks or repairs its submission against the parent's acceptance criteria. It only runs when the launch has an acceptance contract and defaults to `true`; set it to `false` to opt an agent out.
- **`acceptanceMaxFinalizationTurns`** — Sets the maximum number of same-session self-review/repair turns from `1` to `10`. It defaults to `3` for all agents.
- **`canBeChangedByAgent`** — Lists which explicit run settings the parent agent may change for this target agent. Omitted or empty means deny all overrides, and denied values fail before any child starts.

`canBeChangedByAgent` accepts exact paths and segment wildcards such as `model`, `acceptance.*`, `sandbox.*`, or the global `*`. Malformed or unsupported patterns fail closed, and management-created definitions reject patterns that cannot match a guarded setting.

Guarded paths are `cwd`, `context`, `model`, `fastMode`, `skills`, `output`, `outputMode`, `reads`, `progress`, `outputSchema`, `share`, `worktree`, `maxSubagentDepth`, every `acceptance.<field>`, and every `sandbox.<field>`. A shared override in a multi-agent launch must be allowed by every affected agent; this includes a shared `worktree: true` request. The packaged `orchestrator` explicitly opts into `worktree`; other agents remain deny-by-default unless their definition opts in.

### Agent sandbox

- **`sandboxGitMode`** — Uses `read-only` by default. Opt into `isolated` only with `sandboxProvider: bubblewrap`; the runtime creates a private Git metadata/object layer from the exact assigned base, and exports a compact successful-run bundle. Isolated mode fails closed on ordinary checkouts, unsupported platforms/providers, missing Git identity, and unsafe writable mounts. A guarded `sandbox.gitMode` run override follows the same checks.
- **`sandboxProvider`** — Sets this agent's sandbox provider, normally `bubblewrap`. It overrides the extension default.
- **`sandboxProfile`** — Sets this agent's sandbox profile, normally `host-toolchain`. It controls the base sandbox environment.
- **`sandboxNetwork`** — Sets this agent's network mode to values such as `host` or `none`. Offline mode prevents normal model/API access from inside the child process.
- **`sandboxTrustProject`** — Allows sandbox policy to trust project-local files and configuration for this agent. Keep it false unless project-local discovery is required.
- **`sandboxBashWrite`** — Lets a bash-only agent imply writable cwd access. Without it, bash-only/read-only agents remain read-only while `edit` or `write` agents are inferred as writers.
- **`sandboxAuth`** — Selects the child authentication policy, commonly `pi-json` or `env`. `pi-json` mounts the necessary Pi auth files read-only.
- **`sandboxFallback`** — Chooses `fail` or `none` if sandbox setup cannot be applied. `fail` prevents accidental unsandboxed execution.
- **`sandboxExtraReadOnlyMounts`** — Adds comma-separated read-only mounts for this agent. Use the narrowest paths containing required tools or inputs.
- **`sandboxExtraWritableMounts`** — Adds comma-separated writable mounts for this agent. Restrict them to required caches, outputs, or work directories.
- **`sandboxPackageDiscovery`** — Selects `closed`, `project-local`, or `ambient` package discovery. Prefer `closed`; `ambient` is unsafe legacy behavior.

Fast mode is compatible with closed sandboxes: the child runtime's explicit prompt extension is mounted and loaded alongside the sandbox intercom extension, so the request transformation does not require ambient package discovery. Priority service tiers can change price and availability; `fastMode` does not claim provider activation when Pi does not expose an authoritative response flag.

## Acceptance contract settings

- **`criteria`** — Lists required outcomes as strings or objects with `id`, `must`, optional `evidence`, and optional `severity`. The child must use the exact generated criterion IDs in its `acceptance-report`.
- **`criteria[].id`** — Gives a criterion a stable identifier. If omitted from a string criterion, the runtime generates one.
- **`criteria[].must`** — Describes the outcome that must be true. It should be concrete enough to verify.
- **`criteria[].evidence`** — Lists evidence required specifically for that criterion. Supported evidence kinds are shown below.
- **`criteria[].severity`** — Uses `required` or `recommended`. Recommended criteria do not reject the run when unsatisfied.
- **`evidence`** — Requires global evidence fields in the acceptance report. Values include `changed-files`, `tests-added`, `commands-run`, `validation-output`, `residual-risks`, `no-staged-files`, `diff-summary`, `review-findings`, and `manual-notes`.
- **`verify`** — Lists commands the runtime executes rather than trusting the child's claim. A failed required command rejects acceptance.
- **`verify[].id`** — Gives a verification command a stable identifier. It is included in the acceptance ledger.
- **`verify[].command`** — Sets the command executed for verification. It runs without asking the child to report success on trust alone.
- **`verify[].timeoutMs`** — Sets the command timeout in milliseconds. Omit it to use the runtime default.
- **`verify[].cwd`** — Changes the verification command's working directory. Relative paths are resolved from the run context.
- **`verify[].env`** — Adds string environment variables to the verification command. It does not replace the complete environment.
- **`verify[].allowFailure`** — Records a failing command without making it a required acceptance failure. Use it only for advisory checks.
- **`review`** — Declares an independent review gate and does not turn self-review into independent review. Launch a separate fresh `review` subagent to produce genuine review evidence.
- **`review.agent`** — Names the expected reviewer. It is descriptive gate metadata and does not automatically spawn that agent.
- **`review.focus`** — Describes what the independent reviewer should examine. Keep it narrow and testable.
- **`review.required`** — Makes the review gate required unless set to false. A child cannot satisfy a required independent review gate through self-review alone.
- **`stopRules`** — Lists hard constraints for deciding whether to continue, stop as blocked, or report success. They are repeated in every self-review prompt.
- **`selfReview`** — Explicitly enables or disables same-session self-review for this run and overrides the target agent default. The target agent must allow `acceptance.selfReview` in `canBeChangedByAgent`.
- **`maxFinalizationTurns`** — Overrides the agent's self-review turn budget for this run from `1` to `10`. It is dormant when self-review is disabled and requires `acceptance.maxFinalizationTurns` permission.

## Common run options

- **`agent`** — Selects one agent for single mode. Do not combine it with `tasks` or `chain` as another execution mode.
- **`task`** — Supplies the delegated instruction. Chain templates may reference it as `{task}`.
- **`tasks`** — Starts top-level parallel mode with one configuration object per child. Task-level agent settings are checked against each target's override policy.
- **`chain`** — Starts sequential, static-parallel, or dynamic-fanout workflow mode. Each child step is checked against its target agent's override policy.
- **`cwd`** — Sets the working directory shared by affected children. Every affected agent must permit `cwd` when it is explicitly provided.
- **`context`** — Uses `fresh` or `fork` context for the launch. Every affected agent must permit an explicit context change.
- **`model`** — Overrides the target model for a single/task run. The target agent must permit `model`.
- **`fastMode`** — Requests priority for one launch, task, or chain step; it is a guarded override and the target agent must permit `fastMode`. Unsupported candidates still run normally and report `unsupported`; unavailable model metadata reports `requested` without injecting priority, and fallback candidates are evaluated independently.
- **`skill`** — Adds, replaces, or disables skills for the relevant child or chain. It maps to the guarded `skills` path.
- **`output`** — Sets an output path or `false` to disable saved output. The target agent must permit `output`.
- **`outputMode`** — Uses `inline` or `file-only` result delivery. `file-only` is an intentional persistence request and may use an automatically generated runtime path when no explicit output path is supplied.
- **`reads`** — Supplies files to read before work or `false` to disable reads. The target agent must permit `reads`.
- **`progress`** — Enables or disables progress-file tracking. The target agent must permit `progress`.
- **`outputSchema`** — Requires strict structured output matching a JSON Schema object. The target agent must permit `outputSchema`.
- **`acceptance`** — Supplies the acceptance contract described above. Every explicitly supplied acceptance field needs its matching permission.
- **`sandbox`** — Supplies per-run sandbox fields that override agent and extension defaults. Every explicitly supplied sandbox field needs its matching permission.
- **`maxSubagentDepth`** — Overrides the nesting limit for affected children. It may replace the top-level config but cannot loosen an inherited nested limit.
- **`share`** — Requests session sharing through the configured Pi mechanism. Every affected agent must permit `share`.
- **`async`** — Selects background or foreground execution. It is an orchestration control and is not governed by `canBeChangedByAgent`.
- **`clarify`** — Opens the human clarification editor where supported. Human edits occur after raw agent-generated override preflight.
- **`concurrency`** — Sets simultaneous workers for top-level parallel mode. It is an orchestration control rather than an agent-specific override.
- **`worktree`** — Isolates parallel writers in Git worktrees. It requires a clean Git repository, and every affected agent must permit the guarded `worktree` override.
- **`chainDir`** — Sets the persistent directory for chain artifacts and named outputs. It is an orchestration path rather than a child-agent override.
- **`sessionDir`** — Sets the child session-log directory. It takes precedence over `defaultSessionDir`.
- **`artifacts`** — Enables or disables debug artifacts for the run. It does not alter the child agent's capabilities.
- **`includeProgress`** — Includes full progress text in returned results. It only changes result detail size.
- **`maxOutput`** — Overrides final output truncation limits in bytes and lines. Full output may still be available in saved artifacts.
- **`control`** — Overrides control/attention settings for this run. It is an orchestration control and does not change the agent definition.
