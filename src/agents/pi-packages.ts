import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = ".pi";

export interface ProjectLocalPiPackageResources {
	extensions: string[];
	packageRoots: string[];
}

interface PackageEntrySelection {
	source: string;
	extensions?: string[] | false;
}

function readJsonBestEffort(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectConfigDir(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const configDir = path.join(current, CONFIG_DIR);
		if (isDirectory(configDir)) return configDir;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findNearestPackageRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isSafePackagePath(value: string): boolean {
	return value.length > 0
		&& !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const packageName = match?.[1] ?? spec;
	return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;

	let host = "";
	let repoPath = "";
	const scpLike = spec.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] ?? "";
		repoPath = scpLike[2] ?? "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
		try {
			const url = new URL(spec);
			host = url.hostname;
			repoPath = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = spec.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = spec.slice(0, slashIndex);
		repoPath = spec.slice(slashIndex + 1);
	}

	const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) {
		return undefined;
	}
	return { host, repoPath: normalizedPath };
}

function resolveSettingsPackageRoot(source: string, configDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("git:")) {
		const parsed = parseGitPackagePath(trimmed);
		return parsed ? path.join(configDir, "git", parsed.host, parsed.repoPath) : undefined;
	}
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? path.join(configDir, "npm", "node_modules", packageName) : undefined;
	}
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(configDir, normalized);
	}
	return undefined;
}

function parsePackageEntry(entry: unknown): PackageEntrySelection | undefined {
	if (typeof entry === "string") return { source: entry };
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const source = (entry as { source?: unknown }).source;
	if (typeof source !== "string") return undefined;
	const extensions = (entry as { extensions?: unknown }).extensions;
	if (extensions === false) return { source, extensions: false };
	if (Array.isArray(extensions)) {
		return { source, extensions: extensions.filter((value): value is string => typeof value === "string") };
	}
	return { source };
}

function resolvePackageExtensionPaths(packageRoot: string, selectedExtensions?: string[] | false): string[] {
	if (selectedExtensions === false) return [];
	const canonicalRoot = tryRealpathSync(packageRoot);
	const manifestPath = path.join(canonicalRoot, "package.json");
	const manifest = readJsonBestEffort(manifestPath);
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
	const pi = (manifest as { pi?: unknown }).pi;
	if (!pi || typeof pi !== "object" || Array.isArray(pi)) return [];
	const manifestExtensions = (pi as { extensions?: unknown }).extensions;
	const rawExtensions = selectedExtensions ?? (Array.isArray(manifestExtensions) ? manifestExtensions : []);
	return rawExtensions
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0 && !path.isAbsolute(entry))
		.map((entry) => path.resolve(canonicalRoot, entry))
		.filter((resolved) => isWithinPath(resolved, canonicalRoot));
}

function tryRealpathSync(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

function isWithinPath(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pushUnique(target: string[], seen: Set<string>, value: string): void {
	const resolved = path.resolve(value);
	if (seen.has(resolved)) return;
	seen.add(resolved);
	target.push(resolved);
}

export function resolveProjectLocalPiPackageResources(cwd: string): ProjectLocalPiPackageResources {
	const extensions: string[] = [];
	const packageRoots: string[] = [];
	const seenExtensions = new Set<string>();
	const seenRoots = new Set<string>();

	const addPackageRoot = (packageRoot: string, selectedExtensions?: string[] | false) => {
		const resolvedRoot = path.resolve(packageRoot);
		const canonicalRoot = tryRealpathSync(resolvedRoot);
		if (!fs.existsSync(path.join(canonicalRoot, "package.json"))) return;
		const extensionPaths = resolvePackageExtensionPaths(canonicalRoot, selectedExtensions);
		if (extensionPaths.length === 0) return;
		pushUnique(packageRoots, seenRoots, canonicalRoot);
		for (const extensionPath of extensionPaths) {
			if (!fs.existsSync(extensionPath)) continue;
			const canonicalExtension = tryRealpathSync(extensionPath);
			if (!isWithinPath(canonicalExtension, canonicalRoot)) continue;
			pushUnique(extensions, seenExtensions, canonicalExtension);
		}
	};

	const configDir = findNearestProjectConfigDir(cwd);
	const projectRoot = configDir ? path.dirname(configDir) : undefined;
	if (configDir) {
		const settings = readJsonBestEffort(path.join(configDir, "settings.json"));
		const packages = settings && typeof settings === "object" && !Array.isArray(settings)
			? (settings as { packages?: unknown }).packages
			: undefined;
		if (Array.isArray(packages)) {
			for (const entry of packages) {
				const parsed = parsePackageEntry(entry);
				if (!parsed) continue;
				const packageRoot = resolveSettingsPackageRoot(parsed.source, configDir);
				if (!packageRoot) continue;
				if (projectRoot) {
					const canonicalPackageRoot = tryRealpathSync(packageRoot);
					const canonicalProjectRoot = tryRealpathSync(projectRoot);
					if (!isWithinPath(canonicalPackageRoot, canonicalProjectRoot)) continue;
				}
				addPackageRoot(packageRoot, parsed.extensions);
			}
		}
	}

	const cwdPackageRoot = findNearestPackageRoot(cwd);
	if (cwdPackageRoot) addPackageRoot(cwdPackageRoot);

	return { extensions, packageRoots };
}
