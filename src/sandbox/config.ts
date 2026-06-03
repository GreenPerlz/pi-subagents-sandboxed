import type { AgentSandboxConfig, ResolvedSandboxConfig, SandboxRunConfig, SandboxSettingsDefaults } from "./types.ts";

interface SandboxResolutionInput {
	settings?: SandboxSettingsDefaults;
	agent?: { sandbox?: AgentSandboxConfig };
	run?: SandboxRunConfig;
}

function normalizeString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function applyStringOverride<T extends string>(target: Record<T, string | undefined>, key: T, value: string | undefined): void {
	if (value === undefined) return;
	target[key] = normalizeString(value);
}

function applyBooleanOverride<T extends string>(target: Record<T, boolean | undefined>, key: T, value: boolean | undefined): void {
	if (value === undefined) return;
	target[key] = value;
}

export function resolveSandboxConfig(input: SandboxResolutionInput = {}): ResolvedSandboxConfig | undefined {
	const resolved: {
		provider?: string;
		profile?: string;
		network?: string;
		trustProject?: boolean;
		bashWrite?: boolean;
		auth?: string;
		fallback?: string;
	} = {};

	const settings = input.settings;
	if (settings) {
		applyStringOverride(resolved, "provider", settings.defaultProvider);
		applyStringOverride(resolved, "profile", settings.defaultProfile);
		applyStringOverride(resolved, "network", settings.network);
		applyBooleanOverride(resolved, "trustProject", settings.trustProject);
		applyStringOverride(resolved, "auth", settings.auth);
		applyStringOverride(resolved, "fallback", settings.fallback);
	}

	const agent = input.agent?.sandbox;
	if (agent) {
		applyStringOverride(resolved, "provider", agent.provider);
		applyStringOverride(resolved, "profile", agent.profile);
		applyStringOverride(resolved, "network", agent.network);
		applyBooleanOverride(resolved, "trustProject", agent.trustProject);
		applyBooleanOverride(resolved, "bashWrite", agent.bashWrite);
		applyStringOverride(resolved, "auth", agent.auth);
		applyStringOverride(resolved, "fallback", agent.fallback);
	}

	const run = input.run;
	if (run) {
		applyStringOverride(resolved, "provider", run.provider);
		applyStringOverride(resolved, "profile", run.profile);
		applyStringOverride(resolved, "network", run.network);
		applyBooleanOverride(resolved, "trustProject", run.trustProject);
		applyBooleanOverride(resolved, "bashWrite", run.bashWrite);
		applyStringOverride(resolved, "auth", run.auth);
		applyStringOverride(resolved, "fallback", run.fallback);
	}

	const provider = normalizeString(resolved.provider);
	if (!provider || provider === "none") return undefined;

	return {
		provider,
		...(resolved.profile !== undefined ? { profile: resolved.profile } : {}),
		...(resolved.network !== undefined ? { network: resolved.network } : {}),
		...(resolved.trustProject !== undefined ? { trustProject: resolved.trustProject } : {}),
		...(resolved.bashWrite !== undefined ? { bashWrite: resolved.bashWrite } : {}),
		...(resolved.auth !== undefined ? { auth: resolved.auth } : {}),
		...(resolved.fallback !== undefined ? { fallback: resolved.fallback } : {}),
	};
}
