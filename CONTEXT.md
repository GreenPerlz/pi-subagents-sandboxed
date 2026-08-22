# Scoped Git runtime

An **isolated Git runtime** is an owner-managed private checkout and Git policy boundary. A **scoped Git endpoint** is an opaque Unix socket mounted read-only into one sandbox subtree; the trusted owner records its canonical worktree, cwd, rights, network, and lease state. A **writer lease** is exclusive per canonical worktree while read-only scopes may run concurrently. The **owner** creates scopes, delegates child scopes monotonically, executes Git policy, and owns export, recovery, fencing, and cleanup.
