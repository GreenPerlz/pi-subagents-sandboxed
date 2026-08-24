export type SandboxPackageDiscoveryMode = "closed" | "project-local" | "ambient";
export type GitMode = "read-only" | "isolated";

export interface SandboxRunConfig {
	provider?: string;
	/** Git access policy for this child; omitted preserves the read-only default. */
	gitMode?: GitMode | string;
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
	/** Trusted user-global permission to explicitly disable Bubblewrap. Project settings cannot grant this. */
	allowSandboxOptOut?: boolean;
	/** User-global ceiling for parent-managed worktree opt-out; project settings may only narrow it. */
	allowWorktreeOptOut?: boolean;
	/** Default Git access policy. Unconfigured agents remain read-only. */
	gitMode?: GitMode | string;
	defaultProfile?: string;
	network?: string;
	auth?: string;
	trustProject?: boolean;
	fallback?: string;
	extraReadOnlyMounts?: string[];
	extraWritableMounts?: string[];
	packageDiscovery?: SandboxPackageDiscoveryMode | string;
}

/** Internal transport: null is an authenticated explicit provider:none decision. */
export type SandboxTransport = ResolvedSandboxConfig | null;

export interface ResolvedSandboxConfig {
	provider: string;
	gitMode?: GitMode | string;
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
	/** Host descriptors inherited by the immediate sandbox wrapper only. */
	inheritedFds?: number[];
	/** Internal request to pin read-only mount sources across wrapper spawn. */
	pinReadonlyMounts?: boolean;
}

export type SandboxMountMode = "ro" | "rw";

export interface SandboxMount {
	source: string;
	mode: SandboxMountMode;
	/** Optional sandbox destination for policy overlays (defaults to source). */
	target?: string;
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
	gitMode?: GitMode | string;
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
