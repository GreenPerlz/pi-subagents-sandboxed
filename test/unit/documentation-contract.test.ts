import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { taskDisallowsFileUpdates } from "../../src/shared/settings.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function document(relativePath: string): string {
	return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function section(source: string, heading: RegExp, nextHeading = /^## /m): string {
	const start = source.search(heading);
	assert.notEqual(start, -1, `missing section ${heading}`);
	const body = source.slice(start + source.slice(start).indexOf("\n") + 1);
	const end = body.search(nextHeading);
	return end === -1 ? body : body.slice(0, end);
}

function codeBlocks(source: string): string[] {
	return [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function fencedBlockAfter(source: string, heading: RegExp): string {
	const headingMatch = heading.exec(source);
	assert.ok(headingMatch, `missing heading ${heading}`);
	const openingFence = source.indexOf("```", headingMatch.index + headingMatch[0].length);
	assert.notEqual(openingFence, -1, `missing fenced block after ${heading}`);
	const bodyStart = source.indexOf("\n", openingFence) + 1;
	const closingFence = source.indexOf("```", bodyStart);
	assert.notEqual(closingFence, -1, `unterminated fenced block after ${heading}`);
	return source.slice(bodyStart, closingFence);
}

function executableTaskValues(block: string): string[] {
	return [...block.matchAll(/\btask\s*:\s*"((?:\\.|[^"\\])*)"/gs)].map((match) => {
		const raw = match[1] ?? "";
		return JSON.parse(`"${raw}"`) as string;
	});
}

function conceptualCreationBodies(block: string): string[] {
	const starts = [...block.matchAll(/(?:^|\n)\s*(?:[A-Za-z_$][\w$]*\s*=\s*)?create delegation\s*:\s*/g)]
		.map((match) => (match.index ?? 0) + match[0].length);
	return starts.map((start, index) => block.slice(start, starts[index + 1] ?? block.length));
}

function assertMarkersInOrder(source: string, markers: RegExp[], message: string): void {
	let previous = -1;
	for (const marker of markers) {
		const relativeIndex = source.slice(previous + 1).search(marker);
		assert.ok(relativeIndex >= 0, `${message}: missing or out-of-order ${marker}`);
		previous += relativeIndex + 1;
	}
}

