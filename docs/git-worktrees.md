# Git, worktrees, and recovery

Git isolation is a policy boundary as well as a filesystem choice. The parent owns the canonical checkout, integration, export, recovery, fencing, and cleanup. A scoped Git endpoint is an opaque route into one owned scope; nested route authority is not Git authority.

## Two safe access modes

| Git mode | Project files | Git metadata | Use |
| --- | --- | --- | --- |
| `read-only` | Read-only for observers; may be writable when `edit`/`write` tools or trusted `bashWrite` enable content writes | Parent metadata remains protected | `explore`, `research`, `review`, and custom agents that must not change Git state |
| `isolated` | Writable private runtime-managed worktree | Private Git metadata/object layer | `work`, `orchestrator`, and explicitly configured commit-producing writers |

A custom agent with no sandbox frontmatter defaults to **read-only Git**, not necessarily read-only project files: write inference can still mount its cwd writable when it has `edit` or `write` tools. Packaged writers default to isolated Git. Host-Git operation (`provider: none`) and `worktree: false` are trusted, guarded opt-outs—not defaults.

## Isolated versus parent-managed worktrees

Direct packaged writer launches receive exactly one runtime-managed isolated worktree. Nested writer/reviewer calls inherit the parent's scoped endpoint and do not create nested worktrees. For independent parallel writers, a parent may use `worktree: true` with agents that explicitly permit it. A parent-managed worktree requires a clean Git checkout, and its temporary worktrees are removed after patches/diff stats are captured.

!!! danger "Do not combine isolation mechanisms"
    Do not set `worktree: true` for an agent already using `sandboxGitMode: isolated`. Choose parent-managed worktrees for independent uncommitted branches, or isolated Git for runtime-managed commit bundles.

## Success and recovery bundles

Isolated Git exports one owner-only bundle for every terminal outcome: success, failure, timeout, cancellation/interruption, acceptance failure, or orchestration rejection. A successful writer should commit its change; the bundle metadata reports authored commits, base/head, checksums, dirty state, and a recovery ref. Runtime recovery commits are packaging evidence, not child-authored history.

If staged index state and final worktree state differ, metadata may include `stagedSnapshot`; `recovery` remains the final worktree-result tip. Ignored files and runtime-synthetic paths are excluded. If export fails, the original error remains visible and an actionable preserved worktree path is retained—never assume failed cleanup means lost work.

Bundles are owner-only and retained for seven days by default. Cleanup is best effort and never removes a runtime worktree whose export failed. `artifacts: false` does not disable recovery export.

## Parent integration and cherry-pick flow

The runtime does not auto-integrate isolated work. Inspect first:

```bash
git bundle verify /path/to/bundle
git bundle list-heads /path/to/bundle
# Replace this example with the exact named head ref reported by the result.
head_ref=refs/heads/isolated-0
git fetch /path/to/bundle "$head_ref":refs/review/subagent-head
git log --oneline <base>..refs/review/subagent-head
git show <authored-commit>
```

Use only refs reported by the result metadata and `git bundle list-heads`. A recovery or staged-snapshot ref is optional; do not assume either exists. If metadata reports one that you need, fetch that exact ref into a temporary review namespace before inspecting it.

Then choose one deliberate integration path in the canonical parent checkout:

```bash
# Authored commits only, after review.
git cherry-pick <authored-commit>...

# Or, only when metadata reported and you fetched a recovery ref, apply its
# reviewed final state without adopting runtime packaging commits.
git diff <base> refs/review/subagent-recovery > /tmp/recovery.patch
git apply /tmp/recovery.patch
git add -A
```

Resolve conflicts as the parent, run tests, and review the resulting diff. Never cherry-pick a runtime recovery commit merely because it is reachable from the bundle.

## Safe parallel integration

1. Keep the parent checkout clean before creating parent-managed worktrees.
2. Give each writer a disjoint task and explicit output/commit expectations.
3. Capture each result and patch before temporary worktrees are cleaned.
4. Integrate one reviewed change at a time, or cherry-pick independent authored commits in a planned order.
5. Run tests after integration; do not let a child push, merge, reset, or rewrite the parent checkout.

For a writer that must author commits in isolated Git:

```yaml
---
name: isolated-writer
description: Commit-producing isolated writer
sandboxProvider: bubblewrap
sandboxGitMode: isolated
sandboxProfile: host-toolchain
sandboxNetwork: host
sandboxAuth: pi-json
sandboxFallback: fail
sandboxPackageDiscovery: closed
---
Implement the task, commit authored changes, and leave the isolated checkout clean.
```

The source [settings reference](settings-reference.md) defines every Git and recovery field.

## Preconditions and boundaries

Isolated Git requires a Git repository, configured `user.name` and `user.email`, Linux with Bubblewrap, a repository-contained cwd, and no unsandboxed fallback. A task subdirectory is mapped to the same relative location in the private worktree. The parent owns scoped endpoint creation and delegation monotonically; a child cannot widen its inherited scope.
