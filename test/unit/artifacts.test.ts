import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupOldArtifacts } from "../../src/shared/artifacts.ts";

describe("artifact cleanup", () => {
	it("recursively cleans stale isolated bundle directories while retaining fresh bundles", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-cleanup-"));
		const bundles = path.join(root, "isolated-git-bundles");
		fs.mkdirSync(bundles, { recursive: true });
		const stale = path.join(bundles, "stale.bundle");
		const fresh = path.join(bundles, "fresh.bundle");
		fs.writeFileSync(stale, "stale");
		fs.writeFileSync(fresh, "fresh");
		const oldSeconds = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(stale, oldSeconds, oldSeconds);
		cleanupOldArtifacts(root, 7);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(fresh), true);
		fs.rmSync(root, { recursive: true, force: true });
	});
});
