// Loaded directly by the external standalone Pi executable, never by a simulated resolver.
// Run with scripts/standalone-scoped-git.sh. All inputs are private synthetic paths.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createScopedGitEndpoint, reserveScopedGitChildDescriptor, scopedGitDescriptorMounts } from "../../src/sandbox/scoped-git-endpoint.ts";

export default function (pi: { on: (event: string, handler: () => Promise<void>) => void }) {
 pi.on("session_start", async () => {
  let owner: ReturnType<typeof createScopedGitEndpoint> | undefined;
  try {
   const root = process.env.SCOPED_FIXTURE_ROOT!;
   const standalone = fs.realpathSync(process.env.SCOPED_FIXTURE_STANDALONE!);
   if (fs.realpathSync(process.execPath) !== standalone || /^node(?:\.exe)?$/i.test(path.basename(process.execPath))) throw Error(`not a standalone Pi parent: ${process.execPath}`);
   // The outer parent prepares this synthetic repository with native Git;
   // this extension uses only the authenticated scoped wrappers.
   const repo = path.join(root, "repo");
   if (!fs.existsSync(path.join(repo, ".git")) || fs.readFileSync(path.join(repo, "tracked"), "utf8") !== "after\n") throw Error("synthetic repository was not prepared by the outer parent");
   const savedPath = process.env.PATH;
   const rejected = (name: string, pattern: RegExp) => {
    const candidate = path.join(root, name);
    try {
     createScopedGitEndpoint({ runtimeRoot: candidate, worktree: repo, rights: "read-only", gitPath: process.env.SCOPED_FIXTURE_GIT! });
     throw Error(`${name}: unexpectedly published an endpoint`);
    } catch (error) {
     if (!pattern.test(String(error)) || fs.existsSync(candidate)) throw error;
    }
   };
   try {
    process.env.PATH = "";
    rejected("missing-node", /requires an absolute Node runtime/);
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.symlinkSync(standalone, path.join(bin, "node")); process.env.PATH = bin;
    rejected("aliased-node", /aliased to standalone Pi/);
    fs.unlinkSync(path.join(bin, "node"));
    fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\necho not-javascript\n", { mode: 0o755 });
    rejected("non-js-node", /working Node JavaScript runtime/);
    fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", { mode: 0o755 });
    const probeStart = Date.now();
    rejected("term-resistant-node", /working Node JavaScript runtime/);
    if (Date.now() - probeStart > 3500) throw Error("Node runtime probe exceeded its bound");
   } finally { process.env.PATH = savedPath; }
   owner = createScopedGitEndpoint({ runtimeRoot: path.join(root, "rt"), worktree: repo, rights: "read-only", gitPath: process.env.SCOPED_FIXTURE_GIT! });
   const child = owner.reserveChild({ rights: "read-only" });
   // Reserve through the child's endpoint: its returned coordinate is relative
   // to the child's rebound mount, not the owner's original endpoint root.
   const grandchild = await reserveScopedGitChildDescriptor(child.descriptor, { rights: "read-only" });
   const systemMounts: string[] = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--dir", "/run", "--dir", "/tmp"];
   for (const sys of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    if (!fs.existsSync(sys)) continue;
    if (fs.lstatSync(sys).isSymbolicLink()) systemMounts.push("--symlink", fs.readlinkSync(sys), sys);
    else systemMounts.push("--ro-bind", fs.realpathSync(sys), sys);
   }
   // Each descriptor is interpreted inside its parent's fixed /run/pi-scoped-git
   // mount, never resolved against the outer host's unrelated /run subtree.
   // Cross each process boundary as JSON: non-enumerable host-root metadata
   // must not be available to the nested child or grandchild mount lookup.
   const childDescriptor = JSON.parse(JSON.stringify(child.descriptor));
   const grandchildDescriptor = JSON.parse(JSON.stringify(grandchild));
   const levels = [owner.invocationMounts(), scopedGitDescriptorMounts(childDescriptor), scopedGitDescriptorMounts(grandchildDescriptor)];
   for (let level = 1; level < levels.length; level++) {
    const relative = level === 1 ? childDescriptor.relativeSubtree : grandchildDescriptor.relativeSubtree;
    if (levels[level]![0]!.source !== path.join("/run/pi-scoped-git", relative)) throw Error("nested mount did not rebind relative to its parent");
   }
   const invoke = async (depth: number, command: string) => {
    let executable = "/run/pi-scoped-git/git";
    let argv = [command, ...(command === "status" ? ["--short"] : [])];
    for (let level = depth; level >= 0; level--) {
     const args = [...systemMounts];
     for (const mount of levels[level]) args.push("--ro-bind", mount.source, mount.target ?? mount.source);
     for (const dir of ["home", "agent", "sessions", "config", "data", "cache", "state", "runtime", "tmp", "db", "repo"]) {
      const privatePath = path.join(root, dir);
      args.push("--bind", privatePath, privatePath);
     }
     args.push("--chdir", repo, "--clearenv");
     for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "SQLITE_TMPDIR", "PI_CODING_AGENT_DIR", "PI_SESSION_DIR", "PI_DATABASE_DIR"]) args.push("--setenv", key, process.env[key]!);
     args.push("--setenv", "PATH", "/usr/sbin:/usr/bin:/bin", "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null", "--", executable, ...argv);
     executable = "/usr/sbin/bwrap";
     argv = args;
    }
    return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
     const proc = spawn("bwrap", argv, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
     const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
     proc.stdout.on("data", data => { stdout += data; if (stdout.length > 65536) proc.kill("SIGKILL"); });
     proc.stderr.on("data", data => { stderr += data; if (stderr.length > 65536) proc.kill("SIGKILL"); });
     proc.on("error", reject); proc.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
   };
   for (const [depth, label] of ["owner", "child", "grandchild"].entries()) {
    const statusStart = Date.now();
    const status = await invoke(depth, "status");
    const statusMs = Date.now() - statusStart;
    if (status.status !== 0 || status.stdout !== " M tracked\n" || status.stderr) throw Error(`${label} status: ${JSON.stringify(status)}`);
    const diffStart = Date.now();
    const diff = await invoke(depth, "diff");
    const diffMs = Date.now() - diffStart;
    if (diff.status !== 0 || !diff.stdout.includes("-before\n+after\n") || diff.stderr) throw Error(`${label} diff: ${JSON.stringify(diff)}`);
    console.log("STANDALONE_SCOPED_GIT_SCOPE " + JSON.stringify({ label, statusMs, status: status.stdout.trimEnd(), diffMs, diff: diff.stdout.match(/-before\n\+after\n/)?.[0].trimEnd() }));
   }
   console.log("STANDALONE_SCOPED_GIT_OK " + JSON.stringify({ parentExecPath: process.execPath }));
   process.exitCode = 0;
  } catch (error) { console.error("STANDALONE_SCOPED_GIT_FAIL", error); process.exitCode = 1; }
  finally { if (owner && !(await owner.close())) process.exitCode = 1; process.exit(); }
 });
}
