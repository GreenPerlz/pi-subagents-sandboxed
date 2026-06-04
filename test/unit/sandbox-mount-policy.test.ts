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
});

describe("subagent sandbox mount policy", () => {
	it("mounts cwd read-only when write inference says the child is read-only", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));

		const mounts = buildSubagentSandboxMounts({ cwd, cwdMode: "ro" });

		assert.equal(mountMode(mounts, cwd), "ro");
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

	it("mounts Pi auth JSON read-only but NOT settings JSON when pi-json auth mode is requested", () => {
		const root = tempRoot();
		const cwd = mkdirp(path.join(root, "project"));
		const agentDir = mkdirp(path.join(root, "agent"));
		const authPath = writeFile(path.join(agentDir, "auth.json"), "{}");
		const settingsPath = writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:ambient-package-that-would-need-npm-root"] }));

		const mounts = buildSubagentSandboxMounts({ cwd, authMode: "pi-json", agentDir });

		assert.equal(mountMode(mounts, authPath), "ro");
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
