#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-issue-15-repro-"));
const log = [];

function event(type, details = {}) {
  const entry = { index: log.length + 1, type, ...details };
  log.push(entry);
  console.log(`${String(entry.index).padStart(2, "0")} ${type} ${JSON.stringify(details)}`);
  return entry;
}

function initSafeRepo() {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# issue-15 safe repro fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=Issue15", "-c", "user.email=issue15@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: repoDir });
  event("safe_fixture_ready", { repoDir });
}

function validateSubagentParams(params) {
  const modes = ["agent" in params, Array.isArray(params.tasks), Array.isArray(params.chain)].filter(Boolean).length;
  if (modes !== 1) return { ok: false, reason: "tool-contract validation failure: use exactly one execution mode" };
  if (Array.isArray(params.tasks)) {
    for (const [i, task] of params.tasks.entries()) {
      if (!task || typeof task.agent !== "string" || typeof task.task !== "string") {
        return { ok: false, reason: `tool-contract validation failure: tasks[${i}] requires string agent and task` };
      }
    }
  }
  if (params.async !== undefined && typeof params.async !== "boolean") {
    return { ok: false, reason: "tool-contract validation failure: async must be boolean" };
  }
  return { ok: true };
}

class AsyncLauncher {
  constructor() {
    this.running = new Map();
    this.next = 1;
  }

  launch(params) {
    const activeBefore = this.running.size;
    const runId = `issue15-worker-${this.next++}`;
    this.running.set(runId, { params, state: "running" });
    event("async_start", {
      runId,
      agent: params.agent ?? params.tasks?.[0]?.agent,
      async: params.async === true,
      activeWorkersBefore: activeBefore,
      activeWorkersAfter: this.running.size,
    });
    return { runId, state: "running", completed: false };
  }
}

class RalphOrchestratorSimulator {
  constructor(launcher) {
    this.launcher = launcher;
  }

  nestedSubagentCall(params, note) {
    event("nested_subagent_attempt", { by: "ralph-orchestrator", note, params });
    const validation = validateSubagentParams(params);
    if (!validation.ok) {
      event("validation_failed", { by: "subagent tool contract", reason: validation.reason });
      return { ok: false, validation };
    }
    if (params.async === true) return { ok: true, result: this.launcher.launch(params) };
    event("sync_start", { agent: params.agent, completed: false });
    return { ok: true, result: { state: "running" } };
  }

  runRunawayPattern() {
    // Prompt failure: after a malformed nested call is rejected, the orchestrator keeps trying
    // nested subagent calls instead of stopping or asking for a supervisor decision.
    this.nestedSubagentCall(
      { tasks: [{ agent: "worker" }], async: true },
      "malformed parallel task: missing required task string",
    );
    this.nestedSubagentCall(
      { tasks: [{ agent: "worker" }], async: true },
      "runaway retry after validation failure with the same malformed call",
    );

    // Async behavior: a successful async call returns after the worker is started, not after it
    // completes. Without a parent-side pending-launch guard, a second async call can start while
    // the first worker is still running.
    this.nestedSubagentCall(
      { agent: "worker", task: "Research issue #15 fixture A; sleep before completing", async: true },
      "first well-formed async worker launch",
    );
    this.nestedSubagentCall(
      { agent: "worker", task: "Duplicate issue #15 fixture B launched before A completes", async: true },
      "second async launch before first worker completion",
    );
  }
}

initSafeRepo();
const launcher = new AsyncLauncher();
const orchestrator = new RalphOrchestratorSimulator(launcher);
orchestrator.runRunawayPattern();

const repeatedNestedAttempts = log.filter((entry) => entry.type === "nested_subagent_attempt").length;
const validationFailures = log.filter((entry) => entry.type === "validation_failed").length;
const asyncStarts = log.filter((entry) => entry.type === "async_start");
const secondAsyncBeforeFirstCompleted = asyncStarts.some((entry) => entry.activeWorkersBefore > 0);

const summary = {
  repoDir,
  repeatedNestedAttempts,
  validationFailures,
  asyncStarts: asyncStarts.length,
  secondAsyncBeforeFirstCompleted,
  interventionPoint: "after validation_failed and before any retry/duplicate async_start, a ralph-orchestrator nested-launch guard should halt or request supervision",
  rootCause: {
    promptFailure: "ralph-orchestrator retries nested subagent calls after a validation failure instead of stopping",
    toolContractValidationFailure: "malformed tasks[0] missing task string is rejected before any worker starts",
    asyncLaunchBehavior: "async:true records a running worker and returns immediately, allowing another launch while activeWorkersBefore > 0",
    sandboxWorktreeFailure: "not involved in this fixture; the temp git repo is initialized cleanly and no worktree/sandbox setup failure is injected",
  },
};

fs.writeFileSync(path.join(repoDir, "issue-15-repro-log.json"), `${JSON.stringify({ log, summary }, null, 2)}\n`);
event("summary", summary);

if (repeatedNestedAttempts < 4 || validationFailures < 2 || asyncStarts.length < 2 || !secondAsyncBeforeFirstCompleted) {
  console.error("issue #15 reproduction assertions failed", summary);
  process.exit(1);
}
