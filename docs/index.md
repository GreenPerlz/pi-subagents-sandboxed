# pi-subagents-sandboxed

`pi-subagents-sandboxed` gives Pi a delegation tool and packaged agents for focused research, exploration, implementation, review, and orchestration. Packaged agents run in Bubblewrap by default; the goal is safer delegation with explicit, reviewable authority—not hostile-code-grade isolation.

## Quick start

1. Install the extension:

   ```bash
   pi install npm:pi-subagents-sandboxed
   ```

2. Install Bubblewrap (`bwrap`) with your OS package manager:

   === "Debian/Ubuntu"

       ```bash
       sudo apt install bubblewrap
       ```

   === "Fedora"

       ```bash
       sudo dnf install bubblewrap
       ```

   === "Arch"

       ```bash
       sudo pacman -S bubblewrap
       ```

3. Keep this fork **or** upstream `pi-subagents` enabled, not both.
4. Ask Pi in natural language:

   ```text
   Use review to review this diff.
   ```

   or use a slash command:

   ```text
   /run explore find the files and tests relevant to authentication
   ```

Read [mental model & execution modes](concepts.md) next, then choose an [agent](agents.md) and [workflow](workflows.md). When a writer edits code, read [Git, worktrees & recovery](git-worktrees.md) before integrating anything.

!!! warning "Fail closed is intentional"
    Bubblewrap is the default and packaged agents request `fallback: fail`. Do not work around a missing `bwrap` by making an unsafe opt-out. Fix the setup or make an explicitly trusted, narrowly authorized decision.

## What this package does

- Starts focused child Pi sessions in foreground, background, chain, parallel, and nested modes.
- Ships `explore`, `orchestrator`, `research`, `review`, and `work` agents.
- Applies a closed Bubblewrap runtime, Pi JSON credentials mounted read-only, and a `host-toolchain` profile by default.
- Keeps packaged read-only agents on read-only Git and gives packaged writers one runtime-managed isolated Git worktree.
- Returns sandbox diagnostics and preserves recovery evidence when isolated execution fails.

## Safety in one paragraph

The parent owns integration. A nested route can authorize a child launch, but it does not become Git authority. Isolated writers return bundles for inspection; they do not automatically cherry-pick into the parent checkout. Treat `provider: none`, `fallback: none`, broad mounts, and host-Git operation as trusted opt-outs, not convenience switches.

## Build the site locally

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve                 # live preview
mkdocs build --strict        # CI-equivalent check
```

The virtual environment and generated `site/` are local artifacts and must not be committed.
