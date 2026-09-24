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

**Observed case (September 2026, not a universal diagnosis):** on Ubuntu kernel `7.0.0-31-generic` with bwrap 0.11.1, the host label was `unconfined` and the outer child was `bwrap//&unpriv_bwrap (enforce)`. The outer `clone(CLONE_NEWNS|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD)` succeeded; the inner invocation of the same `/usr/bin/bwrap` failed that clone with `EPERM`, exited 1, and printed `bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.` The child's `NoNewPrivs: 1`, `Seccomp: 0`, and zero capability sets/bounding set do not on their own establish the denial cause; zero capabilities alone are normal Bubblewrap behavior. Unprivileged user namespaces were enabled (`kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=57290`); AppArmor restriction sysctls were 1. The installed `/etc/apparmor.d/bwrap-userns-restrict` explicitly stacks `unpriv_bwrap` on child exec and includes `audit deny capability,`. **Read-only kernel audit now confirms the cause:** `sudo journalctl -k --since today` returned no entries, but a separately authorized read-only `sudo dmesg` showed repeated `apparmor="DENIED" operation="capable" class="cap" profile="unpriv_bwrap" comm="bwrap" capability=21 capname="sys_admin"` records, including the actual nested smoke and a fresh corrected reproducer. For example, the traced nested process has `apparmor="DENIED" operation="capable" class="cap" profile="unpriv_bwrap" pid=3595739 comm="bwrap" capability=21 capname="sys_admin"`. The stacked `unpriv_bwrap` profile denied `CAP_SYS_ADMIN` needed by nested Bubblewrap on this VPS. A corrected identical private-`/tmp` probe passed on an Arch `7.1.9-arch1-2` workstation with bwrap 0.11.2; its earlier probe without `/tmp` failed for a different reason. This comparison does not prove a version defect or that upgrading bwrap fixes the VPS policy.

For a bounded diagnostic read, an administrator can use `sudo journalctl -k --since '<probe start time>' --until '<probe end time>' --no-pager` and inspect only relevant `apparmor=`, `unpriv_bwrap`, or `bwrap` records; if that source is empty, `sudo dmesg` can be filtered for those same terms and correlated by probe time and traced pid. Do not publish unrelated kernel messages or private paths. Diagnostic sudo does not authorize policy changes.

**Installed remedy on this VPS (September 2026):** after user approval for nested Bubblewrap workloads generally (not a Pi-only startup gate), independent policy review, and a backup **outside** `/etc/apparmor.d`, the administrator changed only the adjacent explanatory comment and the `unpriv_bwrap` rule in root-owned, mode-0644 `/etc/apparmor.d/bwrap-userns-restrict`:

```diff
-# The unpriv_bwrap profile is used to strip capabilities within the userns
+# The unpriv_bwrap profile restricts capabilities within the userns
 profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {
@@
-  audit deny capability,
+  allow capability sys_admin,
```

All other capabilities remain default-denied by `unpriv_bwrap`; this is not a blanket capability grant. The backed-up original SHA-256 was `d61facde27707b9c47ffe47921b7273e788784484cb5530eb819e6daac1f1990`; the installed file SHA-256 was `78cefdebc2120d877d6c2f6b00f8cc70a14509912e11b3184d9a483ce617e17e`. A proposed `priority=1 allow capability sys_admin,` in `local/unpriv_bwrap` compiled identically to the original policy and **failed** live nesting; it is not a working alternative. Neither local override was retained. AppArmor's allow is **not namespace-qualified**: it does not grant missing host capabilities, but could allow use of host `CAP_SYS_ADMIN` by a Bubblewrap child that already held it. This is a deliberate tradeoff affecting all workloads under that profile, not only Pi. Do not run privileged host agents to validate it. Vendor package updates may replace or conflict with this file; re-review and revalidate after updates.

Before any administrator-owned change, preserve the exact original file with owner/mode and hash in a protected location **outside** `/etc/apparmor.d` (a backup there may be parsed as another profile), record the full comment-and-rule diff, verify the installed profile and parser, and obtain policy approval. For rollback, first verify the current installed file still matches the reviewed candidate; restore the backed-up original as root:root 0644 to `/etc/apparmor.d/bwrap-userns-restrict`, reload **that named policy** with `/usr/sbin/apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`, then verify the original hash, active enforcement and a fresh probe. Do not overwrite intervening administrator/package changes blindly. This rollback disables the newly enabled nesting; keep `fallback: fail` rather than continuing on the host. Do not globally disable AppArmor/userns restrictions, modify global sysctls, rename/copy the executable to escape path policy, broadly grant capabilities, bypass containment guards, or give agents permanent sudo/root.

**Functional verification:** the corrected two-level probe above exited `nested_exit=0` as non-root host UID 1001. Private mount, PID, proc, dev and tmp boundaries passed. An expanded inner `--unshare-net` variant requested `NET_ADMIN` and was denied; the passing variant shares networking per the runtime's `network: host` contract, **not** universal Bubblewrap flag parity. A negative `ip link set lo up` test within a private network namespace had effective `NET_ADMIN` there (`CapEff: 0000000000001000`) and was denied (`ip_exit=2`). The renewed read-only audit confirms `apparmor="DENIED" operation="capable" profile="unpriv_bwrap" pid=3615350 comm="ip" capability=12 capname="net_admin"` at epoch `1790289481.453`, matching the negative-test fixture mtime `1790289481.4545`. An earlier `net_admin` audit applied to nested `bwrap`, not this `ip` test. Temporary diagnostic sudo did not grant permanent privileges or change timer/sudoers settings.

The actual configured sandboxed orchestrator run `1eeebd19-5a0f-4e78-9299-3014f325c40d` launched foreground explore `682f0e26`, sole work `37cf9ff6` (authored commit `944ae8c144f2f82a265cad4786770bb15c0281ea`), and fresh observation-only review `41668783` in the **same isolated scope**. Its clean authored bundle was verified by the parent; diagnostics reported Bubblewrap, isolated Git, `fallback: fail`, `fallbackOccurred: false` and no host fallback. A predecessor had hit a separate missing-`/tmp` runtime setup obstacle: the provider did not explicitly create `/tmp`. A supported `extraReadOnlyMounts` entry for an **empty, owned** `/tmp/pi-nested-bwrap-bootstrap-20260924` made the sandbox's private `/tmp` exist without exposing host `/tmp`. Recreate that empty directory after removal/reboot as needed; this is a scoped configuration workaround, not a permanent extension fix. The functional nesting smoke and matching negative audit proof passed. Fresh #8/#13 work was launched in parallel isolated scopes (batch `897c09d3-bacb-4a18-a183-7004074e69d8`), but only initial exploration was reported; this does not establish product completion or verify the two actual scope paths.

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
