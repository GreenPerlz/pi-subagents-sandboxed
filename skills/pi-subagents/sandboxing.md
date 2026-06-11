# Sandboxing reference for `pi-subagents`

Use this note when you need to explain or change how sandboxed subagent runs work in this fork.

## Mental model

Sandboxing happens in three stages:

1. **Resolve config** in `src/sandbox/config.ts`
   - precedence: **run options > agent frontmatter > settings defaults**
   - `extraReadOnlyMounts` and `extraWritableMounts` are **additive** across those layers
   - if `provider` is omitted or set to `none`, the run is **not sandboxed**
   - default auth becomes `pi-json` whenever a provider is configured

2. **Build mounts** in `src/sandbox/mount-policy.ts`
   - mounts cwd/worktree
   - auto-mounts linked-worktree gitdir/common gitdir when needed
   - mounts session/output/progress/status paths
   - mounts package/extension runtime paths needed by the child
   - mounts auth material depending on `auth`
   - adds explicit read-only and writable mounts

3. **Wrap the child Pi invocation** in `src/sandbox/bubblewrap.ts`
   - validates provider/profile/network
   - prepends baseline Bubblewrap mounts
   - injects env and `bwrap` args
   - either runs sandboxed, fails closed, or falls back unsandboxed if explicitly allowed

Related behavior:
- `src/sandbox/write-inference.ts` decides whether cwd/worktree must be writable
- `src/sandbox/preflight.ts` does focused checks such as `gh auth`, git probe, and linked-worktree access
- `src/sandbox/diagnostics.ts` explains common missing-mount and read-only failures

## Where users can configure sandboxing

### Per run

```ts
subagent({
  agent: "worker",
  task: "Fix the selected issue",
  sandbox: {
    provider: "bubblewrap",
    profile: "host-toolchain",
    network: "host",
    auth: "pi-json",
    fallback: "fail",
    packageDiscovery: "closed"
  }
})
```

### Per agent frontmatter

```yaml
sandboxProvider: bubblewrap
sandboxProfile: host-toolchain
sandboxNetwork: host
sandboxAuth: pi-json
sandboxFallback: fail
sandboxPackageDiscovery: closed
```

### Settings defaults

```json
{
  "subagents": {
    "sandbox": {
      "defaultProvider": "bubblewrap",
      "defaultProfile": "host-toolchain",
      "network": "host",
      "auth": "pi-json",
      "fallback": "fail",
      "packageDiscovery": "closed"
    }
  }
}
```

## Supported modes today

### Provider

- `bubblewrap`: wraps the child with `bwrap`
- `none` or omitted: no sandbox

### Profile

- `host-toolchain`: **the only implemented Bubblewrap profile right now**

Do not assume users can invent a new profile name in config. Profiles are code-defined, not data-defined.

### Network

- `host`: normal network access for model/API calls
- `none`: passes `--unshare-net` for offline work

### Fallback

- `fail`: default, safest, refuses to continue if Bubblewrap cannot be applied
- `none`: explicitly allows the original unsandboxed invocation and records that fallback happened

### Package discovery

- `closed`: default, child Pi starts with closed-runtime flags and only explicit runtime/extension inputs
- `project-local`: still closed by default, but the parent resolves project-local Pi packages and mounts their extension roots read-only
- `ambient`: legacy/unsafe, reopens more normal discovery and may require broader mounts

## Auth modes

There are effectively **two auth behaviors** today.

### 1. `pi-json` (default)

`pi-json` is the safe default. In `src/sandbox/mount-policy.ts` it mounts:
- `~/.pi/agent/auth.json` read-only
- `~/.pi/agent/subagents.json` read-only, when present, so nested sandboxed children can honor builtin agent overrides without broader settings access

It intentionally does **not** mount:
- `~/.pi/agent/settings.json`

Why that matters:
- the child gets Pi provider auth without inheriting broader user settings/package discovery
- this reduces accidental ambient package loading inside the sandbox
- it is the right default for most sandboxed child runs

Accepted strings with this same behavior currently include:
- `pi-json`
- `pi-config`
- `auth-json`
- `file`
- `json`

Prefer documenting and using **`pi-json`**.

