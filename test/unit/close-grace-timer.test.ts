import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { attachPostExitStdioGuard, isChildProcessGroupGone, processControlUnsupported, signalChildProcessGroup, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

const temporaryScriptDirs = new Set<string>();

after(() => {
	for (const dir of temporaryScriptDirs) fs.rmSync(dir, { recursive: true, force: true });
	temporaryScriptDirs.clear();
});

function writeScript(name: string, lines: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-close-grace-"));
	temporaryScriptDirs.add(dir);
	const script = path.join(dir, name);
	fs.writeFileSync(script, lines.join("\n"), { mode: 0o755 });
	return script;
}

function makeSilentLeakyScript(sleepSeconds: number): string {
	return writeScript("silent-leak.sh", [
		"#!/bin/bash",
		"set -eu",
		"echo done",
		`sleep ${sleepSeconds} &`,
		"disown || true",
		"exit 0",
	]);
}

function makeChattyLeakyScript(tickMs: number): string {
	return writeScript("chatty-leak.sh", [
		"#!/bin/bash",
		"set -eu",
		"echo start",
		`( while true; do echo tick; sleep ${(tickMs / 1000).toFixed(3)}; done ) &`,
		"disown || true",
		"exit 0",
	]);
}

interface RunResult {
	resolvedMs: number;
	exitCode: number | null;
	stdout: string;
}

function runWithGuard(script: string, idleMs: number, hardMs: number, maxWaitMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const child = spawn("bash", [script], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "";
		const clearGuard = attachPostExitStdioGuard(child, { idleMs, hardMs, killProcessGroupOnCutoff: process.platform !== "win32" });
		const hardStop = setTimeout(() => {
			try { signalChildProcessGroup(child, "SIGKILL"); } catch {}
			reject(new Error(`promise did not resolve within ${maxWaitMs}ms`));
		}, maxWaitMs);
		hardStop.unref?.();

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", () => {});
		child.on("close", (code) => {
			clearTimeout(hardStop);
			clearGuard();
			resolve({ resolvedMs: Date.now() - start, exitCode: code, stdout });
		});
		child.on("error", reject);
	});
}

describe("process control platform policy", () => {
	it("fails closed on POSIX platforms without portable identity continuity", () => {
		assert.match(processControlUnsupported("darwin"), /unsupported on darwin/i);
		assert.match(processControlUnsupported("freebsd"), /refusing to spawn/i);
	});

	it("allows Linux private groups and Windows child control", () => {
		assert.equal(processControlUnsupported("linux"), undefined);
		assert.equal(processControlUnsupported("win32"), undefined);
	});
});

