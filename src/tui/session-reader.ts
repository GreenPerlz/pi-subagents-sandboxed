/**
 * Session file reader for the /subagents overlay detail pane.
 *
 * Reads JSONL session files (or plain text log/artifact files), parses entries,
 * and formats them into display lines with optional thinking-block filtering.
 */

import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OverlayRun, OverlayNestedChild } from "./run-tree-collector.ts";

// Re-export ThinkingContent shape for internal use
interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

interface TextContent {
	type: "text";
	text: string;
}

interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

interface SessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

interface MessageEntry extends SessionTreeEntryBase {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: string | AssistantContent[] | (TextContent | { type: "image"; data: string; mimeType: string })[];
		timestamp: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

interface CompactionEntry extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

interface CustomMessageEntry extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | TextContent[];
	display: boolean;
}

interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

interface ModelChangeEntry extends SessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| CustomMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ActiveToolsChangeEntry;

type Theme = ExtensionContext["ui"]["theme"];

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

export interface FormattedLine {
	text: string;
	isThinking: boolean;
}

function parseJsonlLine(line: string): SessionEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as SessionEntry;
	} catch {
		return undefined;
	}
}

function isThinkingContent(c: AssistantContent): c is ThinkingContent {
	return c.type === "thinking";
}

function isTextContent(c: AssistantContent): c is TextContent {
	return c.type === "text";
}

function isToolCallContent(c: AssistantContent): c is ToolCallContent {
	return c.type === "toolCall";
}

