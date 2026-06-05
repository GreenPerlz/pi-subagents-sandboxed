/**
 * Tests for external terminal handoff (issue #23).
 *
 * Covers:
 * - resolveTerminalCommand availability and normalization
 * - buildTerminalArgs placeholder substitution and safety
 * - terminalUnavailableReason for missing config or session file
 * - launchTerminal validation (command resolution, session file existence)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveTerminalCommand,
	buildTerminalArgs,
	terminalUnavailableReason,
	launchTerminal,
	type TerminalLaunchMetadata,
} from "../../src/tui/terminal-launcher.ts";

describe("terminal launcher", () => {
	describe("resolveTerminalCommand", () => {
		it("returns undefined when config is missing", () => {
			assert.strictEqual(resolveTerminalCommand(undefined), undefined);
		});

		it("returns undefined when command is empty", () => {
			assert.strictEqual(resolveTerminalCommand({ command: "" }), undefined);
			assert.strictEqual(resolveTerminalCommand({ command: "   " }), undefined);
		});

		it("returns command and default empty args when only command is set", () => {
			const result = resolveTerminalCommand({ command: "xterm" });
			assert.ok(result);
			assert.strictEqual(result!.command, "xterm");
			assert.deepStrictEqual(result!.args, []);
		});

		it("returns command and args when both are set", () => {
			const result = resolveTerminalCommand({ command: "kitty", args: ["-e", "pi", "--session", "{sessionFile}"] });
			assert.ok(result);
			assert.strictEqual(result!.command, "kitty");
			assert.deepStrictEqual(result!.args, ["-e", "pi", "--session", "{sessionFile}"]);
		});

		it("filters out non-string args", () => {
			const result = resolveTerminalCommand({ command: "xterm", args: ["-e", 123 as unknown as string, null as unknown as string, "pi"] });
			assert.ok(result);
			assert.deepStrictEqual(result!.args, ["-e", "pi"]);
		});
	});

	describe("buildTerminalArgs", () => {
		it("passes through args without placeholders", () => {
			const args = buildTerminalArgs(["-e", "pi"], { sessionFile: "/tmp/session.jsonl", cwd: "/project" });
			assert.deepStrictEqual(args, ["-e", "pi"]);
		});

		it("substitutes {sessionFile} with the actual path", () => {
			const args = buildTerminalArgs(["--session", "{sessionFile}"], { sessionFile: "/tmp/session.jsonl" });
			assert.deepStrictEqual(args, ["--session", "/tmp/session.jsonl"]);
		});

		it("substitutes {cwd} with the actual cwd", () => {
			const args = buildTerminalArgs(["--cwd", "{cwd}"], { cwd: "/project" });
			assert.deepStrictEqual(args, ["--cwd", "/project"]);
		});

		it("leaves unknown placeholders unchanged", () => {
			const args = buildTerminalArgs(["--foo", "{unknown}"], { sessionFile: "/tmp/session.jsonl" });
			assert.deepStrictEqual(args, ["--foo", "{unknown}"]);
		});

		it("replaces missing sessionFile with empty string", () => {
			const args = buildTerminalArgs(["--session", "{sessionFile}"], {});
			assert.deepStrictEqual(args, ["--session", ""]);
		});

		it("does not perform shell interpolation", () => {
			const args = buildTerminalArgs(["--session", "{sessionFile}"], { sessionFile: "file; rm -rf /" });
			assert.deepStrictEqual(args, ["--session", "file; rm -rf /"]);
		});
	});

	describe("terminalUnavailableReason", () => {
		it("returns reason when no command is configured", () => {
			const reason = terminalUnavailableReason(undefined, { sessionFile: "/tmp/session.jsonl" });
			assert.strictEqual(reason, "No terminal command configured.");
		});

		it("returns undefined when command exists and session file is present", () => {
			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				const reason = terminalUnavailableReason({ command: "xterm", args: ["-e", "bash"] }, { sessionFile });
				assert.strictEqual(reason, undefined);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("returns reason when sessionFile is missing even when no placeholder is used", () => {
			const reason = terminalUnavailableReason(
				{ command: "xterm", args: ["-e", "bash"] },
				{},
			);
			assert.strictEqual(reason, "No session file available for this run yet.");
		});

		it("returns reason when args need sessionFile but none is available", () => {
			const reason = terminalUnavailableReason(
				{ command: "xterm", args: ["-e", "pi", "--session", "{sessionFile}"] },
				{},
			);
			assert.strictEqual(reason, "No session file available for this run yet.");
		});

		it("returns undefined when args need sessionFile and it exists", () => {
			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				const reason = terminalUnavailableReason(
					{ command: "xterm", args: ["-e", "pi", "--session", "{sessionFile}"] },
					{ sessionFile },
				);
				assert.strictEqual(reason, undefined);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("returns reason when session file does not exist", () => {
			const reason = terminalUnavailableReason(
				{ command: "xterm", args: ["-e", "bash"] },
				{ sessionFile: "/tmp/does-not-exist-pi-subagents-test.jsonl" },
			);
			assert.ok(reason?.includes("not found"), `expected 'not found' in reason: ${reason}`);
		});

		it("returns reason when sessionFile points to a directory", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-terminal-dir-"));
			try {
				const reason = terminalUnavailableReason(
					{ command: "xterm", args: ["-e", "bash"] },
					{ sessionFile: dir },
				);
				assert.ok(reason?.includes("not found"), `expected 'not found' in reason: ${reason}`);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("launchTerminal", () => {
		it("returns failure when command is not found", async () => {
			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				const result = await launchTerminal(
					{ command: "definitely-not-a-real-terminal-12345", args: [] },
					{ sessionFile },
				);
				assert.strictEqual(result.success, false);
				assert.ok(result.error?.includes("not found"), `expected 'not found' in error: ${result.error}`);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("returns failure when session file does not exist", async () => {
			const result = await launchTerminal(
				{ command: "cat", args: ["{sessionFile}"] },
				{ sessionFile: "/tmp/does-not-exist-pi-subagents-test.jsonl" },
			);
			assert.strictEqual(result.success, false);
			assert.ok(result.error?.includes("not found"), `expected 'not found' in error: ${result.error}`);
		});

		it("returns success for a valid command with existing session file", async () => {
			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				// Use 'true' as a universally available no-op command
				const result = await launchTerminal(
					{ command: "true", args: [] },
					{ sessionFile },
				);
				assert.strictEqual(result.success, true);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("filters out empty args from missing optional placeholders", async () => {
			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				const result = await launchTerminal(
					{ command: "true", args: ["{sessionFile}", "{cwd}"] },
					{ sessionFile },
				);
				assert.strictEqual(result.success, true);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("returns failure when spawn emits an error event", async () => {
			const mockChild = new EventEmitter() as import("node:child_process").ChildProcess;
			const mockSpawn = (..._args: unknown[]) => mockChild;

			const tmpDir = os.tmpdir();
			const sessionFile = path.join(tmpDir, `pi-subagents-terminal-test-${Date.now()}.jsonl`);
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			try {
				// Use 'true' so resolveCommandPath succeeds and our mock spawn is invoked
				const promise = launchTerminal(
					{ command: "true", args: [] },
					{ sessionFile },
					mockSpawn as typeof import("node:child_process").spawn,
				);

				process.nextTick(() => {
					mockChild.emit("error", new Error("EPERM spawn failure"));
				});

				const result = await promise;
				assert.strictEqual(result.success, false);
				assert.ok(result.error?.includes("EPERM spawn failure"), `expected spawn error: ${result.error}`);
			} finally {
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
			}
		});

		it("returns failure when session file is missing even when args have no placeholder", async () => {
			const result = await launchTerminal(
				{ command: "true", args: [] },
				{},
			);
			assert.strictEqual(result.success, false);
			assert.ok(result.error?.includes("No session file available"), `expected missing session error: ${result.error}`);
		});

		it("returns failure when session file does not exist even when args have no placeholder", async () => {
			const result = await launchTerminal(
				{ command: "true", args: [] },
				{ sessionFile: "/tmp/does-not-exist-pi-subagents-test.jsonl" },
			);
			assert.strictEqual(result.success, false);
			assert.ok(result.error?.includes("not found"), `expected 'not found' in error: ${result.error}`);
		});

		it("returns failure when sessionFile points to a directory", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-terminal-dir-"));
			try {
				const result = await launchTerminal(
					{ command: "true", args: [] },
					{ sessionFile: dir },
				);
				assert.strictEqual(result.success, false);
				assert.ok(result.error?.includes("not found"), `expected 'not found' in error: ${result.error}`);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
