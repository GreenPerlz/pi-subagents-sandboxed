import fs from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only numeric context limits cross the closed-runtime configuration boundary. */
export function readPrivateModelLimits(filePath: string): Buffer | undefined {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot read models.json for private worker context limits");
	}
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch { throw new Error("Invalid models.json for private worker context limits"); }
	if (!isRecord(parsed) || (parsed.providers !== undefined && !isRecord(parsed.providers))) {
		throw new Error("Invalid models.json providers for private worker context limits");
	}
	const providers: Record<string, unknown> = Object.create(null);
	for (const [providerId, config] of Object.entries(parsed.providers ?? {})) {
		if (!isRecord(config) || config.modelOverrides === undefined) continue;
		if (!isRecord(config.modelOverrides)) throw new Error("Invalid models.json modelOverrides");
		const modelOverrides: Record<string, { contextWindow: number }> = Object.create(null);
		for (const [modelId, override] of Object.entries(config.modelOverrides)) {
			if (!isRecord(override) || !Object.hasOwn(override, "contextWindow")) continue;
			const limit = override.contextWindow;
			if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
				throw new Error("Invalid models.json contextWindow: expected a positive safe integer");
			}
			modelOverrides[modelId] = { contextWindow: limit };
		}
		if (Object.keys(modelOverrides).length > 0) providers[providerId] = { modelOverrides };
	}
	return Object.keys(providers).length > 0
		? Buffer.from(`${JSON.stringify({ providers }, null, 2)}\n`, "utf8")
		: undefined;
}
