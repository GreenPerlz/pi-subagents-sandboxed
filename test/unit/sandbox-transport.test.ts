import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSandboxTransport } from "../../src/sandbox/config.ts";

describe("sandbox transport", () => {
	it("preserves an authorized explicit provider:none as null", () => {
		assert.equal(resolveSandboxTransport({
			settings: { allowSandboxOptOut: true },
			agent: { sandbox: { provider: "bubblewrap" } },
			run: { provider: "none" },
		}), null);
	});

	it("rejects an unauthorized explicit provider:none instead of treating it as omitted", () => {
		assert.throws(
			() => resolveSandboxTransport({ agent: { sandbox: { provider: "bubblewrap" } }, run: { provider: "none" } }),
			/Sandbox opt-out denied/,
		);
	});

	it("keeps omitted sandbox resolution on the normal Bubblewrap path", () => {
		assert.deepEqual(resolveSandboxTransport({
			settings: { allowSandboxOptOut: true },
			agent: { sandbox: { provider: "bubblewrap" } },
		}), { provider: "bubblewrap", gitMode: "read-only", auth: "pi-json" });
	});
});
