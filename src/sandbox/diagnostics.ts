import type { ResolvedSandboxConfig, SandboxDiagnostic, SandboxResultDetails, SandboxWrapResult } from "./types.ts";

export function sandboxResultDetails(config: ResolvedSandboxConfig, wrapResult?: Pick<SandboxWrapResult, "diagnostics" | "fallbackOccurred">): SandboxResultDetails {
	const diagnostics = wrapResult?.diagnostics?.length ? wrapResult.diagnostics : undefined;
	return {
		provider: config.provider,
		profile: config.profile ?? "host-toolchain",
		network: config.network ?? "host",
		auth: config.auth ?? "env",
		fallbackMode: config.fallback ?? "fail",
		fallbackOccurred: wrapResult?.fallbackOccurred === true,
		...(diagnostics ? { diagnostics: diagnostics.map((diagnostic): SandboxDiagnostic => ({ ...diagnostic })) } : {}),
	};
}
