#!/usr/bin/env bash
# Usage: PI_STANDALONE=/absolute/path/to/standalone/pi NODE_RUNTIME=/absolute/path/to/node PI_FIXTURE_GIT=/absolute/path/to/native/git bash scripts/standalone-scoped-git.sh
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
: "${PI_STANDALONE:?set PI_STANDALONE to the genuine external standalone Pi executable}"
: "${NODE_RUNTIME:?set NODE_RUNTIME to a separate executable Node runtime}"
[[ "$PI_STANDALONE" = /* && "$NODE_RUNTIME" = /* ]] || { echo 'absolute executables required' >&2; exit 2; }
[[ "$(realpath "$PI_STANDALONE")" != "$(realpath "$NODE_RUNTIME")" ]] || { echo 'standalone and Node must be distinct' >&2; exit 2; }
root="$(mktemp -d /tmp/v-XXXXXX)"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root"/{home,agent,sessions,config,data,cache,state,runtime,tmp,db,repo,source/test/fixtures}
chmod 700 "$root/runtime"
# The test loads the fixed checkout's source in a disposable private copy.
cp -a "$source_root/src" "$root/source/src"
cp "$source_root/test/fixtures/standalone-scoped-git.ts" "$root/source/test/fixtures/"
# Run this launcher only from the trusted outer parent: fixture initialization
# uses native Git exclusively in the disposable synthetic repository. The Pi
# extension below uses only authenticated scoped Git wrappers.
: "${PI_FIXTURE_GIT:?set PI_FIXTURE_GIT to the trusted outer parent native Git executable}"
[[ "$PI_FIXTURE_GIT" = /* ]] || { echo 'absolute native Git path required' >&2; exit 2; }
fixture_git() { env -i PATH=/usr/bin:/bin HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime" TMPDIR="$root/tmp" SQLITE_TMPDIR="$root/tmp" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "$PI_FIXTURE_GIT" -C "$root/repo" "$@"; }
fixture_git init -q
printf 'before\n' > "$root/repo/tracked"
fixture_git add tracked
fixture_git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
printf 'after\n' > "$root/repo/tracked"
# The FIXED checkout's extension and runtime source are loaded from a disposable copy.
# No real home, agent authentication, sessions, caches or global git config are inherited.
timeout --signal=KILL 25s env -i \
 PATH="$(dirname "$NODE_RUNTIME"):/usr/bin:/bin" HOME="$root/home" PI_CODING_AGENT_DIR="$root/agent" \
 XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" \
 XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime" TMPDIR="$root/tmp" SQLITE_TMPDIR="$root/tmp" \
 PI_SESSION_DIR="$root/sessions" PI_DATABASE_DIR="$root/db" \
 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
 SCOPED_FIXTURE_ROOT="$root" SCOPED_FIXTURE_STANDALONE="$PI_STANDALONE" SCOPED_FIXTURE_GIT="$PI_FIXTURE_GIT" \
 "$PI_STANDALONE" --no-extensions --extension "$root/source/test/fixtures/standalone-scoped-git.ts" --no-session -p 'fixture exits during session_start; no model call'
