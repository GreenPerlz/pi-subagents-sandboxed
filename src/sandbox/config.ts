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

function normalizeGitMode(value: string | undefined): string | undefined {
	const normalized = normalizeString(value);
	if (normalized !== undefined && normalized !== "read-only" && normalized !== "isolated") {
		throw new Error(`Unsupported Git mode: ${normalized}. Expected 'read-only' or 'isolated'.`);
	}
	return normalized;
}

function applyStringOverride<T extends string>(target: Record<T, string | undefined>, key: T, value: string | undefined): void {
	if (value === undefined) return;
	target[key] = normalizeString(value);
}

function applyBooleanOverride<T extends string>(target: Record<T, boolean | undefined>, key: T, value: boolean | undefined): void {
	if (value === undefined) return;
	target[key] = value;
}

const DEFAULT_SANDBOX_AUTH = "pi-json";

export function resolveGitMode(config?: Pick<ResolvedSandboxConfig, "gitMode">): "read-only" | "isolated" {
	return config?.gitMode === "isolated" ? "isolated" : "read-only";
}

/** Return whether the winning explicit provider value is the documented opt-out. */
export function hasExplicitSandboxOptOut(input: SandboxResolutionInput = {}): boolean {
	let provider: string | undefined;
	if (input.settings?.defaultProvider !== undefined) provider = input.settings.defaultProvider;
	if (input.agent?.sandbox?.provider !== undefined) provider = input.agent.sandbox.provider;
	if (input.run?.provider !== undefined) provider = input.run.provider;
	return normalizeString(provider) === "none";
}

function appendPathOverrides(target: string[], value: string[] | undefined): void {
	if (!value) return;
	for (const item of value) {
		const normalized = normalizeString(item);
		if (normalized && !target.includes(normalized)) target.push(normalized);
	}
}

