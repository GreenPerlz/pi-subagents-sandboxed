import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createScopedGitEndpoint, readScopedGitProcessIdentity } from "../../src/sandbox/scoped-git-endpoint.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { makeMinimalCtx } from "../support/helpers.ts";
import { setPiSpawnEntrypointOverrideForTests } from "../../src/runs/shared/pi-spawn.ts";
import { buildPiArgs, SUBAGENT_SCOPED_GIT_ENDPOINT_ENV } from "../../src/runs/shared/pi-args.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

const hasBubblewrap = process.platform === "linux" && spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;

const roots = new Set<string>();
function repository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-integration-"));
	roots.add(root);
	spawnSync("git", ["-C", root, "init", "-q"]);
	spawnSync("git", ["-C", root, "config", "user.name", "Delegation Test"]);
	spawnSync("git", ["-C", root, "config", "user.email", "delegation@example.invalid"]);
	fs.writeFileSync(path.join(root, "base"), "base\n");
	spawnSync("git", ["-C", root, "add", "base"]);
	spawnSync("git", ["-C", root, "commit", "-qm", "base"]);
	return root;
}

async function endpointRequest(endpoint: string, body: object): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 3000;
	return await new Promise((resolve, reject) => {
		const connect = () => {
			let data = "";
			const socket = net.createConnection(endpoint);
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => data += chunk);
			socket.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ECONNREFUSED" && Date.now() < deadline) return setImmediate(connect);
				reject(error);
			});
			socket.on("end", () => { try { resolve(JSON.parse(data) as Record<string, unknown>); } catch (error) { reject(error); } });
			socket.on("connect", () => socket.end(JSON.stringify(body) + "\n"));
		};
		connect();
	});
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function identityFor(pid: number) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const identity = readScopedGitProcessIdentity(pid);
		if (identity) return identity;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("spawned delegation process identity was not observable");
}

async function gitRequest(endpoint: string, args: string[]): Promise<number> {
	const result = await endpointRequest(endpoint, { args, input: "" });
	return Number(result.status);
}

async function gitOutput(endpoint: string, args: string[]): Promise<{ status: number; stdout: string }> {
	const result = await endpointRequest(endpoint, { args, input: "" });
	return { status: Number(result.status), stdout: Buffer.from(String(result.stdout ?? ""), "base64").toString() };
}

function appendHostToolchainMounts(args: string[]): void {
	const nodeRoot = path.dirname(path.dirname(process.execPath));
	for (const target of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", nodeRoot]) {
		if (!fs.existsSync(target) || args.includes(target)) continue;
		if (fs.lstatSync(target).isSymbolicLink()) args.push("--symlink", fs.readlinkSync(target), target);
		else args.push("--ro-bind", fs.realpathSync(target), target);
	}
}

function spawnBubblewrapHandshake(worktree: string, endpointRoot: string): ReturnType<typeof spawn> {
	const args = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev"];
	appendHostToolchainMounts(args);
	args.push(
		"--bind", worktree, worktree,
		"--ro-bind", endpointRoot, "/run/pi-scoped-git",
		"--chdir", worktree, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
		"--", "/bin/sh", "-c", "printf 'READY\\n'; IFS= read -r release; printf 'RELEASED\\n'",
	);
	return spawn("bwrap", args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("READY\n")) {
				child.stdout?.off("data", onData);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.once("error", reject);
		child.once("close", (code) => reject(new Error(`handshake child exited before READY (${code})`)));
	});
}

async function waitForRelease(endpoint: string, descriptor: object): Promise<void> {
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const result = await endpointRequest(endpoint, { op: "child-status", descriptor });
		if (result.released === true) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("delegated writer reservation did not release after exact child disappearance");
}

afterEach(() => {
	setPiSpawnEntrypointOverrideForTests(undefined);
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	for (const runId of ["scoped-chain-real", "scoped-parallel-real"]) fs.rmSync(path.join(TEMP_ROOT_DIR, "chain-runs", runId), { recursive: true, force: true });
	roots.clear();
});

