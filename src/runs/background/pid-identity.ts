import * as fs from "node:fs";
import * as path from "node:path";

export interface PersistedPidIdentityCheck {
	ok: boolean;
	error?: string;
}

export function readProcessStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
		return fields[19] || undefined;
	} catch { return undefined; }
}

/** Encode the exact detached runner argv identity persisted with a status file. */
export function formatAsyncRunnerIdentity(
	runnerPath: string,
	configPath: string,
	runId: string,
	startToken?: string,
	uid?: number,
	expectedArgv: readonly string[] = ["node", path.resolve(runnerPath), path.resolve(configPath)],
): string {
	const argv = encodeURIComponent(JSON.stringify(expectedArgv));
	return `runner:${path.resolve(runnerPath)};config:${path.resolve(configPath)};run:${runId};argv:${argv}${startToken ? `;start:${startToken}` : ""}${uid !== undefined ? `;uid:${uid}` : ""}`;
}

function parseIdentity(identity: string | undefined): { runner?: string; config?: string; run?: string; argv?: string[]; start?: string; uid?: number } {
	const values: Record<string, string> = {};
	for (const part of identity?.split(";") ?? []) {
		const separator = part.indexOf(":");
		if (separator > 0) values[part.slice(0, separator)] = part.slice(separator + 1);
	}
	let argv: string[] | undefined;
	if (values.argv) {
		try {
			const parsed = JSON.parse(decodeURIComponent(values.argv));
			if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) argv = parsed;
		} catch { /* malformed identity is rejected by the caller */ }
	}
	return { runner: values.runner, config: values.config, run: values.run, argv, start: values.start, uid: values.uid !== undefined ? Number(values.uid) : undefined };
}

/** Return an explicit safe/fail-closed result for a persisted PID query. */
export function checkExpectedAsyncRunnerPid(
	pid: number | undefined,
	runId: string,
	identity?: string,
	readCmdline: (pid: number) => string[] | string | undefined = (candidate) => {
		if (process.platform !== "linux") return undefined;
		try {
			return fs.readFileSync(`/proc/${candidate}/cmdline`).toString("utf8").split("\0").filter((entry) => entry.length > 0);
		} catch {
			return undefined;
		}
	},
	platform: NodeJS.Platform = process.platform,
	readStartToken: (pid: number) => string | undefined = (candidate) => readProcessStartToken(candidate, platform),
	readUid: (pid: number) => number | undefined = (candidate) => {
		try { return fs.statSync(`/proc/${candidate}`).uid; } catch { return undefined; }
	},
): PersistedPidIdentityCheck {
	if (!Number.isInteger(pid) || !pid || pid <= 0 || !runId) return { ok: false, error: "invalid persisted runner PID or run id" };
	if (platform !== "linux") return { ok: false, error: "persisted runner identity cannot be queried safely on this platform" };
	const parsed = parseIdentity(identity);
	if (!parsed.runner || !parsed.config || !parsed.argv || parsed.run !== runId || !parsed.start || !Number.isInteger(parsed.uid)) return { ok: false, error: "persisted runner identity is incomplete" };
	const rawArgv = readCmdline(pid);
	if (!rawArgv) return { ok: false, error: "runner /proc cmdline is unreadable" };
	const argv = Array.isArray(rawArgv)
		? rawArgv
		: rawArgv.includes("\0")
			? rawArgv.split("\0").filter((entry) => entry.length > 0)
			: rawArgv.trim().split(/\s+/).filter((entry) => entry.length > 0);
	const runner = path.resolve(parsed.runner);
	const config = path.resolve(parsed.config);
	// Persist and compare the complete launcher argv. Matching only a suffix lets
	// a same-UID process with the right-looking runner/config tail be signalled.
	const canonicalArgv = (entry: string): string => entry.startsWith("/") ? path.resolve(entry) : entry;
	if (argv.length !== parsed.argv.length || argv.some((entry, index) => canonicalArgv(entry) !== canonicalArgv(parsed.argv![index]!))) {
		return { ok: false, error: "runner argv does not exactly match the persisted launcher identity" };
	}
	if (canonicalArgv(parsed.argv.at(-2) ?? "") !== runner || canonicalArgv(parsed.argv.at(-1) ?? "") !== config) {
		return { ok: false, error: "persisted runner argv does not end with the expected runner/config paths" };
	}
	if (path.basename(config) !== `async-cfg-${runId}.json`) return { ok: false, error: "persisted config path does not match the run token" };
	if (readStartToken(pid) !== parsed.start) return { ok: false, error: "runner process start token does not match persisted identity" };
	if (readUid(pid) !== parsed.uid) return { ok: false, error: "runner UID does not match persisted identity" };
	return { ok: true };
}

export function isExpectedAsyncRunnerPid(
	pid: number | undefined,
	runId: string,
	identity?: string,
	readCmdline?: (pid: number) => string[] | string | undefined,
	platform?: NodeJS.Platform,
	readStartToken?: (pid: number) => string | undefined,
	readUid?: (pid: number) => number | undefined,
): boolean {
	return checkExpectedAsyncRunnerPid(pid, runId, identity, readCmdline, platform, readStartToken, readUid).ok;
}
