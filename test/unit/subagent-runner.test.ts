import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAuthorityEnvironment } from "../../src/runs/shared/pi-args.ts";

describe("scoped endpoint runner", () => {
	it("strips endpoint descriptors from ambient child environments", () => {
		const clean = sanitizeAuthorityEnvironment({ PI_SUBAGENT_SCOPED_GIT_ENDPOINT: "{\"relativeSubtree\":\".\"}", PI_SUBAGENT_RUN_ID: "run", PATH: "/bin" });
		assert.equal(clean.PI_SUBAGENT_SCOPED_GIT_ENDPOINT, undefined);
		assert.equal(clean.PI_SUBAGENT_RUN_ID, undefined);
		assert.equal(clean.PATH, "/bin");
	});
});
