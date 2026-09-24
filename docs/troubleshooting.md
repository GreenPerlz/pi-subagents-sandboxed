# Troubleshooting and doctor

Start with the read-only doctor action:

```text
/subagents-doctor
```

```ts
subagent({ action: "doctor" })
```

It reports setup and discovery diagnostics without changing configuration. Then inspect the exact run status and result details.

## Common symptoms

### `bwrap` is missing or sandbox setup fails

Install Bubblewrap and verify `bwrap --version`. Packaged agents use `fallback: fail`, so a missing provider should stop the child rather than silently run on the host. Do not solve this by setting `provider: none`; that is a trusted user-global opt-out.

### Nested Bubblewrap fails with `No permissions to create a new namespace`

A working single-level `bwrap` or a completed isolated-Git orchestrator does **not** prove nested agents can start. First check the effective policy (permitted run options → agent frontmatter → settings defaults): the orchestrator and writer need Bubblewrap with isolated Git, nested observers read-only Git, and `fallback: fail`. A `provider: none`/read-only-Git configuration failure is separate from a kernel denial after configuration is repaired. Check the run's sandbox provider, Git mode, fallback diagnostics, nested child result, and exported bundle; a successful parent export alone is not nested success. See [sandbox policy](sandbox-security.md) and [nested scope inheritance](git-worktrees.md).

On Linux with `/usr/bin/bwrap`, `/usr/bin/sh`, `/usr/bin/true`, `/usr/bin/grep`, `cat`, `/usr`, `/lib`, and `/lib64` available, save the following as `nested-bwrap-probe.sh` outside sensitive worktrees and run it **as the affected unprivileged user**, not as root. Both levels must have a private `/tmp` (as well as proc/dev and PID isolation); omitting `/tmp` can produce a different missing-path error. Adapt library paths only if the host genuinely uses different paths; do not rename or copy `bwrap` to evade executable policy.

```sh
#!/bin/sh
printf 'host_label='; cat /proc/self/attr/current
/usr/bin/bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp --unshare-pid --die-with-parent \
  /usr/bin/sh -c '
    printf "outer_child_label="; cat /proc/self/attr/current
    /usr/bin/grep -E "^(Cap|NoNewPrivs|Seccomp)" /proc/self/status
    /usr/bin/bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
      --proc /proc --dev /dev --tmpfs /tmp --unshare-pid --die-with-parent /usr/bin/true
    result=$?; printf "nested_exit=%s\n" "$result"; exit "$result"
  '
```

Capture the exit code and, if available, trace **the same probe** with `strace -f -e trace=clone,unshare,execve -o nested-bwrap.trace sh ./nested-bwrap-probe.sh` (exit 1 in the VPS case). Inspect `cat /proc/self/attr/current` and the printed outer-child label, `bwrap --version`, `uname -r`, and readable `sysctl kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns kernel.apparmor_restrict_unprivileged_unconfined`; unavailable sysctl keys are not evidence of denial. The trace identifies a syscall and errno, not the responsible kernel policy.

**Observed case (September 2026, not a universal diagnosis):** on Ubuntu kernel `7.0.0-31-generic` with bwrap 0.11.1, the host label was `unconfined` and the outer child was `bwrap//&unpriv_bwrap (enforce)`. The outer `clone(CLONE_NEWNS|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD)` succeeded; the inner invocation of the same `/usr/bin/bwrap` failed that clone with `EPERM`, exited 1, and printed `bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.` The child's `NoNewPrivs: 1`, `Seccomp: 0`, and zero capability sets/bounding set do not on their own establish the denial cause; zero capabilities alone are normal Bubblewrap behavior. Unprivileged user namespaces were enabled (`kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=57290`); AppArmor restriction sysctls were 1. The installed `/etc/apparmor.d/bwrap-userns-restrict` explicitly stacks `unpriv_bwrap` on child exec and includes `audit deny capability,`. **Read-only kernel audit now confirms the cause:** `sudo journalctl -k --since today` returned no entries, but a separately authorized read-only `sudo dmesg` showed repeated `apparmor="DENIED" operation="capable" class="cap" profile="unpriv_bwrap" comm="bwrap" capability=21 capname="sys_admin"` records, including the actual nested smoke and a fresh corrected reproducer. For example, the traced nested process has `apparmor="DENIED" operation="capable" class="cap" profile="unpriv_bwrap" pid=3595739 comm="bwrap" capability=21 capname="sys_admin"`. The stacked `unpriv_bwrap` profile denies `CAP_SYS_ADMIN` needed by nested Bubblewrap on this VPS. This confirms the cause, **not a verified fix**. A corrected identical private-`/tmp` probe passed on an Arch `7.1.9-arch1-2` workstation with bwrap 0.11.2; its earlier probe without `/tmp` failed for a different reason. This comparison does not prove a version defect or that upgrading bwrap fixes the VPS policy.