function extractText(content: string | AssistantContent[] | (TextContent | { type: "image" })[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function extractThinkingBlocks(content: string | AssistantContent[]): ThinkingContent[] {
	if (typeof content === "string") return [];
	return content.filter(isThinkingContent);
}

function extractToolCalls(content: string | AssistantContent[]): ToolCallContent[] {
	if (typeof content === "string") return [];
	return content.filter(isToolCallContent);
}

function wrapLines(text: string, prefix: string, width: number): string[] {
	if (!text.trim()) return [];
	const available = Math.max(1, width - localVisibleWidth(prefix));
	const lines = text.split("\n");
	const result: string[] = [];
	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		if (localVisibleWidth(line) <= available) {
			result.push(prefix + line);
			continue;
		}
		// Simple word-wrap
		let current = "";
		for (const word of line.split(/(\s+)/)) {
			if (!word) continue;
			const next = current + word;
			if (localVisibleWidth(next) <= available) {
				current = next;
			} else {
				if (current) result.push(prefix + current);
				current = word;
			}
		}
		if (current) result.push(prefix + current);
	}
	return result;
}

function formatTimestamp(ts: number | string | undefined): string {
	if (ts === undefined) return "";
	const num = typeof ts === "string" ? Date.parse(ts) : ts;
	if (Number.isNaN(num)) return "";
	const d = new Date(num);
	return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// Entry formatting
// ---------------------------------------------------------------------------

function formatUserMessage(entry: MessageEntry, theme: Theme, width: number): FormattedLine[] {
	const msg = entry.message;
	const text = extractText(msg.content);
	const ts = formatTimestamp(msg.timestamp);
	const header = `${theme.fg("accent", "User")}${ts ? theme.fg("dim", ` · ${ts}`) : ""}`;
	const lines: FormattedLine[] = [{ text: header, isThinking: false }];
	for (const wrapped of wrapLines(text, "  ", width)) {
		lines.push({ text: truncateToWidth(wrapped, width), isThinking: false });
	}
	return lines;
}

function formatAssistantMessage(entry: MessageEntry, theme: Theme, width: number, showThinking: boolean): FormattedLine[] {
	const msg = entry.message;
	const text = extractText(msg.content);
	const thinkingBlocks = extractThinkingBlocks(msg.content);
	const toolCalls = extractToolCalls(msg.content);
	const ts = formatTimestamp(msg.timestamp);
	const lines: FormattedLine[] = [];

	const header = `${theme.fg("success", "Assistant")}${ts ? theme.fg("dim", ` · ${ts}`) : ""}`;
	lines.push({ text: header, isThinking: false });

	// Tool calls
	for (const tc of toolCalls) {
		const args = JSON.stringify(tc.arguments);
		const tcLine = `  ${theme.fg("dim", `⎿ tool_call: ${tc.name}`)}${args.length > 40 ? ` ${args.slice(0, 40)}...` : ` ${args}`}`;
		lines.push({ text: truncateToWidth(tcLine, width), isThinking: false });
	}

	// Main text
	for (const wrapped of wrapLines(text, "  ", width)) {
		lines.push({ text: truncateToWidth(wrapped, width), isThinking: false });
	}

	// Thinking blocks
	for (const tb of thinkingBlocks) {
		if (!showThinking) {
			const hiddenLabel = `  ${theme.fg("dim", `⎿ [thinking hidden — press t to show]`)}`;
			lines.push({ text: truncateToWidth(hiddenLabel, width), isThinking: true });
			continue;
		}
		const thinkingHeader = `  ${theme.fg("dim", "⎿ thinking:")}`;
		lines.push({ text: truncateToWidth(thinkingHeader, width), isThinking: true });
		for (const wrapped of wrapLines(tb.thinking, "    ", width)) {
			lines.push({ text: truncateToWidth(wrapped, width), isThinking: true });
		}
	}

	return lines;
}

function formatToolResultMessage(entry: MessageEntry, theme: Theme, width: number): FormattedLine[] {
	const msg = entry.message;
	const text = extractText(msg.content);
	const ts = formatTimestamp(msg.timestamp);
	const errorTag = msg.isError ? theme.fg("error", " [error]") : "";
	const header = `${theme.fg("warning", `Tool result${msg.toolName ? `: ${msg.toolName}` : ""}`)}${errorTag}${ts ? theme.fg("dim", ` · ${ts}`) : ""}`;
	const lines: FormattedLine[] = [{ text: header, isThinking: false }];
	for (const wrapped of wrapLines(text, "  ", width)) {
		lines.push({ text: truncateToWidth(wrapped, width), isThinking: false });
	}
	return lines;
}

function formatMessageEntry(entry: MessageEntry, theme: Theme, width: number, showThinking: boolean): FormattedLine[] {
	switch (entry.message.role) {
		case "user": return formatUserMessage(entry, theme, width);
		case "assistant": return formatAssistantMessage(entry, theme, width, showThinking);
		case "toolResult": return formatToolResultMessage(entry, theme, width);
		default: return [];
	}
}

function formatCompactionEntry(entry: CompactionEntry, theme: Theme, width: number): FormattedLine[] {
	const text = `${theme.fg("dim", "[compaction]")} ${entry.summary}`;
	return [{ text: truncateToWidth(text, width), isThinking: false }];
}

function formatCustomMessageEntry(entry: CustomMessageEntry, theme: Theme, width: number): FormattedLine[] {
	const content = typeof entry.content === "string" ? entry.content : entry.content.map((c) => c.text).join("");
	const text = `${theme.fg("dim", `[${entry.customType}]`)} ${content}`;
	return [{ text: truncateToWidth(text, width), isThinking: false }];
}

function formatThinkingLevelChange(entry: ThinkingLevelChangeEntry, theme: Theme, width: number): FormattedLine[] {
	const text = `${theme.fg("dim", "[thinking level]")} ${entry.thinkingLevel}`;
	return [{ text: truncateToWidth(text, width), isThinking: false }];
}

function formatModelChange(entry: ModelChangeEntry, theme: Theme, width: number): FormattedLine[] {
	const text = `${theme.fg("dim", "[model]")} ${entry.provider}/${entry.modelId}`;
	return [{ text: truncateToWidth(text, width), isThinking: false }];
}

function formatActiveToolsChange(entry: ActiveToolsChangeEntry, theme: Theme, width: number): FormattedLine[] {
	const text = `${theme.fg("dim", "[tools]")} ${entry.activeToolNames.join(", ")}`;
	return [{ text: truncateToWidth(text, width), isThinking: false }];
}

function formatEntry(entry: SessionEntry, theme: Theme, width: number, showThinking: boolean): FormattedLine[] {
	switch (entry.type) {
		case "message": return formatMessageEntry(entry, theme, width, showThinking);
		case "compaction": return formatCompactionEntry(entry, theme, width);
		case "custom_message": return formatCustomMessageEntry(entry, theme, width);
		case "thinking_level_change": return formatThinkingLevelChange(entry, theme, width);
		case "model_change": return formatModelChange(entry, theme, width);
		case "active_tools_change": return formatActiveToolsChange(entry, theme, width);
		default: return [];
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadSessionResult {
	lines: FormattedLine[];
	error?: string;
}

/**
 * Read a session file (JSONL) or plain text log file and format entries.
 * Returns display lines with optional thinking-block filtering.
 */
export function readSessionFile(filePath: string, theme: Theme, width: number, showThinking: boolean): ReadSessionResult {
	try {
		if (!fs.existsSync(filePath)) {
			return { lines: [], error: `Session file not found: ${filePath}` };
		}
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) {
			return { lines: [], error: `Not a file: ${filePath}` };
		}

		const raw = fs.readFileSync(filePath, "utf-8");
		if (!raw.trim()) {
			return { lines: [], error: "Session file is empty" };
		}

		// Try JSONL first; fall back to plain text if parsing fails broadly
		const lines = raw.split("\n");
		const result: FormattedLine[] = [];
		let parsedCount = 0;

		for (const line of lines) {
			const entry = parseJsonlLine(line);
			if (entry) {
				parsedCount++;
				result.push(...formatEntry(entry, theme, width, showThinking));
			}
		}

		// If no entries parsed, treat as plain text log
		if (parsedCount === 0) {
			for (const line of lines) {
				result.push({ text: truncateToWidth(line, width), isThinking: false });
			}
		}

		return { lines: result };
	} catch (err) {
		return { lines: [], error: `Error reading session: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * Find the best available session/log file for a run.
 * Prefers sessionFile, then logPath, then artifactPath, then constructs from asyncDir.
 *
 * `preferred` filters the search:
 * - `"session"` only returns session files.
 * - `"logs"` only returns log/output files.
 * - `"auto"` (default) prefers session, then falls back to logs.
 */
export function resolveSessionPath(run: { sessionFile?: string; logPath?: string; artifactPath?: string; asyncDir?: string }, preferred: "session" | "logs" | "auto" = "auto"): string | undefined {
	if (preferred === "session" || preferred === "auto") {
		if (run.sessionFile) {
			if (fs.existsSync(run.sessionFile) && fs.statSync(run.sessionFile).isFile()) return run.sessionFile;
		}
	}
	if (preferred === "logs" || preferred === "auto") {
		if (run.logPath) {
			if (fs.existsSync(run.logPath) && fs.statSync(run.logPath).isFile()) return run.logPath;
		}
	}
	if (run.artifactPath) {
		const artifactStat = fs.existsSync(run.artifactPath) ? fs.statSync(run.artifactPath) : undefined;
		if (artifactStat?.isFile() && preferred !== "session") {
			return run.artifactPath;
		}
		const candidates = preferred === "session"
			? ["session.jsonl"]
			: preferred === "logs"
				? ["output.log", "output-0.log"]
				: ["output.log", "output-0.log", "session.jsonl"];
		for (const candidate of candidates) {
			const p = run.artifactPath + (run.artifactPath.endsWith("/") ? "" : "/") + candidate;
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
		}
	}
	if (run.asyncDir) {
		const candidates = preferred === "session"
			? ["session.jsonl"]
			: preferred === "logs"
				? ["output.log", "output-0.log"]
				: ["session.jsonl", "output.log", "output-0.log"];
		for (const candidate of candidates) {
			const p = run.asyncDir + (run.asyncDir.endsWith("/") ? "" : "/") + candidate;
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
		}
	}
	return undefined;
}

/**
 * Find the best available session/log file for a run, searching the run itself,
 * its steps, and nested children recursively.
 */
export function resolveSessionPathForRun(run: OverlayRun): string | undefined {
	const direct = resolveSessionPath(run);
	if (direct) return direct;

	for (const step of run.steps) {
		const stepPath = resolveSessionPath(step);
		if (stepPath) return stepPath;
	}

	function searchChildren(children: OverlayNestedChild[]): string | undefined {
		for (const child of children) {
			const childPath = resolveSessionPath(child);
			if (childPath) return childPath;
			const nested = searchChildren(child.children);
			if (nested) return nested;
		}
		return undefined;
	}

	for (const step of run.steps) {
		const nested = searchChildren(step.children);
		if (nested) return nested;
	}

	return undefined;
}

function localVisibleWidth(s: string): number {
	return visibleWidth(s);
}
