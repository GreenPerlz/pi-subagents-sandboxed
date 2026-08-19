#!/usr/bin/env node

import fs from "node:fs/promises";

const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const piPackages = ["dependencies", "devDependencies"].flatMap((section) =>
	Object.keys(packageJson[section] ?? {})
		.filter((name) => name.startsWith("@earendil-works/pi-") || name === "pi-subagent-runtime")
		.map((name) => name === "pi-subagent-runtime"
			? { section, name, registryName: "@earendil-works/pi-coding-agent", alias: true }
			: { section, name }),
);
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const configured = piPackages.map((entry) => {
	const spec = packageJson[entry.section]?.[entry.name];
	const registryName = entry.registryName ?? entry.name;
	const aliasPrefix = `npm:${registryName}@`;
	const version = entry.alias && typeof spec === "string" && spec.startsWith(aliasPrefix)
		? spec.slice(aliasPrefix.length)
		: spec;
	return { ...entry, registryName, spec, version };
});
const invalid = configured.filter(({ version }) => typeof version !== "string" || !exactVersionPattern.test(version));
if (invalid.length > 0) {
	for (const { section, name, spec } of invalid) {
		console.error(`${section}.${name} must pin an exact Pi version; found ${JSON.stringify(spec)}`);
	}
	process.exit(1);
}

let lockfileStale = false;
const lockedRoot = packageLock.packages?.[""];
for (const { section, name, spec, version } of configured) {
	const lockedSpec = lockedRoot?.[section]?.[name];
	const lockedVersion = packageLock.packages?.[`node_modules/${name}`]?.version;
	if (lockedSpec !== spec || lockedVersion !== version) {
		lockfileStale = true;
		console.error(`${name} lockfile mismatch: manifest ${spec}, root lock ${lockedSpec}, installed lock ${lockedVersion}`);
	}
}
if (lockfileStale) {
	console.error("Run npm install and commit the updated package-lock.json.");
	process.exit(1);
}

const registry = (process.env.PI_NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/$/, "");
const registryNames = [...new Set(configured.map(({ registryName }) => registryName))];
const latestByName = new Map(await Promise.all(registryNames.map(async (name) => {
	const response = await fetch(`${registry}/${encodeURIComponent(name)}/latest`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`npm registry returned HTTP ${response.status} for ${name}`);
	}
	const metadata = await response.json();
	if (typeof metadata.version !== "string") {
		throw new Error(`npm registry returned no latest version for ${name}`);
	}
	return [name, metadata.version];
})));

let stale = false;
for (const { name, registryName, version } of configured) {
	const latest = latestByName.get(registryName);
	if (version !== latest) {
		stale = true;
		console.error(`${name} is pinned to ${version}; npm latest for ${registryName} is ${latest}`);
	}
}

if (stale) {
	console.error("Update the bundled Pi packages together and commit package.json plus package-lock.json.");
	process.exit(1);
}

console.log(`Bundled Pi packages are pinned to npm latest (${[...latestByName.values()][0]}).`);