export function resolveSandboxConfig(input: SandboxResolutionInput = {}): ResolvedSandboxConfig | undefined {
	const resolved: {
		provider?: string;
		gitMode?: string;
		profile?: string;
		network?: string;
		trustProject?: boolean;
		bashWrite?: boolean;
		auth?: string;
		fallback?: string;
		extraReadOnlyMounts: string[];
		extraWritableMounts: string[];
		packageDiscovery?: string;
	} = { extraReadOnlyMounts: [], extraWritableMounts: [] };
	let providerOrigin: "settings" | "agent" | "run" | undefined;
	let gitModeOrigin: "settings" | "agent" | "run" | undefined;

	const settings = input.settings;
	if (settings) {
		if (settings.defaultProvider !== undefined) providerOrigin = "settings";
		if (settings.gitMode !== undefined) gitModeOrigin = "settings";
		applyStringOverride(resolved, "provider", settings.defaultProvider);
		applyStringOverride(resolved, "gitMode", settings.gitMode);
		applyStringOverride(resolved, "profile", settings.defaultProfile);
		applyStringOverride(resolved, "network", settings.network);
		applyBooleanOverride(resolved, "trustProject", settings.trustProject);
		applyStringOverride(resolved, "auth", settings.auth);
		applyStringOverride(resolved, "fallback", settings.fallback);
		appendPathOverrides(resolved.extraReadOnlyMounts, settings.extraReadOnlyMounts);
		appendPathOverrides(resolved.extraWritableMounts, settings.extraWritableMounts);
		applyStringOverride(resolved, "packageDiscovery", settings.packageDiscovery);
	}

	const agent = input.agent?.sandbox;
	if (agent) {
		if (agent.provider !== undefined) providerOrigin = "agent";
		if (agent.gitMode !== undefined) gitModeOrigin = "agent";
		applyStringOverride(resolved, "provider", agent.provider);
		applyStringOverride(resolved, "gitMode", agent.gitMode);
		applyStringOverride(resolved, "profile", agent.profile);
		applyStringOverride(resolved, "network", agent.network);
		applyBooleanOverride(resolved, "trustProject", agent.trustProject);
		applyBooleanOverride(resolved, "bashWrite", agent.bashWrite);
		applyStringOverride(resolved, "auth", agent.auth);
		applyStringOverride(resolved, "fallback", agent.fallback);
		appendPathOverrides(resolved.extraReadOnlyMounts, agent.extraReadOnlyMounts);
		appendPathOverrides(resolved.extraWritableMounts, agent.extraWritableMounts);
		applyStringOverride(resolved, "packageDiscovery", agent.packageDiscovery);
	}

	const run = input.run;
	if (run) {
		if (run.provider !== undefined) providerOrigin = "run";
		if (run.gitMode !== undefined) gitModeOrigin = "run";
		applyStringOverride(resolved, "provider", run.provider);
		applyStringOverride(resolved, "gitMode", run.gitMode);
		applyStringOverride(resolved, "profile", run.profile);
		applyStringOverride(resolved, "network", run.network);
		applyBooleanOverride(resolved, "trustProject", run.trustProject);
		applyBooleanOverride(resolved, "bashWrite", run.bashWrite);
		applyStringOverride(resolved, "auth", run.auth);
		applyStringOverride(resolved, "fallback", run.fallback);
		appendPathOverrides(resolved.extraReadOnlyMounts, run.extraReadOnlyMounts);
		appendPathOverrides(resolved.extraWritableMounts, run.extraWritableMounts);
		applyStringOverride(resolved, "packageDiscovery", run.packageDiscovery);
	}

	const provider = normalizeString(resolved.provider);
	const gitMode = normalizeGitMode(resolved.gitMode);
	const layerOrder = { settings: 0, agent: 1, run: 2 } as const;
	if (provider === "none" && gitMode === "isolated" && providerOrigin === gitModeOrigin) {
		throw new Error("Explicit provider 'none' cannot be combined with isolated Git in the same request; choose Bubblewrap or omit isolated Git.");
	}
	// An isolated mode from a higher-precedence layer must not inherit an
	// unsandboxed provider-none opt-out from below it.
	const isolatedModeWins = provider === "none" && gitMode === "isolated"
		&& gitModeOrigin !== undefined
		&& (providerOrigin === undefined || layerOrder[gitModeOrigin] > layerOrder[providerOrigin]);
	// A caller that supplies no sandbox settings, custom agent, or run override
	// has opted out of resolving a child sandbox (for example while resolving a
	// shared mode before the concrete agent is known). Discovered user/project
	// agents with no sandbox block still receive the safe read-only default;
	// synthetic AgentConfig values used by lower-level callers retain the
	// historical unsandboxed behavior unless they explicitly configure one.
	const customAgent = input.agent?.source === "user" || input.agent?.source === "project";
	const hasSandboxConfiguration = input.settings !== undefined
		|| input.agent?.sandbox !== undefined
		|| customAgent
		|| input.run !== undefined;
	if (!hasSandboxConfiguration && provider === undefined && gitMode === undefined) return undefined;
	// An explicit provider `none` remains the only opt-out. An omitted provider
	// is a configured-safe default: Bubblewrap protects ordinary and linked
	// worktree Git metadata even for custom agents that do not declare sandbox
	// frontmatter. This also means writer-capable children cannot silently fall
	// back to an unsandboxed parent checkout.
	if (provider === "none" && !isolatedModeWins) return undefined;

	return {
		provider: isolatedModeWins ? "bubblewrap" : (provider ?? "bubblewrap"),
		// Git is read-only unless isolated was explicitly selected. Keep the
		// resolved value on the runtime config so mount construction cannot
		// accidentally treat an omitted mode as an unprotected checkout.
		gitMode: gitMode ?? "read-only",
		...(resolved.profile !== undefined ? { profile: resolved.profile } : {}),
		...(resolved.network !== undefined ? { network: resolved.network } : {}),
		...(resolved.trustProject !== undefined ? { trustProject: resolved.trustProject } : {}),
		...(resolved.bashWrite !== undefined ? { bashWrite: resolved.bashWrite } : {}),
		auth: resolved.auth ?? DEFAULT_SANDBOX_AUTH,
		...(resolved.fallback !== undefined ? { fallback: resolved.fallback } : {}),
		...(resolved.extraReadOnlyMounts.length > 0 ? { extraReadOnlyMounts: resolved.extraReadOnlyMounts } : {}),
		...(resolved.extraWritableMounts.length > 0 ? { extraWritableMounts: resolved.extraWritableMounts } : {}),
		...(resolved.packageDiscovery !== undefined ? { packageDiscovery: resolved.packageDiscovery } : {}),
	};
}
