import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, readSandboxSettings } from "../../src/agents/agents.ts";
import { hasExplicitSandboxOptOut, resolveSandboxConfig, sandboxOptOutIsAuthorized, worktreeOptOutIsAuthorized } from "../../src/sandbox/config.ts";
import { buildSubagentSandboxMounts } from "../../src/sandbox/mount-policy.ts";

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
					gitMode: "read-only",
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
			"sandboxGitMode: isolated",
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
			gitMode: "isolated",
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
			gitMode: "read-only",
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
			gitMode: "isolated",
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
				gitMode: "read-only",
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
			gitMode: "read-only",
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

	it("defaults unconfigured agents to read-only Bubblewrap Git protection", () => {
		assert.deepEqual(resolveSandboxConfig({
			settings: {
				defaultProfile: "host-toolchain",
				network: "host",
				auth: "env",
				trustProject: true,
				fallback: "fail",
			},
		}), {
			provider: "bubblewrap",
			gitMode: "read-only",
			profile: "host-toolchain",
			network: "host",
			trustProject: true,
			auth: "env",
			fallback: "fail",
		});
	});

	it("defaults a custom agent with no settings, frontmatter, or run override to read-only Bubblewrap", () => {
		const { project } = makeProject();
		writeAgent(project, "");
		const agent = discoverAgents(project, "project").agents.find((candidate) => candidate.name === "worker");
		assert.ok(agent, "custom worker should be discovered");
		assert.equal(agent.sandbox, undefined);
		assert.deepEqual(resolveSandboxConfig({ agent }), {
			provider: "bubblewrap",
			gitMode: "read-only",
			auth: "pi-json",
		});
	});

	it("retains trust-sensitive settings with user-global authority and project narrowing", () => {
		const { project, home } = makeProject();
		writeJson(path.join(home, ".pi", "agent", "subagents.json"), {
			sandbox: { allowSandboxOptOut: true, allowWorktreeOptOut: true },
		});
		writeJson(path.join(project, ".pi", "subagents.json"), {
			sandbox: { allowSandboxOptOut: true, allowWorktreeOptOut: false },
		});
		const settings = readSandboxSettings(project);
		assert.deepEqual(settings, {
			allowSandboxOptOut: true,
			allowWorktreeOptOut: false,
		});
		assert.equal(sandboxOptOutIsAuthorized({ settings, run: { provider: "none" } }), true);
		assert.equal(worktreeOptOutIsAuthorized(settings), false);
	});

	it("does not let a project enable trusted sandbox opt-out", () => {
		const { project } = makeProject();
		writeJson(path.join(project, ".pi", "subagents.json"), { sandbox: { allowSandboxOptOut: true, allowWorktreeOptOut: true } });
		const settings = readSandboxSettings(project);
		assert.equal(settings?.allowSandboxOptOut, false);
		assert.equal(settings?.allowWorktreeOptOut, false);
		assert.equal(sandboxOptOutIsAuthorized({ settings, run: { provider: "none" } }), false);
	});

	it("keeps an explicit provider none opt-out unsandboxed", () => {
		assert.equal(resolveSandboxConfig({ run: { provider: "none" } }), undefined);
		assert.equal(hasExplicitSandboxOptOut({ run: { provider: "none" } }), true);
		assert.equal(hasExplicitSandboxOptOut({ settings: { defaultProvider: "none" }, agent: { sandbox: { provider: "bubblewrap" } } }), false);
	});

	it("resolves the winning sandbox provider and Git mode across settings, agent, and run precedence", () => {
		const isolatedWins = [
			{
				name: "agent isolated mode overrides settings provider none",
				input: { settings: { defaultProvider: "none" }, agent: { sandbox: { gitMode: "isolated" } } },
			},
			{
				name: "run isolated mode overrides settings provider none",
				input: { settings: { defaultProvider: "none" }, run: { gitMode: "isolated" } },
			},
			{
				name: "run isolated mode overrides agent provider none",
				input: { agent: { sandbox: { provider: "none" } }, run: { gitMode: "isolated" } },
			},
		] as const;
		for (const { name, input } of isolatedWins) {
			assert.deepEqual(resolveSandboxConfig(input), {
				provider: "bubblewrap",
				gitMode: "isolated",
				auth: "pi-json",
			}, name);
		}

		const optOutWins = [
			{
				name: "agent provider none overrides settings isolated mode",
				input: { settings: { gitMode: "isolated" }, agent: { sandbox: { provider: "none" } } },
			},
			{
				name: "run provider none overrides settings isolated mode",
				input: { settings: { gitMode: "isolated" }, run: { provider: "none" } },
			},
			{
				name: "run provider none overrides agent isolated mode",
				input: { agent: { sandbox: { gitMode: "isolated" } }, run: { provider: "none" } },
			},
		] as const;
		for (const { name, input } of optOutWins) {
			assert.equal(resolveSandboxConfig(input), undefined, name);
		}

		const sameLayerContradictions = [
			{ name: "settings", input: { settings: { defaultProvider: "none", gitMode: "isolated" } } },
			{ name: "agent", input: { agent: { sandbox: { provider: "none", gitMode: "isolated" } } } },
			{ name: "run", input: { run: { provider: "none", gitMode: "isolated" } } },
		] as const;
		for (const { name, input } of sameLayerContradictions) {
			assert.throws(
				() => resolveSandboxConfig(input),
				/explicit provider 'none'.*isolated Git|cannot combine.*provider.*none.*isolated/i,
				name,
			);
		}
	});

	it("defaults sandbox auth to pi-json when provider is configured", () => {
		assert.deepEqual(resolveSandboxConfig({
			run: { provider: "bubblewrap" },
		}), {
			provider: "bubblewrap",
			gitMode: "read-only",
			auth: "pi-json",
		});
	});

	it("resolves omitted Git mode to read-only and mounts ordinary .git metadata read-only", () => {
		const { project } = makeProject();
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		for (const gitMode of [undefined, "read-only"] as const) {
			const mounts = buildSubagentSandboxMounts({ cwd: project, cwdMode: "rw", gitMode });
			assert.deepEqual(mounts.find((mount) => mount.source === path.join(project, ".git")), {
				source: path.join(project, ".git"),
				mode: "ro",
			});
		}
	});

	it("lets a per-run provider none opt out of an agent sandbox default", () => {
		assert.equal(resolveSandboxConfig({
			agent: { sandbox: { provider: "bubblewrap", profile: "host-toolchain" } },
			run: { provider: "none" },
		}), undefined);
		assert.equal(resolveSandboxConfig({
			settings: { gitMode: "isolated" },
			run: { provider: "none" },
		}), undefined, "an explicit run provider none must also clear inherited isolated Git mode");
		assert.throws(
			() => resolveSandboxConfig({ run: { provider: "none", gitMode: "isolated" } }),
			/explicit provider 'none'.*isolated Git|cannot combine.*provider.*none.*isolated/i,
			"the same request must not combine provider none with isolated Git",
		);
	});
});
