import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSavedOutputHeader,
	hasReadOnlyToolset,
	isRelativeOutputTarget,
	resolveSavedOutputDir,
	resolveSavedOutputPath,
	shouldPersistSavedOutput,
	writeSavedOutput,
} from "../../src/shared/output-paths.ts";

let tmpDir: string;

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "output-paths-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isRelativeOutputTarget", () => {
	it("accepts relative string paths only", () => {
		assert.equal(isRelativeOutputTarget("context.md"), true);
		assert.equal(isRelativeOutputTarget("reports/context.md"), true);
		assert.equal(isRelativeOutputTarget(""), false);
		assert.equal(isRelativeOutputTarget(false), false);
		assert.equal(isRelativeOutputTarget(true), false);
		assert.equal(isRelativeOutputTarget(path.join(tmpDir, "abs.md")), false);
	});
});

describe("hasReadOnlyToolset", () => {
	it("treats edit/write as mutating tools", () => {
		assert.equal(hasReadOnlyToolset(["read", "bash"]), true);
		assert.equal(hasReadOnlyToolset(["read", "edit"]), false);
		assert.equal(hasReadOnlyToolset(["read", "write"]), false);
	});
});

describe("shouldPersistSavedOutput", () => {
	it("persists outputs by default", () => {
		assert.equal(shouldPersistSavedOutput({ output: "context.md", tools: ["read"] }), true);
		assert.equal(shouldPersistSavedOutput({ output: undefined, outputMode: "inline", tools: ["read", "bash"] }), true);
		assert.equal(shouldPersistSavedOutput({ output: undefined, outputMode: "file-only", tools: ["read", "edit"] }), true);
	});

	it("lets callers opt out with false", () => {
		assert.equal(shouldPersistSavedOutput({ output: false, tools: ["read"] }), false);
		assert.equal(shouldPersistSavedOutput({ output: "false", tools: ["read"] }), false);
	});
});

describe("resolveSavedOutputDir", () => {
	it("uses cwd/tmp outside git", () => {
		assert.equal(resolveSavedOutputDir(tmpDir), path.join(tmpDir, "tmp"));
	});

	it("uses the git toplevel tmp inside a repository", () => {
		git(tmpDir, "init");
		const nested = path.join(tmpDir, "nested", "work");
		fs.mkdirSync(nested, { recursive: true });
		assert.equal(resolveSavedOutputDir(nested), path.join(tmpDir, "tmp"));
	});
});

describe("resolveSavedOutputPath", () => {
	it("builds agent/run/index markdown paths under tmp", () => {
		const filePath = resolveSavedOutputPath({
			runtimeCwd: tmpDir,
			agent: "reviewer",
			runId: "run-123",
			index: 2,
		});
		assert.equal(filePath, path.join(tmpDir, "tmp", "reviewer-run-123-2.md"));
	});
});

describe("buildSavedOutputHeader", () => {
	it("includes agent, run, index, and savedAt", () => {
		const header = buildSavedOutputHeader({ agent: "reviewer", runId: "run-1", index: 3, savedAt: "2026-01-02T03:04:05.000Z" });
		assert.match(header, /# Saved subagent output/);
		assert.match(header, /agent: `reviewer`/);
		assert.match(header, /runId: `run-1`/);
		assert.match(header, /index: `3`/);
		assert.match(header, /savedAt: `2026-01-02T03:04:05.000Z`/);
	});
});

describe("writeSavedOutput", () => {
	it("writes header plus content", () => {
		const targetPath = path.join(tmpDir, "tmp", "reviewer-run-1.md");
		const result = writeSavedOutput({
			targetPath,
			agent: "reviewer",
			runId: "run-1",
			index: 0,
			content: "## Review\n\nLooks good.\n",
		});
		assert.equal(result.savedPath, targetPath);
		const saved = fs.readFileSync(result.savedPath, "utf-8");
		assert.equal(saved, result.savedContent);
		assert.match(saved, /# Saved subagent output/);
		assert.match(saved, /## Review/);
	});

	it("creates a fresh suffixed file when the target already exists", () => {
		const targetPath = path.join(tmpDir, "tmp", "reviewer-run-1.md");
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.writeFileSync(targetPath, "first", "utf-8");
		const result = writeSavedOutput({
			targetPath,
			agent: "reviewer",
			runId: "run-1",
			content: "second",
		});
		assert.equal(path.basename(result.savedPath), "reviewer-run-1-1.md");
		assert.equal(fs.readFileSync(targetPath, "utf-8"), "first");
	});
});
