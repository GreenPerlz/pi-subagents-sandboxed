import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { createScopedGitEndpoint, readScopedGitProcessIdentity, reserveScopedGitChildDescriptor, scopedGitDescriptorMounts, scopedGitInvocation, validateScopedGitCommand } from "../../src/sandbox/scoped-git-endpoint.ts";

const roots = new Set<string>();
function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-git-endpoint-")); roots.add(root);
	spawnSync("git", ["-C", root, "init", "-q"]); spawnSync("git", ["-C", root, "config", "user.name", "Endpoint Test"]); spawnSync("git", ["-C", root, "config", "user.email", "endpoint@example.invalid"]);
	fs.writeFileSync(path.join(root, "base"), "base\n"); spawnSync("git", ["-C", root, "add", "base"]); spawnSync("git", ["-C", root, "commit", "-qm", "base"]);
	return root;
}
async function request(endpoint: string, args: string[], input = ""): Promise<{ status: number; stdout: string; stderr: string }> {
	await new Promise<void>((resolve) => {
		const check = () => fs.existsSync(endpoint) ? resolve() : setImmediate(check);
		check();
	});
	return await new Promise((resolve, reject) => {
		const connect = () => { const socket = net.createConnection(endpoint); let data = ""; socket.setEncoding("utf8");
			socket.on("data", (chunk) => data += chunk); socket.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? setTimeout(connect, 10) : reject(error)); socket.on("end", () => { const value = JSON.parse(data); resolve({ status: value.status, stdout: Buffer.from(value.stdout, "base64").toString(), stderr: Buffer.from(value.stderr, "base64").toString() }); });
			socket.on("connect", () => socket.end(JSON.stringify({ args, input: Buffer.from(input).toString("base64") }) + "\n")); };
		connect();
	});
}
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe("scoped Git endpoint", () => {
	it("keeps the serialized descriptor free of host authority and rejects traversal", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			assert.deepEqual(Object.keys(owner.descriptor), ["relativeSubtree"]);
			assert.equal(owner.descriptor.relativeSubtree, ".");
			assert.equal(scopedGitDescriptorMounts(owner.descriptor)[0]?.target, "/run/pi-scoped-git");
			assert.throws(() => scopedGitDescriptorMounts({ relativeSubtree: "../stronger" }), /escapes|invalid/);
		} finally { await owner.close(); }
	});

	it("executes native add/commit through the owner endpoint and rejects read-only and helper routes", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			fs.writeFileSync(path.join(worktree, "change"), "change\n");
			assert.equal((await request(owner.scope.endpoint, ["add", "change"])).status, 0);
			assert.equal((await request(owner.scope.endpoint, ["commit", "-m", "change"])).status, 0);
			const review = owner.reserveChild({ rights: "read-only" });
			const reviewResult = await request(review.scope.endpoint, ["add", "change"]); assert.notEqual(reviewResult.status, 0);
			assert.notEqual((await request(owner.scope.endpoint, ["upload-pack", worktree])).status, 0);
			assert.throws(() => owner.reserveChild({ cwd: path.dirname(worktree), rights: "read-only" }), /widens|escapes/);
			assert.throws(() => owner.reserveChild({ rights: "writer" }), /already|scope/);
		} finally { await owner.close(); }
	});

	it("narrows endpoint subtrees and keeps scope records independent of request paths", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const nested = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			assert.equal(nested.scope.worktree, owner.scope.worktree); assert.ok(nested.scope.endpointRoot.startsWith(owner.scope.endpointRoot + path.sep));
			assert.equal(owner.invocationMounts(nested.scope)[0]?.mode, "ro");
			assert.throws(() => validateScopedGitCommand(["-c", "core.hooksPath=/tmp", "status"], "writer"), /configuration/);
		} finally { await owner.close(); }
	});

	it("serializes dynamic child and grandchild coordinates without host metadata", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const child = await reserveScopedGitChildDescriptor(owner.descriptor, { rights: "read-only" });
			const grandchild = await reserveScopedGitChildDescriptor(child, { rights: "read-only" });
			assert.notEqual(child.relativeSubtree, grandchild.relativeSubtree);
			assert.equal(JSON.stringify(child).includes(worktree), false);
			assert.ok(scopedGitDescriptorMounts(grandchild).every((mount) => !mount.source.includes(worktree)));
		} finally { await owner.close(); }
	});

	it("proves the read-only endpoint subtree can be rebound into Bubblewrap", async () => {
		if (process.platform !== "linux") return;
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const mount = owner.invocationMounts()[0]!;
			const args = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--dir", "/run"];
			const nodeRoot = path.dirname(path.dirname(process.execPath));
			for (const system of ["/usr", "/bin", "/lib", "/etc", nodeRoot]) {
				if (!fs.existsSync(system) || args.includes(system)) continue;
				const source = fs.realpathSync(system);
				if (source !== system) args.push("--dir", system);
				args.push("--ro-bind", source, system);
			}
			args.push("--bind", worktree, worktree, "--ro-bind", mount.source, mount.target!, "--chdir", worktree, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--", "/bin/sh", "/run/pi-scoped-git/git", "status");
			const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => { const child = spawn("bwrap", args, { stdio: ["pipe", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", reject); child.on("close", (status) => resolve({ status, stderr })); child.stdin.end(); });
			assert.equal(result.status, 0, result.stderr);
		} finally { await owner.close(); }
	});

	it("runs hierarchical child and grandchild scopes through real Bubblewrap rebinding", async () => {
		if (process.platform !== "linux") return;
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		const run = async (scope: ReturnType<typeof createScopedGitEndpoint>, args: string[]) => {
			const command = ["--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--dir", "/run"];
			const nodeRoot = path.dirname(path.dirname(process.execPath));
			for (const system of ["/usr", "/bin", "/lib", "/etc", nodeRoot]) {
				if (!fs.existsSync(system) || command.includes(system)) continue;
				const source = fs.realpathSync(system);
				if (source !== system) command.push("--dir", system);
				command.push("--ro-bind", source, system);
			}
			for (const mount of scope.invocationMounts()) command.push("--ro-bind", mount.source, mount.target!);
			command.push("--", "/bin/sh", "/run/pi-scoped-git/git", ...args);
			return await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => { const child = spawn("bwrap", command, { stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", reject); child.on("close", (status) => resolve({ status, stderr })); });
		};
		try {
			const child = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			const sibling = owner.reserveChild({ cwd: worktree, rights: "read-only" });
			const grandchild = child.reserveChild({ cwd: worktree, rights: "read-only" });
			assert.notEqual(child.scope.endpointRoot, sibling.scope.endpointRoot);
			const rebound = scopedGitDescriptorMounts(child.descriptor);
			assert.ok(rebound.every((mount) => !mount.source.includes(worktree)));
			assert.throws(() => scopedGitDescriptorMounts({ relativeSubtree: "../" + path.basename(sibling.scope.endpointRoot) }), /escapes|invalid/);
			const childResult = await run(child, ["status", "--short"]);
			assert.equal(childResult.status, 0, childResult.stderr);
			const denied = await run(child, ["add", "base"]);
			assert.notEqual(denied.status, 0, denied.stderr);
			const grandchildResult = await run(grandchild, ["status", "--short"]);
			assert.equal(grandchildResult.status, 0, grandchildResult.stderr);
			assert.ok(grandchild.descriptor.relativeSubtree !== child.descriptor.relativeSubtree);
		} finally { await owner.close(); }
	});

	it("keeps a same-worktree parent writer suspended until exact delegated process disappearance", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const childProcess = spawn("sleep", ["1"], { detached: true }); let identity;
			for (let attempt = 0; attempt < 50 && !identity; attempt += 1) { identity = readScopedGitProcessIdentity(childProcess.pid!); if (!identity) await new Promise<void>((resolve) => setImmediate(resolve)); }
			assert.ok(identity);
			const child = owner.delegateWriter(identity!);
			const suspended = await request(owner.scope.endpoint, ["add", "missing"]); assert.notEqual(suspended.status, 0); assert.match(suspended.stderr, /suspended|rejected/);
			await child.waitForRelease;
			assert.equal((await request(owner.scope.endpoint, ["status"])).status, 0);
		} finally { await owner.close(); }
	});

	it("retains the writer fence when a delegated leader exits with a group survivor", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			const childProcess = spawn("sh", ["-c", "sleep 2 & sleep 0.2; exit 0"], { detached: true, stdio: "ignore" });
			let identity;
			for (let attempt = 0; attempt < 50 && !identity; attempt += 1) { identity = readScopedGitProcessIdentity(childProcess.pid!); if (!identity) await new Promise<void>((resolve) => setImmediate(resolve)); }
			assert.ok(identity);
			const child = owner.delegateWriter(identity!);
			await new Promise<void>((resolve) => childProcess.once("close", () => resolve()));
			assert.notEqual((await request(owner.scope.endpoint, ["add", "missing"])).status, 0, "leader exit does not release a surviving group");
			try { process.kill(-identity!.pgid, "SIGTERM"); } catch { /* survivor may have exited */ }
			await child.waitForRelease;
			assert.equal((await request(owner.scope.endpoint, ["status"])).status, 0);
		} finally { await owner.close(); }
	});

	it("closes an active permitted Git request with SIGTERM-only private-group proof", { skip: process.platform !== "linux" ? "Linux private process-group identity is required" : undefined }, async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const marker = path.join(runtimeRoot, "executor-events");
		const executor = path.join(runtimeRoot, "controlled-git.mjs");
		fs.writeFileSync(executor, [
			"#!/bin/sh",
			`marker=${JSON.stringify(marker)}`,
			"printf '%s\\n' \"$$\" > \"$marker\"",
			`trap 'printf "TERM\\n" >> "$marker"; exit 143' TERM`,
			"while :; do /bin/sleep 1; done",
		].join("\n"), { mode: 0o755 });
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer", gitPath: executor });
		try {
			const requestPromise = request(owner.scope.endpoint, ["status"]);
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const watcher = fs.watch(runtimeRoot, (_event, filename) => {
					if (String(filename) === path.basename(marker) && fs.existsSync(marker)) { settled = true; watcher.close(); resolve(); }
				});
				if (fs.existsSync(marker)) { settled = true; watcher.close(); resolve(); }
				void requestPromise.then(() => { if (!settled) { settled = true; watcher.close(); reject(new Error("controlled permitted executor exited before startup")); } });
			});
			assert.equal(fs.existsSync(marker), true, "controlled permitted executor started");
			const pid = Number(fs.readFileSync(marker, "utf8").split("\\n", 1)[0]);
			let identity;
			for (let attempt = 0; attempt < 50 && !identity; attempt += 1) {
				identity = readScopedGitProcessIdentity(pid);
				if (!identity) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			assert.ok(identity);
			assert.equal(identity.pgid, identity.pid, "active request owns a private process group");
			const closePromise = owner.close();
			await closePromise;
			assert.equal(readScopedGitProcessIdentity(pid), undefined, "exact private group disappeared before close resolved");
			assert.equal(fs.readFileSync(marker, "utf8"), `${pid}\nTERM\n`, "close uses SIGTERM only");
			const result = await requestPromise;
			assert.notEqual(result.status, 0, "terminated request does not report success");
			assert.equal(fs.existsSync(owner.scope.endpointRoot), false, "successful teardown removes private endpoint evidence");
		} finally { await owner.close(); }
	});

	it("bounds permitted Git output and proves process teardown before responding", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const executor = path.join(runtimeRoot, "noisy-git.sh");
		fs.writeFileSync(executor, [
			"#!/bin/sh",
			"if [ \"$1\" = --exec-path ]; then exec git --exec-path; fi",
			"while :; do printf '0123456789abcdef0123456789abcdef\\n'; done",
		].join("\n"), { mode: 0o755 });
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer", gitPath: executor });
		try {
			const result = await request(owner.scope.endpoint, ["status"]);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /output exceeded limit/);
			assert.ok(Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024, "response remains within the owner output cap");
		} finally { await owner.close(); }
	});

	it("waits for a normal command's surviving group before clearing teardown proof", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const executor = path.join(runtimeRoot, "brief-survivor-git.sh");
		fs.writeFileSync(executor, [
			"#!/bin/sh",
			"if [ \"$1\" = --exec-path ]; then exec git --exec-path; fi",
			"sleep 0.2 &",
			"exit 0",
		].join("\n"), { mode: 0o755 });
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer", gitPath: executor });
		assert.equal((await request(owner.scope.endpoint, ["status"])).status, 0);
		await owner.close();
		assert.equal(fs.existsSync(owner.scope.endpointRoot), false, "proven late disappearance permits endpoint cleanup");
	});

	it("rolls back endpoint roots and writer leases when setup fails", async () => {
		const worktree = repo(); const runtimeRoot = path.join(os.tmpdir(), `scoped-runtime-failed-${randomUUID()}`); roots.add(runtimeRoot);
		const configPath = path.join(worktree, ".git", "config");
		const config = fs.readFileSync(configPath);
		fs.rmSync(configPath); fs.mkdirSync(configPath);
		assert.throws(() => createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" }), /EISDIR|regular file/i);
		assert.equal(fs.existsSync(runtimeRoot), false, "partial endpoint setup leaves no private root");
		fs.rmdirSync(configPath); fs.writeFileSync(configPath, config);
		const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(retryRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot: retryRoot, worktree, rights: "writer" });
		await owner.close();
	});

	it("lets any child close the shared owner safely without retaining the root writer lease", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		const child = owner.reserveChild({ rights: "read-only" });
		assert.equal(await child.close(), true);
		assert.equal(fs.existsSync(owner.scope.endpointRoot), false);
		assert.equal(await owner.close(), true, "owner close remains idempotent after child-initiated shared close");
		const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(retryRoot);
		const retry = createScopedGitEndpoint({ runtimeRoot: retryRoot, worktree, rights: "writer" });
		await retry.close();
	});

	it("retains teardown tracking when a spawned Git command cannot be identified", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer", gitPath: path.join(runtimeRoot, "missing-git") });
		const result = await request(owner.scope.endpoint, ["status"]);
		assert.notEqual(result.status, 0);
		assert.equal(await owner.close(), true);
		assert.equal(fs.existsSync(owner.scope.endpointRoot), false);
	});

	it("allows independent writers for different canonical worktrees", async () => {
		const first = repo(); const second = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const left = createScopedGitEndpoint({ runtimeRoot, worktree: first, rights: "writer" });
		const right = createScopedGitEndpoint({ runtimeRoot, worktree: second, rights: "writer" });
		try {
			assert.notEqual(left.scope.worktree, right.scope.worktree);
			assert.equal((await request(left.scope.endpoint, ["status"])).status, 0);
			assert.equal((await request(right.scope.endpoint, ["status"])).status, 0);
		} finally { await left.close(); await right.close(); }
	});

	it("keeps ordinary changed-file diff working without external helpers", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			fs.writeFileSync(path.join(worktree, "base"), "changed\n");
			const result = await request(owner.scope.endpoint, ["diff", "--", "base"]);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /-base\n\+changed/);
		} finally { await owner.close(); }
	});

	it("rejects pre-existing local helper, filter, driver, include, and callback configuration", async () => {
		const cases = [
			'[diff "attack"]\n\ttextconv = /tmp/scoped-marker\n',
			'[credential]\n\thelper = /tmp/scoped-marker\n',
			'[credential]\n\thelper\n',
			'[merge "attack"]\n\tdriver = /tmp/scoped-marker %O %A %B\n',
			'[core]\n\tsshCommand = /tmp/scoped-marker\n',
			'[core]\n\tfsmonitor = /tmp/scoped-marker\n',
			'[core]\n\thooksPath = /tmp\n',
			'[core]\n\tworktree = /tmp\n',
			'[core]\n\tbare = true\n',
			'[core]\n\teditor = /tmp/scoped-marker\n',
			'[core]\n\tsequenceEditor = /tmp/scoped-marker\n',
			'[core]\n\tpager = /tmp/scoped-marker\n',
			'[commit]\n\tgpgSign = true\n',
			'[gpg]\n\tprogram = /tmp/scoped-marker\n',
			'[core]\n\tattributesFile = /tmp/scoped-attributes\n',
			'[core]\n\texcludesFile = /tmp/scoped-excludes\n',
			'[core]\n\tgitProxy = /tmp/scoped-marker\n',
			'[core]\n\talternateRefsCommand = /tmp/scoped-marker\n',
			'[include]\n\tpath = /tmp/scoped-config\n',
			'[filter "attack"]\n\tprocess = /tmp/scoped-marker\n',
		];
		for (const unsafeConfig of cases) {
			const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
			fs.appendFileSync(path.join(worktree, ".git", "config"), `\n${unsafeConfig}`);
			const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
			try {
				fs.writeFileSync(path.join(worktree, "base"), "changed\n");
				const result = await request(owner.scope.endpoint, ["diff", "--no-ext-diff", "--", "base"]);
				assert.notEqual(result.status, 0, unsafeConfig);
				assert.match(result.stderr, /helper|filter|configuration|rejected/i);
			} finally { await owner.close(); }
		}
	});

	it("revokes an unbound writer child when its reservation expires", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer", reservationTimeoutMs: 25 });
		try {
			const child = owner.reserveChild({ rights: "writer", allowWriter: true });
			await new Promise((resolve) => setTimeout(resolve, 75));
			fs.writeFileSync(path.join(worktree, "expired"), "expired\n");
			assert.notEqual((await request(child.scope.endpoint, ["add", "expired"])).status, 0, "expired child endpoint is revoked");
			assert.equal((await request(owner.scope.endpoint, ["add", "expired"])).status, 0, "owner writer resumes after expiry");
		} finally { await owner.close(); }
	});

	it("enforces command-specific allowlists and blocks host side effects", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		const readonly = owner.reserveChild({ rights: "read-only" });
		const outside = path.join(os.tmpdir(), `scoped-secret-${randomUUID()}`);
		const marker = path.join(os.tmpdir(), `scoped-marker-${randomUUID()}`);
		try {
			fs.writeFileSync(outside, "secret\n");
			const redacted = await request(owner.scope.endpoint, ["status", path.join(worktree, "base")]);
			assert.equal(redacted.stderr.includes(worktree), false, "endpoint host source is absent from error diagnostics");
			for (const args of [["diff", "--no-index", outside, path.join(worktree, "base")], ["diff", "../scoped-secret-outside"], ["diff", `--output=${outside}`, "HEAD"], ["init"], ["checkout-index", "--prefix=/tmp/"], ["symbolic-ref", "HEAD", "refs/heads/evil"], ["hash-object", "-w", outside], ["commit-graph", "write"], ["update-server-info"], ["fast-import"]]) {
				assert.notEqual((await request(owner.scope.endpoint, args)).status, 0, args.join(" "));
				assert.notEqual((await request(readonly.scope.endpoint, args)).status, 0, `read-only ${args.join(" ")}`);
			}
			const config = path.join(worktree, ".git", "config");
			fs.appendFileSync(config, `\n[alias]\n\tattack = !touch ${marker}\n`);
			assert.notEqual((await request(owner.scope.endpoint, ["attack"])).status, 0);
			assert.equal(fs.existsSync(marker), false);
			assert.equal((await request(owner.scope.endpoint, ["status", "--short"])).status !== 0, true, "mutated local config fails closed");
		} finally { fs.rmSync(outside, { force: true }); fs.rmSync(marker, { force: true }); await owner.close(); }
	});

	it("exposes only the scoped endpoint through the foreground Git invocation surface", async () => {
		const worktree = repo(); const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-runtime-surface-")); roots.add(runtimeRoot);
		const owner = createScopedGitEndpoint({ runtimeRoot, worktree, rights: "writer" });
		try {
			assert.equal((await request(owner.scope.endpoint, ["status"])).status, 0);
			const invocation = scopedGitInvocation(owner.scope, { command: "node", args: ["-e", ""], cwd: worktree });
			assert.equal(invocation.command, "/run/pi-scoped-git/git");
			assert.equal(invocation.env?.SCOPED_GIT_ENDPOINT, "/run/pi-scoped-git");
			assert.deepEqual(Object.keys(invocation.env ?? {}).sort(), ["PATH", "SCOPED_GIT_ENDPOINT"].sort());
		} finally { await owner.close(); }
	});
});
