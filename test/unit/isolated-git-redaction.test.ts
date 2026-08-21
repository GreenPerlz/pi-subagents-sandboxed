import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactAbsolutePaths, stripIsolatedGitExportDiagnostics } from "../../src/sandbox/isolated-git.ts";

describe("portable isolated Git metadata redaction", () => {
	it("redacts POSIX and Windows absolute paths in common metadata forms", () => {
		const metadata = [
			"cwd=/tmp/personal-secret",
			"path=C:\\Users\\Alice\\secret",
			"quoted \"/home/alice/private\"",
			"bracketed [/var/tmp/cache]",
			"whitespace /Users/alice/work",
			"punctuation (/tmp/private),",
		].join(" | ");
		const redacted = redactAbsolutePaths(metadata);
		assert.equal(redacted.includes("/tmp/personal-secret"), false);
		assert.equal(redacted.includes("C:\\Users\\Alice\\secret"), false);
		assert.equal((redacted.match(/\[absolute-path\]/g) ?? []).length, 6);
	});

	it("redacts spaced, Unicode, UNC, punctuation-delimited, and multiple paths", () => {
		const value = "note;/home/Alice Smith/秘密/file.txt; C:\\Users\\Alice Smith\\秘密\\secret.txt and \\\\server\\share\\Alice\\secret; /tmp/one /var/二";
		const redacted = redactAbsolutePaths(value);
		assert.equal(redacted.includes("Alice Smith"), false);
		assert.equal(redacted.includes("秘密"), false);
		assert.equal(redacted.includes("\\\\server\\share"), false);
		assert.equal((redacted.match(/\[absolute-path\]/g) ?? []).length, 5);
		assert.ok(redacted.includes("note;"));
	});

	it("redacts a spaced final basename without consuming prose boundaries", () => {
		assert.equal(redactAbsolutePaths("/tmp/foo bar"), "[absolute-path]");
		assert.equal(redactAbsolutePaths("/tmp/private crashed yesterday"), "[absolute-path] crashed yesterday");
		assert.equal(redactAbsolutePaths("Use /api/v1 endpoint for requests"), "Use /api/v1 endpoint for requests");
	});

	it("preserves sentence suffixes and route-like prose", () => {
		assert.equal(redactAbsolutePaths("/home/alice/project completed successfully"), "[absolute-path] completed successfully");
		assert.equal(redactAbsolutePaths(String.raw`C:\\Users\\Alice\\file.txt could not be opened`), "[absolute-path] could not be opened");
		assert.equal(redactAbsolutePaths("/tmp/private crashed yesterday"), "[absolute-path] crashed yesterday");
		assert.equal(
			redactAbsolutePaths(String.raw`UNC \\server\share\Alice Smith\秘密.txt. next step`),
			"UNC [absolute-path]. next step",
		);
		assert.equal(redactAbsolutePaths("Use /api/v1 endpoint for requests"), "Use /api/v1 endpoint for requests");
	});

	it("keeps adjacent paths and route-like prose segmented", () => {
		assert.equal(
			redactAbsolutePaths("/tmp/one /var/two completed at /api/v1; see /home/Alice Smith/file.txt"),
			"[absolute-path] [absolute-path] completed at /api/v1; see [absolute-path]",
		);
	});

	it("removes only recovered export diagnostics and preserves execution errors", () => {
		const path = "/tmp/recovery-root";
		const original = `provider failed\nIsolated Git bundle export failed; recover worktree at ${path}: retryable packaging error`;
		assert.deepEqual(stripIsolatedGitExportDiagnostics(original), {
			error: "provider failed",
			onlyDiagnostics: false,
		});
		assert.deepEqual(stripIsolatedGitExportDiagnostics(`Isolated Git bundle export failed; recover isolated worktree at ${path}: retryable packaging error`), {
			onlyDiagnostics: true,
		});
		assert.deepEqual(stripIsolatedGitExportDiagnostics("provider failed"), {
			error: "provider failed",
			onlyDiagnostics: false,
		});
	});

	it("advances past root-only POSIX, drive, and UNC candidates", () => {
		const subject = "roots: /home/|/tmp/|C:/|\\\\server\\";
		assert.equal(redactAbsolutePaths(subject), "roots: [absolute-path]|[absolute-path]|[absolute-path]|[absolute-path]");
	});

	it("leaves ordinary prose and non-path commit punctuation intact", () => {
		const subject = "fix issue #59 / docs, preserve foo:bar and C: drive notation";
		assert.equal(redactAbsolutePaths(subject), subject);
	});
});
