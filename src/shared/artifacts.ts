import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths } from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";

export function getArtifactsDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, "subagent-artifacts");
	}
	return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function ensureArtifactsDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
	fs.appendFileSync(filePath, `${line}\n`);
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	const cleanupEntry = (filePath: string): void => {
		try {
			const stat = fs.lstatSync(filePath);
			if (stat.isDirectory()) {
				for (const child of fs.readdirSync(filePath)) cleanupEntry(path.join(filePath, child));
				// Export directories are nested below artifact directories. Remove an
				// empty stale directory only after its bundle files were considered.
				if (fs.readdirSync(filePath).length === 0 && stat.mtimeMs < cutoff) fs.rmdirSync(filePath);
			} else if (stat.mtimeMs < cutoff) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Artifact cleanup is best-effort housekeeping. Skip files that disappear
			// or become unreadable while scanning so one bad entry does not block the rest.
		}
	};
	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		cleanupEntry(path.join(dir, file));
	}

	fs.writeFileSync(markerPath, String(now));
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	const sessionsBase = path.join(getAgentDir(), "sessions");
	if (!fs.existsSync(sessionsBase)) return;

	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsBase);
	} catch {
		// Session artifact cleanup is best-effort. If the sessions root cannot be read,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
		try {
			cleanupOldArtifacts(artifactsDir, maxAgeDays);
		} catch {
			// Session cleanup is best-effort. Keep going so one unreadable session dir
			// does not block cleanup for the rest.
		}
	}
}