### 2. `env`

`env` means **no auth file mount is added by sandbox mount policy**.
The child must rely on credentials already present in its environment.

Use `env` only when you deliberately want environment-based credentials.

Tradeoff vs `pi-json`:
- `pi-json` = file-based Pi auth, narrower and more explicit
- `env` = environment-based auth, simpler when the host session already exports credentials

### Anything else

Any other auth string currently behaves like “no special auth mount” from the mount-policy perspective. For clarity, use only:
- `pi-json`
- `env`

## Writable vs read-only behavior

Write access is inferred, not granted broadly.

- agents with `edit` or `write` tools get writable cwd/worktree mounts
- `bash` alone stays read-only unless `bashWrite: true` is set
- explicit `extraWritableMounts` should be only caches, outputs, temp/work dirs
- explicit `extraReadOnlyMounts` should be toolchains, inputs, config, or other immutable dependencies

Parallel sandboxed writers require `worktree: true`.

## How to edit the existing profile

Today, editing `host-toolchain` means editing code, not just settings.

Primary files:
- `src/sandbox/bubblewrap.ts`
- `src/sandbox/mount-policy.ts`
- `src/sandbox/write-inference.ts` when writable policy changes
- `src/sandbox/preflight.ts` when profile assumptions affect checks
- `README.md` and this file for docs
- `test/unit/sandbox-*.test.ts` for coverage

Typical profile edits:

### Change the baseline read-only host toolchain mounts

Edit `HOST_TOOLCHAIN_READONLY_PATHS` in `src/sandbox/bubblewrap.ts`.

Current baseline includes paths like:
- `/usr`
- `/bin`
- `/sbin`
- `/lib`
- `/lib64`
- `/etc`

Keep these mounts narrow and read-only.

### Change network behavior

Edit validation and wrapping behavior in `src/sandbox/bubblewrap.ts`.
Currently only `host` and `none` are accepted.

### Change auth-file mounting behavior

Edit `authModeUsesPiJson()` and `addSandboxAuthMounts()` in `src/sandbox/mount-policy.ts`.
That is where `pi-json` gets translated into read-only `auth.json` and `subagents.json` mounts.

### Change runtime-mounted paths

Edit `buildSubagentSandboxMounts()` in `src/sandbox/mount-policy.ts`.
That is where cwd, outputs, progress files, linked-worktree gitdirs, package roots, extension paths, and intercom state are mounted.

## How to add a new profile

There is no generic “drop in a profile file” mechanism yet. To add a new Bubblewrap profile:

1. **Teach the provider to recognize it**
   - update profile validation in `src/sandbox/bubblewrap.ts`

2. **Define the profile’s baseline mounts and isolation rules**
   - read-only system/toolchain mounts
   - whether network modes differ
   - whether extra runtime paths must be mounted

3. **Verify mount policy still makes sense**
   - cwd/worktree mode
   - output/progress/session paths
   - linked worktrees
   - package/extension resolution
   - auth mounts

4. **Update docs**
   - `README.md`
   - this file
   - any agent frontmatter/examples that should use the new profile

5. **Add tests**
   - provider wrapping tests
   - mount-policy tests
   - config-resolution tests if new config semantics are introduced

Until that is done, the profile name is not real.

## Safe tuning workflow

When a sandboxed run fails:

1. rerun the smallest failing command/test
2. inspect sandbox diagnostics in result details or async status
3. if an executable is missing, add the narrowest containing dir to `extraReadOnlyMounts`
4. if a cache/output/work path needs writes, add the narrowest dir to `extraWritableMounts`
5. keep `fallback: "fail"` unless the user explicitly approves unsandboxed fallback

Prefer adding one narrow mount and re-testing over broadening the whole sandbox.

## Important caveats

- `host-toolchain` is the only implemented profile today
- `trustProject` is accepted by schema/config but is not currently a meaningful Bubblewrap behavior switch in this fork; do not rely on it for access control
- `pi-json` covers Pi auth plus dedicated subagent override config (`subagents.json`); other tools may still need their own narrowly scoped mounts if they depend on external config files
- do not mount all of `$HOME` just to make a failing tool work
