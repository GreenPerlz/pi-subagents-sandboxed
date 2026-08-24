<p>
  <img src="https://raw.githubusercontent.com/GreenPerlz/pi-subagents-sandboxed/main/banner.png" alt="pi-subagents-sandboxed" width="1100">
</p>

# pi-subagents-sandboxed

`pi-subagents-sandboxed` is a [Pi](https://github.com/badlogic/pi-mono) extension for delegating work to focused child agents. It supports single agents, chains, parallel fanout, background runs, nested orchestration, and recovery—with Bubblewrap containment and protected Git metadata by default.

This project is a sandbox-focused replacement fork of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents), based on upstream v0.27.0. Do not enable both extensions in the same Pi environment.

## Documentation

**Read the complete guide:** https://greenperlz.github.io/pi-subagents-sandboxed/

The guide covers installation, agents, workflows, isolated Git and worktrees, recovery bundles, sandbox policy, async and nested runs, configuration, troubleshooting, and the agent integration contract. Documentation source lives in [`docs/`](docs/index.md).

## Install

Install [Bubblewrap](https://github.com/containers/bubblewrap) first:

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
```

Then install the extension:

```bash
pi install npm:pi-subagents-sandboxed
```

Packaged agents fail closed when Bubblewrap cannot be applied. See the [quick start](https://greenperlz.github.io/pi-subagents-sandboxed/) for other distributions and setup details.

## Packaged agents

| Agent | Purpose | Git access |
| --- | --- | --- |
| `explore` | Find relevant code, tests, and call paths | Read-only |
| `research` | Research external documentation and facts | Read-only |
| `review` | Review code, plans, and acceptance evidence | Read-only |
| `work` | Implement and commit an assigned change | Isolated Git |
| `orchestrator` | Coordinate explore → work → review loops | Isolated Git |

Ask Pi naturally:

```text
Use explore to map the authentication flow.
Have work implement this approved change, then run a fresh review.
Run two read-only reviews in parallel: correctness and tests.
```

Packaged writers commit inside runtime-managed isolated Git. The trusted parent verifies the returned bundle and deliberately integrates the authored commits; children do not modify or integrate into the canonical parent checkout automatically.

## Safety scope

The extension uses Bubblewrap to narrow child filesystem, Git, credential, package-discovery, and network access. It preserves recovery evidence and fails closed when isolation or teardown cannot be proven. This is local containment for safer delegation, not hostile-code-grade isolation.

Sandbox opt-outs and host-Git operation require trusted user-level authorization. Additional mounts must be configured explicitly and remain subject to sandbox policy. A nested route or control token is never Git authority.

## Development

```bash
npm ci
npm run check:pi-version
npm test
npm run test:integration
```

Build the documentation:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs build --strict
```

See [`CHANGELOG.md`](CHANGELOG.md) for release history and [GitHub Issues](https://github.com/GreenPerlz/pi-subagents-sandboxed/issues) for bugs and feature requests.

## License

MIT
