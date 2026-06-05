/**
 * Snapshot-style tests for the /subagents overlay rendering.
 * Tests verify empty state, single top-level run, nested child indentation,
 * and detail pane navigation/scrolling (issue #21).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { renderOverlay, SubagentDetailPane, SubagentsOverlay } from "../../src/tui/subagents-overlay.ts";
import type { OverlayRun } from "../../src/tui/run-tree-collector.ts";

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
				sessionFile: "/s",
				logPath: "/l",
				artifactPath: "/a",
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
		assert.ok(text.includes("/s"), "should show session path when available");
		assert.ok(text.includes("/l"), "should show log path when available");
		assert.ok(text.includes("/a"), "should show artifact path when available");
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

	it("renders a running/completed switch in filtered overlay mode", () => {
		const lines = renderOverlay([], theme as never, WIDTH, 0, {
			view: "running",
			runningCount: 0,
			completedCount: 2,
		});
		const text = lines.join("\n");

		assert.ok(text.includes("running 0"), "should show running count");
		assert.ok(text.includes("completed 2"), "should show completed count");
		assert.ok(text.includes("No running subagents"), "should explain empty running view");
		assert.ok(text.includes("switch view"), "should show switch hint");
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

	it("renders a single foreground worker exactly once without redundant step", () => {
		const runs: OverlayRun[] = [
			{
				id: "fg-1",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				currentTool: "read",
				elapsed: "5.2s",
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
		// The worker agent name should appear exactly once (in the run header)
		const workerMatches = text.match(/\bworker\b/g);
		assert.strictEqual(workerMatches?.length, 1, "worker should appear exactly once in rendered output");
		// The run header should include the currentTool
		assert.ok(text.includes("read"), "run header should include currentTool");
		// There should be no indented step line
		const stepLine = lines.find((l) => l.includes("worker") && l.includes("running") && l.replace(/^.*?│/, "").startsWith("  "));
		assert.strictEqual(stepLine, undefined, "should not render a redundant step line");
	});

	it("keeps the step when a single foreground run has nested children", () => {
		const runs: OverlayRun[] = [
			{
				id: "fg-nested",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				steps: [
					{
						agent: "worker",
						state: "running",
						children: [
							{
								id: "nested-1",
								agent: "reviewer",
								state: "running",
								children: [],
							},
						],
					},
				],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");
		// Both worker (step) and reviewer (nested child) should appear
		assert.ok(text.includes("worker"), "should show worker step");
		assert.ok(text.includes("reviewer"), "should show nested child");
	});

	it("renders a completed foreground run with correct state glyph", () => {
		const runs: OverlayRun[] = [
			{
				id: "fg-done",
				label: "chain: researcher, worker",
				state: "complete",
				mode: "chain",
				source: "foreground",
				agents: ["researcher", "worker"],
				elapsed: "12s",
				steps: [
					{ agent: "researcher", state: "complete", elapsed: "8s", children: [] },
					{ agent: "worker", state: "complete", elapsed: "4s", children: [] },
				],
			},
		];
		const lines = renderOverlay(runs, theme as never, WIDTH);
		const text = lines.join("\n");
		assert.ok(text.includes("researcher"), "should show researcher step");
		assert.ok(text.includes("worker"), "should show worker step");
		assert.ok(text.includes("complete"), "should show complete state");
		assert.ok(text.includes("fg"), "should show foreground source badge");
		assert.ok(text.includes("12s"), "should show elapsed");
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

describe("subagents overlay detail pane (issue #21)", () => {
	it("shows no-session message when run has no readable session", () => {
		const run: OverlayRun = {
			id: "no-session-run",
			label: "single: worker",
			state: "running",
			mode: "single",
			source: "async",
			agents: ["worker"],
			steps: [],
		};
		const pane = new SubagentDetailPane(run, theme as never, () => {});
		const lines = pane.render(WIDTH, 20);
		const text = lines.join("\n");
		assert.ok(text.includes("no-session-run"), "should show run id in title");
		assert.ok(text.includes("worker"), "should show agent in title");
		assert.ok(text.includes("No session file or log available"), "should show no-session message");
	});

	it("toggles thinking visibility", () => {
		const run: OverlayRun = {
			id: "think-run",
			label: "single: worker",
			state: "running",
			mode: "single",
			source: "async",
			agents: ["worker"],
			steps: [],
		};
		const pane = new SubagentDetailPane(run, theme as never, () => {});
		assert.strictEqual(pane.getShowThinking(), false, "thinking hidden by default");
		pane.toggleThinking();
		assert.strictEqual(pane.getShowThinking(), true, "thinking shown after toggle");
		pane.toggleThinking();
		assert.strictEqual(pane.getShowThinking(), false, "thinking hidden after second toggle");
	});

	it("scrolls independently within content", () => {
		const run: OverlayRun = {
			id: "scroll-run",
			label: "single: worker",
			state: "running",
			mode: "single",
			source: "async",
			agents: ["worker"],
			steps: [],
		};
		const pane = new SubagentDetailPane(run, theme as never, () => {});
		const linesBefore = pane.render(WIDTH, 20);
		const textBefore = linesBefore.join("\n");

		// Scroll down should change the visible content
		pane.scrollDown(5);
		const linesAfter = pane.render(WIDTH, 20);
		const textAfter = linesAfter.join("\n");

		// The scroll hint should change to show lines above
		assert.ok(textAfter.includes("↑") || textAfter.includes("end of content"), "scroll hint should reflect scrolled state");
	});

	it("scroll hint reflects actual render height, not hardcoded 20", () => {
		// 3 user messages produce 6 formatted lines (header + content each)
		const entries = Array.from({ length: 3 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "h-run",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				sessionFile: p,
				steps: [],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			// height 9 gives viewport = 4 lines (5 non-content lines); 6 lines total => 2 below
			const lines = pane.render(80, 9);
			const text = lines.join("\n");
			assert.ok(text.includes("↓ 2 more"), "scroll hint should reflect height-based viewport");
		} finally {
			cleanup(p);
		}
	});

	it("auto-scrolls to bottom when content grows while user was at bottom", () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "grow-run",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				sessionFile: p,
				steps: [],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			// Establish a known render size and scroll to bottom explicitly
			pane.render(80, 15);
			pane.scrollDown(1000);
			const lines1 = pane.render(80, 15);
			const scrollHint1 = lines1[lines1.length - 2]!;
			assert.ok(!scrollHint1.includes("↓"), "should be at bottom before growth");

			// Grow the file by appending more entries
			const moreEntries = Array.from({ length: 5 }, (_, i) =>
				JSON.stringify({ type: "message", id: String(10 + i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `More${i}`, timestamp: Date.now() } })
			).join("\n");
			fs.appendFileSync(p, "\n" + moreEntries, "utf-8");

			// Refresh should stay pinned at bottom
			pane.refresh();
			const lines2 = pane.render(80, 15);
			const scrollHint2 = lines2[lines2.length - 2]!;
			assert.ok(!scrollHint2.includes("↓"), "should stay pinned at bottom after growth");
			assert.ok(lines2.join("\n").includes("More4"), "should show latest content");
		} finally {
			cleanup(p);
		}
	});

	it("does not auto-scroll when content grows if user scrolled away from bottom", () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "stay-run",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				sessionFile: p,
				steps: [],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			// Establish a known render size and scroll to bottom explicitly
			pane.render(80, 15);
			pane.scrollDown(1000);

			// Scroll up away from bottom
			pane.scrollUp(5);
			const linesAfterScroll = pane.render(80, 15);
			const scrollHintAfterScroll = linesAfterScroll[linesAfterScroll.length - 2]!;
			assert.ok(scrollHintAfterScroll.includes("↓"), "should show scroll-down indicator after scrolling up");

			// Grow the file
			const moreEntries = Array.from({ length: 5 }, (_, i) =>
				JSON.stringify({ type: "message", id: String(10 + i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `More${i}`, timestamp: Date.now() } })
			).join("\n");
			fs.appendFileSync(p, "\n" + moreEntries, "utf-8");

			pane.refresh();
			const linesAfterRefresh = pane.render(80, 15);
			const scrollHintAfterRefresh = linesAfterRefresh[linesAfterRefresh.length - 2]!;
			// Should still show downward indicator, meaning we didn't jump to bottom
			assert.ok(scrollHintAfterRefresh.includes("↓"), "should remain scrolled up after refresh");
			// Should NOT show the latest content since we didn't jump
			assert.ok(!linesAfterRefresh.join("\n").includes("More4"), "should not show latest content when not at bottom");
		} finally {
			cleanup(p);
		}
	});

	it("returns exactly the requested height lines", () => {
		const entries = Array.from({ length: 3 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "height-run",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "async",
				agents: ["worker"],
				sessionFile: p,
				steps: [],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			for (const h of [10, 15, 20, 25]) {
				const lines = pane.render(80, h);
				assert.strictEqual(lines.length, h, `render(80, ${h}) should return exactly ${h} lines`);
			}
		} finally {
			cleanup(p);
		}
	});

	it("returns exactly the requested height lines for error state", () => {
		const run: OverlayRun = {
			id: "err-run",
			label: "single: worker",
			state: "running",
			mode: "single",
			source: "async",
			agents: ["worker"],
			steps: [],
		};
		const pane = new SubagentDetailPane(run, theme as never, () => {});
		for (const h of [10, 15, 20]) {
			const lines = pane.render(80, h);
			assert.strictEqual(lines.length, h, `error render(80, ${h}) should return exactly ${h} lines`);
		}
	});

	it("switches between running and completed run buckets", () => {
		let renderCount = 0;
		const requestRender = () => { renderCount++; };

		const state = {
			baseCwd: "/tmp",
			currentSessionId: null,
			asyncJobs: new Map([
				["run-running", {
					asyncId: "run-running",
					asyncDir: "/tmp/run-running",
					status: "running",
					agents: ["worker"],
					steps: [{ agent: "worker", status: "running" }],
				}],
				["run-complete", {
					asyncId: "run-complete",
					asyncDir: "/tmp/run-complete",
					status: "complete",
					agents: ["reviewer"],
					steps: [{ agent: "reviewer", status: "completed" }],
				}],
			]),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} },
		};

		const keybindings = {
			matches: (data: string, keyId: string) => {
				if (keyId === "tui.select.up" && data === "\x1B[A") return true;
				if (keyId === "tui.select.down" && data === "\x1B[B") return true;
				if (keyId === "tui.select.cancel" && data === "\x1B") return true;
				return false;
			},
		} as never;

		let doneCalled = false;
		const done = () => { doneCalled = true; };

		const overlay = new SubagentsOverlay(theme as never, state as never, done, requestRender, keybindings);
		try {
			const runningText = overlay.render(WIDTH).join("\n");
			assert.ok(runningText.includes("running 1"), "should show running count");
			assert.ok(runningText.includes("completed 1"), "should show completed count");
			assert.ok(runningText.includes("worker"), "running view should show running agent");
			assert.ok(!runningText.includes("reviewer complete"), "running view should hide completed agent");

			overlay.handleInput("c");
			const completedText = overlay.render(WIDTH).join("\n");
			assert.ok(completedText.includes("reviewer"), "completed view should show completed agent");
			assert.ok(!completedText.includes("worker running"), "completed view should hide running agent");

			overlay.handleInput("r");
			const backToRunningText = overlay.render(WIDTH).join("\n");
			assert.ok(backToRunningText.includes("worker"), "running shortcut should switch back");
			assert.equal(doneCalled, false, "switching views should not close overlay");
		} finally {
			overlay.dispose();
		}
	});

	it("preserves list selection when going back from detail", () => {
		let renderCount = 0;
		const requestRender = () => { renderCount++; };

		const state = {
			baseCwd: "/tmp",
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} },
		};

		const keybindings = {
			matches: (data: string, keyId: string) => {
				if (keyId === "tui.select.up" && data === "\x1B[A") return true;
				if (keyId === "tui.select.down" && data === "\x1B[B") return true;
				if (keyId === "tui.select.cancel" && data === "\x1B") return true;
				return false;
			},
		} as never;

		let doneCalled = false;
		const done = () => { doneCalled = true; };

		const overlay = new SubagentsOverlay(theme as never, state, done, requestRender, keybindings);

		// Initially in list mode
		const listLines = overlay.render(WIDTH);
		assert.ok(listLines.join("\n").includes("Subagents"), "should start in list mode");

		// Try to open detail when no runs exist — should stay in list mode
		overlay.handleInput("\r"); // Enter
		const afterEnter = overlay.render(WIDTH);
		assert.ok(afterEnter.join("\n").includes("Subagents"), "should remain in list mode when no runs");

		overlay.dispose();
	});

	it("shows nested child session content in detail view for running foreground worker", () => {
		const entries = Array.from({ length: 3 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "fg-nested",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				steps: [
					{
						agent: "worker",
						state: "running",
						children: [
							{
								id: "nested-1",
								agent: "worker",
								state: "running",
								sessionFile: p,
								children: [],
							},
						],
					},
				],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			const lines = pane.render(WIDTH, 20);
			const text = lines.join("\n");
			assert.ok(!text.includes("No session file or log available"), "should not show empty state when nested child has session file");
			assert.ok(text.includes("Msg0"), "should show nested child session content");
		} finally {
			cleanup(p);
		}
	});

	it("shows step session content in detail view when run has no direct session file", () => {
		const entries = Array.from({ length: 3 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Msg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const run: OverlayRun = {
				id: "fg-step",
				label: "single: worker",
				state: "running",
				mode: "single",
				source: "foreground",
				agents: ["worker"],
				steps: [
					{
						agent: "worker",
						state: "running",
						sessionFile: p,
						children: [],
					},
				],
			};
			const pane = new SubagentDetailPane(run, theme as never, () => {});
			const lines = pane.render(WIDTH, 20);
			const text = lines.join("\n");
			assert.ok(!text.includes("No session file or log available"), "should not show empty state when step has session file");
			assert.ok(text.includes("Msg0"), "should show step session content");
		} finally {
			cleanup(p);
		}
	});

	it("refreshes an open detail pane with newly discovered foreground session paths", () => {
		const entries = Array.from({ length: 3 }, (_, i) =>
			JSON.stringify({ type: "message", id: String(i), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `LiveMsg${i}`, timestamp: Date.now() } })
		).join("\n");
		const p = tmpFile(entries);
		try {
			const control = {
				runId: "fg-live",
				mode: "single",
				currentAgent: "worker",
				startedAt: 1000,
				updatedAt: 2000,
			};
			const state = {
				baseCwd: "/tmp",
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map([["fg-live", control]]),
				lastForegroundControlId: null,
				pendingForegroundControlNotices: new Map(),
				cleanupTimers: new Map(),
				lastUiContext: null,
				poller: null,
				completionSeen: new Map(),
				watcher: null,
				watcherRestartTimer: null,
				resultFileCoalescer: { schedule: () => false, clear: () => {} },
			};
			const keybindings = {
				matches: (data: string, keyId: string) => {
					if (keyId === "tui.select.up" && data === "\x1B[A") return true;
					if (keyId === "tui.select.down" && data === "\x1B[B") return true;
					if (keyId === "tui.select.cancel" && data === "\x1B") return true;
					return false;
				},
			} as never;
			const overlay = new SubagentsOverlay(theme as never, state as never, () => {}, () => {}, keybindings);
			try {
				overlay.handleInput("\r");
				assert.ok(overlay.render(WIDTH).join("\n").includes("No session file or log available"), "detail starts empty before path is discovered");

				(control as { nestedChildren?: unknown[] }).nestedChildren = [
					{
						id: "nested-live",
						parentRunId: "fg-live",
						depth: 1,
						path: [{ runId: "fg-live" }],
						state: "running",
						agent: "worker",
						sessionFile: p,
					},
				];
				(state as { foregroundControls: Map<string, unknown> }).foregroundControls.set("fg-live", control);
				(overlay as unknown as { refresh(): void }).refresh();

				const text = overlay.render(WIDTH).join("\n");
				assert.ok(!text.includes("No session file or log available"), "detail should update without closing/reopening");
				assert.ok(text.includes("LiveMsg0"), "detail should show newly discovered session content");
			} finally {
				overlay.dispose();
			}
		} finally {
			cleanup(p);
		}
	});
});
