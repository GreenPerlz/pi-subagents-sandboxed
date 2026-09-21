import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { prepareEphemeralPiAgentDir } from "../../src/sandbox/ephemeral-auth.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(models?: unknown) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-private-model-limits-"));
	roots.push(root);
	const sourceAgentDir = path.join(root, "source");
	const tempDir = path.join(root, "run");
	fs.mkdirSync(sourceAgentDir);
	fs.mkdirSync(tempDir);
	fs.writeFileSync(path.join(sourceAgentDir, "auth.json"), "{}\n");
	if (models !== undefined) fs.writeFileSync(path.join(sourceAgentDir, "models.json"), JSON.stringify(models));
	return { sourceAgentDir, tempDir, authMode: "pi-json-ephemeral" };
}

function readLimits(agentDir: string) {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
}

describe("private worker context limits", () => {
	it("inherits the exact context limit but no provider credentials, routing, code, or settings", () => {
		const input = fixture({
			providers: {
				antigravity: {
					apiKey: "!must-not-execute", baseUrl: "https://untrusted.invalid", headers: { authorization: "secret" },
					models: [{ id: "unexpected", contextWindow: 999 }],
					modelOverrides: {
						"gemini-3.8-flash": { contextWindow: 272000, maxTokens: 42, headers: { secret: "!command" }, compat: { arbitrary: true } },
						"no-limit": { headers: { secret: "must-not-copy" } },
					},
				},
				"unrelated-provider": { apiKey: "secret" },
			},
		});
		fs.writeFileSync(path.join(input.sourceAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:untrusted"], compaction: { enabled: false } }));
		const before = fs.readFileSync(path.join(input.sourceAgentDir, "models.json"), "utf8");
		const agentDir = prepareEphemeralPiAgentDir(input)!;
		assert.deepEqual(readLimits(agentDir), { providers: { antigravity: { modelOverrides: { "gemini-3.8-flash": { contextWindow: 272000 } } } } });
		assert.equal(fs.statSync(path.join(agentDir, "models.json")).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(path.join(agentDir, "settings.json")), false);
		assert.equal(fs.readFileSync(path.join(input.sourceAgentDir, "models.json"), "utf8"), before);
	});

	it("preserves limits when a nested child is seeded from a private agent directory", () => {
		const input = fixture({ providers: { antigravity: { modelOverrides: { "gemini-3.8-flash": { contextWindow: 272000 } } } } });
		const parent = prepareEphemeralPiAgentDir(input)!;
		const nestedTemp = path.join(input.tempDir, "nested"); fs.mkdirSync(nestedTemp);
		const child = prepareEphemeralPiAgentDir({ ...input, sourceAgentDir: parent, tempDir: nestedTemp })!;
		assert.deepEqual(readLimits(child), readLimits(parent));
	});

	it("does not create a model configuration when no limits exist", () => {
		for (const value of [undefined, {}, { providers: {} }, { providers: { custom: { models: [{ id: "custom", contextWindow: 1 }] } } }]) {
			const agentDir = prepareEphemeralPiAgentDir(fixture(value))!;
			assert.equal(fs.existsSync(path.join(agentDir, "models.json")), false);
		}
	});

	it("fails closed for malformed JSON or invalid declared context limits", () => {
		for (const contextWindow of [0, -1, 1.5, "272000", null, Number.MAX_SAFE_INTEGER + 1]) {
			const input = fixture({ providers: { antigravity: { modelOverrides: { "gemini-3.8-flash": { contextWindow } } } } });
			assert.throws(() => prepareEphemeralPiAgentDir(input), /contextWindow/);
		}
		const input = fixture();
		fs.writeFileSync(path.join(input.sourceAgentDir, "models.json"), "{malformed SECRET_VALUE");
		assert.throws(() => prepareEphemeralPiAgentDir(input), (error: Error) => {
			assert.match(error.message, /models.json/);
			assert.doesNotMatch(error.message, /SECRET_VALUE/);
			return true;
		});
	});

	it("does not follow a child-created models destination symlink on another attempt", () => {
		const input = fixture({ providers: { antigravity: { modelOverrides: { "gemini-3.8-flash": { contextWindow: 272000 } } } } });
		const first = prepareEphemeralPiAgentDir(input)!;
		const unrelated = path.join(input.tempDir, "unrelated"); fs.writeFileSync(unrelated, "unchanged");
		fs.rmSync(path.join(first, "models.json"), { force: true });
		fs.symlinkSync(unrelated, path.join(first, "models.json"));
		const second = prepareEphemeralPiAgentDir(input)!;
		assert.equal(fs.readFileSync(unrelated, "utf8"), "unchanged");
		assert.equal(readLimits(second).providers.antigravity.modelOverrides["gemini-3.8-flash"].contextWindow, 272000);
	});
});
