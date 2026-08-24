import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AcceptanceEvidenceKind,
	AcceptanceLedger,
	AcceptanceProvenanceLevel,
	AcceptanceReport,
	AcceptanceRuntimeCheck,
	AcceptanceReviewResult,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
} from "../../shared/types.ts";
import { requiredAcceptanceEvidence } from "./acceptance-contract.ts";
import { parseAcceptanceReport } from "./acceptance-reports.ts";
import { captureChildProcessGroupMembers, captureChildProcessIdentity, isChildProcessGroupGone, processControlUnsupported, signalChildProcessGroup, waitForChildProcessGroupGone } from "../../shared/post-exit-stdio-guard.ts";

const LEVEL_RANK: Record<AcceptanceProvenanceLevel, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(criterion.id);
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

function reportEvidencePresent(report: AcceptanceReport, kind: AcceptanceEvidenceKind): boolean {
	switch (kind) {
		case "changed-files": return isStringArray(report.changedFiles) && report.changedFiles.length > 0;
		case "tests-added": return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0;
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0;
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0;
		case "residual-risks": return isStringArray(report.residualRisks);
		case "no-staged-files": return report.noStagedFiles === true;
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0;
		case "review-findings": return isStringArray(report.reviewFindings);
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim());
	}
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], {
		cwd,
		encoding: "utf-8",
		timeout: 15_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.status !== 0 || result.error) {
		const evidence = result.error?.message ?? result.stderr?.trim() ?? `git exited with status ${result.status ?? "unknown"}`;
		return { id: "no-staged-files", status: "failed", message: `git status failed; no-staged-files proof unavailable: ${evidence}` };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	checks.push(...checkCriteriaSatisfied(acceptance.criteria, report));
	for (const kind of requiredAcceptanceEvidence(acceptance)) {
		const present = reportEvidencePresent(report, kind);
		checks.push({
			id: `evidence:${kind}`,
			status: present ? "passed" : "failed",
			message: present ? `${kind} evidence present.` : `${kind} evidence missing from child report.`,
		});
	}
	if (requiredAcceptanceEvidence(acceptance).includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

const RUNTIME_REVIEW_MAX_OUTPUT = 12_000;
const RUNTIME_REVIEW_MAX_RESULTS = 128;

function isContainedPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readTrustedReviewArtifact(candidate: unknown, trustedRoots: string[]): string | undefined {
	if (typeof candidate !== "string" || candidate.trim() === "" || trustedRoots.length === 0) return undefined;
	try {
		const resolvedCandidate = path.resolve(candidate);
		const candidateRealpath = fs.realpathSync(resolvedCandidate);
		if (trustedRoots.every((root) => {
			try { return !isContainedPath(fs.realpathSync(path.resolve(root)), candidateRealpath); } catch { return true; }
		})) return undefined;
		const requestedStat = fs.lstatSync(resolvedCandidate);
		if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) return undefined;
		const canonicalStat = fs.lstatSync(candidateRealpath);
		if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) return undefined;
		const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		const fd = fs.openSync(candidateRealpath, fs.constants.O_RDONLY | noFollow);
		try {
			const opened = fs.fstatSync(fd);
			if (!opened.isFile() || opened.dev !== canonicalStat.dev || opened.ino !== canonicalStat.ino) return undefined;
			const buffer = Buffer.allocUnsafe(RUNTIME_REVIEW_MAX_OUTPUT + 1);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const content = buffer.subarray(0, Math.min(bytesRead, RUNTIME_REVIEW_MAX_OUTPUT)).toString("utf8").trim();
			return bytesRead > RUNTIME_REVIEW_MAX_OUTPUT || opened.size > RUNTIME_REVIEW_MAX_OUTPUT
				? `${content}\n...[truncated]`
				: content || undefined;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function reviewResultOutput(result: Record<string, unknown>, trustedRoots: string[]): string | undefined {
	const fileOnly = result.outputMode === "file-only";
	const readArtifact = (): string | undefined => {
		const reference = result.outputReference;
		if (reference && typeof reference === "object" && !Array.isArray(reference)) {
			const content = readTrustedReviewArtifact((reference as Record<string, unknown>).path, trustedRoots);
			if (content) return content;
		}
		const artifacts = result.artifactPaths;
		if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
			const content = readTrustedReviewArtifact((artifacts as Record<string, unknown>).outputPath, trustedRoots);
			if (content) return content;
		}
		return readTrustedReviewArtifact(result.savedOutputPath, trustedRoots);
	};
	if (fileOnly) return readArtifact();
	if (typeof result.finalOutput === "string") {
		const inline = trimOutput(result.finalOutput);
		if (inline) return inline;
	}
	return readArtifact();
}

/** Collect only authenticated-shaped nested review tool results for acceptance evidence. */
export function collectRuntimeReviewEvidence(messages: unknown[], trustedRoots: string[] = [], existing: string[] = []): string[] {
	const evidence = existing.slice(0, RUNTIME_REVIEW_MAX_RESULTS);
	if (evidence.length >= RUNTIME_REVIEW_MAX_RESULTS) return evidence;
	const seen = new Set(evidence);
	let scannedMessages = 0;
	let scannedResults = 0;
	for (const message of messages) {
		if (++scannedMessages > RUNTIME_REVIEW_MAX_RESULTS) break;
		if (!message || typeof message !== "object") continue;
		const toolMessage = message as Record<string, unknown>;
		if (toolMessage.role !== "toolResult" || toolMessage.toolName !== "subagent" || toolMessage.isError === true) continue;
		const details = toolMessage.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) continue;
		const results = (details as Record<string, unknown>).results;
		if (!Array.isArray(results)) continue;
		for (const value of results) {
			if (++scannedResults > RUNTIME_REVIEW_MAX_RESULTS) return evidence;
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const result = value as Record<string, unknown>;
			const agent = typeof result.agent === "string" ? result.agent : "";
			if (!/^(review|reviewer)$/i.test(agent)) continue;
			if (result.exitCode !== 0 || result.error !== undefined || result.interrupted === true || result.cancelled === true || result.detached === true || result.teardownUnproven === true) continue;
			const output = reviewResultOutput(result, trustedRoots);
			if (output && !seen.has(output)) {
				evidence.push(output);
				seen.add(output);
			}
			if (evidence.length >= RUNTIME_REVIEW_MAX_RESULTS) return evidence;
		}
	}
	return evidence;
}

function processStartToken(pid: number): string | undefined {
	if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		return stat.slice(closeParen + 2).trim().split(/\s+/u)[19] || undefined;
	} catch {
		return undefined;
	}
}

