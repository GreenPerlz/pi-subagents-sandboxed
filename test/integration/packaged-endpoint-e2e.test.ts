import { after, before, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { executeAsyncChain } from "../../src/runs/background/async-execution.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { ASYNC_DIR, getAsyncConfigPath, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, makeMinimalCtx, type MockPi, removeTempDir } from "../support/helpers.ts";

const hasBubblewrap = process.platform === "linux" && spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;
const roots = new Set<string>();

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function createFixtureRepo(prefix: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.add(repo);
	git(repo, ["init", "--initial-branch=main"]);
	git(repo, ["config", "user.name", "Packaged Fixture Owner"]);
	git(repo, ["config", "user.email", "packaged-fixture@example.invalid"]);
	fs.mkdirSync(path.join(repo, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "packaged-endpoint-fixture", version: "1.0.0" }));
	writePackagedAgent(repo, "work", "read,edit,bash", "Write changes and commit them.");
	writePackagedAgent(repo, "review", "read,bash", "Inspect the checkout and record review findings. Do not modify files.");
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "base"]);
	return repo;
}

function writePackagedAgent(repo: string, localName: string, tools: string, body: string): void {
	fs.writeFileSync(path.join(repo, ".pi", "agents", `${localName}.md`), [
		"---",
		`name: ${localName}`,
		"package: fixture.pkg",
		`description: packaged ${localName} fixture agent`,
		`tools: ${tools}`,
		"systemPromptMode: replace",
		"inheritProjectContext: false",
		"inheritSkills: false",
		"---",
		body,
		"",
	].join("\n"));
}

function scopedEndpointEntries(): string[] {
	try { return fs.readdirSync("/tmp/pi-scoped-git/scopes").sort(); } catch { return []; }
}

function scopedEndpointEntriesMatch(expected: string[]): boolean {
	return JSON.stringify(scopedEndpointEntries()) === JSON.stringify(expected);
}

function fixtureAgents(repo: string) {
	const result = discoverAgents(repo, "project");
	const agents = result.agents.filter((agent) => agent.name === "fixture.pkg.work" || agent.name === "fixture.pkg.review");
	assert.deepEqual(agents.map((agent) => agent.name).sort(), ["fixture.pkg.review", "fixture.pkg.work"]);
	assert.ok(agents.every((agent) => agent.packageName === "fixture.pkg" && agent.source === "project"));
	return agents;
}

function resultBundle(result: { details: { results: Array<{ gitBundle?: Record<string, unknown> }> } }): Record<string, unknown> {
	const bundles = result.details.results.map((item) => item.gitBundle).filter((bundle): bundle is Record<string, unknown> => Boolean(bundle));
	assert.equal(bundles.length, 1, "shared sequential owner must export exactly one bundle");
	return bundles[0]!;
}

function cloneBundle(bundlePath: string, baseRepo: string): string {
	const clone = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-bundle-clone-"));
	roots.add(clone);
	let result = spawnSync("git", ["clone", "-q", baseRepo, clone]);
	assert.equal(result.status, 0, result.stderr?.toString());
	result = spawnSync("git", ["-C", clone, "fetch", "-q", bundlePath, "refs/heads/isolated-0"]);
	assert.equal(result.status, 0, result.stderr?.toString());
	result = spawnSync("git", ["-C", clone, "checkout", "-q", "FETCH_HEAD"]);
	assert.equal(result.status, 0, result.stderr?.toString());
	return clone;
}

