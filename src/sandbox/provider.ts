import { BubblewrapSandboxProvider, type BubblewrapProviderDeps } from "./bubblewrap.ts";
import type { ResolvedSandboxConfig, SandboxProvider } from "./types.ts";
export { SandboxUnavailableError } from "./types.ts";

export type SandboxProviderDeps = BubblewrapProviderDeps;

export function createSandboxProvider(config: ResolvedSandboxConfig, deps: SandboxProviderDeps = {}): SandboxProvider {
	if (config.provider === "bubblewrap") {
		return new BubblewrapSandboxProvider(deps);
	}

	throw new Error(`Unsupported sandbox provider: ${config.provider}`);
}
