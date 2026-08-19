/** Fast mode is a service-tier request, not a model or thinking-level alias. */
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { findModelInfo, type ModelInfo } from "./model-info.ts";

export type FastModeSupport = "supported" | "unsupported" | "unknown";
export interface FastModeStatus {
	requested: boolean;
	/** Whether this particular resolved model is eligible for priority requests. */
	eligible: boolean | "unknown";
	/** Provider activation is not reported unless the provider exposes it authoritatively. */
	active: boolean | "unknown";
	model?: string;
}

/** Pi provider adapters that expose the priority service tier. */
export const FAST_MODE_SERVICE_TIER_APIS = new Set(["openai-responses", "openai-codex-responses"]);
export const FAST_MODE_SERVICE_TIER_PROVIDERS = new Set(["openai", "openai-codex"]);

type CanonicalModelOrigin = {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
};

/**
 * Registry entries are mutable and may replace a built-in model with a proxy
 * under the same provider/id. Only entries whose provider, API, and endpoint
 * match the bundled 0.84.2 catalog are trusted for service-tier injection.
 */
function canonicalModelOrigin(provider: string, id: string): CanonicalModelOrigin | undefined {
	try {
		const model = getBuiltinModel(provider as never, id as never) as unknown as Partial<CanonicalModelOrigin> | undefined;
		if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || typeof model.api !== "string" || typeof model.baseUrl !== "string") {
			return undefined;
		}
		return {
			provider: model.provider,
			id: model.id,
			api: model.api,
			baseUrl: model.baseUrl,
		};
	} catch {
		return undefined;
	}
}

function isTrustedCanonicalBuiltin(info: ModelInfo): boolean {
	if (!FAST_MODE_SERVICE_TIER_PROVIDERS.has(info.provider)) return false;
	const canonical = canonicalModelOrigin(info.provider, info.id);
	if (!canonical || info.provider !== canonical.provider || info.id !== canonical.id) return false;
	if (!FAST_MODE_SERVICE_TIER_APIS.has(canonical.api)) return false;
	// Missing registry origin metadata is not proof of trust. This makes test
	// or unavailable registries conservatively inactive rather than guessing.
	return info.api === canonical.api && info.baseUrl === canonical.baseUrl;
}

export function fastModeSupportForModel(
	model: string | undefined,
	availableModels: ModelInfo[] | undefined,
	preferredProvider?: string,
): FastModeSupport {
	if (!model || !availableModels || availableModels.length === 0) return "unknown";
	const info = findModelInfo(model, availableModels, preferredProvider);
	if (!info) return "unknown";
	if (!FAST_MODE_SERVICE_TIER_PROVIDERS.has(info.provider)) return "unsupported";
	// A registry entry under a supported key without origin metadata is a
	// concrete, untrusted replacement, not an unavailable registry.
	if (info.api === undefined || info.baseUrl === undefined) return "unsupported";
	return isTrustedCanonicalBuiltin(info) ? "supported" : "unsupported";
}

export function resolveFastModeStatus(
	requested: boolean | undefined,
	model: string | undefined,
	availableModels: ModelInfo[] | undefined,
	preferredProvider?: string,
): FastModeStatus | undefined {
	if (!requested) return undefined;
	const support = fastModeSupportForModel(model, availableModels, preferredProvider);
	return {
		requested: true,
		eligible: support === "supported" ? true : support === "unsupported" ? false : "unknown",
		active: support === "unsupported" ? false : "unknown",
		...(model ? { model } : {}),
	};
}

/** Only supported, registry-resolved candidates get a service-tier request. */
export function shouldRequestFastMode(status: FastModeStatus | undefined): boolean {
	return status?.requested === true && status.eligible === true;
}
