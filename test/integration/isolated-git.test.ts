import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScopedGitCommand } from "../../src/sandbox/scoped-git-endpoint.ts";

describe("isolated Git lifecycle migration", () => {
	it("keeps the public isolated runtime surface on scoped endpoint policy", () => {
		assert.doesNotThrow(() => validateScopedGitCommand(["status"], "read-only"));
		assert.throws(() => validateScopedGitCommand(["commit"], "read-only"), /rejects/);
	});
});
