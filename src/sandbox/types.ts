export type SandboxPackageDiscoveryMode = "closed" | "project-local" | "ambient";

export interface SandboxRunConfig {
	provider?: string;
	profile?: string;
	network?: string;
	trustProject?: boolean;
	bashWrite?: boolean;
	auth?: string;
	fallback?: string;
	extraReadOnlyMounts?: string[];
	extraWritableMounts?: string[];
	packageDiscovery?: SandboxPackageDiscoveryMode | string;
}

export interface AgentSandboxConfig extends SandboxRunConfig {}

export interface SandboxSettingsDefaults {
	defaultProvider?: string;
	defaultProfile?: string;
	network?: string;
	auth?: string;
	trustProject?: boolean;
	fallback?: string;
	extraReadOnlyMounts?: string[];
	extraWritableMounts?: string[];
	packageDiscovery?: SandboxPackageDiscoveryMode | string;
}

export interface ResolvedSandboxConfig {
	provider: string;
	profile?: string;
	network?: string;
	trustProject?: boolean;
	bashWrite?: boolean;
	auth?: string;
	fallback?: string;
	extraReadOnlyMounts?: string[];
	extraWritableMounts?: string[];
	packageDiscovery?: SandboxPackageDiscoveryMode | string;
}

export interface SpawnableInvocation {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export type SandboxMountMode = "ro" | "rw";

export interface SandboxMount {
	source: string;
	mode: SandboxMountMode;
}

export type SandboxDiagnosticLevel = "info" | "warning" | "error";

export interface SandboxDiagnostic {
	level: SandboxDiagnosticLevel;
	message: string;
}

export interface SandboxMountDiagnostic {
	path: string;
	mode: SandboxMountMode;
}

export interface SandboxWrapInput {
	config: ResolvedSandboxConfig;
	invocation: SpawnableInvocation;
	mounts?: SandboxMount[];
}

export interface SandboxWrapResult {
	invocation: SpawnableInvocation;
	diagnostics: SandboxDiagnostic[];
	fallbackOccurred?: boolean;
	mounts?: SandboxMountDiagnostic[];
}

export interface SandboxResultDetails {
	provider: string;
	profile: string;
	network: string;
	auth: string;
	fallbackMode: string;
	fallbackOccurred: boolean;
	diagnostics?: SandboxDiagnostic[];
	mounts?: SandboxMountDiagnostic[];
}

export interface SandboxProvider {
	wrapInvocation(input: SandboxWrapInput): SandboxWrapResult;
}

export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}