const VERIFY_MAX_OUTPUT = 8 * 1024 * 1024;

function parseVerifyCommand(command: string): string[] {
	// Verification commands are intentionally not run through a shell. Support
	// the usual quoted arguments while preventing shell descendants from escaping
	// the private process group.
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) { current += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
		if (char === '"' || char === "'") { quote = char; continue; }
		if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } continue; }
		current += char;
	}
	if (escaped) current += "\\";
	if (current) args.push(current);
	return args;
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		const args = parseVerifyCommand(command.command);
		if (args.length === 0) {
			resolve({ id: command.id, command: command.command, cwd, exitCode: 1, status: "failed", stderr: "Verification command is empty.", durationMs: 0 });
			return;
		}
		const processControlError = processControlUnsupported();
		if (processControlError) {
			resolve({ id: command.id, command: command.command, cwd, exitCode: 1, status: "failed", stderr: processControlError, durationMs: 0 });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overflowed = false;
		let settled = false;
		const child = spawn(args[0]!, args.slice(1), {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			detached: process.platform === "linux",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const pid = child.pid;
		const childIdentity = captureChildProcessIdentity(child);
		// Snapshot members while the leader is still live. The close event is too
		// late: Node may have reaped the leader by then, leaving only exact member
		// continuity as authority for descendants that survived naturally.
		captureChildProcessGroupMembers(child, childIdentity?.pgid ?? pid);
		const groupIdentityMatches = (): boolean => Boolean(
			process.platform === "linux"
				&& pid && pid > 0
				&& childIdentity?.pid === pid
				&& childIdentity.pgid === pid,
		);
		const groupGone = (): boolean => isChildProcessGroupGone(child);
		const terminate = (signal: NodeJS.Signals): void => {
			if (!pid || pid <= 0) return;
			if (process.platform === "win32") {
				try { child.kill(signal); } catch { /* already gone */ }
				return;
			}
			if (groupGone()) return;
			if (groupIdentityMatches()) {
				signalChildProcessGroup(child, signal, { identity: childIdentity });
				return;
			}
			// If the leader exited naturally, exact member snapshots captured while
			// it was live retain continuity authority for surviving descendants.
			// This path never falls back to the leader PID after reaping.
			if (signalChildProcessGroup(child, signal, { identity: childIdentity })) return;
			// A detached ChildProcess that is still unreaped is an owned private
			// group even when /proc token capture lost the startup race. This is the
			// sole tokenless fallback; after exit, never signal the bare PID/PGID.
			if (process.platform === "linux" && child.exitCode == null && child.signalCode == null) {
				try { process.kill(-pid, signal); } catch { /* preserve evidence on refusal */ }
			}
		};
		let hardKillTimer: NodeJS.Timeout | undefined;
		const scheduleHardKill = (): void => {
			if (hardKillTimer) return;
			hardKillTimer = setTimeout(() => {
				hardKillTimer = undefined;
				if (!settled) terminate("SIGKILL");
			}, 1000);
			hardKillTimer.unref?.();
		};
		const timeout = setTimeout(() => { timedOut = true; terminate("SIGTERM"); scheduleHardKill(); }, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
			const remaining = VERIFY_MAX_OUTPUT - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
			const text = chunk.subarray(0, Math.max(0, remaining)).toString();
			if (target === "stdout") stdout += text; else stderr += text;
			if (chunk.byteLength > Math.max(0, remaining) && !overflowed) {
				overflowed = true;
				stderr += "\n[acceptance verification output exceeded 8 MiB; process group terminated]";
				terminate("SIGTERM");
				scheduleHardKill();
			}
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		const teardownGroup = async (): Promise<boolean> => {
			if (process.platform === "win32") return child.exitCode !== null || child.pid === undefined;
			if (groupGone()) return true;
			terminate("SIGTERM");
			if (await waitForChildProcessGroupGone(child, 1_000)) return true;
			terminate("SIGKILL");
			return waitForChildProcessGroupGone(child, 2_000);
		};
		const finish = async (exitCode: number | null, error?: unknown): Promise<void> => {
			if (settled) return;
			const groupGone = await teardownGroup();
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (hardKillTimer) {
				clearTimeout(hardKillTimer);
				hardKillTimer = undefined;
			}
			const durationMs = Date.now() - startedAt;
			const teardownError = groupGone ? undefined : "verification process group did not disappear within teardown bound";
			const passed = exitCode === 0 && !timedOut && !overflowed && !error && groupGone;
			resolve({ id: command.id, command: command.command, cwd, exitCode, status: timedOut ? "timed-out" : overflowed || !groupGone ? "failed" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed", stdout: trimOutput(stdout), stderr: error || teardownError ? `${stderr}${stderr ? "\n" : ""}${error instanceof Error ? error.message : error ? String(error) : teardownError}` : trimOutput(stderr), durationMs });
		};
		child.on("exit", () => { captureChildProcessGroupMembers(child, childIdentity?.pgid ?? pid); });
		child.on("close", (exitCode) => { captureChildProcessGroupMembers(child, childIdentity?.pgid ?? pid); void finish(exitCode); });
		child.on("error", (error) => { void finish(1, error); });
	});
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
	runtimeReviewEvidence?: string[];
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
	if (parsed.report) {
		// Runtime review evidence supplements (but never overrides) an explicitly
		// attested reviewFindings field. It is supplied only by the narrow collector.
		if (parsed.report.reviewFindings === undefined && input.runtimeReviewEvidence?.length) {
			parsed.report = { ...parsed.report, reviewFindings: input.runtimeReviewEvidence };
		}
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = runStructuralChecks(acceptance, parsed.report, input.cwd);
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (acceptance.verify.length > 0) {
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd));
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.review) {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
			const optionalReview = acceptance.review.required === false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: optionalReview ? "non-blocking" : "blocker",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child self-review or evidence alone.",
				}],
			};
			if (!optionalReview) ledger.status = "rejected";
		}
	}

	return ledger;
}


export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") return "Acceptance review required but no automatic reviewer result is available.";
	if (ledger.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}
