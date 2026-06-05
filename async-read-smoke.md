# Async Read Smoke — Repository Inspection Report

## (1) Files Inspected

- `package.json` — project metadata, dependencies, scripts, Pi extension registration.
- `README.md` — comprehensive user documentation (first ~950 lines; full file is 1215 lines).
- `src/sandbox/bubblewrap.ts` — core Bubblewrap sandbox provider implementation (~160 lines).
- *Also skimmed:* `docs/prd/sandboxed-subagents.md` for design context (not required, but helpful).

## (2) What the Project Appears to Do

`pi-subagents-sandboxed` is a **Pi coding-agent extension** that lets the parent Pi session delegate work to focused child agents (subagents). It supports:

- Single, parallel, chain, and async subagent runs
- Worktree isolation for parallel writers
- Forked or fresh child context
- TUI clarification UI before launching workflows
- Optional `pi-intercom` bridge for child-to-parent coordination

**Key differentiator:** This is a *fork* of upstream `pi-subagents` (v0.27.0) that adds **Bubblewrap sandboxing by default** for its packaged builtin agents (`researcher`, `reviewer`, `worker`). The sandbox constrains filesystem access (read-only host toolchain mounts, narrow writable mounts), network (`host` or `none`), and auth (`pi-json` read-only, no broad `$HOME` mounts). It is intended as a safer-by-default replacement for the upstream package, not a companion to it.

## (3) One Interesting Implementation/Design Observation

The `BubblewrapSandboxProvider` in `src/sandbox/bubblewrap.ts` uses a **"host-toolchain" profile** with an elegant dual-layer access model:

1. **Read-only baseline:** It mounts standard host paths (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`) and the Node.js install root read-only, plus `/proc` and `/dev` for process functionality.
2. **Write inference:** It does *not* blindly make the working directory writable. Instead, writability is inferred from the agent’s declared tools — agents with `edit` or `write` tools get a writable cwd/worktree; `bash`-only agents stay read-only unless `sandboxBashWrite: true` is explicitly set. This prevents accidental mutation by read-only reviewers/researchers.
3. **Fail-closed fallback:** If `bwrap` is unavailable, the default behavior throws `SandboxUnavailableError` and refuses to run. Only an explicit `fallback: "none"` config opts out, and even then the result is flagged with `fallbackOccurred: true` and a diagnostic warning.

This design reflects a "narrowest necessary privilege" philosophy rather than a broad-container approach.

## (4) Confirmation: No Files Were Modified

This inspection was **read-only**. Only `ls`, `read`, and `write` (for this report file) were used. No source files, configuration files, or documentation were edited, created, or deleted in the repository.
