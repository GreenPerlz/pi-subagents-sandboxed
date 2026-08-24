import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BubblewrapSandboxProvider, closePinnedSandboxFds } from "../../src/sandbox/bubblewrap.ts";
import { createSandboxProvider, SandboxUnavailableError } from "../../src/sandbox/provider.ts";
import type { ResolvedSandboxConfig } from "../../src/sandbox/types.ts";

const hostToolchainConfig: ResolvedSandboxConfig = {
	provider: "bubblewrap",
	profile: "host-toolchain",
	network: "host",
};

function availableProvider(): BubblewrapSandboxProvider {
	return new BubblewrapSandboxProvider({
		isBubblewrapAvailable: () => true,
		pathExists: (candidate) => ["/usr", "/bin", "/etc", "/opt/node"].includes(candidate),
	});
}

describe("Bubblewrap sandbox provider", () => {
	it("wraps a host-toolchain invocation while preserving host mount paths and selected env", () => {
		const result = availableProvider().wrapInvocation({
			config: hostToolchainConfig,
			invocation: {
				command: "pi",
				args: ["--version"],
				cwd: "/home/alice/project",
				env: {
					FOO: "bar",
					EMPTY: "",
					SKIP_ME: undefined,
				},
			},
			mounts: [
				{ source: "/home/alice/project", mode: "rw" },
				{ source: "/var/cache/tool", mode: "ro" },
			],
		});

		assert.equal(result.invocation.command, "bwrap");
		assert.equal(result.invocation.cwd, "/home/alice/project");
		assert.deepEqual(result.diagnostics, []);

		const args = result.invocation.args;
		assert.deepEqual(args.slice(0, 6), ["--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin"]);
		assert.deepEqual(args.slice(args.indexOf("/home/alice/project") - 1, args.indexOf("/home/alice/project") + 2), ["--bind", "/home/alice/project", "/home/alice/project"]);
		assert.ok(args.includes("--ro-bind"));
		assert.ok(args.includes("/var/cache/tool"));
		assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", "/home/alice/project"]);
		assert.deepEqual(args.slice(args.indexOf("FOO") - 1, args.indexOf("FOO") + 2), ["--setenv", "FOO", "bar"]);
		assert.deepEqual(args.slice(args.indexOf("EMPTY") - 1, args.indexOf("EMPTY") + 2), ["--setenv", "EMPTY", ""]);
		assert.equal(args.includes("SKIP_ME"), false);
		assert.equal(args.includes("--unshare-net"), false);
		assert.ok(args.includes("--die-with-parent"), "sandboxed children must die with their runner");
		assert.equal(args.includes("/workspace"), false);
		assert.deepEqual(args.slice(-2), ["pi", "--version"]);
	});

	it("mounts an absolute Node install root so npm/npx are available to sandboxed Pi", () => {
		const result = availableProvider().wrapInvocation({
			config: hostToolchainConfig,
			invocation: {
				command: "/opt/node/bin/node",
				args: ["/workspace/pi/dist/cli.js", "--version"],
				cwd: "/home/alice/project",
			},
			mounts: [{ source: "/home/alice/project", mode: "ro" }, { source: "/opt/node", mode: "ro" }],
		});

		const args = result.invocation.args;
		assert.deepEqual(args.slice(args.indexOf("/opt/node") - 1, args.indexOf("/opt/node") + 2), ["--ro-bind", "/opt/node", "/opt/node"]);
		assert.equal(args.filter((arg) => arg === "/opt/node").length, 2, "node install root should only be bound once");
	});

	it("pins read-only mount inodes across pathname replacement", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bwrap-pin-"));
		const runtime = path.join(root, "runtime");
		const replacement = path.join(root, "replacement");
		fs.mkdirSync(runtime);
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(runtime, "marker"), "safe");
		fs.writeFileSync(path.join(replacement, "marker"), "metadata");
		const result = availableProvider().wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "pi", args: [], pinReadonlyMounts: true },
			mounts: [{ source: runtime, mode: "ro" }],
		});
		try {
			assert.equal(result.invocation.inheritedFds?.length, 1);
			const fd = result.invocation.inheritedFds![0]!;
			fs.renameSync(runtime, `${runtime}-old`);
			fs.symlinkSync(replacement, runtime, "dir");
			assert.equal(fs.readFileSync(`/proc/self/fd/${fd}/marker`, "utf8"), "safe");
			const sourceIndex = result.invocation.args.indexOf("/proc/self/fd/3");
			assert.equal(result.invocation.args[sourceIndex - 1], "--ro-bind");
			assert.equal(result.invocation.args[sourceIndex + 1], runtime);
		} finally {
			closePinnedSandboxFds(result.invocation.inheritedFds);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults to host networking and uses Bubblewrap network isolation when network is none", () => {
		const hostResult = availableProvider().wrapInvocation({
			config: { provider: "bubblewrap", profile: "host-toolchain" },
			invocation: {
				command: "node",
				args: ["script.js"],
				cwd: "/home/alice/project",
			},
			mounts: [{ source: "/home/alice/project", mode: "ro" }],
		});
		const isolatedResult = availableProvider().wrapInvocation({
			config: { ...hostToolchainConfig, network: "none" },
			invocation: {
				command: "node",
				args: ["script.js"],
				cwd: "/home/alice/project",
			},
			mounts: [{ source: "/home/alice/project", mode: "ro" }],
		});

		assert.equal(hostResult.invocation.args.includes("--unshare-net"), false);
		assert.ok(isolatedResult.invocation.args.includes("--unshare-net"));
	});

	it("fails closed by default when bwrap is unavailable", () => {
		const provider = new BubblewrapSandboxProvider({ isBubblewrapAvailable: () => false });

		assert.throws(() => provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "pi", args: [], cwd: "/home/alice/project" },
		}), (error) => {
			assert.ok(error instanceof SandboxUnavailableError);
			assert.match(error.message, /Bubblewrap sandbox requested but bwrap is unavailable/);
			assert.match(error.message, /README.*Sandboxed subagents/);
			return true;
		});
	});

	it("falls back to the original invocation with a diagnostic when fallback is none", () => {
		const provider = new BubblewrapSandboxProvider({ isBubblewrapAvailable: () => false });
		const original = { command: "pi", args: ["--help"], cwd: "/home/alice/project", env: { FOO: "bar" } };

		const result = provider.wrapInvocation({
			config: { ...hostToolchainConfig, fallback: "none" },
			invocation: original,
		});

		assert.deepEqual(result.invocation, original);
		assert.equal(result.fallbackOccurred, true);
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0]?.level, "warning");
		assert.match(result.diagnostics[0]?.message ?? "", /running without sandbox/);
	});

	it("creates the provider through the internal provider abstraction", () => {
		const provider = createSandboxProvider(hostToolchainConfig, {
			isBubblewrapAvailable: () => true,
			pathExists: () => false,
		});

		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "echo", args: ["ok"] },
		});

		assert.equal(result.invocation.command, "bwrap");
		assert.deepEqual(result.invocation.args.slice(-2), ["echo", "ok"]);
	});

	it("mounts the exact WSL resolver target with narrow destination parents", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc", "/etc/resolv.conf", "/mnt/wsl/resolv.conf"].includes(candidate),
			realPath: (filePath) => filePath === "/etc/resolv.conf" ? "/mnt/wsl/resolv.conf" : filePath,
			lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, uid: typeof process.getuid === "function" ? process.getuid() : 0 } as fs.Stats),
		});
		const result = provider.wrapInvocation({ config: hostToolchainConfig, invocation: { command: "node", args: [] } });
		const args = result.invocation.args;
		const mount = args.lastIndexOf("/mnt/wsl/resolv.conf");
		assert.ok(mount > -1);
		assert.equal(args[mount - 2], "--ro-bind");
		assert.equal(args[mount - 1], "/mnt/wsl/resolv.conf");
		assert.equal(args[mount - 4], "--dir");
		assert.equal(args[mount - 3], "/mnt/wsl");
		assert.equal(args[mount - 6], "--dir");
		assert.equal(args[mount - 5], "/mnt");
	});

	it("keeps caller mounts from aliasing the WSL resolver source or target", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/etc", "/etc/resolv.conf", "/mnt/wsl/resolv.conf"].includes(candidate),
			realPath: (filePath) => filePath === "/etc/resolv.conf" ? "/mnt/wsl/resolv.conf" : filePath,
			lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, uid: typeof process.getuid === "function" ? process.getuid() : 0 } as fs.Stats),
		});
		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "node", args: [] },
			mounts: [
				{ source: "/mnt/wsl/resolv.conf", target: "/tmp/resolver-alias", mode: "ro" },
				{ source: "/tmp/forged-resolver", target: "/mnt/wsl/resolv.conf", mode: "ro" },
			],
		});
		assert.equal(result.invocation.args.includes("/tmp/resolver-alias"), false);
		assert.equal(result.invocation.args.includes("/tmp/forged-resolver"), false);
		assert.equal(result.invocation.args.filter((arg) => arg === "/mnt/wsl/resolv.conf").length, 2);
	});

	it("rejects an external resolver target and a missing WSL target", () => {
		for (const target of ["/tmp/secret-resolv.conf", "/mnt/wsl/missing-resolv.conf"]) {
			const provider = new BubblewrapSandboxProvider({
				isBubblewrapAvailable: () => true,
				pathExists: (candidate) => candidate === "/etc" || candidate === "/etc/resolv.conf" || (target !== "/mnt/wsl/missing-resolv.conf" && candidate === "/mnt/wsl/resolv.conf"),
				realPath: (filePath) => filePath === "/etc/resolv.conf" ? target : filePath,
				lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, uid: typeof process.getuid === "function" ? process.getuid() : 0 } as fs.Stats),
			});
			const result = provider.wrapInvocation({ config: hostToolchainConfig, invocation: { command: "node", args: [] } });
			assert.equal(result.invocation.args.includes("/mnt/wsl/resolv.conf"), false);
			assert.equal(result.invocation.args.includes("/tmp/secret-resolv.conf"), false);
		}
	});

	it("rejects an untrusted WSL resolver source", () => {
		for (const stat of [
			{ isFile: () => false, isSymbolicLink: () => false, mode: 0o040755, uid: 0 },
			{ isFile: () => true, isSymbolicLink: () => true, mode: 0o120777, uid: 0 },
			{ isFile: () => true, isSymbolicLink: () => false, mode: 0o100666, uid: 0 },
			{ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, uid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1 },
		]) {
			const provider = new BubblewrapSandboxProvider({
				isBubblewrapAvailable: () => true,
				pathExists: (candidate) => ["/etc", "/etc/resolv.conf", "/mnt/wsl/resolv.conf"].includes(candidate),
				realPath: (filePath) => filePath === "/etc/resolv.conf" ? "/mnt/wsl/resolv.conf" : filePath,
				lstat: () => stat as fs.Stats,
			});
			const result = provider.wrapInvocation({ config: hostToolchainConfig, invocation: { command: "node", args: [] } });
			assert.equal(result.invocation.args.includes("/mnt/wsl/resolv.conf"), false);
		}
	});

	it("does not mount the WSL resolver without host networking", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/etc", "/etc/resolv.conf", "/mnt/wsl/resolv.conf"].includes(candidate),
			realPath: (filePath) => filePath === "/etc/resolv.conf" ? "/mnt/wsl/resolv.conf" : filePath,
			lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, uid: typeof process.getuid === "function" ? process.getuid() : 0 } as fs.Stats),
		});
		const result = provider.wrapInvocation({ config: { ...hostToolchainConfig, network: "none" }, invocation: { command: "node", args: [] } });
		assert.equal(result.invocation.args.includes("/mnt/wsl/resolv.conf"), false);
		assert.ok(result.invocation.args.includes("--unshare-net"));
	});

	it("mounts /run/systemd/resolve read-only when /etc/resolv.conf resolves into it on host networking", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc", "/etc/resolv.conf", "/run/systemd/resolve"].includes(candidate),
			realPath: (filePath) =>
				filePath === "/etc/resolv.conf" ? "/run/systemd/resolve/stub-resolv.conf" : filePath,
		});

		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "node", args: ["script.js"] },
		});

		const args = result.invocation.args;
		const idx = args.indexOf("/run/systemd/resolve");
		assert.ok(idx !== -1, "expected /run/systemd/resolve to be mounted");
		assert.equal(args[idx - 1], "--ro-bind");
		assert.equal(args.filter((a) => a === "/run/systemd/resolve").length, 2);
	});

	it("does not mount /run/systemd/resolve when /etc/resolv.conf is a regular file", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc"].includes(candidate),
			realPath: (filePath) => filePath,
		});

		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "node", args: ["script.js"] },
		});

		assert.equal(result.invocation.args.includes("/run/systemd/resolve"), false);
	});

	it("does not mount /run/systemd/resolve when /etc/resolv.conf symlink points elsewhere", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc", "/etc/resolv.conf", "/run/systemd/resolve"].includes(candidate),
			realPath: (filePath) =>
				filePath === "/etc/resolv.conf" ? "/etc/resolv.conf.custom" : filePath,
		});

		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "node", args: ["script.js"] },
		});

		assert.equal(result.invocation.args.includes("/run/systemd/resolve"), false);
	});

	it("does not mount /run/systemd/resolve when the directory does not exist", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc", "/etc/resolv.conf"].includes(candidate),
			realPath: (filePath) =>
				filePath === "/etc/resolv.conf" ? "/run/systemd/resolve/stub-resolv.conf" : filePath,
		});

		const result = provider.wrapInvocation({
			config: hostToolchainConfig,
			invocation: { command: "node", args: ["script.js"] },
		});

		assert.equal(result.invocation.args.includes("/run/systemd/resolve"), false);
	});

	it("provides /proc and /dev so sandboxed child processes can launch tools and nested sandboxes", () => {
		const result = availableProvider().wrapInvocation({
			config: hostToolchainConfig,
			invocation: {
				command: "node",
				args: ["script.js"],
				cwd: "/home/alice/project",
			},
			mounts: [{ source: "/home/alice/project", mode: "ro" }],
		});

		const args = result.invocation.args;
		const procIdx = args.indexOf("/proc");
		assert.ok(procIdx !== -1, "expected /proc to be provided via --proc");
		assert.equal(args[procIdx - 1], "--proc");
		const devIdx = args.indexOf("/dev");
		assert.ok(devIdx !== -1, "expected /dev to be provided via --dev");
		assert.equal(args[devIdx - 1], "--dev");
	});

	it("does not mount /run/systemd/resolve when network is none", () => {
		const provider = new BubblewrapSandboxProvider({
			isBubblewrapAvailable: () => true,
			pathExists: (candidate) => ["/usr", "/bin", "/etc", "/etc/resolv.conf", "/run/systemd/resolve"].includes(candidate),
			realPath: (filePath) =>
				filePath === "/etc/resolv.conf" ? "/run/systemd/resolve/stub-resolv.conf" : filePath,
		});

		const result = provider.wrapInvocation({
			config: { ...hostToolchainConfig, network: "none" },
			invocation: { command: "node", args: ["script.js"] },
		});

		assert.equal(result.invocation.args.includes("/run/systemd/resolve"), false);
		assert.ok(result.invocation.args.includes("--unshare-net"));
	});
});
