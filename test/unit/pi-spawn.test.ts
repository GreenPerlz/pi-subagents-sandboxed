import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { getPiSpawnCommand, resolveInstalledPiPackageRoot, resolveWindowsPiCliScript, type PiSpawnDeps } from "../../src/runs/shared/pi-spawn.ts";

function makeDeps(input: {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	entrypointOverride?: string;
	existing?: string[];
	packageJsonPath?: string;
	packageJsonContent?: string;
	packageEntry?: string;
	preferNodeCli?: boolean;
	env?: Record<string, string | undefined>;
}): PiSpawnDeps {
	const existing = new Set(input.existing ?? []);
	const packageJsonPath = input.packageJsonPath;
	const packageJsonContent = input.packageJsonContent;
	return {
		platform: input.platform,
		execPath: input.execPath,
		argv1: input.argv1,
		entrypointOverride: input.entrypointOverride,
		existsSync: (filePath) => existing.has(filePath),
		isExecutable: (filePath) => existing.has(filePath),
		readFileSync: (_filePath, _encoding) => {
			if (!packageJsonPath || !packageJsonContent) {
				throw new Error("package json not configured");
			}
			return packageJsonContent;
		},
		resolvePackageJson: packageJsonPath ? () => packageJsonPath : undefined,
		resolvePackageEntry: input.packageEntry ? () => input.packageEntry! : undefined,
		preferNodeCli: input.preferNodeCli,
		env: input.env,
	};
}

describe("bundled child Pi runtime", () => {
	it("resolves the private npm alias instead of the host Pi package", () => {
		const packageRoot = resolveInstalledPiPackageRoot();
		assert.ok(packageRoot);
		assert.equal(path.basename(packageRoot), "pi-subagent-runtime");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { name?: string; version?: string };
		assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
		assert.match(manifest.version ?? "", /^\d+\.\d+\.\d+/);

		const spawn = getPiSpawnCommand(["-p", "Task: hello"], { preferNodeCli: true });
		assert.equal(spawn.command, process.execPath);
		assert.ok(spawn.args[0]?.startsWith(`${packageRoot}${path.sep}`));
	});
});

describe("getPiSpawnCommand", () => {
	it("uses plain pi on non-Windows even when argv1 is a runnable JS file", () => {
		const argv1 = "/tmp/pi-entry.mjs";
		const deps = makeDeps({
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			argv1,
			existing: [argv1],
		});
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "pi", args });
	});

	it("uses plain pi on non-Windows even when the CLI script can be resolved from package bin", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "pi", args });
	});

	it("falls back to plain pi command on non-Windows when CLI script cannot be resolved", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, { platform: "darwin" });
		assert.deepEqual(result, { command: "pi", args });
	});

	it("fails closed when the private CLI cannot be resolved", () => {
		const deps = makeDeps({
			platform: "linux",
			execPath: "/usr/local/bin/node",
			packageJsonPath: "/opt/pi/package.json",
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [],
			preferNodeCli: true,
		});
		assert.throws(() => getPiSpawnCommand(["-p", "Task: hello"], deps), /private pi-subagent-runtime CLI/);
	});

	it("uses an external Node runtime when the parent is standalone Pi", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const nodePath = path.resolve("/opt/node/bin/node");
		const deps = makeDeps({
			platform: "linux",
			execPath: "/opt/standalone/pi",
			argv1: "/opt/standalone/pi",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [cliPath, nodePath],
			preferNodeCli: true,
			env: { PATH: path.dirname(nodePath) },
		});
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, nodePath);
		assert.equal(result.args[0], cliPath);
	});

	it("uses node + CLI script on non-Windows when preferNodeCli is set for sandboxing", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			platform: "linux",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
			preferNodeCli: true,
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.deepEqual(result.args, [cliPath, ...args]);
	});

	it("uses package bin instead of unrelated argv1 JS when preferNodeCli is set", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const argv1 = "/tmp/test-runner.mjs";
		const deps = makeDeps({
			platform: "linux",
			execPath: "/usr/local/bin/node",
			argv1,
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [argv1, packageJsonPath, cliPath],
			preferNodeCli: true,
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.deepEqual(result.args, [cliPath, ...args]);
	});

	it("uses an explicitly injected mock entrypoint in tests", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const mockEntrypoint = "/tmp/mock-pi-script.mjs";
		const deps = makeDeps({
			platform: "linux",
			execPath: "/usr/local/bin/node",
			entrypointOverride: mockEntrypoint,
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [mockEntrypoint, packageJsonPath, cliPath],
			preferNodeCli: true,
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.deepEqual(result.args, [mockEntrypoint, ...args]);
	});

	it("uses node + argv1 script on Windows when argv1 is runnable JS", () => {
		const argv1 = "/tmp/pi-entry.mjs";
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1,
			existing: [argv1],
		});
		const args = ["--mode", "json", 'Task: Read C:/dev/file.md and review "quotes" & pipes | too'];
		const result = getPiSpawnCommand(args, deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], argv1);
		assert.equal(result.args[3], args[2]);
	});

	it("resolves CLI script from package bin when argv1 is not runnable JS", () => {
		const packageJsonPath = "/opt/pi/package.json";
		// Compute expected path the same way the production code does:
		// path.resolve(path.dirname(packageJsonPath), binPath) — which on Windows
		// prepends the current drive letter to POSIX absolute paths.
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], cliPath);
	});

	it("falls back to pi when Windows CLI script cannot be resolved", () => {
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/pi/subagent-runner.ts",
			existing: [],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "pi", args });
	});

	it("walks from package main entry to resolve package bin", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-package-root-"));
		try {
			const packageRoot = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
			const entry = path.join(packageRoot, "dist", "index.js");
			const cliPath = path.join(packageRoot, "dist", "cli", "index.js");
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.mkdirSync(path.dirname(cliPath), { recursive: true });
			fs.writeFileSync(entry, "export {};\n");
			fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli/index.js" } }));
			const result = getPiSpawnCommand(["-p", "Task: hello"], {
				platform: "win32",
				execPath: "/usr/local/bin/node",
				argv1: "/opt/pi/subagent-runner.ts",
				resolvePackageEntry: () => entry,
			});
			assert.equal(result.command, "/usr/local/bin/node");
			assert.equal(result.args[0], cliPath);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

});

describe("getPiSpawnCommand with piPackageRoot", () => {
	it("resolves CLI script via piPackageRoot when argv1 is not runnable", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		deps.piPackageRoot = "/opt/pi";
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], cliPath);
	});
});

describe("resolveWindowsPiCliScript", () => {
	it("supports package bin as string", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.mjs");
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: "dist/cli/index.mjs" }),
			existing: [packageJsonPath, cliPath],
		});
		assert.equal(resolveWindowsPiCliScript(deps), cliPath);
	});
});
