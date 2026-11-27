import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPrivateModelLimits } from "./model-limits.ts";

export const EPHEMERAL_PI_JSON_AUTH_MODE = "pi-json-ephemeral";

export function authModeUsesEphemeralPiJson(authMode: string | undefined): boolean {
	return authMode?.trim().toLowerCase() === EPHEMERAL_PI_JSON_AUTH_MODE;
}

export function defaultPiAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return path.join(os.homedir(), ".pi", "agent");
	if (configured === "~") return os.homedir();
	if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return path.resolve(configured);
}

export function ephemeralPiAgentDir(tempDir: string): string {
	return path.join(tempDir, "private-agent");
}

function copyPrivateJson(source: string, destination: string, fallback: string): void {
	const contents = fs.existsSync(source) ? fs.readFileSync(source) : Buffer.from(fallback, "utf8");
	writePrivateJson(destination, contents);
}

function writePrivateJson(destination: string, contents: Buffer): void {
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
	try {
		fs.writeFileSync(fd, contents);
		fs.fchmodSync(fd, 0o600);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Create a run-private writable Pi agent directory seeded from trusted JSON.
 * settings.json is deliberately not copied: closed package discovery must not
 * become ambient merely because OAuth credentials need to refresh.
 */
export function prepareEphemeralPiAgentDir(input: {
	authMode: string | undefined;
	tempDir: string | undefined;
	sourceAgentDir?: string;
}): string | undefined {
	if (!authModeUsesEphemeralPiJson(input.authMode)) return undefined;
	if (!input.tempDir) throw new Error("pi-json-ephemeral auth requires a runtime-managed temporary directory");

	const sourceDir = path.resolve(input.sourceAgentDir ?? defaultPiAgentDir());
	// Validate before copying credentials. Never inherit executable model config.
	const modelLimits = readPrivateModelLimits(path.join(sourceDir, "models.json"));
	const privateDir = ephemeralPiAgentDir(input.tempDir);
	// Attempts may reuse one runtime temp directory. Recreate the private tree so
	// child-created files or symlinks can never become trusted copy destinations.
	fs.rmSync(privateDir, { recursive: true, force: true });
	fs.mkdirSync(privateDir, { recursive: false, mode: 0o700 });
	fs.chmodSync(privateDir, 0o700);
	copyPrivateJson(path.join(sourceDir, "auth.json"), path.join(privateDir, "auth.json"), "{}\n");
	copyPrivateJson(path.join(sourceDir, "subagents.json"), path.join(privateDir, "subagents.json"), "{}\n");
	if (modelLimits) writePrivateJson(path.join(privateDir, "models.json"), modelLimits);
	return privateDir;
}
