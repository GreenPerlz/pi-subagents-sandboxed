export interface SandboxRunConfig {
	provider?: string;
	profile?: string;
	network?: string;
	trustProject?: boolean;
	bashWrite?: boolean;
	auth?: string;
	fallback?: string;
}

export interface AgentSandboxConfig extends SandboxRunConfig {}

export interface SandboxSettingsDefaults {
	defaultProvider?: string;
	defaultProfile?: string;
	network?: string;
	auth?: string;
	trustProject?: boolean;
	fallback?: string;
}

export interface ResolvedSandboxConfig {
	provider: string;
	profile?: string;
	network?: string;
	trustProject?: boolean;
	bashWrite?: boolean;
	auth?: string;
	fallback?: string;
}