function terminalPublicationOperations(source: string): string[] {
	return source
		.split(/\r?\n/)
		.map((line) => line.replace(/[\\`*_]/g, "").replace(/\s+/g, " ").trim())
		.filter((line) => /^runtime\s+publishes?\b(?=[^.!?]*\battributed\b)(?=[^.!?]*\bterminal\b)(?=[^.!?]*\bresult\b)/i.test(line));
}

function assertSingleFinalWorkResult(task: string): void {
	assert.match(task, /Return one normal final task result containing changed files, validation, risks, and a reviewer handoff for a fresh reviewer/i);
	assert.equal((task.match(/\breturn\b/gi) ?? []).length, 1, "work task must request one final result, not sequential returns");
	assert.doesNotMatch(task, /\bthen return\b/i, "work task must not request a second return");
}

test("documentation names every packaged agent that discovery actually exposes", () => {
	const discovered = discoverAgentsAll(projectRoot).builtin.map((agent) => agent.name).sort();
	for (const required of ["explore", "orchestrator", "research", "review", "work"]) {
		assert.ok(discovered.includes(required), `${required} is not exposed by packaged discovery`);
	}

	const agentsDoc = document("docs/agents.md");
	for (const name of discovered) {
		assert.match(agentsDoc, new RegExp(`\\b${name}\\b`), `${name} is missing from packaged-agent documentation`);
	}

	const skill = document("skills/pi-subagents/SKILL.md");
	for (const name of discovered) {
		assert.match(skill, new RegExp("\\`" + name + "\\`"), `${name} is missing from the parent skill's packaged-agent table`);
	}
});

test("ownership and fresh-review documentation preserves the scoped Git boundary", () => {
	const migration = document("docs/delegation-migration.md");
	const contract = document("docs/agent-contract.md");
	const combined = `${migration}\n${contract}`.replace(/\s+/g, " ");

	assert.match(combined, /trusted parent owns the canonical checkout/i);
	assert.match(combined, /child must never stage,\s*commit,\s*reset,\s*merge,\s*or create\s+a worktree in that checkout/i);
	assert.match(combined, /runtime-owned private checkout with isolated Git/i);
	assert.match(combined, /writer.*authorized.*author.*commit/i);
	assert.match(combined, /fresh reviewer is an observation-only participant/i);
	assert.match(combined, /authored (?:history|base-to-head history).*tree.*base/i);
	assert.match(combined, /remaining (?:working-tree.*index|index.*working-tree) changes/i);
	assert.match(combined, /one authenticated scoped Git context/i);
	assert.match(combined, /writers are serialized/i);
	assert.match(combined, /handoffs are inline/i);
	assert.match(combined, /names.*task prose.*(?:do not grant|grant no)/is);
	assert.match(combined, /parent alone stages or commits the canonical checkout/i);
});

test("direct writer review uses an available disposable checkout before canonical integration", () => {
	const workflows = document("docs/workflows.md");
	const direct = section(workflows, /^### Direct writer: export, validate, review, then integrate/m, /^### Nested orchestrator:/m);
	const directText = direct.replace(/\s+/g, " ");
	assert.match(directText, /direct worker returns only after its original private scope has been exported and removed/i);
	assert.match(directText, /available disposable validation checkout/i);
	assert.match(directText, /review import is separate from canonical integration/i);

	const ordering = codeBlocks(direct).find((block) => /work authors commit in private isolated scope/i.test(block));
	assert.ok(ordering, "direct workflow must show the post-export review operations");
	assertMarkersInOrder(ordering, [
		/work\s+authors?\s+commit\s+.*private\s+isolated\s+scope/i,
		/runtime\s+exports?\s+authored\s+refs\s+and\s+removes?\s+.*private\s+scope/i,
		/parent\s+verifies?\s+bundle\s+and\s+prerequisites/i,
		/parent\s+imports?\s+authored\s+refs\s+into\s+disposable\s+(?:validation\s+)?checkout/i,
		/fresh\s+(?:observation-only\s+)?observer\s+reviews?\s+authored\s+base-to-head\s+history\/tree\s+and\s+remaining\s+diff\s+there/i,
		/trusted\s+parent\s+validates?\s+acceptance\s+and\s+integrates?\s+into\s+canonical\s+checkout/i,
	], "direct workflow ordering");
	assert.match(ordering, /disposable validation checkout/i);
	assert.match(ordering, /remaining diff there/i);
	assert.match(directText, /review verification\/import and canonical integration are different operations/i);
});

test("current writer task strings remain mutation-allowed while the observer task is restricted", () => {
	const piSkill = document("skills/pi-subagents/SKILL.md");
	const workOnIssues = document("skills/work-on-issues/SKILL.md");
	const workflows = document("docs/workflows.md");
	const orchestrator = document("agents/orchestrator.md");
	const writerTasks = [
		...executableTaskValues(fencedBlockAfter(piSkill, /^### Implement then review/m)),
		...executableTaskValues(fencedBlockAfter(piSkill, /^## Per-issue orchestrators/m)),
		...executableTaskValues(fencedBlockAfter(workOnIssues, /^### 2\. Launch one orchestrator/m)),
		...executableTaskValues(fencedBlockAfter(workflows, /^## Structured acceptance/m)),
		fencedBlockAfter(orchestrator, /^Work task:\s*$/m).trim(),
	];
	assert.equal(writerTasks.length, 5, "all documented current writer/orchestrator task strings must be extracted");
	for (const task of writerTasks) {
		const mutationProhibited = taskDisallowsFileUpdates(task);
		assert.equal(mutationProhibited, false, `writer task was classified as mutation-prohibited: ${task}`);
	}

	const observerTask = fencedBlockAfter(orchestrator, /^Review task:\s*$/m).trim();
	const mutationProhibited = taskDisallowsFileUpdates(observerTask);
	assert.equal(mutationProhibited, true, "observer task must remain restricted by the runtime classifier");
});

test("the extracted work task requests one structured final result", () => {
	const workTask = fencedBlockAfter(document("agents/orchestrator.md"), /^Work task:\s*$/m).trim();
	assert.doesNotThrow(() => assertSingleFinalWorkResult(workTask));

	const ambiguousTask = workTask.replace(
		/Return one normal final task result containing changed files, validation, risks, and a reviewer handoff for a fresh reviewer/i,
		"Return the final task result normally, then return changed files, validation, risks, and a reviewer handoff for a fresh reviewer",
	);
	assert.match(ambiguousTask, /Return the final task result normally, then return changed files/i);
	assert.throws(() => assertSingleFinalWorkResult(ambiguousTask), /one normal final task result|second return/);
});

test("pending batch examples state nonempty tasks, async creation, and later observation", () => {
	const migration = document("docs/delegation-migration.md");
	const target = section(migration, /^## #91 target:/m, /^## #99\//m);
	const targetBlocks = codeBlocks(target).join("\n");
	const targetText = target.replace(/\s+/g, " ");

	assert.match(targetText, /CONCEPTUAL PSEUDOCODE, NOT EXECUTABLE\s+API/i);
	assert.match(targetText, /one explicit, nonempty `tasks` array/i);
	assert.match(targetText, /always creates asynchronously/i);
	assert.match(targetText, /durable receipts immediately/i);
	assert.match(targetText, /observe results later/i);
	for (const label of ["One-task batch", "Multi-task batch", "Sequential submission", "Discovered fan-out"]) {
		assert.match(targetText, new RegExp(`### ${label} \\(target\\)`, "i"), `${label} example is missing`);
	}

	const creations = codeBlocks(target).flatMap(conceptualCreationBodies);
	assert.ok(creations.length >= 6, "target examples should cover each one-task, multi-task, sequential, and discovered creation");
	for (const [index, creation] of creations.entries()) {
		const taskArray = creation.match(/\btasks\s*:\s*(\[[\s\S]*?\])\s*(?:async\s*:|$)/)?.[1];
		assert.ok(taskArray, `conceptual creation ${index + 1} must have an explicit tasks array`);
		assert.match(taskArray, /^\[\s*\{/, `conceptual creation ${index + 1} must have a nonempty tasks array`);
		assert.match(creation, /\basync\s*:\s*true\b/, `conceptual creation ${index + 1} must be asynchronous`);
	}
	assert.match(targetBlocks, /tasks:\s*\[\s*\{[^\]]+\}\s*\]/s);
	assert.match(targetBlocks, /tasks:\s*\[[\s\S]*\{[\s\S]*\},[\s\S]*\{[\s\S]*\}[\s\S]*\]/);
});

test("pending native communication examples cover routing, correlation, lifecycle, and provenance", () => {
	const migration = document("docs/delegation-migration.md");
	const target = section(migration, /^## #99\/\#100\/\#95 target:/m, /^## Review passes and self-review/m);
	const targetBlocks = codeBlocks(target).join("\n");
	const targetText = target.replace(/\s+/g, " ");

	assert.match(targetText, /PENDING MIGRATION TARGETS.*CONCEPTUAL OPERATION DESCRIPTIONS/is);
	assert.match(targetText, /actual immediate parent/i);
	assert.match(targetText, /exact pending request correlation/i);
	assert.match(targetText, /arbitrary message\s+cannot answer/i);
	assert.match(targetText, /live follow-up.*distinct.*run-scoped/is);
	assert.match(targetText, /decision reply.*(?:separate|distinct)/is);
	assert.match(targetText, /terminal publication.*(?:separate|distinct)/is);
	assert.match(targetText, /revival remain separate operations/is);
	assert.match(targetText, /child returns its final task result normally/i);
	assert.match(targetText, /publishes exactly one terminal result attributed to that child\/run/i);
	assert.match(targetText, /does not send a second model-authored "completion" message/i);
	assert.match(targetText, /model-facing text.*delegated agent/i);
	assert.match(targetText, /transcript.*agent-authored/i);
	assert.match(targetText, /human approval.*system instructions.*developer instructions/is);
	assert.match(targetText, /runtime metadata authenticates routing/i);

	assert.doesNotMatch(targetBlocks, /intercom|global roster|alias|manual completion/i, "target examples must use native run-scoped operations");
	assert.match(targetBlocks, /decision-request/);
	assert.match(targetBlocks, /decision-reply/);
	assert.match(targetBlocks, /kind: \"follow-up\"/);
	assert.match(targetBlocks, /one attributed terminal result/);

	const terminalLifecycle = codeBlocks(target).find((block) => /\[PENDING #95 TARGET/i.test(block));
	assert.ok(terminalLifecycle, "terminal publication must have a dedicated pending lifecycle example");
	assertMarkersInOrder(terminalLifecycle, [
		/child returns final task result/i,
		/runtime completes acceptance validation/i,
		/runtime completes required teardown and export/i,
		/^runtime\s+publishes?\b(?=[^.!?]*\battributed\b)(?=[^.!?]*\bterminal\b)(?=[^.!?]*\bresult\b)/im,
	], "terminal lifecycle ordering");
	assert.equal(
		terminalPublicationOperations(terminalLifecycle).length,
		1,
		"terminal publication must be exactly one attributed runtime operation",
	);
	const alternatePublication = terminalLifecycle.replace(
		/\bruntime publishes exactly one attributed terminal result\b/i,
		"runtime publishes exactly one attributed terminal result\nruntime publishes another attributed terminal result",
	);
	assert.notEqual(
		terminalPublicationOperations(alternatePublication).length,
		1,
		"a differently worded second publication must violate the one-publication contract",
	);
	assert.doesNotMatch(terminalLifecycle, /decision-request|decision-reply|follow-up/i, "terminal publication must remain distinct from communication operations");
});

test("current commands remain documented separately from pending migration targets", () => {
	const migration = document("docs/delegation-migration.md");
	const workflows = document("docs/workflows.md");
	const current = section(migration, /^## Current behavior \(implemented now\)/m, /^## #91 target:/m);
	const currentText = current.replace(/\s+/g, " ");

	for (const command of ["/run", "/chain", "/run-chain", "/parallel", "--bg"]) {
		assert.ok(currentText.includes(command), `${command} is missing from current-workflow documentation`);
	}
	assert.match(currentText, /currently supported/i);
	assert.match(currentText, /not silently redefined/i);
	assert.match(migration, /#96 human.?approval boundary/i);
	assert.match(migration, /do not remove registrations/i);
	assert.match(workflows, /Implement, review, integrate/);
	const workflowsText = workflows.replace(/\s+/g, " ");
	assert.match(workflowsText, /fresh (?:reviewer|observer).*authored (?:history.*base diff|base-to-head history)/is);
	assert.doesNotMatch(migration, /provider:\s*none|fallback:\s*none|sandbox bypass/i);
});

test("work-loop reassessment is not confused with bounded acceptance self-review", () => {
	const migration = document("docs/delegation-migration.md");
	const orchestrator = document("agents/orchestrator.md");
	const skill = document("skills/pi-subagents/SKILL.md");
	const combined = `${migration}\n${orchestrator}\n${skill}`;

	assert.match(combined, /each five passes/i);
	assert.match(combined, /five is (?:a )?reassessment point|five is not a stop limit/i);
	assert.match(combined, /not a stop limit/i);
	assert.match(combined, /continue delegated work and fresh reviews until validation and review pass, or a genuine external blocker or required human decision prevents progress/i);
	assert.equal(
		(orchestrator.match(/If convergence stalls, reassess the delegation and review plan rather than stopping arbitrarily\./gi) ?? []).length,
		2,
		"both loop instructions must turn stalled convergence into reassessment",
	);
	assert.doesNotMatch(combined, /stop (?:when|after|at)\s+(?:two loops|one follow-up)/i);
	assert.doesNotMatch(orchestrator, /stop when[^.\n]*convergence has stalled/i);
	assert.doesNotMatch(combined, /(?:run|launch) exactly one follow-up `work` agent and stop/i);
});