describe("attachPostExitStdioGuard", () => {
	it("reports whether a termination signal was actually delivered", () => {
		assert.equal(trySignalChild({ kill: () => true }, "SIGTERM"), true);
		assert.equal(trySignalChild({ kill: () => false }, "SIGTERM"), false);
		assert.equal(trySignalChild({ kill: () => { throw new Error("gone"); } }, "SIGTERM"), false);
	});

	it("rejects invalid detached-group PIDs without direct-child fallback", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, () => {
		let directSignals = 0;
		for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(signalChildProcessGroup({ pid, kill: () => { directSignals++; return true; } }, "SIGTERM"), false, `pid ${pid} must be rejected`);
		}
		assert.equal(signalChildProcessGroup({ pid: 2_000_000_000, kill: () => { directSignals++; return true; } }, "SIGTERM"), false);
		assert.equal(directSignals, 0);
	});

	it("kills descendants in a detached process group when stdio remains open", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-process-group-"));
		const pidFile = path.join(dir, "grandchild.pid");
		const script = path.join(dir, "spawn-grandchild.mjs");
		fs.writeFileSync(script, [
			'import { spawn } from "node:child_process";',
			'import fs from "node:fs";',
			'const child = spawn("sleep", ["30"], { stdio: "inherit" });',
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			'setTimeout(() => process.exit(0), 100);',
		].join("\n"));
		const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const clearGuard = attachPostExitStdioGuard(child, { idleMs: 100, hardMs: 2000, killProcessGroupOnCutoff: true });
		try {
			const pidDeadline = Date.now() + 2000;
			while (!fs.existsSync(pidFile) && Date.now() < pidDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
			const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
			assert.ok(grandchildPid > 0);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("detached child did not close")), 5000);
				child.once("close", () => { clearTimeout(timer); resolve(); });
				child.once("error", reject);
			});
			const deadDeadline = Date.now() + 2000;
			while (Date.now() < deadDeadline) {
				try { process.kill(grandchildPid, 0); } catch { return; }
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.fail(`grandchild ${grandchildPid} survived detached process-group cleanup`);
		} finally {
			clearGuard();
			try { signalChildProcessGroup(child, "SIGKILL"); } catch {}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the hard cutoff after forced stream close when a detached grandchild ignores SIGTERM", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-hard-cutoff-"));
		const pidFile = path.join(dir, "grandchild.pid");
		const script = path.join(dir, "spawn-ignoring-grandchild.mjs");
		const grandchildScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
		fs.writeFileSync(script, [
			'import { spawn } from "node:child_process";',
			'import fs from "node:fs";',
			`const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "inherit" });`,
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
			'setTimeout(() => process.exit(0), 50);',
		].join("\n"));
		const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const idleMs = 100;
		const hardMs = 400;
		const clearGuard = attachPostExitStdioGuard(child, { idleMs, hardMs, killProcessGroupOnCutoff: true });
		let grandchildPid: number | undefined;
		let exitedAt: number | undefined;
		let terminalCallbackCalled = false;
		child.once("exit", () => { exitedAt = Date.now(); });
		const closePromise = new Promise<number | null>((resolve, reject) => {
			child.once("close", (code) => {
				terminalCallbackCalled = true;
				// Match production close/error cleanup: the callback is invoked before
				// the mandatory escalation deadline has elapsed.
				clearGuard();
				resolve(code);
			});
			child.once("error", reject);
		});
		try {
			const pidDeadline = Date.now() + 2000;
			while (!fs.existsSync(pidFile) && Date.now() < pidDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(fs.existsSync(pidFile), "grandchild PID was not published");
			grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
			assert.ok(grandchildPid > 0);

			let closeTimer: NodeJS.Timeout | undefined;
			const closeDeadline = new Promise<never>((_, reject) => {
				closeTimer = setTimeout(() => reject(new Error("guard did not permit terminal close callback")), 3000);
				closeTimer.unref?.();
			});
			let exitCode: number | null;
			try {
				exitCode = await Promise.race([closePromise, closeDeadline]);
			} finally {
				if (closeTimer) clearTimeout(closeTimer);
			}
			assert.equal(exitCode, 0);
			assert.equal(terminalCallbackCalled, true);
			assert.ok(exitedAt !== undefined);
			assert.ok(Date.now() - exitedAt! < hardMs, "terminal close should proceed before the mandatory hard deadline");
			assert.doesNotThrow(() => process.kill(grandchildPid!, 0), "SIGTERM should not kill the SIGTERM-ignoring descendant");

			const hardDeadline = exitedAt! + hardMs + 1000;
			while (Date.now() < hardDeadline) {
				try {
					process.kill(grandchildPid, 0);
				} catch {
					grandchildPid = undefined;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(grandchildPid, undefined, "SIGKILL hard cutoff did not kill the detached grandchild");
			assert.throws(() => process.kill(-child.pid!, 0), "detached process group still exists after hard cutoff");
		} finally {
			try { signalChildProcessGroup(child, "SIGKILL"); } catch {}
			clearGuard({ groupTeardownProven: true });
			if (typeof grandchildPid === "number" && grandchildPid > 0) {
				try { process.kill(grandchildPid, "SIGKILL"); } catch {}
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("releases terminal teardown promptly when TERM proves the private group is gone", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, async () => {
		const script = writeScript("close-after-stdio-end.mjs", [
			"process.stdout.write('done\\n');",
			"process.stdout.end();",
			"process.stderr.end();",
			"setTimeout(() => {}, 30_000);",
		]);
		const child = spawn(process.execPath, [script], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const startedAt = Date.now();
		let teardownCompletedAt: number | undefined;
		const clearGuard = attachPostExitStdioGuard(child, {
			idleMs: 100,
			hardMs: 2_000,
			killProcessGroupOnCutoff: true,
			onTeardownComplete: () => { teardownCompletedAt = Date.now(); },
		});
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("close", () => resolve());
				child.once("error", reject);
			});
			assert.ok(teardownCompletedAt !== undefined, "teardown proof should release the terminal gate");
			assert.ok(teardownCompletedAt! - startedAt < 1_000, `teardown proof was delayed: ${teardownCompletedAt! - startedAt}ms`);
		} finally {
			clearGuard({ groupTeardownProven: true });
			try { signalChildProcessGroup(child, "SIGKILL"); } catch {}
		}
	});

	it("refuses a delayed signal after the original process group disappears", async () => {
		const child = spawn("bash", ["-c", "exit 0"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const clearGuard = attachPostExitStdioGuard(child, { idleMs: 100, hardMs: 200, killProcessGroupOnCutoff: process.platform !== "win32" });
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("close", () => resolve());
				child.once("error", reject);
			});
			if (process.platform !== "win32") assert.equal(signalChildProcessGroup(child, "SIGKILL"), false);
		} finally {
			clearGuard({ groupTeardownProven: true });
		}
	});

	it("does not prove an unknown PID or reused process group is gone", () => {
		assert.equal(isChildProcessGroupGone({ pid: 2_000_000_000, kill: () => true }), false);
		// PID 1 is an existing group probe, but this handle has no captured
		// original member identity; group existence is therefore not proof of
		// disappearance.
		if (process.platform === "linux") assert.equal(isChildProcessGroupGone({ pid: 1, kill: () => true }), false);
	});

	it("does not delay a clean exit", async () => {
		const script = writeScript("clean.sh", ["#!/bin/bash", "set -eu", "echo hello", "exit 0"]);
		const result = await runWithGuard(script, 2000, 8000, 5000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /hello/);
		assert.ok(result.resolvedMs < 500, `expected fast close, got ${result.resolvedMs}ms`);
	});

	it("cuts off a silent grandchild with the idle timer", async () => {
		const idleMs = 1500;
		const result = await runWithGuard(makeSilentLeakyScript(30), idleMs, 8000, 10000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /done/);
		assert.ok(result.resolvedMs >= idleMs, `resolved too early: ${result.resolvedMs}ms`);
		assert.ok(result.resolvedMs < idleMs + 2000, `expected idle cutoff, got ${result.resolvedMs}ms`);
	});

	it("cuts off a chatty grandchild with the hard timer", async () => {
		const hardMs = 2000;
		const result = await runWithGuard(makeChattyLeakyScript(200), 1000, hardMs, 10000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /start/);
		assert.ok(result.resolvedMs >= hardMs - 500, `resolved too early: ${result.resolvedMs}ms`);
		assert.ok(result.resolvedMs < hardMs + 2000, `expected hard cutoff, got ${result.resolvedMs}ms`);
	});
});
