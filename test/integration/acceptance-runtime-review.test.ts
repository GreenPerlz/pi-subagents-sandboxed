import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, makeAgent, removeTempDir, tryImport } from "../support/helpers.ts";

const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const asyncExecution = await tryImport<any>("./src/runs/background/async-execution.ts");
const asyncTypes = await tryImport<any>("./src/shared/types.ts");
const piAvailable = Boolean(execution?.runSync);
const asyncAvailable = Boolean(asyncExecution?.executeAsyncSingle && asyncTypes?.RESULTS_DIR);

describe("runtime nested review acceptance evidence", { skip: !piAvailable ? "execution module unavailable" : undefined }, () => {
	let mockPi: MockPi;
	let cwd: string;
	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	beforeEach(() => {
		cwd = createTempDir("pi-runtime-review-");
		mockPi.reset();
	});
	after(() => mockPi.uninstall());

	function acceptanceReport(extra: Record<string, unknown> = {}): string {
		return ["```acceptance-report", JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "nested review" }],
			...extra,
		}), "```"].join("\n");
	}

	async function runReview(output: { finalOutput?: string; artifact?: string }): Promise<any> {
		const artifacts = path.join(cwd, "artifacts");
		const review = output.artifact ? path.join(artifacts, output.artifact) : undefined;
		mockPi.onCall({
			jsonl: [
				{
					type: "tool_result_end",
					message: {
						role: "toolResult",
						toolName: "subagent",
						details: { results: [{ agent: "review", exitCode: 0, ...(review ? { finalOutput: `Output saved to: ${review}`, outputMode: "file-only", artifactPaths: { outputPath: review } } : output.finalOutput ? { finalOutput: output.finalOutput } : {}) }] },
					},
				},
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: acceptanceReport() }], stopReason: "stop" } },
			],
			...(output.artifact ? { writeFiles: [{ path: `artifacts/${output.artifact}`, content: "file-only nested review finding" }] } : {}),
		});
		return execution.runSync(cwd, [makeAgent("worker")], "worker", "Patch the issue", {
			acceptance: { criteria: ["Review evidence"], evidence: ["review-findings"], selfReview: false },
			artifactsDir: artifacts,
			runId: "runtime-review",
		});
	}

	it("accepts inline nested review evidence omitted from final report", async () => {
		const result = await runReview({ finalOutput: "inline nested review finding" });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance?.status, "checked");
		assert.deepEqual(result.acceptance?.childReport?.reviewFindings, ["inline nested review finding"]);
	});

	it("accepts a trusted file-only nested review artifact", async () => {
		const result = await runReview({ artifact: "review.md" });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance?.status, "checked");
		assert.deepEqual(result.acceptance?.childReport?.reviewFindings, ["file-only nested review finding"]);
	});

	it("retains nested review evidence through same-session finalization", async () => {
		mockPi.onCall({ jsonl: [
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "subagent", details: { results: [{ agent: "review", exitCode: 0, finalOutput: "review survives finalization" }] } } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: acceptanceReport() }], stopReason: "stop" } },
		] });
		mockPi.onCall({ output: acceptanceReport({ commandsRun: [{ command: "mock validation", result: "passed", summary: "passed" }] }) });
		const result = await execution.runSync(cwd, [makeAgent("worker")], "worker", "Patch the issue", {
			acceptance: { criteria: ["Review evidence"], evidence: ["review-findings", "commands-run"], selfReview: true, maxFinalizationTurns: 1 },
			runId: "runtime-review-finalization",
			sessionDir: path.join(cwd, "session"),
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance?.status, "checked");
		assert.equal(result.acceptance?.finalization?.status, "completed");
		assert.deepEqual(result.acceptance?.childReport?.reviewFindings, ["review survives finalization"]);
	});

	it("applies the same evidence in the background runner", { skip: !asyncAvailable ? "background runner unavailable" : undefined }, async () => {
		const artifacts = path.join(cwd, "async-artifacts");
		const review = path.join(artifacts, "review.md");
		const id = `runtime-review-${Date.now().toString(36)}`;
		mockPi.onCall({
			jsonl: [
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "subagent", details: { results: [{ agent: "review", exitCode: 0, finalOutput: `Output saved to: ${review}`, outputMode: "file-only", artifactPaths: { outputPath: review } }] } } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: acceptanceReport() }], stopReason: "stop" } },
			],
			writeFiles: [{ path: "async-artifacts/review.md", content: "background nested review finding" }],
		});
		const inheritedKeys = Object.keys(process.env).filter((key) => key.startsWith("PI_SUBAGENT_PARENT_") || key === "PI_SUBAGENT_SCOPED_GIT_ENDPOINT");
		const inherited = new Map(inheritedKeys.map((key) => [key, process.env[key]]));
		for (const key of inheritedKeys) delete process.env[key];
		try {
		const launched = asyncExecution.executeAsyncSingle(id, {
			agent: "worker",
			task: "Patch the issue",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "runtime-review-bg" },
			artifactsDir: artifacts,
			artifactConfig: { enabled: true, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 1 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { criteria: ["Review evidence"], evidence: ["review-findings"], selfReview: false },
			sandbox: null as never,
		});
		assert.equal(launched.isError, undefined, launched.content?.[0]?.text);
		const resultPath = path.join(asyncTypes.RESULTS_DIR, `${id}.json`);
		const deadline = Date.now() + 15_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for background result");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.equal(payload.results?.[0]?.acceptance?.status, "checked", JSON.stringify(payload));
		assert.deepEqual(payload.results?.[0]?.acceptance?.childReport?.reviewFindings, ["background nested review finding"]);
		} finally {
			for (const [key, value] of inherited) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(path.join(asyncTypes.RESULTS_DIR, `${id}.json`), { force: true });
			fs.rmSync(path.join(asyncTypes.ASYNC_DIR, id), { recursive: true, force: true });
		}
	});

	afterEach(() => removeTempDir(cwd));
});
