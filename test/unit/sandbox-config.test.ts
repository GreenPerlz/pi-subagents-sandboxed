import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, readSandboxSettings } from "../../src/agents/agents.ts";
import { resolveSandboxConfig } from "../../src/sandbox/config.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeProject(): { project: string; home: string } {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sandbox-project-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sandbox-home-"));
	tempDirs.push(project, home);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	return { project, home };
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(project: string, frontmatter: string): void {
	const agentsDir = path.join(project, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "worker.md"), `---\nname: worker\ndescription: Worker\n${frontmatter}---\n\nDo work\n`, "utf-8");
}

describe("sandbox configuration resolution", () => {
	it("merges settings, agent frontmatter, and per-run sandbox overrides deterministically", () => {
		const { project } = makeProject();
		writeJson(path.join(project, ".pi", "settings.json"), {
			subagents: {
				sandbox: {
					defaultProvider: "settings-provider",
					defaultProfile: "settings-profile",
					network: "settings-network",
					auth: "settings-auth",
					trustProject: false,
					fallback: "settings-fallback",
					extraReadOnlyMounts: ["/opt/settings-toolchain"],
					extraWritableMounts: ["/var/cache/settings-cache"],
					packageDiscovery: "closed",
				},
			},
		});
		writeAgent(project, [
			"sandboxProvider: agent-provider",
			"sandboxProfile: agent-profile",
			"sandboxNetwork: agent-network",
			"sandboxTrustProject: true",
			"sandboxBashWrite: true",
			"sandboxAuth: agent-auth",
			"sandboxFallback: agent-fallback",
			"sandboxExtraReadOnlyMounts: /opt/agent-toolchain",
			"sandboxExtraWritableMounts: /var/cache/agent-cache",
			"sandboxPackageDiscovery: project-local",
		].join("\n") + "\n");

		const settings = readSandboxSettings(project, "project");
		const agent = discoverAgents(project, "project").agents.find((candidate) => candidate.name === "worker");
		assert.ok(agent, "worker should be discovered");
		assert.deepEqual(agent.sandbox, {
			provider: "agent-provider",
			profile: "agent-profile",
			network: "agent-network",
			trustProject: true,
			bashWrite: true,
			auth: "agent-auth",
			fallback: "agent-fallback",
			extraReadOnlyMounts: ["/opt/agent-toolchain"],
			extraWritableMounts: ["/var/cache/agent-cache"],
			packageDiscovery: "project-local",
		});
		assert.equal(agent.extraFields?.sandboxProvider, undefined);

		assert.deepEqual(resolveSandboxConfig({ settings }), {
			provider: "settings-provider",
			profile: "settings-profile",
			network: "settings-network",
			trustProject: false,
			auth: "settings-auth",
			fallback: "settings-fallback",
			extraReadOnlyMounts: ["/opt/settings-toolchain"],
			extraWritableMounts: ["/var/cache/settings-cache"],
			packageDiscovery: "closed",
		});
		assert.deepEqual(resolveSandboxConfig({ settings, agent }), {
			provider: "agent-provider",
			profile: "agent-profile",
			network: "agent-network",
			trustProject: true,
			bashWrite: true,
			auth: "agent-auth",
			fallback: "agent-fallback",
			extraReadOnlyMounts: ["/opt/settings-toolchain", "/opt/agent-toolchain"],
			extraWritableMounts: ["/var/cache/settings-cache", "/var/cache/agent-cache"],
			packageDiscovery: "project-local",
		});
		assert.deepEqual(resolveSandboxConfig({
			settings,
			agent,
			run: {
				provider: "run-provider",
				profile: "run-profile",
				network: "run-network",
				trustProject: false,
				bashWrite: false,
				auth: "run-auth",
				fallback: "run-fallback",
				extraReadOnlyMounts: ["/opt/run-toolchain"],
				extraWritableMounts: ["/var/cache/run-cache"],
				packageDiscovery: "ambient",
			},
		}), {
			provider: "run-provider",
			profile: "run-profile",
			network: "run-network",
			trustProject: false,
			bashWrite: false,
			auth: "run-auth",
			fallback: "run-fallback",
			extraReadOnlyMounts: ["/opt/settings-toolchain", "/opt/agent-toolchain", "/opt/run-toolchain"],
			extraWritableMounts: ["/var/cache/settings-cache", "/var/cache/agent-cache", "/var/cache/run-cache"],
			packageDiscovery: "ambient",
		});
	});

	it("resolves to no sandbox when provider is omitted everywhere", () => {
		assert.equal(resolveSandboxConfig({
			settings: {
				defaultProfile: "host-toolchain",
				network: "host",
				auth: "env",
				trustProject: true,
				fallback: "fail",
			},
		}), undefined);
	});

	it("defaults sandbox auth to pi-json when provider is configured", () => {
		assert.deepEqual(resolveSandboxConfig({
			run: { provider: "bubblewrap" },
		}), {
			provider: "bubblewrap",
			auth: "pi-json",
		});
	});

	it("lets a per-run provider none opt out of an agent sandbox default", () => {
		assert.equal(resolveSandboxConfig({
			agent: { sandbox: { provider: "bubblewrap", profile: "host-toolchain" } },
			run: { provider: "none" },
		}), undefined);
	});
});
