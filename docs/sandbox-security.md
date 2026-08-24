# Sandbox and security model

Bubblewrap is the packaged default provider. The supported MVP profile is `host-toolchain`: common host runtime/toolchain paths are mounted read-only, while the child cwd/worktree is mounted according to Git and write policy. This is local containment, not a guarantee against a hostile kernel, privileged host, or every side channel.

## Effective policy

Resolution is run options → agent frontmatter → settings defaults. Every guarded run override must be allowed by the target agent. A project setting cannot grant the trusted user-global permissions needed for sandbox opt-out.

Packaged defaults:

- `provider: bubblewrap`, `profile: host-toolchain`, `network: host`.
- `auth: pi-json`: required Pi auth files are read-only; full settings are not mounted.
- `packageDiscovery: closed`: child Pi starts with closed extension/prompt/theme discovery and only explicit runtime extensions.
- `fallback: fail`: if Bubblewrap cannot be applied, the child does not run unsandboxed.
- `explore`, `research`, `review`: Git `read-only`.
- `work`, `orchestrator`: Git `isolated`.

Host networking is needed for normal model/API calls. Set `network: none` only for a task that can operate offline; it prevents normal provider access.

## Filesystem and writes

`edit` and `write` tools infer writable cwd/worktree access. A bash-only agent remains read-only unless its trusted definition sets `sandboxBashWrite: true`. Git metadata protection is separate from filesystem write inference.

Use the narrowest extra mount:

```json
{
  "sandbox": {
    "extraReadOnlyMounts": ["/opt/project-toolchain"],
    "extraWritableMounts": [".cache/subagent-build"]
  }
}
```

Read-only mounts are for installed tools or inputs. Writable mounts are only for caches, outputs, and work directories. Never mount all of `$HOME` to fix one missing path.

## Opt-outs are explicit trust decisions

- `provider: "none"` means no Bubblewrap and host-Git access; it requires trusted user-global `allowSandboxOptOut: true` and emits a prominent diagnostic.
- `fallback: "none"` is a guarded continuation after sandbox setup failure, records that the run was not sandboxed, and is not equivalent to permission to opt out.
- `worktree: false` requires the target's `canOptOutOfWorktree: true` plus the trusted user-global worktree ceiling; parent Git metadata remains read-only in that mode.
- `packageDiscovery: ambient` is unsafe legacy behavior and may need broader mounts. Prefer `closed` or, when needed, narrowly supported `project-local`.

!!! warning "Diagnostics are evidence"
    Inspect `details.results[*].sandbox` (or async status/run logs). Verify `provider`, `fallbackOccurred`, redacted mounts, and diagnostics before treating a result as sandboxed.

## Diagnosing denied access safely

1. Re-run the smallest failing command inside the sandbox.
2. For `execvp ... No such file or directory`, mount only the narrow host directory containing the installed executable as read-only.
3. For `EACCES`, `EPERM`, or `EROFS`, use a dedicated cache/output/work directory and add only that path as writable.
4. Keep `fallback: fail`; do not retry unsandboxed without explicit trusted authorization.

Sandbox diagnostics redact selected local roots before they appear in result details, status, logs, or intercom projections. They are useful evidence, not proof that every host detail is hidden.
