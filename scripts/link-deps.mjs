/**
 * Developer convenience: symlink the Pi runtime packages (and @types/node) from
 * the machine's installed Pi into this project's node_modules so `tsc` and the
 * test runner can resolve them without a network install.
 *
 * Usage: npm run link-deps
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const nodeModules = path.join(projectRoot, "node_modules");

/** NODE_PATH candidates from the `pi` launcher and the ambient environment. */
function piSearchPaths() {
	const paths = [];
	try {
		const script = fs.readFileSync(
			execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
			"utf8",
		);
		const match = /NODE_PATH="([^"]+)"/.exec(script);
		if (match) paths.push(...match[1].split(":").filter(Boolean));
	} catch {
		/* fall through to env candidates */
	}
	const nodePath = process.env.NODE_PATH;
	if (nodePath) paths.push(...nodePath.split(":").filter(Boolean));
	return [...new Set(paths)];
}

function locatePiPackage() {
	for (const base of piSearchPaths()) {
		const candidate = path.join(base, "@earendil-works", "pi-coding-agent");
		if (fs.existsSync(path.join(candidate, "package.json")))
			return fs.realpathSync(candidate);
	}
	throw new Error(
		"Could not locate @earendil-works/pi-coding-agent. Install Pi or set NODE_PATH to its node_modules directory.",
	);
}

function link(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.unlinkSync(to);
	} catch {
		/* nothing to replace */
	}
	fs.symlinkSync(from, to, "dir");
}

function findTypesNode(pnpmDir) {
	let entries;
	try {
		entries = fs.readdirSync(pnpmDir);
	} catch {
		return undefined;
	}
	const versions = entries
		.filter((name) => name.startsWith("@types+node@"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	// Prefer a major that current TypeScript handles cleanly, else the newest.
	const preferred =
		versions.filter((name) => /^@types\+node@(22|24)\./.test(name)).at(-1) ??
		versions.at(-1);
	if (!preferred) return undefined;
	const candidate = path.join(
		pnpmDir,
		preferred,
		"node_modules",
		"@types",
		"node",
	);
	return fs.existsSync(candidate) ? candidate : undefined;
}

function findTypescript(pnpmDir) {
	let entries;
	try {
		entries = fs.readdirSync(pnpmDir);
	} catch {
		return undefined;
	}
	const versions = entries
		.filter((name) => /^typescript@5\./.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const latest = versions.at(-1);
	if (!latest) return undefined;
	const candidate = path.join(pnpmDir, latest, "node_modules", "typescript");
	return fs.existsSync(candidate) ? candidate : undefined;
}

const piDir = locatePiPackage();
const storeNodeModules = path.dirname(path.dirname(piDir)); // .../<hash>/node_modules

for (const name of ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"]) {
	const from = path.join(storeNodeModules, "@earendil-works", name);
	if (!fs.existsSync(from)) {
		console.error(`skip: ${name} not found at ${from}`);
		continue;
	}
	link(fs.realpathSync(from), path.join(nodeModules, "@earendil-works", name));
}

const typebox = path.join(storeNodeModules, "typebox");
if (fs.existsSync(typebox)) {
	link(fs.realpathSync(typebox), path.join(nodeModules, "typebox"));
}

const pnpmDir = path.dirname(path.dirname(storeNodeModules));
const typesNode = findTypesNode(pnpmDir);
if (typesNode) {
	link(typesNode, path.join(nodeModules, "@types", "node"));
} else {
	console.error("skip: @types/node not found in the pnpm store");
}

const typescript = findTypescript(pnpmDir);
if (typescript) {
	link(typescript, path.join(nodeModules, "typescript"));
} else {
	console.error("skip: typescript 5.x not found in the pnpm store");
}

console.log(`Linked Pi runtime packages from ${storeNodeModules}`);
