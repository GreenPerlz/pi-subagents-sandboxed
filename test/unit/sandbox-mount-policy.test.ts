import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildSubagentSandboxMounts } from "../../src/sandbox/mount-policy.ts";
import { inferSandboxCwdWritable } from "../../src/sandbox/write-inference.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sandbox-mounts-"));
	tempRoots.push(root);
	return root;
}

function mkdirp(p: string): string {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function writeFile(p: string, content = "x"): string {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

function mountMode(mounts: ReturnType<typeof buildSubagentSandboxMounts>, source: string): string | undefined {
	return mounts.find((mount) => mount.source === path.resolve(source))?.mode;
}

function bundledAgentTools(agentName: string): string[] {
	const fileName = ({
		explore: "explore.md",
		orchestrator: "orchestrator.md",
		research: "research.md",
		review: "review.md",
		work: "work.md",
	} as const)[agentName as "explore" | "orchestrator" | "research" | "review" | "work"];
	assert.ok(fileName, `${agentName} should map to a bundled agent file`);
	const content = fs.readFileSync(path.join(process.cwd(), "agents", fileName), "utf-8");
	const match = /^tools:\s*(.+)$/m.exec(content);
	assert.ok(match, `${agentName} should declare default tools`);
	return match[1].split(",").map((tool) => tool.trim()).filter(Boolean);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sandbox write capability inference", () => {
	it("treats edit/write as writer-capable while bash is read-only unless sandbox bash writes are enabled", () => {
		assert.equal(inferSandboxCwdWritable({ tools: ["read", "bash"], sandbox: { bashWrite: false } }), false);
		assert.equal(inferSandboxCwdWritable({ tools: ["read", "bash"], sandbox: { bashWrite: true } }), true);
		assert.equal(inferSandboxCwdWritable({ tools: ["read", "edit"] }), true);
		assert.equal(inferSandboxCwdWritable({ tools: ["write"] }), true);
	});

	it("treats omitted tools as writer-capable because child pi receives its default tools", () => {
		assert.equal(inferSandboxCwdWritable({ tools: undefined, sandbox: { bashWrite: false } }), true);
		assert.equal(inferSandboxCwdWritable({ tools: [], sandbox: { bashWrite: true } }), false);
	});

	it("defaults orchestrator cwd writable for nested work workflows without bash write opt-in", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const cwdWritable = inferSandboxCwdWritable({
			agentName: "orchestrator",
			tools: ["read", "grep", "find", "ls", "bash", "subagent"],
			sandbox: { bashWrite: false },
		});

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: cwdWritable ? "rw" : "ro" });

		assert.equal(cwdWritable, true);
		assert.equal(mountMode(mounts, cwd), "rw");
	});

	it("keeps ordinary read-only sandboxed agents read-only by default", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const cwdWritable = inferSandboxCwdWritable({
			agentName: "review",
			tools: ["read", "grep", "find", "ls", "bash"],
			sandbox: { bashWrite: false },
		});

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: cwdWritable ? "rw" : "ro" });

		assert.equal(cwdWritable, false);
		assert.equal(mountMode(mounts, cwd), "ro");
	});

	it("keeps bundled review and research sandbox defaults read-only while work remains writable", () => {
		for (const agentName of ["review", "research"]) {
			const tools = bundledAgentTools(agentName);
			assert.equal(tools.includes("edit"), false, `${agentName} should not expose edit by default`);
			assert.equal(tools.includes("write"), false, `${agentName} should not expose write by default`);
			assert.equal(inferSandboxCwdWritable({ agentName, tools, sandbox: { bashWrite: false } }), false);
		}

		const workTools = bundledAgentTools("work");
		assert.equal(workTools.includes("edit"), true, "work should retain edit ability");
		assert.equal(workTools.includes("write"), true, "work should retain write ability");
		assert.equal(inferSandboxCwdWritable({ agentName: "work", tools: workTools, sandbox: { bashWrite: false } }), true);
	});
});

