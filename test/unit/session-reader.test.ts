/**
 * Tests for session file reading, parsing, and formatting with thinking toggle.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readSessionFile, resolveSessionPath } from "../../src/tui/session-reader.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
};

function tmpFile(content: string): string {
	const dir = os.tmpdir();
	const name = `pi-subagents-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
	const p = path.join(dir, name);
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

function cleanup(p: string): void {
	try { fs.unlinkSync(p); } catch { /* ignore */ }
}

describe("session-reader", () => {
	describe("readSessionFile", () => {
		it("returns error for missing file", () => {
			const result = readSessionFile("/nonexistent/path/session.jsonl", theme as never, 80, false);
			assert.ok(result.error, "should return error");
			assert.ok(result.error!.includes("not found"), "error should mention not found");
			assert.deepStrictEqual(result.lines, []);
		});

		it("parses JSONL message entries into display lines", () => {
			const content = JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Hello", timestamp: Date.now() } }) + "\n" +
				JSON.stringify({ type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Hi there" }], api: "anthropic-messages", provider: "anthropic", model: "claude", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(!result.error, `should not error: ${result.error}`);
				assert.ok(result.lines.length > 0, "should have lines");
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("User"), "should show user header");
				assert.ok(text.includes("Hello"), "should show user content");
				assert.ok(text.includes("Assistant"), "should show assistant header");
				assert.ok(text.includes("Hi there"), "should show assistant content");
			} finally {
				cleanup(p);
			}
		});

		it("hides thinking blocks by default", () => {
			const content = JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "Deep reasoning here" }], api: "anthropic-messages", provider: "anthropic", model: "claude", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(!result.error);
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("Answer"), "should show answer text");
				assert.ok(!text.includes("Deep reasoning"), "should hide thinking content");
				assert.ok(text.includes("thinking hidden"), "should show hidden thinking indicator");
				// Mark thinking lines
				const thinkingLines = result.lines.filter((l) => l.isThinking);
				assert.ok(thinkingLines.length > 0, "should mark hidden-thinking lines");
			} finally {
				cleanup(p);
			}
		});

		it("shows thinking blocks when showThinking is true", () => {
			const content = JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "Deep reasoning here" }], api: "anthropic-messages", provider: "anthropic", model: "claude", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, true);
				assert.ok(!result.error);
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("Answer"), "should show answer text");
				assert.ok(text.includes("Deep reasoning"), "should show thinking content");
				assert.ok(!text.includes("thinking hidden"), "should not show hidden indicator");
				const thinkingLines = result.lines.filter((l) => l.isThinking);
				assert.ok(thinkingLines.length > 0, "should mark thinking lines");
			} finally {
				cleanup(p);
			}
		});

		it("handles tool result messages", () => {
			const content = JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: Date.now() } });
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(!result.error);
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("Tool result"), "should show tool result header");
				assert.ok(text.includes("bash"), "should show tool name");
				assert.ok(text.includes("output"), "should show tool output");
			} finally {
				cleanup(p);
			}
		});

		it("falls back to plain text for non-JSONL files", () => {
			const content = "Line one\nLine two\nLine three";
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(!result.error);
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("Line one"));
				assert.ok(text.includes("Line two"));
				assert.ok(text.includes("Line three"));
			} finally {
				cleanup(p);
			}
		});

		it("formats compaction entries", () => {
			const content = JSON.stringify({ type: "compaction", id: "1", parentId: null, timestamp: new Date().toISOString(), summary: "Summarized old context", firstKeptEntryId: "2", tokensBefore: 1000 });
			const p = tmpFile(content);
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(!result.error);
				const text = result.lines.map((l) => l.text).join("\n");
				assert.ok(text.includes("[compaction]"), "should show compaction label");
				assert.ok(text.includes("Summarized old context"), "should show compaction summary");
			} finally {
				cleanup(p);
			}
		});

		it("handles empty session file", () => {
			const p = tmpFile("   ");
			try {
				const result = readSessionFile(p, theme as never, 80, false);
				assert.ok(result.error, "should return error for empty file");
				assert.ok(result.error!.includes("empty"), "error should mention empty");
			} finally {
				cleanup(p);
			}
		});
	});

	describe("resolveSessionPath", () => {
		it("prefers sessionFile when it exists and is a file", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: p, artifactPath: "/other", asyncDir: "/other2" });
				assert.strictEqual(resolved, p);
			} finally {
				cleanup(p);
			}
		});

		it("does not return sessionFile when it is a directory", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			try {
				const resolved = resolveSessionPath({ sessionFile: dir });
				assert.strictEqual(resolved, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("falls back to logPath when sessionFile missing", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: "/nonexistent", logPath: p, artifactPath: "/other" });
				assert.strictEqual(resolved, p);
			} finally {
				cleanup(p);
			}
		});

		it("falls back to artifactPath when sessionFile and logPath are missing", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: "/nonexistent", logPath: "/also-missing", artifactPath: p });
				assert.strictEqual(resolved, p);
			} finally {
				cleanup(p);
			}
		});

		it("does not return a directory artifactPath, but searches inside it", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const logFile = path.join(dir, "output.log");
			fs.writeFileSync(logFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ artifactPath: dir });
				assert.strictEqual(resolved, logFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("returns undefined when artifactPath is a directory with no candidate files", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			try {
				const resolved = resolveSessionPath({ artifactPath: dir });
				assert.strictEqual(resolved, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("falls back to asyncDir candidates", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(sessionFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ asyncDir: dir });
				assert.strictEqual(resolved, sessionFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("returns undefined when nothing exists", () => {
			const resolved = resolveSessionPath({});
			assert.strictEqual(resolved, undefined);
		});

		it("preferred 'session' returns sessionFile when available", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: p, logPath: "/other" }, "session");
				assert.strictEqual(resolved, p);
			} finally {
				cleanup(p);
			}
		});

		it("preferred 'session' ignores logPath when sessionFile missing", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: "/nonexistent", logPath: p }, "session");
				assert.strictEqual(resolved, undefined);
			} finally {
				cleanup(p);
			}
		});

		it("preferred 'logs' returns logPath when available", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: "/nonexistent", logPath: p }, "logs");
				assert.strictEqual(resolved, p);
			} finally {
				cleanup(p);
			}
		});

		it("preferred 'logs' ignores sessionFile when it exists", () => {
			const p = tmpFile("test");
			try {
				const resolved = resolveSessionPath({ sessionFile: p, logPath: "/nonexistent" }, "logs");
				assert.strictEqual(resolved, undefined);
			} finally {
				cleanup(p);
			}
		});

		it("preferred 'logs' searches artifactPath directory for log files only", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const logFile = path.join(dir, "output.log");
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(logFile, "test", "utf-8");
			fs.writeFileSync(sessionFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ artifactPath: dir }, "logs");
				assert.strictEqual(resolved, logFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("preferred 'session' searches artifactPath directory for session.jsonl only", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const logFile = path.join(dir, "output.log");
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(logFile, "test", "utf-8");
			fs.writeFileSync(sessionFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ artifactPath: dir }, "session");
				assert.strictEqual(resolved, sessionFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("preferred 'logs' searches asyncDir for log files only", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const logFile = path.join(dir, "output.log");
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(logFile, "test", "utf-8");
			fs.writeFileSync(sessionFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ asyncDir: dir }, "logs");
				assert.strictEqual(resolved, logFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("preferred 'session' searches asyncDir for session.jsonl only", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
			const logFile = path.join(dir, "output.log");
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(logFile, "test", "utf-8");
			fs.writeFileSync(sessionFile, "test", "utf-8");
			try {
				const resolved = resolveSessionPath({ asyncDir: dir }, "session");
				assert.strictEqual(resolved, sessionFile);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