describe("foreground nested writer delegation endpoint", () => {
	it("reserves before spawn, binds the exact Bubblewrap child, and restores only after group disappearance", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			fs.writeFileSync(path.join(worktree, "change"), "change\n");
			const child = owner.reserveChild({ cwd: worktree, rights: "writer", allowWriter: true });
			assert.notEqual(await gitRequest(owner.scope.endpoint, ["add", "change"]), 0, "reservation suspends parent mutation before spawn");
			const nested = spawnBubblewrapHandshake(worktree, child.scope.endpointRoot);
			await waitForReady(nested);
			const identity = await identityFor(nested.pid!);
			const bound = await endpointRequest(child.scope.endpoint, { op: "delegate-writer", descriptor: { relativeSubtree: "." }, identity });
			assert.equal(bound.ok, true, JSON.stringify(bound));
			assert.notEqual(await gitRequest(owner.scope.endpoint, ["add", "change"]), 0, "same-worktree parent writer is denied while the bound child group lives");
			nested.stdin!.write("\n");
			await waitForExit(nested);
			await waitForRelease(owner.scope.endpoint, { relativeSubtree: path.relative(owner.scope.endpointRoot, child.scope.endpointRoot) || "." });
			assert.equal(await gitRequest(owner.scope.endpoint, ["add", "change"]), 0, "parent writer succeeds immediately after exact group disappearance");
		} finally { await owner.close(); }
	});

	it("blocks direct parent .git rewiring in scoped isolated mode", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-git-metadata-runtime-"));
		roots.add(runtimeRoot);
		const entrypoint = path.join(runtimeRoot, "pi-entry.mjs");
		fs.writeFileSync(entrypoint, [
			"import fs from 'node:fs';",
			"import path from 'node:path';",
			"try { fs.writeFileSync(path.join(process.cwd(), '.git', 'pi-direct-corruption'), 'corrupt\\n'); process.stderr.write('direct .git write unexpectedly succeeded'); process.exit(73); }",
			"catch (error) { if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) { process.stderr.write(String(error)); process.exit(74); } }",
			"process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'git metadata stayed protected' }], stopReason: 'stop' } }) + '\\n');",
		].join("\n"), "utf8");
		setPiSpawnEntrypointOverrideForTests(entrypoint);
		const owner = createScopedGitEndpoint({ runtimeRoot: path.join(runtimeRoot, "owner"), worktree, rights: "writer" });
		try {
			const result = await runSync(worktree, [{ name: "foreground", tools: ["read", "bash"], systemPromptMode: "replace" }], "foreground", "Do not alter Git metadata", {
				cwd: worktree,
				sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" },
				isolatedGitEndpoint: owner.descriptor,
				isolatedGitRights: "writer",
			});
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(fs.existsSync(path.join(worktree, ".git", "pi-direct-corruption")), false);
		} finally { await owner.close(); }
	});

	it("binds the exact foreground runSync child through Bubblewrap before allowing parent writes", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const entrypoint = path.join(runtimeRoot, "pi-entry.mjs");
		fs.writeFileSync(entrypoint, [
			"import { spawn } from 'node:child_process';",
			`const endpointEnv = ${JSON.stringify(SUBAGENT_SCOPED_GIT_ENDPOINT_ENV)};`,
			"const scoped = Boolean(process.env[endpointEnv]);",
			"const readOnly = Boolean(process.env.PI_TEST_SCOPED_READ_ONLY);",
			"if (scoped && !readOnly) { const ready = spawn('/usr/bin/git', ['status'], { stdio: 'ignore' }); await new Promise((resolve, reject) => { ready.once('error', reject); ready.once('close', (status) => status === 0 ? resolve() : reject(new Error('ready probe failed'))); }); }",
			"const child = spawn('/usr/bin/git', !scoped || readOnly ? ['status'] : ['add', 'child-change'], { stdio: ['ignore', 'pipe', 'pipe'] });",
			"let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);",
			"child.on('error', (error) => { process.stderr.write(String(error)); process.exit(1); });",
			"child.on('close', (status) => { if (status !== 0) process.stderr.write(stderr || 'git failed'); process.exit(status ?? 1); });",
		].join("\n"), "utf8");
		setPiSpawnEntrypointOverrideForTests(entrypoint);
		fs.writeFileSync(path.join(worktree, "child-change"), "child\n");
		fs.writeFileSync(path.join(worktree, "parent-change"), "parent\n");
		const agent = { name: "foreground", tools: ["read", "bash"], systemPromptMode: "replace" };
		const control = await runSync(worktree, [agent], "foreground", "control", {
			cwd: worktree,
			sandbox: { provider: "bubblewrap", fallback: "fail", network: "none" },
		});
		assert.equal(control.exitCode, 0, control.error);
		const owner = createScopedGitEndpoint({ runtimeRoot: path.join(runtimeRoot, "owner"), worktree, rights: "writer" });
		try {
			const nested = runSync(worktree, [agent], "foreground", "nested", {
				cwd: worktree,
				sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" },
				isolatedGitEndpoint: owner.descriptor,
				isolatedGitRights: "writer",
			});
			let parentBlocked = false;
			for (let attempt = 0; attempt < 100 && !parentBlocked; attempt += 1) {
				parentBlocked = (await gitRequest(owner.scope.endpoint, ["add", "parent-change"])) !== 0;
				if (!parentBlocked) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			assert.equal(parentBlocked, true, "parent mutation is rejected while the exact child group lives");
			const result = await nested;
			assert.equal(result.exitCode, 0, result.error);
			const resumed = (await gitRequest(owner.scope.endpoint, ["add", "parent-change"])) === 0;
			assert.equal(resumed, true, "parent resumes after verified child-group disappearance");
			const staged = await gitOutput(owner.scope.endpoint, ["diff", "--cached", "--name-only"]);
			assert.equal(staged.status, 0);
			assert.match(staged.stdout, /parent-change/);
			for (let repetition = 0; repetition < 64; repetition += 1) {
				const fast = await runSync(worktree, [agent], "foreground", `fast-child-${repetition}`, {
					cwd: worktree,
					sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" },
					isolatedGitEndpoint: owner.descriptor,
					isolatedGitRights: "writer",
				});
				assert.equal(fast.exitCode, 0, fast.error);
				assert.equal(await gitRequest(owner.scope.endpoint, ["add", "parent-change"]), 0, `writer lease restored before fast-child-${repetition} returned`);
			}
			process.env.PI_TEST_SCOPED_READ_ONLY = "1";
			try {
				const readOnlyRuns = await Promise.all([
					runSync(worktree, [agent], "foreground", "read-only-a", { cwd: worktree, sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" }, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "read-only" }),
					runSync(worktree, [agent], "foreground", "read-only-b", { cwd: worktree, sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" }, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "read-only" }),
				]);
				assert.ok(readOnlyRuns.every((run) => run.exitCode === 0), readOnlyRuns.map((run) => run.error).join("\\n"));
			} finally { delete process.env.PI_TEST_SCOPED_READ_ONLY; }
			const differentWorktree = repository();
			fs.writeFileSync(path.join(differentWorktree, "child-change"), "other\n");
			const differentOwner = createScopedGitEndpoint({ runtimeRoot: path.join(runtimeRoot, "different"), worktree: differentWorktree, rights: "writer" });
			try {
				const independentRuns = await Promise.all([
					runSync(worktree, [agent], "foreground", "independent-a", { cwd: worktree, sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" }, isolatedGitEndpoint: owner.descriptor, isolatedGitRights: "writer" }),
					runSync(differentWorktree, [agent], "foreground", "independent-b", { cwd: differentWorktree, sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" }, isolatedGitEndpoint: differentOwner.descriptor, isolatedGitRights: "writer" }),
				]);
				assert.ok(independentRuns.every((run) => run.exitCode === 0), independentRuns.map((run) => run.error).join("\\n"));
			} finally { await differentOwner.close(); }
		} finally { await owner.close(); }
	});

	it("runs real foreground chain and parallel reserve-spawn-bind paths", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const entrypoint = path.join(runtimeRoot, "pi-entry.mjs");
		fs.writeFileSync(entrypoint, [
			"import { spawn } from 'node:child_process';",
			"const endpoint = Boolean(process.env.PI_SUBAGENT_SCOPED_GIT_ENDPOINT);",
			"const readOnly = Boolean(process.env.PI_TEST_SCOPED_READ_ONLY);",
			"if (endpoint && !readOnly) { const ready = spawn('/usr/bin/git', ['status'], { stdio: 'ignore' }); await new Promise((resolve, reject) => { ready.once('error', reject); ready.once('close', (status) => status === 0 ? resolve() : reject(new Error('ready probe failed'))); }); }",
			"const child = spawn('/usr/bin/git', endpoint && !readOnly ? ['add', 'child-change'] : ['status'], { stdio: ['ignore', 'pipe', 'pipe'] });",
			"let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);",
			"child.on('error', (error) => { process.stderr.write(String(error)); process.exit(1); });",
			"child.on('close', (status) => { if (status !== 0) process.stderr.write(stderr || 'git failed'); process.exit(status ?? 1); });",
		].join("\n"), "utf8");
		setPiSpawnEntrypointOverrideForTests(entrypoint);
		fs.writeFileSync(path.join(worktree, "child-change"), "chain\n");
		const agent = { name: "work", tools: ["read", "edit"], systemPromptMode: "replace" };
		const reviewAgent = { name: "review", tools: ["read"], systemPromptMode: "replace" };
		const owner = createScopedGitEndpoint({ runtimeRoot: path.join(runtimeRoot, "owner"), worktree, rights: "writer" });
		const base = {
			agents: [agent, reviewAgent], ctx: makeMinimalCtx(worktree), cwd: worktree, runId: "scoped-chain-real", shareEnabled: false,
			sessionDirForIndex: () => undefined, artifactsDir: runtimeRoot, artifactConfig: { enabled: false },
			sandbox: { provider: "bubblewrap", gitMode: "isolated", fallback: "fail", network: "none", auth: "none" },
			clarify: false, includeProgress: false, scopedGitEndpoint: owner.descriptor,
			teardownHooks: { waitForNestedDescendantsToStop: async () => ({ observed: true, stopped: true }) },
		};
		try {
			const chain = await executeChain({ ...base, chain: [{ agent: "work", task: "Write and commit child-change, chain one" }, { agent: "work", task: "Write and commit child-change, chain two" }] } as never);
			assert.equal(chain.isError, undefined, chain.content[0]?.text);
			process.env.PI_TEST_SCOPED_READ_ONLY = "1";
			try {
				const parallel = await executeChain({ ...base, runId: "scoped-parallel-real", chain: [{ parallel: [{ agent: "review", task: "review one" }, { agent: "review", task: "review two" }] }] } as never);
				assert.equal(parallel.isError, undefined, parallel.content[0]?.text);
			} finally { delete process.env.PI_TEST_SCOPED_READ_ONLY; }
		} finally { await owner.close(); }
	});

	it("cancels a writer reservation when Bubblewrap setup fails before spawn", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const entrypoint = path.join(runtimeRoot, "pi-entry.mjs");
		fs.writeFileSync(entrypoint, "process.exit(0);\n", "utf8");
		setPiSpawnEntrypointOverrideForTests(entrypoint);
		const owner = createScopedGitEndpoint({ runtimeRoot: path.join(runtimeRoot, "owner"), worktree, rights: "writer" });
		try {
			fs.writeFileSync(path.join(worktree, "setup-failure"), "failure\\n");
			const result = await runSync(worktree, [{ name: "foreground", tools: ["read"], systemPromptMode: "replace" }], "foreground", "setup failure", {
				cwd: worktree,
				sandbox: { provider: "bubblewrap", gitMode: "isolated", profile: "unsupported", fallback: "fail", network: "none", auth: "none" },
				isolatedGitEndpoint: owner.descriptor,
				isolatedGitRights: "writer",
			});
			assert.equal(result.exitCode, 1);
			assert.equal(await gitRequest(owner.scope.endpoint, ["add", "setup-failure"]), 0, "failed pre-bind setup cancels the reservation");
		} finally { await owner.close(); }
	});

	it("runs nested chain and parallel reservations through independent endpoint paths", async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			fs.writeFileSync(path.join(worktree, "chain-change"), "chain\n");
			const child = owner.reserveChild({ cwd: worktree, rights: "writer", allowWriter: true });
			const childProcess = spawnBubblewrapHandshake(worktree, child.scope.endpointRoot);
			await waitForReady(childProcess);
			const childIdentity = await identityFor(childProcess.pid!);
			assert.equal((await endpointRequest(child.scope.endpoint, { op: "delegate-writer", descriptor: { relativeSubtree: "." }, identity: childIdentity })).ok, true);
			const grandchild = child.reserveChild({ cwd: worktree, rights: "writer", allowWriter: true });
			const grandchildProcess = spawnBubblewrapHandshake(worktree, grandchild.scope.endpointRoot);
			await waitForReady(grandchildProcess);
			const grandchildIdentity = await identityFor(grandchildProcess.pid!);
			assert.equal((await endpointRequest(grandchild.scope.endpoint, { op: "delegate-writer", descriptor: { relativeSubtree: "." }, identity: grandchildIdentity })).ok, true);
			assert.notEqual(await gitRequest(child.scope.endpoint, ["add", "chain-change"]), 0, "chain parent is fenced while grandchild writer is live");
			grandchildProcess.stdin!.write("\n");
			await waitForExit(grandchildProcess);
			await waitForRelease(child.scope.endpoint, { relativeSubtree: path.relative(child.scope.endpointRoot, grandchild.scope.endpointRoot) || "." });
			assert.equal(await gitRequest(child.scope.endpoint, ["add", "chain-change"]), 0, "chain parent resumes after grandchild group disappearance");
			const readOnlyA = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			const readOnlyB = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			assert.deepEqual(await Promise.all([gitRequest(readOnlyA.scope.endpoint, ["status"]), gitRequest(readOnlyB.scope.endpoint, ["status"])]), [0, 0]);
			assert.notEqual(await gitRequest(owner.scope.endpoint, ["add", "chain-change"]), 0, "root lease remains fenced while chain leader is live");
			childProcess.stdin!.write("\n");
			await waitForExit(childProcess);
			await waitForRelease(owner.scope.endpoint, { relativeSubtree: path.relative(owner.scope.endpointRoot, child.scope.endpointRoot) || "." });
			assert.equal(await gitRequest(owner.scope.endpoint, ["add", "chain-change"]), 0);
		} finally { await owner.close(); }
	});

	it("rebinds only the selected child subtree through real Bubblewrap", async () => {
		if (!hasBubblewrap) return;
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const child = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			const args = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev"];
			appendHostToolchainMounts(args);
			args.push("--bind", worktree, worktree, "--ro-bind", child.scope.endpointRoot, "/run/pi-scoped-git", "--chdir", worktree, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--", "/run/pi-scoped-git/git", "status");
			const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
				const process = spawn("bwrap", args, { stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
				process.stderr.on("data", (chunk) => stderr += chunk); process.on("error", reject); process.on("close", (status) => resolve({ status, stderr }));
			});
			assert.equal(result.status, 0, result.stderr);

			const childEnv = buildPiArgs({ baseArgs: ["-p"], task: "nested reserve", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, scopedGitEndpoint: child.descriptor }).env[SUBAGENT_SCOPED_GIT_ENDPOINT_ENV]!;
			assert.deepEqual(JSON.parse(childEnv), { relativeSubtree: "." }, "selected subtree is child-visible only at the fixed mount root");
			const nestedArgs = args.slice(0, args.indexOf("--"));
			const script = "const net=require('node:net');const d=JSON.parse(process.env.PI_SUBAGENT_SCOPED_GIT_ENDPOINT);const s=net.createConnection('/run/pi-scoped-git/'+d.relativeSubtree+'/endpoint');let x='';s.setEncoding('utf8');s.on('data',c=>x+=c);s.on('end',()=>{const r=JSON.parse(x);if(!r.descriptor)throw Error(r.error||'missing nested descriptor')});s.end(JSON.stringify({op:'reserve-child',rights:'read-only'})+'\\n')";
			nestedArgs.push("--setenv", SUBAGENT_SCOPED_GIT_ENDPOINT_ENV, childEnv, "--", process.execPath, "-e", script);
			const nestedResult = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
				const process = spawn("bwrap", nestedArgs, { stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
				process.stderr.on("data", (chunk) => stderr += chunk); process.on("error", reject); process.on("close", (status) => resolve({ status, stderr }));
			});
			assert.equal(nestedResult.status, 0, nestedResult.stderr);
		} finally { await owner.close(); }
	});

	it("rejects forged identity binding and owner-only cancellation", async () => {
		const worktree = repository();
		const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-delegation-runtime-"));
		roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const child = owner.reserveChild({ cwd: worktree, rights: "writer", allowWriter: true });
			const nested = spawn("sleep", ["0.2"], { detached: true, stdio: "ignore" });
			const identity = await identityFor(nested.pid!);
			const forged = { ...identity, startToken: "reused-start-token" };
			const rejected = await endpointRequest(child.scope.endpoint, { op: "delegate-writer", descriptor: child.descriptor, identity: forged });
			assert.notEqual(rejected.ok, true);
			assert.notEqual(await gitRequest(owner.scope.endpoint, ["add", "missing"]), 0, "failed binding remains fail-closed");
			const ownerRelative = path.relative(owner.scope.endpointRoot, child.scope.endpointRoot) || ".";
			assert.equal((await endpointRequest(owner.scope.endpoint, { op: "cancel-child", descriptor: { relativeSubtree: ownerRelative } })).ok, true);
			assert.equal(await gitRequest(owner.scope.endpoint, ["status"]), 0);
		} finally { await owner.close(); }
	});
});