describe("subagent sandbox mount policy", () => {
	it("mounts cwd read-only when write inference says the child is read-only", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "ro" });

		assert.equal(mountMode(mounts, cwd), "ro");
	});

	it("mounts normal repo .git metadata read-only even when cwd is writable", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const gitDir = mkdirp(path.join(cwd, ".git"));

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "ro" });

		assert.equal(mountMode(mounts, cwd), "ro");
		assert.equal(mountMode(mounts, gitDir), "ro");
	});

	it("auto-mounts a linked worktree .git pointer gitdir read-only without changing cwd writability", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "worktree"));
		const gitdir = mkdirp(path.join(root, "repo.git", "worktrees", "worktree"));
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${path.relative(cwd, gitdir)}\n`, "utf-8");

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "rw" });

		assert.equal(mountMode(mounts, cwd), "rw");
		assert.equal(mountMode(mounts, gitdir), "ro");
	});

	it("auto-mounts a linked worktree commondir read-only without changing cwd writability", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "worktree"));
		const commonGitdir = mkdirp(path.join(root, "repo", ".git"));
		const gitdir = mkdirp(path.join(commonGitdir, "worktrees", "worktree"));
		fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${path.relative(cwd, gitdir)}\n`, "utf-8");

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "rw" });

		assert.equal(mountMode(mounts, cwd), "rw");
		assert.equal(mountMode(mounts, gitdir), "ro");
		assert.equal(mountMode(mounts, commonGitdir), "ro");
	});

	it("fails sandbox mount setup clearly for a missing linked worktree gitdir", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "worktree"));
		const missingGitdir = path.join(root, "repo.git", "worktrees", "missing");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${missingGitdir}\n`, "utf-8");

		assert.throws(
			() => buildSubagentSandboxMounts({ cwd, cwdMode: "ro" }),
			/missing or inaccessible gitdir/i,
		);
	});

	it("fails sandbox mount setup clearly for a missing linked worktree commondir", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "worktree"));
		const gitdir = mkdirp(path.join(root, "repo.git", "worktrees", "worktree"));
		fs.writeFileSync(path.join(gitdir, "commondir"), "../../missing-common\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`, "utf-8");

		assert.throws(
			() => buildSubagentSandboxMounts({ cwd, cwdMode: "ro" }),
			/missing or inaccessible common gitdir/i,
		);
	});

	it("fails sandbox mount setup clearly for an unsafe linked worktree commondir", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "worktree"));
		const gitdir = mkdirp(path.join(root, "repo.git", "worktrees", "worktree"));
		fs.writeFileSync(path.join(gitdir, "commondir"), `${root}\n`, "utf-8");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`, "utf-8");

		assert.throws(
			() => buildSubagentSandboxMounts({ cwd, cwdMode: "ro" }),
			/unsafe.*overly broad common gitdir/i,
		);
	});

	it("mounts a fresh child session directory writable without mounting the broad session root", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const sessionRoot = mkdirp(path.join(root, "sessions"));
		const childSessionDir = mkdirp(path.join(sessionRoot, "run-0"));
		const childSessionFile = path.join(childSessionDir, "session.jsonl");
		const tempDir = mkdirp(path.join(root, "prompt-temp"));

		const mounts = buildSubagentSandboxMounts({
			cwd,
			tempDir,
			sessionDir: childSessionDir,
			sessionFile: childSessionFile,
		});

		assert.equal(mountMode(mounts, cwd), "rw");
		assert.equal(mountMode(mounts, tempDir), "ro");
		assert.equal(mountMode(mounts, childSessionDir), "rw");
		assert.equal(mountMode(mounts, sessionRoot), undefined);
	});

	it("mounts an existing forked session file writable without mounting the parent session root", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const broadSessionRoot = mkdirp(path.join(root, "host-session-root"));
		const forkedSessionFile = writeFile(path.join(broadSessionRoot, "forked-child.jsonl"));
		const perRunSessionDir = mkdirp(path.join(root, "subagent-sessions", "run-0"));

		const mounts = buildSubagentSandboxMounts({
			cwd,
			sessionDir: perRunSessionDir,
			sessionFile: forkedSessionFile,
		});

		assert.equal(mountMode(mounts, forkedSessionFile), "rw");
		assert.equal(mountMode(mounts, perRunSessionDir), "rw");
		assert.equal(mountMode(mounts, broadSessionRoot), undefined);
	});

	it("upgrades a cwd read-only mount when a writable progress parent resolves to the same path", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const progressPath = path.join(cwd, "progress.md");

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "ro", progressPaths: [progressPath] });

		assert.equal(mountMode(mounts, cwd), "rw");
		assert.equal(mounts.filter((mount) => mount.source === cwd).length, 1);
	});

	it("mounts prompt temp, output, artifact, structured output, async status, and absolute extension paths with least privilege", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const tempDir = mkdirp(path.join(root, "prompt-temp"));
		const artifactsDir = mkdirp(path.join(root, "artifacts"));
		const jsonlPath = path.join(root, "logs", "child.jsonl");
		const outputPath = path.join(root, "outputs", "answer.md");
		const progressPath = path.join(root, "progress", "progress.md");
		const statusPath = path.join(root, "async", "status.json");
		const schemaPath = writeFile(path.join(root, "schemas", "schema.json"));
		const structuredOutputPath = path.join(root, "structured", "result.json");
		const extensionRoot = mkdirp(path.join(root, "extensions"));
		const extensionPath = writeFile(path.join(extensionRoot, "src", "tool.mjs"));
		writeFile(path.join(extensionRoot, "package.json"), JSON.stringify({ name: "test-extension" }));
		mkdirp(path.dirname(jsonlPath));
		mkdirp(path.dirname(outputPath));
		mkdirp(path.dirname(progressPath));
		mkdirp(path.dirname(statusPath));
		mkdirp(path.dirname(structuredOutputPath));

		const mounts = buildSubagentSandboxMounts({
			cwd,
			tempDir,
			artifactsDir,
			jsonlPath,
			outputPath,
			progressPaths: [progressPath],
			statusPaths: [statusPath],
			structuredOutput: { schemaPath, outputPath: structuredOutputPath },
			piArgs: ["--extension", extensionPath],
		});

		assert.equal(mountMode(mounts, tempDir), "ro");
		assert.equal(mountMode(mounts, artifactsDir), "rw");
		assert.equal(mountMode(mounts, path.dirname(jsonlPath)), "rw");
		assert.equal(mountMode(mounts, path.dirname(outputPath)), "rw");
		assert.equal(mountMode(mounts, path.dirname(progressPath)), "rw");
		assert.equal(mountMode(mounts, path.dirname(statusPath)), "rw");
		assert.equal(mountMode(mounts, path.dirname(schemaPath)), "ro");
		assert.equal(mountMode(mounts, path.dirname(structuredOutputPath)), "rw");
		assert.equal(mountMode(mounts, extensionRoot), "ro");
	});

	it("mounts a project-local extension without exposing its repository metadata", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "isolated-worktree"));
		const extensionRoot = mkdirp(path.join(root, "extension-repo"));
		mkdirp(path.join(extensionRoot, ".git"));
		const extensionPath = writeFile(path.join(extensionRoot, "src", "extension", "index.ts"));
		const packageJson = writeFile(path.join(extensionRoot, "package.json"), JSON.stringify({ name: "project-extension" }));
		const nodeModules = mkdirp(path.join(extensionRoot, "node_modules"));
		fs.symlinkSync(path.join(extensionRoot, ".git"), path.join(extensionRoot, "git-alias"), "dir");
		fs.symlinkSync(extensionRoot, path.join(extensionRoot, "root-alias"), "dir");

		const mounts = buildSubagentSandboxMounts({ cwd, includeCwd: false, piArgs: ["--extension", extensionPath] });

		assert.equal(mountMode(mounts, extensionRoot), undefined);
		assert.equal(mountMode(mounts, path.join(extensionRoot, "src")), "ro");
		assert.equal(mountMode(mounts, packageJson), "ro");
		assert.equal(mountMode(mounts, nodeModules), "ro");
		assert.equal(mountMode(mounts, path.join(extensionRoot, ".git")), undefined);

		const directoryMounts = buildSubagentSandboxMounts({ cwd, includeCwd: false, piArgs: ["--extension", extensionRoot] });
		assert.equal(mountMode(directoryMounts, extensionRoot), undefined);
		assert.equal(mountMode(directoryMounts, path.join(extensionRoot, "src")), "ro");
		assert.equal(mountMode(directoryMounts, path.join(extensionRoot, ".git")), undefined);
		assert.equal(mountMode(directoryMounts, path.join(extensionRoot, "git-alias")), undefined);
		assert.equal(mountMode(directoryMounts, path.join(extensionRoot, "root-alias")), undefined);

		const packageMounts = buildSubagentSandboxMounts({ cwd, includeCwd: false, packageRoots: [extensionRoot], protectedGitPaths: [path.join(extensionRoot, ".git")] });
		assert.equal(mountMode(packageMounts, extensionRoot), undefined);
		assert.equal(mountMode(packageMounts, path.join(extensionRoot, "src")), "ro");
		assert.equal(mountMode(packageMounts, nodeModules), "ro");
		assert.equal(mountMode(packageMounts, path.join(extensionRoot, ".git")), undefined);

		const extensionLink = path.join(root, "extension-link");
		fs.symlinkSync(extensionRoot, extensionLink, "dir");
		const symlinkMounts = buildSubagentSandboxMounts({ cwd, includeCwd: false, piArgs: ["--extension", extensionLink] });
		assert.equal(mountMode(symlinkMounts, extensionLink), undefined);
		assert.equal(mountMode(symlinkMounts, path.join(extensionLink, "src")), "ro");
		assert.equal(mountMode(symlinkMounts, path.join(extensionLink, ".git")), undefined);
	});

	it("mounts absolute sandbox spawn runtime paths so bwrap can exec child Pi without PATH wrappers", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const nodeInstallRoot = mkdirp(path.join(root, "node"));
		const nodePath = writeFile(path.join(nodeInstallRoot, "bin", "node"));
		writeFile(path.join(nodeInstallRoot, "bin", "npm"));
		const nodeModulesRoot = mkdirp(path.join(root, "node_modules"));
		const piPackageRoot = mkdirp(path.join(nodeModulesRoot, "@earendil-works", "pi-coding-agent"));
		const cliPath = writeFile(path.join(piPackageRoot, "dist", "cli.js"));
		writeFile(path.join(piPackageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));

		const mounts = buildSubagentSandboxMounts({
			cwd,
			spawnCommand: nodePath,
			spawnArgs: [cliPath, "-p", "Task: hello"],
		});

		assert.equal(mountMode(mounts, nodeInstallRoot), "ro");
		assert.equal(mountMode(mounts, nodeModulesRoot), "ro");
	});

	it("mounts the real Node installation when the foreground runtime is a symlink", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const nodeInstallRoot = mkdirp(path.join(root, ".hermes", "node"));
		const realNodePath = writeFile(path.join(nodeInstallRoot, "bin", "node"));
		const linkedNodePath = path.join(root, ".local", "bin", "node");
		mkdirp(path.dirname(linkedNodePath));
		fs.symlinkSync(realNodePath, linkedNodePath);

		const mounts = buildSubagentSandboxMounts({ cwd, spawnCommand: linkedNodePath });

		assert.equal(mountMode(mounts, path.join(root, ".local")), "ro", "the symlink path must remain visible");
		assert.equal(mountMode(mounts, nodeInstallRoot), "ro", "the symlink target must be executable inside bwrap");
	});

	it("mounts explicit extra read-only and writable sandbox paths with least privilege", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const toolchain = mkdirp(path.join(root, "toolchain"));
		const writableCache = path.join(root, "cache", "npm");

		const mounts = buildSubagentSandboxMounts({
			cwd,
			extraReadOnlyMounts: [toolchain],
			extraWritableMounts: [writableCache],
		});

		assert.equal(mountMode(mounts, toolchain), "ro");
		assert.equal(mountMode(mounts, writableCache), "rw");
		assert.equal(fs.existsSync(writableCache), true, "writable explicit mounts should be created before bwrap binds them");
	});

	it("rejects every generated writable runtime path that overlaps ordinary Git metadata", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "ordinary"));
		const gitDir = mkdirp(path.join(cwd, ".git"));
		const candidates: Array<[string, Parameters<typeof buildSubagentSandboxMounts>[0]]> = [
			["session", { sessionDir: path.join(gitDir, "session") }],
			["artifacts", { artifactsDir: path.join(gitDir, "artifacts") }],
			["output", { outputPath: path.join(gitDir, "output.md") }],
			["jsonl", { jsonlPath: path.join(gitDir, "logs", "child.jsonl") }],
			["progress", { progressPaths: [path.join(gitDir, "progress.md")] }],
			["status", { statusPaths: [path.join(gitDir, "status.json")] }],
			["structured output", { structuredOutput: { outputPath: path.join(gitDir, "structured", "result.json") } }],
			["ancestor", { sessionDir: cwd }],
		];
		for (const [label, extra] of candidates) {
			assert.throws(
				() => buildSubagentSandboxMounts({ cwd, cwdMode: "rw", ...extra }),
				/overlaps protected Git metadata/i,
				label,
			);
		}
	});

	it("rejects generated writable runtime paths through linked-worktree metadata, ancestors, and symlinks", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "linked"));
		const common = mkdirp(path.join(root, "repo", ".git"));
		const gitdir = mkdirp(path.join(common, "worktrees", "linked"));
		fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${path.relative(cwd, gitdir)}\n`, "utf-8");
		const linkedAlias = path.join(root, "linked-alias");
		fs.symlinkSync(common, linkedAlias, "dir");
		const candidates: Array<[string, Parameters<typeof buildSubagentSandboxMounts>[0]]> = [
			["gitdir descendant", { sessionDir: path.join(gitdir, "generated") }],
			["common metadata", { artifactsDir: common }],
			["common ancestor", { outputPath: path.join(root, "repo", "output.md") }],
			["symlinked metadata suffix", { statusPaths: [path.join(linkedAlias, "new", "status.json")] }],
			["symlinked metadata ancestor", { progressPaths: [linkedAlias] }],
		];
		for (const [label, extra] of candidates) {
			assert.throws(
				() => buildSubagentSandboxMounts({ cwd, cwdMode: "rw", ...extra }),
				/overlaps protected Git metadata/i,
				label,
			);
		}
	});

	it("rejects generated and resource writable mounts before mutation when isolated Git supplies parent metadata", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "private-worktree"));
		const parentGitDir = mkdirp(path.join(root, "parent", ".git"));
		const generated = path.join(parentGitDir, "generated", "out.md");
		const resource = path.join(parentGitDir, "resources", "cache");

		for (const [label, extra] of [
			["generated output", { outputPath: generated }],
			["resource mount", { extraWritableMounts: [resource] }],
		] as const) {
			assert.throws(
				() => buildSubagentSandboxMounts({ cwd, includeCwd: false, protectedGitPaths: [parentGitDir], ...extra }),
				/overlaps protected Git metadata/i,
				label,
			);
		}
		assert.equal(fs.existsSync(path.dirname(generated)), false, "rejected generated output must not create a parent directory");
		assert.equal(fs.existsSync(resource), false, "rejected resource mount must not create a directory");
	});

	it("validates every writable candidate before creating an earlier benign candidate", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "private-worktree"));
		const parentGitDir = mkdirp(path.join(root, "parent", ".git"));
		const protectedGitPaths = [parentGitDir];

		const generatedParent = path.join(root, "generated", "nested");
		assert.throws(
			() => buildSubagentSandboxMounts({
				cwd,
				includeCwd: false,
				protectedGitPaths,
				outputPath: path.join(generatedParent, "out.md"),
				extraWritableMounts: [path.join(parentGitDir, "unsafe")],
			}),
			/overlaps protected Git metadata/i,
		);
		assert.equal(fs.existsSync(generatedParent), false, "a later unsafe extra mount must not leave a generated parent behind");

		const sessionParent = path.join(root, "sessions", "nested");
		assert.throws(
			() => buildSubagentSandboxMounts({
				cwd,
				includeCwd: false,
				protectedGitPaths,
				sessionFile: path.join(sessionParent, "session.jsonl"),
				extraWritableMounts: [path.join(parentGitDir, "unsafe-session")],
			}),
			/overlaps protected Git metadata/i,
		);
		assert.equal(fs.existsSync(sessionParent), false, "a later unsafe extra mount must not leave a session parent behind");

		const benignResource = path.join(root, "resources", "cache");
		assert.throws(
			() => buildSubagentSandboxMounts({
				cwd,
				includeCwd: false,
				protectedGitPaths,
				extraWritableMounts: [benignResource, path.join(parentGitDir, "unsafe-resource")],
			}),
			/overlaps protected Git metadata/i,
		);
		assert.equal(fs.existsSync(benignResource), false, "a later unsafe extra mount must not leave an earlier resource behind");
	});

	it("rejects writable extra mounts that overlap ordinary or linked-worktree Git metadata", () => {
		const root = tempRoot();
		const ordinary = mkdirp(path.join(root, "ordinary"));
		mkdirp(path.join(ordinary, ".git"));
		assert.throws(
			() => buildSubagentSandboxMounts({ cwd: ordinary, cwdMode: "rw", extraWritableMounts: [path.join(ordinary, ".git")] }),
			/overlaps protected Git metadata/i,
		);
		assert.throws(
			() => buildSubagentSandboxMounts({ cwd: ordinary, cwdMode: "rw", extraWritableMounts: [ordinary] }),
			/overlaps protected Git metadata/i,
		);

		const linked = mkdirp(path.join(root, "linked"));
		const common = mkdirp(path.join(root, "repo", ".git"));
		const gitdir = mkdirp(path.join(common, "worktrees", "linked"));
		fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n", "utf-8");
		fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.relative(linked, gitdir)}\n`, "utf-8");
		for (const candidate of [gitdir, common, path.join(common, "objects")]) {
			assert.throws(
				() => buildSubagentSandboxMounts({ cwd: linked, cwdMode: "rw", extraWritableMounts: [candidate] }),
				/overlaps protected Git metadata/i,
			);
		}
	});

	it("mounts Pi auth and subagent JSON read-only but NOT settings JSON when pi-json auth mode is requested", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const agentDir = mkdirp(path.join(root, "agent"));
		const authPath = writeFile(path.join(agentDir, "auth.json"), "{}");
		const subagentsPath = writeFile(path.join(agentDir, "subagents.json"), JSON.stringify({ agentOverrides: { review: { model: "openai/gpt-5.4" } } }));
		const settingsPath = writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:ambient-package-that-would-need-npm-root"] }));

		const mounts = buildSubagentSandboxMounts({ cwd, authMode: "pi-json", agentDir });

		assert.equal(mountMode(mounts, authPath), "ro");
		assert.equal(mountMode(mounts, subagentsPath), "ro");
		assert.equal(mountMode(mounts, settingsPath), undefined);
	});

	it("mounts intercom extension package dir read-only without mounting broad node_modules", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const intercomExtDir = mkdirp(path.join(root, "agent", "npm", "node_modules", "pi-intercom"));
		writeFile(path.join(intercomExtDir, "package.json"), JSON.stringify({ name: "pi-intercom" }));
		writeFile(path.join(intercomExtDir, "index.ts"), "export default {}" );

		const mounts = buildSubagentSandboxMounts({
			cwd,
			piArgs: ["--extension", intercomExtDir],
		});

		assert.equal(mountMode(mounts, intercomExtDir), "ro");
		assert.equal(mountMode(mounts, path.join(root, "agent", "npm", "node_modules")), undefined);
	});

	it("mounts intercom state dir writable when intercomStateDir is provided", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const intercomStateDir = path.join(root, "agent", "intercom");

		const mounts = buildSubagentSandboxMounts({
			cwd,
			intercomStateDir,
		});

		assert.equal(mountMode(mounts, intercomStateDir), "rw");
		assert.equal(fs.existsSync(intercomStateDir), true, "writable intercom state dir should be created before bwrap binds it");
	});

	it("does not mount intercom state dir when intercomStateDir is not provided", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const agentDir = mkdirp(path.join(root, "agent"));
		const intercomStateDir = path.join(agentDir, "intercom");

		const mounts = buildSubagentSandboxMounts({ cwd });

		assert.equal(mountMode(mounts, intercomStateDir), undefined);
	});

	it("expands tilde before rejecting protected read-only and writable mounts", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const protectedRoot = path.join(os.homedir(), `pi-protected-mount-${process.pid}-${Date.now()}`);
		tempRoots.push(protectedRoot);
		mkdirp(protectedRoot);
		for (const mode of ["ro", "rw"] as const) {
			const candidate = path.join(protectedRoot, mode, "resource");
			mkdirp(path.dirname(candidate));
			assert.throws(
				() => buildSubagentSandboxMounts({
					cwd,
					includeCwd: false,
					protectedGitPaths: [`~/${path.relative(os.homedir(), protectedRoot)}`],
					...(mode === "ro" ? { extraReadOnlyMounts: [`~/${path.relative(os.homedir(), candidate)}`] } : { extraWritableMounts: [`~/${path.relative(os.homedir(), candidate)}`] }),
				}),
				/overlaps protected Git metadata/i,
			);
		}
	});

	it("mounts nested subagent event route root writable when nested routing is provided", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const routeRoot = mkdirp(path.join(root, "nested-subagent-events", "run-token"));
		const eventSink = mkdirp(path.join(routeRoot, "events"));
		const controlInbox = mkdirp(path.join(routeRoot, "controls"));
		writeFile(path.join(routeRoot, "route.json"), "{}\n");

		const mounts = buildSubagentSandboxMounts({
			cwd,
			nestedRoute: { eventSink, controlInbox },
		});

		assert.equal(mountMode(mounts, routeRoot), "rw");
	});
});