For a bounded diagnostic read, an administrator can use `sudo journalctl -k --since '<probe start time>' --until '<probe end time>' --no-pager` and inspect only relevant `apparmor=`, `unpriv_bwrap`, or `bwrap` records; if that source is empty, `sudo dmesg` can be filtered for those same terms and correlated by probe time and traced pid. Do not publish unrelated kernel messages or private paths. Timed sudo authorization here covered **read-only diagnosis only**; profile installation/reload or sysctl changes require separate approval. A dedicated policy review must determine any narrow workload-specific profile/transition, security impact, rollback, and validation against the installed AppArmor parser; no remediation is applied or proven. Adding an allow beside the existing deny is not proven sufficient. Do not globally disable AppArmor/userns restrictions, rename/copy the executable to escape path policy, grant capabilities broadly to all `unpriv_bwrap` children, bypass containment guards, or fall back to host execution.

After an approved remedy, repeat the corrected probe, then run the **actual** sandboxed orchestrator → nested explore/work/review workflow: verify each child started with inherited scoped Git rights, writer commits and clean state, fresh review of authored base-to-head history/tree, and exact inherited scope/bundle export evidence. Confirm two independent parallel issue runs receive distinct isolated scopes before resuming #8/#13. A direct isolated documentation writer is not a substitute for this nested-architecture proof.

### A tool is not found inside the child

Re-run the smallest failing command and inspect the sandbox diagnostic. If the tool exists on the host but is not mounted, add only its containing directory to `extraReadOnlyMounts`. If it is not installed on the host, install it outside the child and retry.

### Writes fail with `EACCES`, `EPERM`, or `EROFS`

Check both tool/write inference and Git mode. `edit`/`write` agents get writable cwd access; bash-only agents need explicit trusted `sandboxBashWrite: true`. For a cache or output, use a narrow `extraWritableMounts` path. Do not make the whole home directory writable.

### The child cannot call another agent

Nested delegation requires `subagent` in the resolved child tool allowlist, plus a remaining `maxSubagentDepth`. A visible nested route does not bypass those checks. Packaged `explore`, `research`, `review`, and `work` are intentionally not general nested fanout agents.

### Async work appears stalled

Use `subagent({ action: "status", id: "..." })`. Needs-attention notices may suggest status, interrupt, or a follow-up. `interrupt` is pause-oriented for detached runs; use `resume` with a message when the session is reachable or persisted. See [async lifecycle](async-lifecycle.md).

### Completion disappeared after reload

Look up the persisted run and configured session directory. Startup reconciliation repairs stale projections, while revival requires the child `.jsonl` session. A missing session cannot be revived; use preserved output or Git recovery evidence instead.

### An isolated writer failed

Read the original error and the returned `gitBundle` metadata. Verify the bundle with ordinary Git tools, inspect authored commits separately from runtime recovery commits, and use the preserved worktree path if export failed. The parent—not the child—decides whether to cherry-pick or apply a reviewed patch.

### Parallel work conflicts

Do not run writers in one checkout. Use parent-managed `worktree: true` only for agents that explicitly permit it, or use isolated Git without `worktree: true`. Ensure the parent checkout is clean before parent-managed worktrees are created.

## Evidence to collect

When reporting a problem, include:

- agent name and execution mode,
- exact command/tool call and run id,
- doctor output and `status` details,
- sandbox provider/profile/fallback diagnostics (including whether fallback occurred),
- Git mode and bundle path/checksum if present,
- the original error and the smallest reproducible command.

Redacted mount paths are intentional. Do not paste auth files, full environment dumps, or broad home-directory listings into a report.
