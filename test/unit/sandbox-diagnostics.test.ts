import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { diagnoseSandboxFailure, sandboxResultDetails } from "../../src/sandbox/diagnostics.ts";
import type { ResolvedSandboxConfig, SandboxMount } from "../../src/sandbox/types.ts";

const config: ResolvedSandboxConfig = { provider: "bubblewrap", profile: "host-toolchain", network: "host" };

function hostTool(command: string): string | undefined {
	return command === "custom-tool" ? "/opt/custom/bin/custom-tool" : undefined;
}

describe("sandbox access diagnostics", () => {
	it("distinguishes a host-installed executable that is missing from sandbox mounts and suggests a read-only mount", () => {
		const diagnostics = diagnoseSandboxFailure({
			stderr: "bwrap: execvp custom-tool: No such file or directory\n",
			mounts: [{ source: "/workspace/project", mode: "rw" }],
			resolveHostExecutable: hostTool,
			pathExists: (candidate) => candidate === "/opt/custom/bin/custom-tool" || candidate === "/opt/custom/bin",
		});

		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.level, "error");
		assert.match(diagnostics[0]?.message ?? "", /exists on the host/);
		assert.match(diagnostics[0]?.message ?? "", /not mounted in the sandbox/);
		assert.match(diagnostics[0]?.message ?? "", /extraReadOnlyMounts/);
		assert.match(diagnostics[0]?.message ?? "", /\/opt\/custom\/bin/);
	});

	it("does not suggest a missing mount when the host executable is already covered by a sandbox mount", () => {
		const diagnostics = diagnoseSandboxFailure({
			stderr: "bwrap: execvp git: No such file or directory\n",
			mounts: [{ source: "/usr", mode: "ro" }],
			resolveHostExecutable: () => "/usr/bin/git",
			pathExists: (candidate) => candidate === "/usr/bin/git" || candidate === "/usr/bin",
		});

		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]?.message ?? "", /covered by a read-only sandbox mount/);
		assert.doesNotMatch(diagnostics[0]?.message ?? "", /not mounted in the sandbox/);
	});

	it("distinguishes an executable that is also missing on the host", () => {
		const diagnostics = diagnoseSandboxFailure({
			stderr: "bwrap: execvp not-a-real-tool: No such file or directory\n",
			mounts: [{ source: "/workspace/project", mode: "rw" }],
			resolveHostExecutable: () => undefined,
			pathExists: () => false,
		});

		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]?.message ?? "", /does not appear to be installed on the host/);
		assert.doesNotMatch(diagnostics[0]?.message ?? "", /extraReadOnlyMounts/);
	});

	it("explains read-only write-denied paths and suggests writable mounts only for cache/output/work directories", () => {
		const mounts: SandboxMount[] = [{ source: "/workspace/project", mode: "ro" }];
		const diagnostics = diagnoseSandboxFailure({
			stderr: "EROFS: read-only file system, open '/workspace/project/build/cache.json'\n",
			mounts,
			pathExists: (candidate) => candidate === "/workspace/project" || candidate === "/workspace/project/build",
			resolveHostExecutable: () => undefined,
		});

		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]?.message ?? "", /read-only sandbox mount/);
		assert.match(diagnostics[0]?.message ?? "", /extraWritableMounts/);
		assert.match(diagnostics[0]?.message ?? "", /cache\/output\/work/);
		assert.match(diagnostics[0]?.message ?? "", /\/workspace\/project\/build/);
	});

	it("includes redacted mount details in sandbox result details", () => {
		const home = os.homedir();
		const result = sandboxResultDetails(config, {
			fallbackOccurred: false,
			diagnostics: [],
			mounts: [
				{ path: path.join(home, "project"), mode: "rw" },
				{ path: path.join(home, ".pi", "agent", "auth.json"), mode: "ro" },
			],
		});

		assert.deepEqual(result.mounts, [
			{ path: "~/project", mode: "rw" },
			{ path: "~/.pi/agent/<redacted>", mode: "ro" },
		]);
	});
});
