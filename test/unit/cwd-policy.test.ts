import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { evaluateCwdPolicy, normalizeAuthorizedCwds, resolveExplicitCwd, validateCwdPolicy } from "../../src/runs/shared/cwd-policy.ts";
import { makeAgent } from "../support/helpers.ts";

function fixture(): { root: string; actual: string; child: string; outside: string; sibling: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-policy-"));
	const actual = path.join(root, "actual");
	const child = path.join(actual, "child");
	const outside = path.join(root, "outside");
	const sibling = path.join(root, "actual-sibling");
	for (const directory of [actual, child, outside, sibling]) fs.mkdirSync(directory, { recursive: true });
	return { root, actual, child, outside, sibling };
}

describe("descendant cwd policy", () => {
	it("uses canonical containment and rejects missing, files, NUL, and prefix siblings", () => {
		const f = fixture();
		try {
			fs.writeFileSync(path.join(f.actual, "file"), "x");
			fs.symlinkSync(f.child, path.join(f.actual, "inward"));
			fs.symlinkSync(f.outside, path.join(f.actual, "outward"));
			const alias = path.join(f.root, "actual-alias");
			fs.symlinkSync(f.actual, alias);
			const context = { invokingCwd: f.actual };
			assert.equal((resolveExplicitCwd(context, ".") as { implicitAllowed: boolean }).implicitAllowed, true);
			assert.equal((resolveExplicitCwd(context, "child") as { implicitAllowed: boolean }).implicitAllowed, true);
			assert.equal((resolveExplicitCwd(context, "inward") as { implicitAllowed: boolean }).implicitAllowed, true);
			assert.equal((resolveExplicitCwd(context, "outward") as { implicitAllowed: boolean }).implicitAllowed, false);
			assert.equal((resolveExplicitCwd({ invokingCwd: alias }, "child") as { implicitAllowed: boolean }).implicitAllowed, true);
			assert.equal((resolveExplicitCwd({ invokingCwd: alias }, "../outside") as { implicitAllowed: boolean }).implicitAllowed, false);
			assert.equal((resolveExplicitCwd(context, "../actual-sibling") as { implicitAllowed: boolean }).implicitAllowed, false);
			assert.match((resolveExplicitCwd(context, "missing") as { error: string }).error, /does not exist/);
			assert.match((resolveExplicitCwd(context, "file") as { error: string }).error, /not a directory/);
			assert.match((resolveExplicitCwd(context, "bad\0cwd") as { error: string }).error, /NUL/);
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("requires cwd permission only for targets outside the invoking directory and checks every repeated occurrence", () => {
		const f = fixture();
		try {
			const agent = makeAgent("worker", { canBeChangedByAgent: [] });
			const params = {
				tasks: [
					{ agent: "worker", task: "child", cwd: "child" },
					{ agent: "worker", task: "outside", cwd: "../outside" },
				],
			};
		const denied = validateCwdPolicy(params, [agent], { invokingCwd: f.actual });
		assert.equal(denied.length, 1);
		assert.deepEqual(denied[0]!.paths, ["cwd"]);
		const permitted = makeAgent("worker", { canBeChangedByAgent: ["cwd"] });
		assert.deepEqual(validateCwdPolicy(params, [permitted], { invokingCwd: f.actual }), []);
	} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("collects static and dynamic group cwd occurrences against the trusted base", () => {
		const f = fixture();
		try {
			const agent = makeAgent("worker", { canBeChangedByAgent: [] });
			const params = {
				chain: [
					{ parallel: [{ agent: "worker", task: "a" }], cwd: "../outside" },
					{ expand: { from: { output: "items", path: "/items" } }, cwd: "../outside", parallel: { agent: "worker", task: "{item}" }, collect: { as: "results" } },
				],
			};
		const denied = validateCwdPolicy(params, [agent], { invokingCwd: f.actual });
		assert.equal(denied.length, 2);
	} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("fails closed when an outside target is absent from trusted discovery", () => {
		const f = fixture();
		try {
			const params = { agent: "worker", cwd: "../outside" };
			assert.equal(validateCwdPolicy(params, [], { invokingCwd: f.actual }).length, 1);
			assert.equal(validateCwdPolicy({ agent: "worker", cwd: "child" }, [], { invokingCwd: f.actual }).length, 0);
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("normalizes every admitted cwd field to the authorized canonical identity", () => {
		const f = fixture();
		try {
			fs.symlinkSync(f.child, path.join(f.actual, "inward"));
			const agent = makeAgent("worker");
			const cases = [
				{ params: { agent: "worker", cwd: "inward" }, label: "single" },
				{ params: { tasks: [{ agent: "worker", task: "task", cwd: "inward" }] }, label: "top-level task" },
				{ params: { chain: [{ agent: "worker", task: "sequential", cwd: "inward" }] }, label: "sequential chain" },
				{ params: { chain: [{ parallel: [{ agent: "worker", task: "static", cwd: "inward" }], cwd: "child" }] }, label: "static group" },
				{ params: { chain: [{ expand: { from: { output: "items", path: "/items" } }, parallel: { agent: "worker", task: "dynamic", cwd: "inward" }, collect: { as: "results" }, cwd: "child" }] }, label: "dynamic group" },
			] as const;
			for (const { params, label } of cases) {
				const evaluation = evaluateCwdPolicy(params, [agent], { invokingCwd: f.actual });
				assert.deepEqual(evaluation.violations, [], label);
				const normalized = normalizeAuthorizedCwds(params, evaluation.resolutions);
				assert.equal("error" in normalized, false, label);
				const values = JSON.stringify(normalized);
				assert.doesNotMatch(values, /\"cwd\":\"inward\"/); // no lexical aliases survive
				assert.ok(values.includes(f.child), label);
			}
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("keeps the admitted directory when an inward alias is retargeted later", () => {
		const f = fixture();
		try {
			fs.symlinkSync(f.child, path.join(f.actual, "inward"));
			const params = { chain: [{ agent: "worker", task: "later", cwd: "inward" }] };
			const evaluation = evaluateCwdPolicy(params, [makeAgent("worker")], { invokingCwd: f.actual });
			assert.deepEqual(evaluation.violations, []);
			fs.unlinkSync(path.join(f.actual, "inward"));
			fs.symlinkSync(f.outside, path.join(f.actual, "inward"));
			const normalized = normalizeAuthorizedCwds(params, evaluation.resolutions);
			assert.equal("error" in normalized, false);
			assert.equal((normalized as typeof params).chain[0]!.cwd, f.child);
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});
});
