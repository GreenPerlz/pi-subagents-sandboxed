# Configuration and reference routing

Most users need no configuration beyond Bubblewrap. Effective values resolve from broadest to narrowest authority:

1. user settings,
2. project settings (override user settings),
3. agent frontmatter (overrides settings defaults),
4. permitted run options (override frontmatter).

At each user or project scope, dedicated `subagents.json` wins over the legacy `settings.json -> subagents` block. Agent discovery separately follows project over user over packaged definitions. A run option is effective only when the target agent's `canBeChangedByAgent` permits that exact override; precedence is not authority. The complete list of settings, frontmatter fields, acceptance fields, run options, and recovery metadata is preserved in the [settings reference](settings-reference.md); use this page to route concepts rather than duplicate that reference.

## Minimal safe defaults

```json
{
  "sandbox": {
    "defaultProvider": "bubblewrap",
    "defaultProfile": "host-toolchain",
    "network": "host",
    "auth": "pi-json",
    "fallback": "fail",
    "packageDiscovery": "closed",
    "allowSandboxOptOut": false,
    "allowWorktreeOptOut": false
  }
}
```

`allowSandboxOptOut` and `allowWorktreeOptOut` are trusted user-global ceilings. Do not set them in a project file to grant a child extra authority. Prefer adding a narrow read-only or writable mount over broadening the provider.

## Settings by purpose

- **Execution:** `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`.
- **Fanout:** `parallel.maxTasks`, `parallel.concurrency`, chain dynamic-fanout limits, and worktree mode.
- **Agent discovery:** `disableBuiltins`, `agentOverrides`, project/user agent directories.
- **Control:** `control`, `intercomBridge`, `externalTerminal`, and `overlayShortcut`.
- **Sandbox:** provider/profile, network/auth, fallback, package discovery, project trust, and extra mounts.
- **Worktree setup:** `worktreeSetupHook` and its timeout; hooks must be explicit executable paths and return valid JSON.

## Run-level routing

The `subagent` tool supports single, parallel, chain, and management actions. Typical control calls are:

```ts
subagent({ action: "list" })
subagent({ action: "get", agent: "review" })
subagent({ action: "doctor" })
```

Guarded fields such as `model`, `context`, `output`, `worktree`, `acceptance.*`, and `sandbox.*` are checked against every affected agent's `canBeChangedByAgent`. `async`, `clarify`, and `concurrency` are orchestration controls, not grants of child capability.

## Configuration checklist

- Keep packaged agents on their declared defaults unless you have a specific, trusted reason.
- Set `fallback: fail` for containment-sensitive work.
- Use `pi-json` rather than inherited environment credentials when supported.
- Prefer `closed` package discovery.
- Set `maxSubagentDepth` to a bounded value before enabling nested fanout.
- Treat session logs, async state, recovery bundles, and ordinary output artifacts as different data classes.

For exact accepted values and legacy compatibility, consult [Settings reference](settings-reference.md). For operational failures, use [Troubleshooting & doctor](troubleshooting.md).
