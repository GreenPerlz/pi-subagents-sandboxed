import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createScopedGitEndpoint, scopedGitDescriptorMounts } from "../../src/sandbox/scoped-git-endpoint.ts";
import { getPiSpawnCommand, resolveNodeRuntime } from "../../src/runs/shared/pi-spawn.ts";
import { buildSubagentSandboxMounts } from "../../src/sandbox/mount-policy.ts";

it("selects Node for a standalone Pi parent and fails closed when none is available", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-node-test-"));
	try {
		const node = path.join(root, "node");
		fs.writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		assert.equal(resolveNodeRuntime({ execPath: "/opt/standalone/pi", env: { PATH: root } }), node);
		assert.equal(resolveNodeRuntime({ execPath: "/opt/standalone/pi", env: { PATH: "" } }), undefined);
		assert.equal(resolveNodeRuntime({ execPath: process.execPath, env: { PATH: "" } }), process.execPath);
		// Standalone Pi is an executable rather than a Node CLI. Its private
		// child runtime still needs a real Node interpreter for generated scripts.
		const cli = path.join(root, "pi", "dist", "cli.js");
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(cli, "process.stdout.write('standalone-child\\n');\n");
		assert.deepEqual(getPiSpawnCommand([], { execPath: path.join(root, "standalone-pi"), env: { PATH: root }, preferNodeCli: true, entrypointOverride: cli }), { command: node, args: [cli] });
		assert.throws(() => getPiSpawnCommand([], { execPath: path.join(root, "standalone-pi"), env: { PATH: "" }, preferNodeCli: true, entrypointOverride: cli }), /Node runtime/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("confines a spawned runtime executable without exposing its installation siblings", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-mount-exec-"));
 try {
  const bin = path.join(root, "install", "bin"); fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "node"); fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(bin, "sibling-secret"), "private");
  const mounts = buildSubagentSandboxMounts({ cwd: root, includeCwd: false, spawnCommand: executable });
  assert.deepEqual(mounts.map(m => m.source), [executable]);
  const args = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--dir", "/tmp"];
  for (const sys of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
   if (!fs.existsSync(sys)) continue;
   if (fs.lstatSync(sys).isSymbolicLink()) args.push("--symlink", fs.readlinkSync(sys), sys);
   else args.push("--ro-bind", fs.realpathSync(sys), sys);
  }
  for (const mount of mounts) args.push("--ro-bind", mount.source, mount.target ?? mount.source);
  args.push("--clearenv", "--", executable, "-e", "const fs=require('fs');if(fs.existsSync(process.argv[1]))process.exit(9);process.stdout.write('bounded')", path.join(bin, "sibling-secret"));
  const result = spawnSync("bwrap", args, { encoding: "utf8", timeout: 4000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, "bounded");
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("refuses to publish an endpoint without a working JavaScript runtime", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-reject-"));
 const previousPath = process.env.PATH;
 try {
  fs.mkdirSync(path.join(root, "repo"));
  process.env.PATH = "";
  if (!/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
   assert.throws(() => createScopedGitEndpoint({ runtimeRoot: path.join(root, "missing"), worktree: path.join(root, "repo"), rights: "read-only" }), /Node runtime/);
   assert.equal(fs.existsSync(path.join(root, "missing")), false);
  }
  const fake = path.join(root, "bin"); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "node"), "#!/bin/sh\necho not-javascript\n", { mode: 0o755 });
  // In a normal Node parent the resolver selects process.execPath. A standalone
  // parent exercises the non-JS candidate path in the executable fixture.
  if (!/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
   process.env.PATH = fake;
   assert.throws(() => createScopedGitEndpoint({ runtimeRoot: path.join(root, "fake"), worktree: path.join(root, "repo"), rights: "read-only" }), /working Node JavaScript runtime/);
   assert.equal(fs.existsSync(path.join(root, "fake")), false);
  }
 } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); }
});

it("runs the generated scoped Git wrapper under the selected Node interpreter", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-test-"));
	const worktree = path.join(root, "repo");
	fs.mkdirSync(worktree);
	const privateHome = path.join(root, "home");
	fs.mkdirSync(privateHome);
	const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: privateHome, XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	const git = (...args: string[]) => spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", env: gitEnv });
	let owner: ReturnType<typeof createScopedGitEndpoint> | undefined;
	try {
		assert.equal(git("init", "-q").status, 0);
		fs.writeFileSync(path.join(worktree, "tracked"), "before\n");
		assert.equal(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "tracked").status, 0);
		assert.equal(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base").status, 0);
		fs.writeFileSync(path.join(worktree, "tracked"), "after\n");
		owner = createScopedGitEndpoint({ runtimeRoot: path.join(root, "runtime"), worktree, rights: "read-only" });
		const mounts = owner.invocationMounts();
		assert.ok(mounts.every((mount) => mount.source !== "/" && mount.source !== "/tmp" && mount.target !== "/" && mount.target !== "/tmp"));
		assert.deepEqual(mounts.filter((mount) => mount.target === "/run/pi-scoped-git").map((mount) => mount.source), [owner.scope.endpointRoot]);
		const child = owner.reserveChild({ rights: "read-only" });
		const grandchild = child.reserveChild({ rights: "read-only" });
		for (const descriptor of [child.descriptor, grandchild.descriptor]) {
			assert.equal(scopedGitDescriptorMounts(descriptor).find((mount) => mount.target === "/run/pi-scoped-git")?.mode, "ro");
		}
		assert.match(fs.readFileSync(path.join(grandchild.scope.endpointRoot, "git"), "utf8"), /\/run\/pi-scoped-git\/node-runtime/);
		// Execute the *published* wrapper and client through the same read-only
		// mounts as a confined child, not by sending a direct socket request.
		const { spawn } = await import("node:child_process");
		const execute = async (command: string, extra: string[] = []) => {
			const mounts = owner!.invocationMounts();
			const args = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--dir", "/run", "--dir", "/tmp"];
			for (const system of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
				if (!fs.existsSync(system)) continue;
				if (fs.lstatSync(system).isSymbolicLink()) args.push("--symlink", fs.readlinkSync(system), system);
				else args.push("--ro-bind", fs.realpathSync(system), system);
			}
			for (const mount of mounts) args.push("--ro-bind", mount.source, mount.target ?? mount.source);
			args.push("--bind", worktree, worktree, "--chdir", worktree, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", privateHome, "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null", "--", "/run/pi-scoped-git/git", command, ...extra);
			return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
				child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data);
				child.on("error", reject); child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
			});
		};
		assert.deepEqual(await execute("status", ["--short"]), { status: 0, stdout: " M tracked\n", stderr: "" });
		const diff = await execute("diff");
		assert.equal(diff.status, 0, diff.stderr);
		assert.match(diff.stdout, /-before\n\+after\n/);
		assert.equal(diff.stderr, "");
	} finally { if (owner) assert.equal(await owner.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
});
