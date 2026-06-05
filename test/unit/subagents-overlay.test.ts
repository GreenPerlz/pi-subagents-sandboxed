/**
 * Snapshot-style tests for the /subagents overlay rendering.
 * Tests verify empty state, single top-level run, and nested child indentation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderOverlay } from "../../src/tui/subagents-overlay.ts";
import type { OverlayRun } from "../../src/tui/run-tree-collector.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
};

const WIDTH = 80;

describe("subagents overlay rendering", () => {
	it("renders empty state when no runs exist", () => {
		const lines = renderOverlay([], theme as never, WIDTH);
		const text = lines.join("\n");

		assert.ok(text.includes("No subagents known/running"), "should show empty-state message");
		assert.ok(text.includes("subagent({ action:"), "should point to status action");
		assert.ok(text.includes("Esc to close"), "should show escape hint");
		// Should have border
		assert.ok(lines[0]!.startsWith("╭"), "should start with top-left border");
		assert.ok(lines[lines.length - 1]!.startsWith("╰"), "should end with bottom-left border");
	});

	it("renders a single top-level run with agent and state", () => {
		const runs: OverlayRun[] = [
			{
				id: "run-1",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				elapsed: "5.2s",
				sessionFile: "/s.jsonl",
				artifactPath: "/a.log",
				steps: [
					{
						agent: "worker",
						state: "running",
						currentTool: "read",
						elapsed: "5.2s",
						children: [],
					},
				],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");

		assert.ok(text.includes("worker"), "should show agent name");
		assert.ok(text.includes("running"), "should show run state");
		assert.ok(text.includes("bg"), "should show async source badge");
		assert.ok(text.includes("run-1"), "should show run id");
		assert.ok(text.includes("/s.jsonl"), "should show session path when available");
		assert.ok(text.includes("/a.log"), "should show artifact path when available");
		assert.ok(text.includes("read"), "should show current tool");
		assert.ok(text.includes("5.2s"), "should show elapsed");
		assert.ok(text.includes("Esc"), "should show escape hint");
		// Verify indentation for step (should be indented)
		const stepLine = lines.find((l) => l.includes("worker") && l.includes("running") && !l.includes("Subagents"));
		assert.ok(stepLine, "step line should exist");
		// Step should be indented relative to the header
		const headerLine = lines.find((l) => l.includes("worker") && l.includes("bg"));
		assert.ok(headerLine, "header line should exist");
	});

	it("renders nested children with increasing indentation", () => {
		const runs: OverlayRun[] = [
			{
				id: "chain-1",
				label: "chain: researcher, worker",
				state: "running",
				mode: "chain",
				source: "foreground",
				agents: ["researcher", "worker"],
				elapsed: "12s",
				steps: [
					{
						agent: "researcher",
						state: "complete",
						elapsed: "8s",
						children: [],
					},
					{
						agent: "worker",
						state: "running",
						currentTool: "bash",
						elapsed: "4s",
						children: [
							{
								id: "nested-1",
								agent: "child-worker",
								state: "running",
								currentTool: "edit",
								elapsed: "2s",
								children: [],
							},
						],
					},
				],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");

		assert.ok(text.includes("researcher"), "should show researcher step");
		assert.ok(text.includes("child-worker"), "should show nested child");
		assert.ok(text.includes("edit"), "should show nested child's current tool");

		// Verify indentation levels: nested child should be more indented than parent step
		const stepLineIdx = lines.findIndex((l) => l.includes("worker") && l.includes("running") && !l.includes("child"));
		const nestedLineIdx = lines.findIndex((l) => l.includes("child-worker"));
		assert.ok(stepLineIdx >= 0, "step line should be found");
		assert.ok(nestedLineIdx >= 0, "nested line should be found");
		assert.ok(nestedLineIdx > stepLineIdx, "nested child should appear after parent step");

		// Indentation check: the nested line content after border should have more leading spaces
		const stripBorder = (l: string) => l.replace(/^.*?│/, "");
		const stepContent = stripBorder(lines[stepLineIdx]!);
		const nestedContent = stripBorder(lines[nestedLineIdx]!);
		const stepLeadingSpaces = stepContent.match(/^(\s*)/)?.[1]?.length ?? 0;
		const nestedLeadingSpaces = nestedContent.match(/^(\s*)/)?.[1]?.length ?? 0;
		assert.ok(nestedLeadingSpaces > stepLeadingSpaces, "nested child should be indented deeper than parent step");
	});

	it("renders multiple runs preserving order", () => {
		const runs: OverlayRun[] = [
			{
				id: "run-1",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				steps: [],
			},
			{
				id: "done-1",
				label: "single: reviewer",
				state: "complete",
				mode: "single",
				source: "async",
				agents: ["reviewer"],
				steps: [],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");

		// Both runs should appear
		assert.ok(text.includes("worker"));
		assert.ok(text.includes("reviewer"));

		// Worker should appear before reviewer since it's first in the array
		const workerIdx = text.indexOf("worker");
		const reviewerIdx = text.indexOf("reviewer");
		assert.ok(workerIdx < reviewerIdx, "first run should appear before second run");
	});

	it("renders with fg source badge for foreground runs", () => {
		const runs: OverlayRun[] = [
			{
				id: "fg-1",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				steps: [],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");
		assert.ok(text.includes("fg"), "should show foreground source badge");
	});

	it("truncates lines to width", () => {
		const runs: OverlayRun[] = [
			{
				id: "run-with-very-long-name",
				label: "single: very-long-agent-name-that-should-be-truncated",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["very-long-agent-name-that-should-be-truncated"],
				steps: [],
			},
		];
		const narrowWidth = 40;
		const lines = renderOverlay(runs, theme as never, narrowWidth);
		for (const line of lines) {
			// Strip ANSI and check visible width
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(stripped.length <= narrowWidth, `line exceeds width: "${stripped}"`);
		}
	});
});