function cloneBaseRepo(baseRepo: string, prefix: string): string {
	const clone = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.add(clone);
	const result = spawnSync("git", ["clone", "-q", baseRepo, clone], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	git(clone, ["config", "user.name", "Packaged Recipe User"]);
	git(clone, ["config", "user.email", "packaged-recipe@example.invalid"]);
	return clone;
}

function fetchBundleRefs(clone: string, bundlePath: string): void {
	git(clone, ["fetch", "-q", bundlePath,
		"refs/heads/isolated-0:refs/review/head",
		"refs/isolated/recovery-0:refs/review/recovery",
		"refs/isolated/staged-0:refs/review/staged",
	]);
}

function applyDiff(clone: string, base: string, finalRef: string): void {
	const diff = spawnSync("git", ["-C", clone, "diff", base, finalRef], { encoding: "utf8" });
	assert.equal(diff.status, 0, diff.stderr);
	const applied = spawnSync("git", ["-C", clone, "apply"], { input: diff.stdout, encoding: "utf8" });
	assert.equal(applied.status, 0, applied.stderr);
}

function watcherState(cwd: string): any {
	return {
		baseCwd: cwd,
		currentSessionId: "packaged-session",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		watcher: null,
		watcherRestartTimer: null,
		completionSeen: new Map(),
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail("timed out waiting for packaged async workflow");
}

describe("genuine packaged endpoint workflows", { skip: !hasBubblewrap ? "Linux Bubblewrap is required" : undefined }, () => {
	let mockPi: MockPi;
	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	after(() => mockPi.uninstall());
	afterEach(() => {
		for (const root of roots) removeTempDir(root);
		roots.clear();
	});

	it("runs packaged work/review A→B stages through one foreground owner and one export", async () => {
		const repo = createFixtureRepo("packaged-foreground-e2e-");
		const agents = fixtureAgents(repo);
		const baseHead = git(repo, ["rev-parse", "HEAD"]);
		const parentStatus = git(repo, ["status", "--porcelain=v1"]);
		const parentIndex = git(repo, ["diff", "--cached", "--name-only"]);
		const runId = `packaged-foreground-${Date.now().toString(36)}`;
		const runtimePrefix = `pi-isolated-git-${runId}-isolated-`;
		const runtimeBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix)));
		const endpointBefore = scopedEndpointEntries();
		const artifactsDir = path.join(os.tmpdir(), `${runId}-artifacts`);
		roots.add(artifactsDir);
		roots.add(path.join(TEMP_ROOT_DIR, "chain-runs", runId));
		mockPi.reset();
		mockPi.onCall({ output: "work A committed", commands: ["printf 'A\\n' > A.txt && git add A.txt && git commit -m 'A'"] });
		mockPi.onCall({ output: "review saw A", commands: ["test \"$(git log -1 --format=%s)\" = A && if git add A.txt; then exit 42; else printf 'review mutation denied\\n'; fi"] });
		mockPi.onCall({ output: "work B committed", commands: ["printf 'B\\n' > B.txt && git add B.txt && git commit -m 'B'"] });
		mockPi.onCall({ output: "review saw B", commands: ["test \"$(git log -1 --format=%s)\" = B && if git add B.txt; then exit 42; else printf 'review mutation denied\\n'; fi"] });

		const execution = await executeChain({
			chain: [
				{ agent: "fixture.pkg.work", task: "Edit and commit A." },
				{ agent: "fixture.pkg.review", task: "Inspect A and record review output without modifying files." },
				{ agent: "fixture.pkg.work", task: "Edit and commit B." },
				{ agent: "fixture.pkg.review", task: "Inspect B and record review output without modifying files." },
			],
			agents,
			ctx: makeMinimalCtx(repo), cwd: repo, runId, shareEnabled: false,
			sessionDirForIndex: () => undefined, artifactsDir, artifactConfig: { enabled: false },
			sandbox: { provider: "bubblewrap", gitMode: "isolated", network: "none", extraWritableMounts: [mockPi.dir] },
			clarify: false, includeProgress: false,
		} as never);
		assert.equal(execution.isError, undefined, execution.content[0]?.text);
		assert.equal(execution.details.results.length, 4);
		assert.deepEqual(execution.details.results.map((item) => item.agent), ["fixture.pkg.work", "fixture.pkg.review", "fixture.pkg.work", "fixture.pkg.review"]);
		assert.ok(execution.details.results.every((item) => item.exitCode === 0), JSON.stringify(execution.details.results));
		assert.match(execution.details.results[1]?.finalOutput ?? "", /review saw A/);
		assert.match(execution.details.results[3]?.finalOutput ?? "", /review saw B/);
		const bundle = resultBundle(execution);
		assert.equal(bundle.base, baseHead);
		assert.equal(bundle.incomplete, false);
		assert.deepEqual((bundle.commits as Array<{ subject: string; author: string }>).map((commit) => commit.subject).sort(), ["A", "B"]);
		assert.ok((bundle.commits as Array<{ author: string }>).every((commit) => commit.author.includes("Packaged Fixture Owner")));
		const clone = cloneBundle(String(bundle.path), repo);
		assert.equal(git(clone, ["rev-list", "--count", "HEAD"]), "3");
		assert.equal(git(clone, ["log", "--format=%s", "--reverse"]), "base\nA\nB");
		assert.equal(fs.readFileSync(path.join(clone, "A.txt"), "utf8"), "A\n");
		assert.equal(fs.readFileSync(path.join(clone, "B.txt"), "utf8"), "B\n");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), baseHead);
		assert.equal(git(repo, ["status", "--porcelain=v1"]), parentStatus);
		assert.equal(git(repo, ["diff", "--cached", "--name-only"]), parentIndex);
		assert.equal(fs.existsSync(path.join(repo, "A.txt")), false);
		assert.equal(fs.existsSync(path.join(repo, "B.txt")), false);
		assert.equal(fs.existsSync(path.join(repo, ".git", "A.txt")), false);
		assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(runtimePrefix) && !runtimeBefore.has(entry)), []);
		await waitFor(() => scopedEndpointEntriesMatch(endpointBefore) ? true : undefined, 5_000);
		assert.deepEqual(scopedEndpointEntries(), endpointBefore, "foreground endpoint sockets must close after export cleanup");
		assert.equal(fs.existsSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", runId)), false);
	});

	it("executes ordinary Git review, cherry-pick, and final-state recipes from an exported bundle", async () => {
		const repo = createFixtureRepo("packaged-git-recipes-e2e-");
		const agents = fixtureAgents(repo);
		const baseHead = git(repo, ["rev-parse", "HEAD"]);
		const endpointBefore = scopedEndpointEntries();
		const runId = `packaged-git-recipes-${Date.now().toString(36)}`;
		const artifactsDir = path.join(os.tmpdir(), `${runId}-artifacts`);
		roots.add(artifactsDir);
		roots.add(path.join(TEMP_ROOT_DIR, "chain-runs", runId));
		mockPi.reset();
		mockPi.onCall({
			output: "authored commit and final state",
			commands: ["printf 'committed\\n' > committed.txt && git add committed.txt && git commit -m 'authored' && printf 'staged\\n' > staged.txt && git add staged.txt && printf 'final base\\n' > base.txt && printf 'uncommitted\\n' > uncommitted.txt"],
		});

		const execution = await executeChain({
			chain: [{ agent: "fixture.pkg.work", task: "Commit the authored change, then leave staged and uncommitted final state." }],
			agents, ctx: makeMinimalCtx(repo), cwd: repo, runId, shareEnabled: false,
			sessionDirForIndex: () => undefined, artifactsDir, artifactConfig: { enabled: false },
			sandbox: { provider: "bubblewrap", gitMode: "isolated", network: "none", extraWritableMounts: [mockPi.dir] },
			clarify: false, includeProgress: false,
		} as never);
		const bundle = resultBundle(execution);
		assert.equal(bundle.base, baseHead);
		assert.ok(typeof bundle.recovery === "string", "final recovery ref must be exported");
		assert.ok(typeof bundle.stagedSnapshot === "string", "staged snapshot ref must be exported");
		const bundlePath = String(bundle.path);

		// A temporary review checkout is the safe place to fetch and inspect every
		// exported ref before touching the base repository.
		const review = cloneBaseRepo(repo, "packaged-git-review-checkout-");
		fetchBundleRefs(review, bundlePath);
		assert.equal(git(review, ["rev-parse", "refs/review/head"]), String(bundle.head));
		assert.equal(git(review, ["rev-parse", "refs/review/recovery"]), String(bundle.recovery));
		assert.equal(git(review, ["rev-parse", "refs/review/staged"]), String(bundle.stagedSnapshot));
		assert.equal(git(review, ["log", "--format=%s", `${baseHead}..refs/review/head`]), "authored");
		assert.equal(git(review, ["show", "--format=%s", "--no-patch", "refs/review/recovery"]), "Pi runtime recovery snapshot");
		assert.equal(git(review, ["show", "--format=%s", "--no-patch", "refs/review/staged"]), "Pi runtime staged-state snapshot");
		git(review, ["checkout", "-q", "refs/review/recovery"]);
		assert.equal(fs.readFileSync(path.join(review, "committed.txt"), "utf8"), "committed\n");
		assert.equal(fs.readFileSync(path.join(review, "staged.txt"), "utf8"), "staged\n");
		assert.equal(fs.readFileSync(path.join(review, "base.txt"), "utf8"), "final base\n");
		assert.equal(fs.readFileSync(path.join(review, "uncommitted.txt"), "utf8"), "uncommitted\n");

		// The authored commit recipe integrates only the authored history into a
		// separate clone of the base repository.
		const cherryPick = cloneBaseRepo(repo, "packaged-git-cherry-pick-");
		fetchBundleRefs(cherryPick, bundlePath);
		const authoredCommits = git(cherryPick, ["rev-list", "--reverse", `${baseHead}..refs/review/head`]).split("\n").filter(Boolean);
		assert.deepEqual(authoredCommits.length, 1);
		git(cherryPick, ["cherry-pick", ...authoredCommits]);
		assert.equal(git(cherryPick, ["log", "--format=%s", "--reverse"]), "base\nauthored");
		assert.equal(fs.readFileSync(path.join(cherryPick, "committed.txt"), "utf8"), "committed\n");
		assert.equal(fs.existsSync(path.join(cherryPick, "staged.txt")), false, "cherry-pick must not include final dirty state");

		// Applying the recovery diff and adding it produces a squash-ready staged
		// result without creating an automatic integration commit.
		const staged = cloneBaseRepo(repo, "packaged-git-staged-squash-");
		fetchBundleRefs(staged, bundlePath);
		applyDiff(staged, baseHead, "refs/review/recovery");
		git(staged, ["add", "-A"]);
		assert.match(git(staged, ["diff", "--cached", "--name-status"]), /committed\.txt/);
		assert.match(git(staged, ["diff", "--cached", "--name-status"]), /staged\.txt/);
		assert.match(git(staged, ["diff", "--cached", "--name-status"]), /uncommitted\.txt/);
		assert.match(git(staged, ["diff", "--cached", "--name-status"]), /base\.txt/);
		assert.equal(git(staged, ["rev-parse", "HEAD"]), baseHead);

		// The same final-state diff can intentionally remain uncommitted and
		// unstaged by omitting git add.
		const unstaged = cloneBaseRepo(repo, "packaged-git-unstaged-squash-");
		fetchBundleRefs(unstaged, bundlePath);
		applyDiff(unstaged, baseHead, "refs/review/recovery");
		assert.equal(git(unstaged, ["diff", "--cached", "--name-only"]), "");
		assert.match(git(unstaged, ["status", "--porcelain=v1"]), /M base\.txt|\?\? base\.txt/);
		assert.match(git(unstaged, ["status", "--porcelain=v1"]), /committed\.txt/);
		assert.equal(git(unstaged, ["rev-parse", "HEAD"]), baseHead);

		// Export and review never integrate into the caller's base repository.
		assert.equal(git(repo, ["rev-parse", "HEAD"]), baseHead);
		assert.equal(git(repo, ["status", "--porcelain=v1"]), "");
		assert.equal(fs.existsSync(path.join(repo, "committed.txt")), false);
		assert.equal(fs.existsSync(path.join(repo, "uncommitted.txt")), false);
		await waitFor(() => scopedEndpointEntriesMatch(endpointBefore) ? true : undefined, 5_000);
		assert.deepEqual(scopedEndpointEntries(), endpointBefore, "recipe endpoint sockets must close after export cleanup");
		assert.equal(fs.existsSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", runId)), false);
	});

	it("runs the same packaged stages through detached runner, status, watcher and intercom", async () => {
		const repo = createFixtureRepo("packaged-async-e2e-");
		const agents = fixtureAgents(repo);
		const baseHead = git(repo, ["rev-parse", "HEAD"]);
		const id = `packaged-async-${Date.now().toString(36)}`;
		const sessionRoot = path.join(repo, "sessions");
		const endpointBefore = scopedEndpointEntries();
		const eventBus = createEventBus();
		const state = watcherState(repo);
		let completion: any;
		let intercom: any;
		eventBus.on("subagent:async-complete", (payload) => { if ((payload as { runId?: string }).runId === id) completion = payload; });
		eventBus.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
			intercom = payload;
			eventBus.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: (payload as { requestId?: string }).requestId, delivered: true });
		});
		const watcher = createResultWatcher({ events: eventBus }, state, RESULTS_DIR, 60_000);
		watcher.startResultWatcher();
		mockPi.reset();
		mockPi.onCall({ output: "work A committed", commands: ["printf 'A\\n' > A.txt && git add A.txt && git commit -m 'A'"] });
		mockPi.onCall({ output: "review saw A", commands: ["test \"$(git log -1 --format=%s)\" = A && if git add A.txt; then exit 42; else printf 'review mutation denied\\n'; fi"] });
		mockPi.onCall({ output: "work B committed", commands: ["printf 'B\\n' > B.txt && git add B.txt && git commit -m 'B'"] });
		mockPi.onCall({ output: "review saw B", commands: ["test \"$(git log -1 --format=%s)\" = B && if git add B.txt; then exit 42; else printf 'review mutation denied\\n'; fi"] });
		try {
			const started = executeAsyncChain(id, {
				chain: [
					{ agent: "fixture.pkg.work", task: "Edit and commit A." },
					{ agent: "fixture.pkg.review", task: "Inspect A and record review output without modifying files." },
					{ agent: "fixture.pkg.work", task: "Edit and commit B." },
					{ agent: "fixture.pkg.review", task: "Inspect B and record review output without modifying files." },
				],
				resultMode: "chain", agents, ctx: { pi: { events: eventBus }, cwd: repo, currentSessionId: "packaged-session" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot, maxSubagentDepth: 2, controlIntercomTarget: "orchestrator",
				sandbox: { provider: "bubblewrap", gitMode: "isolated", network: "none", extraWritableMounts: [mockPi.dir] },
			} as never);
			assert.equal(started.isError, undefined, started.content[0]?.text);
			const configPath = getAsyncConfigPath(id);
			await waitFor(() => fs.existsSync(configPath) ? configPath : undefined, 5_000);
			assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
			const statusPath = path.join(ASYNC_DIR, id, "status.json");
			await waitFor(() => fs.existsSync(statusPath) ? statusPath : undefined, 10_000);
			await waitFor(() => completion, 30_000);
			assert.equal(completion.success, true, JSON.stringify(completion));
			assert.equal(completion.state, "complete");
			assert.deepEqual(completion.results.map((item: any) => item.agent), ["fixture.pkg.work", "fixture.pkg.review", "fixture.pkg.work", "fixture.pkg.review"]);
			assert.ok(completion.results.every((item: any) => item.success === true), JSON.stringify(completion));
			const bundles = completion.results.map((item: any) => item.gitBundle).filter(Boolean);
			assert.equal(bundles.length, 1);
			assert.equal(bundles[0].base, baseHead);
			assert.equal(bundles[0].incomplete, false);
			assert.deepEqual((bundles[0].commits as Array<{ subject: string }>).map((commit) => commit.subject).sort(), ["A", "B"]);
			assert.equal(intercom?.children?.length, 4, JSON.stringify(intercom));
			assert.deepEqual(intercom.children.map((child: any) => child.agent), ["fixture.pkg.work", "fixture.pkg.review", "fixture.pkg.work", "fixture.pkg.review"]);
			assert.equal(git(repo, ["rev-parse", "HEAD"]), baseHead);
			assert.equal(git(repo, ["status", "--porcelain=v1"]), "");
			assert.equal(fs.existsSync(path.join(repo, "A.txt")), false);
			assert.equal(fs.existsSync(path.join(repo, "B.txt")), false);
			assert.equal(fs.existsSync(configPath), false, "runner config must be consumed");
			if (fs.existsSync(statusPath)) {
				const terminalStatus = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { state?: string; error?: string };
				assert.equal(terminalStatus.state, "complete");
				assert.equal(terminalStatus.error, undefined);
			}
			await waitFor(() => scopedEndpointEntriesMatch(endpointBefore) ? true : undefined, 5_000);
			assert.deepEqual(scopedEndpointEntries(), endpointBefore, "async endpoint sockets must close before watcher publication");
			assert.equal(fs.existsSync(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", id)), false);
		} finally {
			watcher.stopResultWatcher();
		}
	});

	it("allows packaged writers concurrently only on distinct isolated worktrees", async () => {
		const repo = createFixtureRepo("packaged-overlap-e2e-");
		const agents = fixtureAgents(repo);
		const baseHead = git(repo, ["rev-parse", "HEAD"]);
		const runId = `packaged-overlap-${Date.now().toString(36)}`;
		const artifactsDir = path.join(os.tmpdir(), `${runId}-artifacts`);
		roots.add(artifactsDir);
		roots.add(path.join(TEMP_ROOT_DIR, "chain-runs", runId));
		mockPi.reset();
		mockPi.onCall({ output: "parallel A", commands: ["printf 'parallel A\\n' > parallel-a.txt && git add parallel-a.txt && git commit -m 'parallel A'"] });
		mockPi.onCall({ output: "parallel B", commands: ["printf 'parallel B\\n' > parallel-b.txt && git add parallel-b.txt && git commit -m 'parallel B'"] });
		const execution = await executeChain({
			chain: [{ parallel: [
				{ agent: "fixture.pkg.work", task: "Edit and commit parallel A." },
				{ agent: "fixture.pkg.work", task: "Edit and commit parallel B." },
			] }],
			agents, ctx: makeMinimalCtx(repo), cwd: repo, runId, shareEnabled: false,
			sessionDirForIndex: () => undefined, artifactsDir, artifactConfig: { enabled: false },
			sandbox: { provider: "bubblewrap", gitMode: "isolated", network: "none", extraWritableMounts: [mockPi.dir] },
			clarify: false, includeProgress: false,
			teardownHooks: { waitForNestedDescendantsToStop: async () => ({ observed: true, stopped: true }) },
		} as never);
		assert.equal(execution.isError, undefined, execution.content[0]?.text);
		assert.equal(execution.details.results.length, 2);
		assert.ok(execution.details.results.every((item) => item.exitCode === 0), JSON.stringify(execution.details.results));
		assert.equal(new Set(execution.details.results.map((item) => item.gitBundle?.base)).size, 1);
		assert.equal(execution.details.results.every((item) => item.gitBundle?.base === baseHead), true);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), baseHead);
		assert.equal(git(repo, ["status", "--porcelain=v1"]), "");
	});
});
