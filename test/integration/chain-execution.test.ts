/**
 * Integration tests for chain execution (sequential and parallel steps).
 *
 * Uses the local createMockPi() harness to simulate subagent processes.
 * Tests the full chain pipeline: template resolution → spawn → output capture
 * → {previous} passing.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgent,
	makeMinimalCtx,
	tryImport,
	events,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT } from "../../src/shared/types.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

interface TestSequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

interface TestParallelTask {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

type TestChainStep = TestSequentialStep | {
	parallel: TestParallelTask[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
} | {
	expand: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems?: number;
		onEmpty?: "skip" | "fail";
	};
	parallel: TestParallelTask;
	collect: { as: string; outputSchema?: Record<string, unknown> };
	concurrency?: number;
	failFast?: boolean;
	label?: string;
	acceptance?: unknown;
};

interface ChainResultItem {
	agent: string;
	exitCode: number;
	finalOutput?: string;
	structuredOutput?: unknown;
	task?: string;
	detached?: boolean;
	attemptedModels?: string[];
	skills?: string[];
	acceptance?: { status?: string; verifyRuns?: Array<{ status?: string }>; childReport?: unknown; runtimeChecks?: Array<{ status?: string; id?: string }> };
	savedOutputPath?: string;
	gitBundle?: { path: string; checksum: string; base: string; head: string; commitSummary: string };
	success?: boolean;
	exitCode?: number;
	status?: string;
	progress?: { status?: string };
	progressSummary?: { durationMs?: number };
}

interface ChainExecutionResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	details: {
		results: ChainResultItem[];
		chainAgents?: string[];
		totalSteps?: number;
		workflowGraph?: {
			nodes: Array<{ kind?: string; outputName?: string; status?: string; error?: string; acceptanceStatus?: string; children?: Array<{ itemKey?: string; label?: string; status?: string; acceptanceStatus?: string }> }>;
		};
		currentStepIndex?: number;
		outputs?: Record<string, { text: string; structured?: unknown }>;
	};
}

interface ChainExecutionModule {
	executeChain(params: Record<string, unknown>): Promise<ChainExecutionResult>;
}

interface ExecutorModule {
	createSubagentExecutor?: (deps: Record<string, unknown>) => {
		state: { foregroundRuns: Map<string, { children: ChainResultItem[] }> };
		execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ChainExecutionResult>;
	};
}

const chainMod = await tryImport<ChainExecutionModule>("./src/runs/foreground/chain-execution.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!chainMod;
const executeChain = chainMod?.executeChain;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function removeNewIsolatedRoots(before: Set<string>): void {
	const processes = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout.split("\n");
	for (const entry of fs.readdirSync(os.tmpdir())) {
		if (!entry.startsWith("pi-isolated-git-") || before.has(entry)) continue;
		const root = path.join(os.tmpdir(), entry);
		// Integration files run concurrently in the same host. Never let this
		// file's broad fallback cleanup remove a sibling test's live runtime.
		if (processes.some((line) => line.includes(root))) continue;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;
	let mockPi: MockPi;
	let isolatedRootsBefore: Set<string>;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		artifactsDir = path.join(tempDir, "artifacts");
		isolatedRootsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-")));
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
		removeNewIsolatedRoots(isolatedRootsBefore);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			sandbox: { provider: "none" },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function installFakeBwrap(): { recordDir: string; restore: () => void } {
		const rootDir = fs.mkdtempSync(path.join(tempDir, "fake-bwrap-"));
		const binDir = path.join(rootDir, "bin");
		const recordDir = path.join(rootDir, "records");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(recordDir, { recursive: true });
		const scriptPath = path.join(binDir, "fake-bwrap.mjs");
		fs.writeFileSync(scriptPath, `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const recordDir = process.env.FAKE_BWRAP_RECORD_DIR;
if (!recordDir) process.exit(97);
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(path.join(recordDir, \`call-\${Date.now()}-\${process.pid}.json\`), JSON.stringify({ args, cwd: process.cwd() }), "utf-8");
const separator = args.indexOf("--");
if (separator === -1 || !args[separator + 1]) process.exit(98);
const child = spawnSync(args[separator + 1], args.slice(separator + 2), { stdio: "inherit", env: process.env, cwd: process.cwd() });
if (child.error) process.exit(99);
process.exit(child.status ?? 0);
`, "utf-8");
		const bwrapPath = path.join(binDir, "bwrap");
		fs.writeFileSync(bwrapPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf-8");
		fs.chmodSync(bwrapPath, 0o755);
		const previousPath = process.env.PATH;
		const previousRecordDir = process.env.FAKE_BWRAP_RECORD_DIR;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.FAKE_BWRAP_RECORD_DIR = recordDir;
		return {
			recordDir,
			restore() {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousRecordDir === undefined) delete process.env.FAKE_BWRAP_RECORD_DIR;
				else process.env.FAKE_BWRAP_RECORD_DIR = previousRecordDir;
			},
		};
	}

	function readLastFakeBwrapArgs(recordDir: string): string[] {
		const callFile = fs.readdirSync(recordDir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).sort().at(-1);
		assert.ok(callFile, "expected a recorded fake bwrap call");
		const payload = JSON.parse(fs.readFileSync(path.join(recordDir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded bwrap args");
		return payload.args;
	}

	function assertBind(args: string[], source: string): void {
		assert.deepEqual(args.slice(args.indexOf(source) - 1, args.indexOf(source) + 2), ["--bind", source, source]);
	}

	function acceptanceReport(overrides: Record<string, unknown> = {}): string {
		return [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
				...overrides,
			}),
			"```",
		].join("\n");
	}

	function writePackageSkill(packageRoot: string, skillName: string): void {
		const skillDir = path.join(packageRoot, "skills", skillName);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
			"utf-8",
		);
	}

	it("runs a 2-step chain", async () => {
		mockPi.onCall({ output: "Analysis complete: found 3 issues" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
	});

	it("keeps omitted chain output inline without a repo-local report", async () => {
		mockPi.onCall({ output: "inline chain output" });
		const agents = [makeAgent("analyst")];
		const result = await executeChain(
			makeChainParams([{ agent: "analyst", task: "Analyze" }], agents, { chainDir: tempDir }),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0]?.finalOutput, "inline chain output");
		assert.equal(result.details.results[0]?.savedOutputPath, undefined);
		assert.equal(fs.existsSync(path.join(tempDir, "tmp")), false);
	});

	it("passes file-only saved-output references through {previous}", async () => {
		mockPi.onCall({ output: "full chain output\nwith details" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "analyst", task: "Analyze", output: "analysis.md", outputMode: "file-only" },
					{ agent: "reporter" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.match(result.details.results[0]?.finalOutput ?? "", /\/tmp\//);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full chain output/);
		const secondTaskArg = readCallArgs(1).at(-1) ?? "";
		assert.match(secondTaskArg, /Output saved to:/);
		assert.match(secondTaskArg, /\/tmp\//);
		assert.doesNotMatch(secondTaskArg, /full chain output/);
	});

	it("auto-saves read-only file-only chain steps without explicit output paths", async () => {
		mockPi.onCall({ output: "review output\nwith evidence" });
		const agents = [makeAgent("reviewer", { tools: ["read", "bash"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "reviewer", task: "Review", outputMode: "file-only" }],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.match(result.details.results[0]?.savedOutputPath ?? "", /\/tmp\//);
		assert.match(fs.readFileSync(result.details.results[0]!.savedOutputPath!, "utf-8"), /# Saved subagent output/);
	});

	it("keeps explicit chain output files while also saving per-run history in tmp", async () => {
		mockPi.onCall({ output: "# Analysis\n\nSaved body" });
		const agents = [makeAgent("analyst", { tools: ["read"], output: "analysis.md" })];

		const params = makeChainParams(
			[{ agent: "analyst", task: "Analyze", output: "analysis.md" }],
			agents,
			{ chainDir: tempDir },
		);
		const result = await executeChain(params);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const explicitOutputPath = path.join(tempDir, String(params.runId), "analysis.md");
		assert.equal(fs.readFileSync(explicitOutputPath, "utf-8"), "# Analysis\n\nSaved body");
		assert.ok(result.details.results[0]?.savedOutputPath);
		assert.notEqual(result.details.results[0]?.savedOutputPath, explicitOutputPath);
		assert.match(result.details.results[0]?.savedOutputPath ?? "", /\/tmp\//);
	});

	it("persists explicit checked acceptance and rejects missing evidence", async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", output: "accepted.md", outputMode: "file-only", acceptance: { criteria: ["Patch bug"] } }],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.equal(result.details.results[0]?.acceptance?.status, "checked");
		assert.ok(result.details.results[0]?.acceptance?.childReport);
		assert.equal(result.details.results[0]?.acceptance?.finalization?.status, "completed");
		assert.ok(result.details.results[0]?.acceptance?.initialChildReport);
		assert.equal(mockPi.callCount(), 2);
		assert.match(readCallArgs(1).at(-1) ?? "", /## Acceptance Finalization/);

		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: [],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					residualRisks: [],
					noStagedFiles: true,
				}),
				"```",
			].join("\n"),
		});

		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { criteria: ["Patch bug"], evidence: ["tests-added"] } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.match(failed.details.results[0]?.error ?? "", /tests-added evidence missing/);
	});

	it("runs explicit verified acceptance commands and does not trust child command claims as verification", async () => {
		const acceptanceReport = [
			"implemented",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "child claimed pass" }],
				validationOutput: ["child output"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		const verifyLog = path.join(tempDir, "verify-count.txt");
		const verifyCommand = `node -e 'require("node:fs").appendFileSync(${JSON.stringify(verifyLog)}, "x")'`;
		mockPi.onCall({ output: acceptanceReport });
		mockPi.onCall({ output: acceptanceReport });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { criteria: ["Patch bug"], verify: [{ id: "runtime-pass", command: verifyCommand }] } }],
				agents,
			),
		);
		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "passed");
		assert.equal(fs.readFileSync(verifyLog, "utf-8"), "x");
		assert.equal(mockPi.callCount(), 2);

		mockPi.onCall({ output: acceptanceReport });
		mockPi.onCall({ output: acceptanceReport });
		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { criteria: ["Patch bug"], verify: [{ id: "runtime-fail", command: "node -e \"process.exit(5)\"" }] } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(failed.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "failed");
		assert.match(failed.details.results[0]?.error ?? "", /runtime-fail/);
	});

	it("retries chain steps with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "provider unavailable",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step 1 recovered" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [
			makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("step2"),
		];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("prefers the parent session provider for ambiguous bare chain step models", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("Step 1 ran", "github-copilot/gpt-5-mini")] });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { model: "gpt-5-mini" }), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot" },
						modelRegistry: {
							getAvailable: () => [
								{ provider: "openai", id: "gpt-5-mini" },
								{ provider: "github-copilot", id: "gpt-5-mini" },
							],
						},
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("suppresses progress for {task} chain templates when the top-level task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer" }],
				agents,
				{ task: "Review-only. Do not edit files. Return findings." },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		mockPi.onCall({ output: "Step 1 unique output: MARKER_ABC_123" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

	it("updates foregroundControl currentModel from runtime child result during live chain step", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "package.json" }),
				events.assistantMessage("step 1 output", "runtime/claude-sonnet"),
			],
		});
		const agents = [makeAgent("step1", { model: "configured/claude-sonnet" })];
		const foregroundControl = {
			runId: "test-chain-model",
			mode: "chain" as const,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			currentAgent: undefined as string | undefined,
			currentIndex: undefined as number | undefined,
			currentActivityState: undefined as string | undefined,
		};
		const liveModels: (string | undefined)[] = [];

		await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }],
				agents,
				{
					foregroundControl,
					runId: "test-chain-model",
					onUpdate: () => {
						liveModels.push(foregroundControl.currentModel);
					},
				},
			),
		);

		assert.ok(liveModels.includes("configured/claude-sonnet"), "foregroundControl should start with the configured fallback model");
		assert.ok(liveModels.includes("runtime/claude-sonnet"), "live updates should replace the configured fallback with the runtime model");
		assert.equal(foregroundControl.currentModel, "runtime/claude-sonnet");
	});

	it("passes named sequential outputs through {outputs.name}", async () => {
		mockPi.onCall({ output: "Context marker: CTX_123" });
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("context"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "context", task: "Gather context", as: "contextOutput" },
					{ agent: "writer", task: "Use {outputs.contextOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.match(readCallArgs(1).at(-1) ?? "", /CTX_123/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.outputName, "contextOutput");
	});

	it("expands structured named output into dynamic parallel children and collects results", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "synthesized" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: {
							agent: "reviewer",
							task: "Review {target.path}",
							label: "Review {target.path}",
							outputSchema: { type: "object" },
						},
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readCallArgs(1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readCallArgs(2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readCallArgs(3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = result.details.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.kind, "dynamic-parallel-group");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("persists checked acceptance status for dynamic fanout materialized children", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }), structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }) });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }), structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }) });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" }, acceptance: { criteria: ["Review item"] } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, undefined);
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["checked", "checked"]);
	});

	it("rejects group-level acceptance on dynamic fanout steps", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }] },
		});
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						acceptance: { criteria: ["Aggregate child reviews"] },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support group-level acceptance/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not expose collected dynamic output when a child fails", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ exitCode: 1, stderr: "review-b failed" });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 3);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.results.some((entry) => entry.exitCode === 1), true);
	});

	it("fails dynamic fanout before spawning children for invalid source arrays", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "a" }, { path: "b" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 1 },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /exceeding maxItems 1/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /exceeding maxItems 1/);
	});

	it("auto-saves dynamic file-only fanout results without explicit output paths", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "reviewed src/a.ts" });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputMode: "file-only" },
						collect: { as: "reviews" },
					},
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "completed");
		assert.match(result.details.results[1]?.savedOutputPath ?? "", /\/tmp\//);
	});

	it("marks empty dynamic fanout skip as a completed graph group", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [] } });
		mockPi.onCall({ output: "used empty reviews" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.outputs?.reviews?.structured, []);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "completed");
		assert.deepEqual(result.details.workflowGraph?.nodes[1]?.children, []);
		assert.deepEqual(result.details.groupDiagnostics, [{ groupId: "dynamic-group-1", unindexed: true, agent: "reviewer", status: "complete" }]);
		assert.equal(result.details.results.some((child) => child.groupId === "dynamic-group-1"), false);
	});

	it("marks dynamic collect schema failures as failed graph groups", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews", outputSchema: { type: "object" } },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Collected output validation failed/);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /Collected output validation failed/);
		assert.equal(result.details.workflowGraph?.nodes[1]?.children?.[0]?.status, "completed");
	});

	it("keeps materialized dynamic children in live graph updates for later sequential steps", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("writer started")] }] });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];
		let writerUpdateChildren: Array<{ itemKey?: string; status?: string }> | undefined;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
				{
					onUpdate(update: { details?: ChainExecutionResult["details"] }) {
						if (update.details?.currentStepIndex !== 2) return;
						writerUpdateChildren = update.details.workflowGraph?.nodes[1]?.children;
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(writerUpdateChildren?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("fails duplicate and unknown named outputs before spawning children", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];

		const duplicate = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "A", as: "same" }, { agent: "b", task: "B", as: "same" }],
				agents,
			),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /Duplicate chain output name 'same'/);
		assert.equal(mockPi.callCount(), 0);

		const unknown = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.missing}" }],
				agents,
			),
		);
		assert.equal(unknown.isError, true);
		assert.match(unknown.content[0]?.text ?? "", /Unknown chain output reference/);
		assert.equal(mockPi.callCount(), 0);

		const malformed = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.bad-name}" }],
				agents,
			),
		);
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("requires schema-valid structured_output when outputSchema is set", async () => {
		const schema = {
			type: "object",
			required: ["ok"],
			properties: { ok: { type: "boolean" }, note: { type: "string" } },
		};
		mockPi.onCall({ output: "prose", structuredOutput: { ok: true, note: "captured" } });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.results[0]?.structuredOutput, { ok: true, note: "captured" });

		mockPi.reset();
		mockPi.onCall({ output: "prose only" });
		const missing = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.details.results[0]?.error ?? "", /Missing structured_output call/);

		mockPi.reset();
		mockPi.onCall({ output: "invalid", structuredOutput: { ok: "yes" } });
		const invalid = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema, phase: "Validate", label: "Structured worker", as: "result" }], agents),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.details.results[0]?.error ?? "", /Structured output validation failed/);
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.status, "failed");
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.outputName, "result");
		assert.match(invalid.details.workflowGraph?.nodes[0]?.error ?? "", /Structured output validation failed/);
	});

	it("substitutes {task} in templates", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Agent crashed" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("runs a 3-step chain end-to-end", async () => {
		mockPi.onCall({ output: "Step output" });
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("resolves relative step cwd values against the chain cwd for skills", async () => {
		mockPi.onCall({ output: "ok" });
		const chainCwd = path.join(tempDir, "worktree");
		const stepPackageDir = path.join(chainCwd, "packages", "app");
		writePackageSkill(stepPackageDir, "chain-step-skill");
		const agents = [makeAgent("analyst", { skills: ["chain-step-skill"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze", cwd: "packages/app" }],
				agents,
				{ cwd: chainCwd },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0]?.skills, ["chain-step-skill"]);
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("sandboxed foreground chain mounts custom chain progress and session paths", async () => {
		mockPi.onCall({ output: "Sandboxed chain done" });
		const fakeBwrap = installFakeBwrap();
		try {
			const agents = [makeAgent("worker")];
			const chainDir = path.join(tempDir, "custom-chain-dir");
			const sessionRoot = path.join(tempDir, "chain-sessions");

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Track progress", progress: true }],
					agents,
					{
						chainDir,
						sessionDirForIndex: (index = 0) => path.join(sessionRoot, `run-${index}`),
						sandbox: { provider: "bubblewrap" },
					},
				),
			);

			assert.equal(result.isError, undefined);
			const bwrapArgs = readLastFakeBwrapArgs(fakeBwrap.recordDir);
			const mountedChainDir = bwrapArgs.find((arg) => arg.startsWith(`${chainDir}${path.sep}`));
			assert.ok(mountedChainDir, "expected custom chain run dir to be mounted for progress writes");
			assertBind(bwrapArgs, mountedChainDir);
			assertBind(bwrapArgs, path.join(sessionRoot, "run-0"));
		} finally {
			fakeBwrap.restore();
		}
	});

	it("uses agent-level sandbox bashWrite for foreground parallel chain guard and preserves run-level overrides", async () => {
		const fakeBwrap = installFakeBwrap();
		try {
			const agents = [makeAgent("shell", { tools: ["bash"], sandbox: { bashWrite: true } })];

			const rejected = await executeChain(
				makeChainParams(
					[{ parallel: [{ agent: "shell", task: "Shell write" }] }],
					agents,
					{ sandbox: { provider: "bubblewrap" } },
				),
			);
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0]?.text ?? "", /require worktree: true/);

			mockPi.onCall({ output: "read-only shell" });
			const allowed = await executeChain(
				makeChainParams(
					[{ parallel: [{ agent: "shell", task: "Inspect" }] }],
					agents,
					{ sandbox: { provider: "bubblewrap", bashWrite: false } },
				),
			);
			assert.equal(allowed.isError, undefined);
			const bwrapArgs = readLastFakeBwrapArgs(fakeBwrap.recordDir);
			assert.ok(bwrapArgs.some((arg, index) => arg === "--ro-bind" && bwrapArgs[index + 1] === tempDir && bwrapArgs[index + 2] === tempDir));
		} finally {
			fakeBwrap.restore();
		}
	});

	it("rejects sandboxed writable dynamic fanout because dynamic worktree isolation is unsupported", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		const fakeBwrap = installFakeBwrap();
		try {
			const agents = [makeAgent("producer", { tools: ["read", "bash"] }), makeAgent("writer", { tools: ["write"] })];

			const result = await executeChain(
				makeChainParams(
					[
						{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
						{
							expand: { from: { output: "targets", path: "/items" }, item: "file", key: "/path", maxItems: 4 },
							parallel: { agent: "writer", task: "Edit {file.path}" },
							collect: { as: "reviews" },
						},
					],
					agents,
					{ sandbox: { provider: "bubblewrap" } },
				),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /dynamic fanout does not support worktree: true/i);
			assert.equal(mockPi.callCount(), 1);
		} finally {
			fakeBwrap.restore();
		}
	});

	it("uses custom chainDir when provided", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});

	it("tightens child recursion depth per agent without relaxing the inherited chain max", async () => {
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		const originalMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
			const agents = [makeAgent("worker", { maxSubagentDepth: 1 })];

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Inspect env" }],
					agents,
					{ maxSubagentDepth: 3 },
				),
			);

			assert.ok(!result.isError);
			assert.deepEqual(JSON.parse(result.details.results[0].finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
			if (originalMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = originalMaxDepth;
		}
	});
});

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	let isolatedRootsBefore: Set<string>;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		isolatedRootsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-isolated-git-")));
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
		removeNewIsolatedRoots(isolatedRootsBefore);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			sandbox: { provider: "none" },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs parallel tasks within a chain step", async () => {
		mockPi.onCall({ output: "Parallel task done" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("shares one isolated Git base across a real foreground chain and cleans every writable layer", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "isolated-chain-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.email", "chain@example.invalid"], ["config", "user.name", "Chain Parent"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n", "utf-8");
		fs.mkdirSync(path.join(repoDir, "packages", "app"), { recursive: true });
		fs.writeFileSync(path.join(repoDir, "packages", "app", "seed.txt"), "seed\n", "utf-8");
		for (const args of [["add", "base.txt", "packages/app/seed.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const base = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
		const runId = "isolated-chain-cleanup";
		const runtimePrefix = `pi-isolated-git-${runId}-isolated-`;
		const runtimeRootsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix)));
		const agents = [makeAgent("isolated-a", { tools: ["read", "bash"] }), makeAgent("isolated-b", { tools: ["read", "bash"] })];
		const commitCommand = "printf 'child\\n' > child.txt && git add child.txt && git commit -m 'isolated chain child'";
		mockPi.onCall({ output: "isolated chain A", commands: [commitCommand] });
		mockPi.onCall({ output: "isolated chain B", commands: [commitCommand] });
		const result = await executeChain(
			makeChainParams(
				[{ parallel: [{ agent: "isolated-a", task: "Commit A", cwd: "packages/app" }, { agent: "isolated-b", task: "Commit B", cwd: "packages/app" }] }],
				agents,
				{
					cwd: repoDir,
					ctx: makeMinimalCtx(repoDir),
					runId,
					sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] },
				},
			),
		);
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.results.length, 2);
		const bundles = result.details.results.map((child) => child.gitBundle);
		assert.equal(bundles.every((bundle) => bundle?.base === base && fs.existsSync(bundle.path)), true);
		assert.notEqual(bundles[0]?.path, bundles[1]?.path);
		assert.equal(spawnSync("git", ["-C", repoDir, "status", "--porcelain=v1"], { encoding: "utf-8" }).stdout, "");
		const leakedRuntimeRoots = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix) && !runtimeRootsBefore.has(entry));
		assert.deepEqual(leakedRuntimeRoots, [], "foreground chain must remove its private isolated Git runtime root");
	});

	it("fences production isolated chain export until a nested child reaches terminal state", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "isolated-nested-fence-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.email", "chain@example.invalid"], ["config", "user.name", "Chain Parent"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n", "utf-8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const runId = "isolated-nested-fence";
		const route = createNestedRoute(runId);
		const startedAt = Date.now();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: startedAt,
			parentRunId: runId,
			parentStepIndex: 0,
			child: { id: "nested-child", parentRunId: runId, parentStepIndex: 0, depth: 1, path: [{ runId, stepIndex: 0 }], state: "running", agent: "reviewer", startedAt, lastUpdate: startedAt },
		});
		const terminalTimer = setTimeout(() => writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: Date.now(),
			parentRunId: runId,
			parentStepIndex: 0,
			child: { id: "nested-child", parentRunId: runId, parentStepIndex: 0, depth: 1, path: [{ runId, stepIndex: 0 }], state: "complete", agent: "reviewer", startedAt, lastUpdate: Date.now() },
		}), 100);
		try {
			mockPi.onCall({ output: "isolated nested fence complete", commands: ["printf 'child\\n' > child.txt && git add child.txt && git commit -m 'nested fence child'"] });
			const started = Date.now();
			const result = await executeChain(
				makeChainParams(
					[{ parallel: [{ agent: "worker", task: "Commit after nested child" }] }],
					[makeAgent("worker", { tools: ["read", "bash"] })],
					{ cwd: repoDir, ctx: makeMinimalCtx(repoDir), runId, nestedRoute: route, sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] } },
				),
			);
			assert.equal(result.isError, undefined, result.content[0]?.text);
			assert.ok(result.details.results[0]?.gitBundle?.path);
			assert.ok(Date.now() - started >= 75, `export should wait for nested terminal proof (started ${Date.now() - started}ms)`);
		} finally {
			clearTimeout(terminalTimer);
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("derives isolated parallel commit requirements from resolved read-only task text", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "isolated-read-only-policy-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.email", "chain@example.invalid"], ["config", "user.name", "Chain Parent"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n", "utf-8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		mockPi.onCall({ output: "review complete" });
		const result = await executeChain(
			makeChainParams(
				[{ parallel: [{ agent: "reviewer", task: "{task}" }] }],
				[makeAgent("reviewer", { tools: ["read", "write"] })],
				{
					task: "Review-only. Do not edit files. Return findings.",
					cwd: repoDir,
					ctx: makeMinimalCtx(repoDir),
					runId: "isolated-read-only-policy",
					sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] },
				},
			),
		);
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.results.length, 1);
		assert.equal(result.details.results[0]?.gitBundle?.incomplete, false);
		assert.equal(result.details.results[0]?.error, undefined);
	});

	it("caller-level export failure preserves original error and actionable root", { skip: process.platform !== "linux" || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap is required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "chain-export-failure-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.email", "chain@example.invalid"], ["config", "user.name", "Chain Parent"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const blockedArtifacts = path.join(tempDir, "artifacts-file");
		fs.writeFileSync(blockedArtifacts, "not a directory", "utf8");
		mockPi.onCall({ output: "chain execution output", stderr: "original chain execution error", exitCode: 1, commands: ["printf 'chain\n' > chain.txt && git add chain.txt && git commit -m 'chain export failure'" ] });
		const result = await executeChain!(makeChainParams(
			[{ agent: "worker", task: "Commit the chain change" }],
			[makeAgent("worker", { tools: ["read", "bash"] })],
			{
				ctx: makeMinimalCtx(repoDir),
				runId: "chain-export-failure-visible",
				artifactsDir: blockedArtifacts,
				sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] },
			},
		));
		assert.equal(result.isError, true, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /original chain execution error/i);
		assert.match(result.content[0]?.text ?? "", /bundle export failed/i);
		assert.match(result.content[0]?.text ?? "", /recover (?:isolated )?worktrees? at/i);
	});

	it("unexpected chain export failure is visible without intercom", { skip: process.platform !== "linux" || !createSubagentExecutor || spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status !== 0 ? "Linux Bubblewrap and public executor are required" : undefined }, async () => {
		const repoDir = path.join(tempDir, "public-chain-export-failure-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init", "--initial-branch=main"], ["config", "user.email", "chain@example.invalid"], ["config", "user.name", "Chain Parent"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n", "utf8");
		for (const args of [["add", "base.txt"], ["commit", "-m", "base"]]) {
			const setup = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
			assert.equal(setup.status, 0, setup.stderr);
		}
		const parentSessionFile = path.join(tempDir, "parent-session.jsonl");
		mockPi.onCall({ output: "chain execution output", stderr: "original chain execution error", exitCode: 1, commands: ["printf 'chain\\n' > chain.txt && git add chain.txt && git commit -m 'chain export failure'"] });
		const agents = [makeAgent("worker", { tools: ["read", "bash"] })];
		const state = { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null };
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { intercomBridge: { mode: "off" } },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
		const ctx = { ...makeMinimalCtx(repoDir), sessionManager: { getSessionId: () => "session-123", getSessionFile: () => parentSessionFile } };
		let blockedArtifacts = false;
		const result = await executor.execute("public-chain-export-failure", {
			chain: [{ agent: "worker", task: "Commit the chain change" }],
			cwd: repoDir,
			clarify: false,
			sandbox: { provider: "bubblewrap", gitMode: "isolated", extraWritableMounts: [mockPi.dir] },
		}, new AbortController().signal, (update: any) => {
			const outputPath = update.details?.results?.[0]?.artifactPaths?.outputPath;
			if (blockedArtifacts || typeof outputPath !== "string") return;
			blockedArtifacts = true;
			const artifactsDir = path.dirname(outputPath);
			fs.rmSync(artifactsDir, { recursive: true, force: true });
			fs.writeFileSync(artifactsDir, "not a directory", "utf8");
		}, ctx);
		assert.equal(result.isError, true, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /original chain execution error|Chain execution rejected/i);
		assert.match(result.content[0]?.text ?? "", /bundle export failed/i);
		assert.match(result.content[0]?.text ?? "", /recover (?:isolated )?worktrees? at/i);
		assert.equal(result.details.results.length, 1, "public result must retain the rejected chain child");
		assert.match(result.details.results[0]?.error ?? "", /bundle export failed|recover/i);
		assert.equal(result.details.results[0]?.success, false, "recovery refusal must not leave a successful child projection");
		assert.notEqual(result.details.results[0]?.exitCode, 0, "recovery refusal must be nonzero");
		const persisted = [...state.foregroundRuns.values()].at(-1);
		assert.equal(persisted?.children.length, 1);
		assert.match(persisted?.children[0]?.error ?? "", /bundle export failed|recover/i);
		assert.equal(persisted?.children[0]?.status, "failed", "durable foreground observer must retain failed status");
		assert.notEqual(persisted?.children[0]?.exitCode, 0);
	});

	it("preserves chain worktrees after a post-child artifact rejection", async () => {
		const repoDir = path.join(tempDir, "rejected-chain-repo");
		fs.mkdirSync(repoDir, { recursive: true });
		for (const args of [["init"], ["config", "user.email", "tests@example.com"], ["config", "user.name", "Chain Tests"]]) {
			const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(result.status, 0, result.stderr);
		}
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
		for (const args of [["add", "-A"], ["commit", "-m", "initial"]]) {
			const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const runId = "chain-artifact-rejection";
		const artifactsDir = path.join(repoDir, "artifacts");
		fs.mkdirSync(path.join(artifactsDir, `${runId}_worker_0_output.md`), { recursive: true });
		mockPi.onCall({
			output: "Chain worker edited before artifact failure",
			writeFiles: [{ path: "chain-rejected.txt", content: "recover chain edit\n" }],
		});
		let preservedWorktree: string | undefined;
		try {
			const result = await executeChain!(makeChainParams(
				[{ parallel: [{ agent: "worker", task: "Write then fail artifact persistence" }], worktree: true }],
				[makeAgent("worker")],
				{
					runId,
					ctx: makeMinimalCtx(repoDir),
					artifactsDir,
					artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeMetadata: false },
				},
			));
			const text = result.content[0]?.text ?? "";
			assert.equal(result.isError, true);
			assert.match(text, /failed unexpectedly/i);
			assert.match(text, /Full patches:/);
			assert.match(text, /Recoverable worktree path/i);
			const listing = spawnSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
			preservedWorktree = [...listing.stdout.matchAll(/^worktree (.+)$/gm)]
				.map((match) => match[1])
				.find((candidate) => candidate && path.resolve(candidate) !== path.resolve(repoDir));
			assert.ok(preservedWorktree, "post-child rejection must preserve the edited worktree");
			assert.equal(fs.readFileSync(path.join(preservedWorktree!, "chain-rejected.txt"), "utf-8"), "recover chain edit\n");
		} finally {
			if (preservedWorktree) spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", preservedWorktree], { encoding: "utf-8" });
		}
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		mockPi.onCall({ output: "Review findings here" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("passes completed parallel task outputs to later {outputs.name} references", async () => {
		mockPi.onCall({ output: "Alpha named output" });
		mockPi.onCall({ output: "Beta named output" });
		mockPi.onCall({ output: "Final" });
		const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "alpha", task: "Alpha", as: "alphaOutput" },
							{ agent: "beta", task: "Beta", as: "betaOutput" },
						],
					},
					{ agent: "writer", task: "Use {outputs.alphaOutput} and {outputs.betaOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		const finalTask = readCallArgs(2).at(-1) ?? "";
		assert.match(finalTask, /Alpha named output/);
		assert.match(finalTask, /Beta named output/);
	});

	it("aggregates file-only parallel outputs as file references for the next step", async () => {
		mockPi.onCall({ output: "full parallel chain output\nwith details" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review A", output: "a.md", outputMode: "file-only" },
							{ agent: "reviewer-b", task: "Review B", output: "b.md", outputMode: "file-only" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full parallel chain output/);
		assert.doesNotMatch(result.details.results[1]?.finalOutput ?? "", /full parallel chain output/);
		const synthTaskArg = readCallArgs(2).at(-1) ?? "";
		assert.match(synthTaskArg, /Output saved to:/);
		assert.match(synthTaskArg, /\/tmp\//);
		assert.doesNotMatch(synthTaskArg, /full parallel chain output/);
	});

	it("auto-saves chain parallel file-only output without spawning validation errors", async () => {
		mockPi.onCall({ output: "Review A output" });
		mockPi.onCall({ output: "Review B output" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review A", outputMode: "file-only" },
						{ agent: "reviewer-b", task: "Review B", output: "b.md" },
					],
				}],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.match(result.details.results[0]?.savedOutputPath ?? "", /\/tmp\//);
	});

	it("detaches parallel chain children cleanly on intercom handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ output: "Other task done" });
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }),
		];
		const intercomEvents = createEventBus();
		const terminalIntercomPayloads: Array<{ children?: Array<{ agent?: string; status?: string; index?: number; gitBundle?: unknown; children?: unknown[] }> }> = [];
		intercomEvents.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload: any) => {
			if (payload?.to !== "orchestrator") return;
			terminalIntercomPayloads.push(payload);
			intercomEvents.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: payload.requestId, delivered: true });
		});
		let detachEmitted = false;
		let terminalResolve!: (update: { details?: { results?: ChainResultItem[] } }) => void;
		const terminalUpdate = new Promise<{ details?: { results?: ChainResultItem[] } }>((resolve) => { terminalResolve = resolve; });

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Send handoff" },
							{ agent: "b", task: "Keep working" },
						],
					},
				],
				agents,
				{
					runId: "detached-chain-observer",
					intercomEvents,
					orchestratorIntercomTarget: "orchestrator",
					foregroundControl: {
						updatedAt: Date.now(),
						nestedChildren: [{ id: "nested-observer", parentRunId: "detached-chain-observer", parentStepIndex: 0, depth: 1, path: [{ runId: "detached-chain-observer", stepIndex: 0 }], state: "complete", agent: "nested" }],
					},
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }>; results?: ChainResultItem[] } }) {
						if (update.details?.results?.some((entry) => entry.detached !== true && entry.exitCode === 0 && entry.progressSummary?.durationMs !== undefined && entry.finalOutput === "after handoff")) terminalResolve(update);
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-parallel-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(result.details.results.some((entry) => entry.detached === true && entry.exitCode === 0), true);
		const terminal = await Promise.race([
			terminalUpdate,
			new Promise<{ details?: { results?: ChainResultItem[] } }>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for parallel chain detached terminal projection")), 5_000)),
		]);
		assert.equal(terminal.details?.results?.some((entry) => entry.detached !== true && entry.exitCode === 0 && entry.progressSummary?.durationMs !== undefined && entry.finalOutput === "after handoff"), true, JSON.stringify(terminal.details?.results));
		const fullTerminal = terminalIntercomPayloads.find((payload) => payload.children?.length === 2);
		assert.ok(fullTerminal, "detached terminal intercom publication should include the sibling");
		assert.deepEqual(fullTerminal.children?.map((child) => ({ agent: child.agent, index: child.index, status: child.status })), [
			{ agent: "a", index: 0, status: "completed" },
			{ agent: "b", index: 1, status: "completed" },
		]);
		assert.equal(fullTerminal.children?.[0]?.children?.[0] && (fullTerminal.children[0].children[0] as { id?: string }).id, "nested-observer");
	});

	it("stops a sequential chain when a child detaches for intercom coordination", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b"),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;
		let terminalResolve!: (update: { details?: { results?: ChainResultItem[] } }) => void;
		const terminalUpdate = new Promise<{ details?: { results?: ChainResultItem[] } }>((resolve) => { terminalResolve = resolve; });

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "a", task: "Ask supervisor" },
					{ agent: "b", task: "Must not run yet" },
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }>; results?: ChainResultItem[] } }) {
						if (update.details?.results?.some((entry) => entry.detached !== true && entry.exitCode === 0 && entry.progressSummary?.durationMs !== undefined && entry.finalOutput === "after reply")) terminalResolve(update);
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-sequential-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(mockPi.callCount(), 1);
		const terminal = await Promise.race([
			terminalUpdate,
			new Promise<{ details?: { results?: ChainResultItem[] } }>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for sequential chain detached terminal projection")), 5_000)),
		]);
		assert.equal(terminal.details?.results?.some((entry) => entry.detached !== true && entry.exitCode === 0 && entry.progressSummary?.durationMs !== undefined && entry.finalOutput === "after reply"), true, JSON.stringify(terminal.details?.results));
	});

	it("fails chain on parallel step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Parallel task failed" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("rejects worktree parallel steps that set a different task cwd", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];
		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B", cwd: path.join(tempDir, "other") },
						],
						worktree: true,
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should reject conflicting task cwd under worktree");
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(b\) sets cwd/i);
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		mockPi.onCall({ output: "Step complete" });
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4);
		assert.equal(result.details.totalSteps, 3);
	});
});
