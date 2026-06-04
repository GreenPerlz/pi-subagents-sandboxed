import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveProjectLocalPiPackageResources } from "../../src/agents/pi-packages.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function makePackage(dir: string, extensions: string[]): void {
	writeJson(path.join(dir, "package.json"), {
		name: path.basename(dir),
		pi: { extensions },
	});
}

function makeProject(): { project: string; home: string; configDir: string } {
	const project = makeTempDir("pi-subagents-project-");
	const home = makeTempDir("pi-subagents-home-");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const configDir = path.join(project, ".pi");
	fs.mkdirSync(configDir, { recursive: true });
	return { project, home, configDir };
}

describe("resolveProjectLocalPiPackageResources", () => {
	it("includes cwd package root when it has pi extensions", () => {
		const { project } = makeProject();
		makePackage(project, ["./src/ext.ts"]);
		fs.mkdirSync(path.join(project, "src"), { recursive: true });
		fs.writeFileSync(path.join(project, "src", "ext.ts"), "", "utf-8");

		const result = resolveProjectLocalPiPackageResources(project);

		assert.ok(result.packageRoots.includes(project));
		assert.ok(result.extensions.some((e) => e.endsWith(path.join("src", "ext.ts"))));
	});

	it("rejects settings package roots outside the project boundary", () => {
		const { project, home, configDir } = makeProject();
		const outsideProject = makeTempDir("pi-subagents-outside-");
		const insideProject = path.join(project, "packages", "inside");
		fs.mkdirSync(insideProject, { recursive: true });

		makePackage(outsideProject, ["./ext.ts"]);
		makePackage(insideProject, ["./ext.ts"]);
		makePackage(project, ["./src/cwd-ext.ts"]);

		writeJson(path.join(configDir, "settings.json"), {
			packages: [
				{ source: `file:${outsideProject}` },
				{ source: `file:../../${path.basename(outsideProject)}` },
				{ source: `file:${home}` },
				{ source: "file:~" },
				{ source: "file:~/global-pkg" },
				{ source: `file:${insideProject}` },
				{ source: "file:./packages/inside" },
				{ source: "file:../project/packages/inside" },
				{ source: "npm:safe-npm-pkg" },
				{ source: "git:github.com/user/repo" },
				{ source: "/absolute/path" },
			],
		});

		// Also create packages for npm/git sources so they exist under configDir
		makePackage(path.join(configDir, "npm", "node_modules", "safe-npm-pkg"), ["./ext.ts"]);
		fs.writeFileSync(path.join(configDir, "npm", "node_modules", "safe-npm-pkg", "ext.ts"), "", "utf-8");
		makePackage(path.join(configDir, "git", "github.com", "user", "repo"), ["./ext.ts"]);
		fs.writeFileSync(path.join(configDir, "git", "github.com", "user", "repo", "ext.ts"), "", "utf-8");

		const result = resolveProjectLocalPiPackageResources(project);

		// Only project-local ones should be included
		assert.equal(result.packageRoots.includes(outsideProject), false, "should reject absolute outside path");
		assert.equal(result.packageRoots.includes(home), false, "should reject home dir");
		assert.equal(result.packageRoots.includes(path.join(home, "global-pkg")), false, "should reject home subdir");
		assert.equal(result.packageRoots.includes("/absolute/path"), false, "should reject absolute path");
		assert.equal(result.packageRoots.includes(insideProject), true, "should accept inside project absolute");
		assert.equal(result.packageRoots.includes(path.resolve(configDir, "npm", "node_modules", "safe-npm-pkg")), true, "should accept npm under configDir");
		assert.equal(result.packageRoots.includes(path.resolve(configDir, "git", "github.com", "user", "repo")), true, "should accept git under configDir");
		assert.ok(result.packageRoots.includes(project), "should include cwd package root");
	});

	it("rejects extension entries that are absolute or escape the package root", () => {
		const { project, configDir } = makeProject();
		const pkgDir = path.join(configDir, "packages", "safe-pkg");
		fs.mkdirSync(pkgDir, { recursive: true });
		const absoluteBad = path.join(makeTempDir("pi-subagents-abs-"), "bad.ts");
		fs.writeFileSync(absoluteBad, "", "utf-8");

		writeJson(path.join(pkgDir, "package.json"), {
			name: "safe-pkg",
			pi: {
				extensions: [
					"./safe.ts",
					"../escaped.ts",
					"../../more-escaped.ts",
					absoluteBad,
					"./nested/also-safe.ts",
				],
			},
		});
		fs.mkdirSync(path.join(pkgDir, "nested"), { recursive: true });
		fs.writeFileSync(path.join(pkgDir, "safe.ts"), "", "utf-8");
		fs.writeFileSync(path.join(pkgDir, "nested", "also-safe.ts"), "", "utf-8");
		// Create the escaped files on disk so the test verifies they are rejected even when they exist
		fs.writeFileSync(path.resolve(pkgDir, "../escaped.ts"), "", "utf-8");
		fs.writeFileSync(path.resolve(pkgDir, "../../more-escaped.ts"), "", "utf-8");

		writeJson(path.join(configDir, "settings.json"), {
			packages: [{ source: "file:./packages/safe-pkg" }],
		});

		const result = resolveProjectLocalPiPackageResources(project);

		assert.ok(result.packageRoots.includes(pkgDir), "package root should be included");
		assert.equal(result.extensions.some((e) => e.endsWith("safe.ts")), true, "safe extension should be included");
		assert.equal(result.extensions.some((e) => e.endsWith("also-safe.ts")), true, "nested safe extension should be included");
		assert.equal(result.extensions.some((e) => e.includes("escaped")), false, "escaped extension should be rejected");
		assert.equal(result.extensions.some((e) => e.includes("more-escaped")), false, "more-escaped extension should be rejected");
		assert.equal(result.extensions.includes(absoluteBad), false, "absolute extension should be rejected");
	});

	it("rejects selected extension entries that are absolute or escape the package root", () => {
		const { project, configDir } = makeProject();
		const pkgDir = path.join(configDir, "packages", "safe-pkg");
		fs.mkdirSync(pkgDir, { recursive: true });
		const absoluteBad = path.join(makeTempDir("pi-subagents-abs-"), "bad.ts");
		fs.writeFileSync(absoluteBad, "", "utf-8");

		makePackage(pkgDir, ["./safe.ts"]);
		fs.writeFileSync(path.join(pkgDir, "safe.ts"), "", "utf-8");
		fs.writeFileSync(path.resolve(pkgDir, "../escaped.ts"), "", "utf-8");

		writeJson(path.join(configDir, "settings.json"), {
			packages: [{
				source: "file:./packages/safe-pkg",
				extensions: ["./safe.ts", "../escaped.ts", absoluteBad],
			}],
		});

		const result = resolveProjectLocalPiPackageResources(project);

		assert.ok(result.packageRoots.includes(pkgDir));
		assert.equal(result.extensions.some((e) => e.endsWith("safe.ts")), true);
		assert.equal(result.extensions.some((e) => e.includes("escaped")), false);
		assert.equal(result.extensions.includes(absoluteBad), false);
	});
});
