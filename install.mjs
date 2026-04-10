#!/usr/bin/env node

/**
 * pi-minions installer
 * 
 * Usage:
 *   npx pi-minions          # Install to ~/.pi/agent/extensions/subagent
 *   npx pi-minions --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");
const REPO_URL = "https://github.com/ahmadaccino/pi-minions.git";

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-minions - Pi extension for delegating tasks to subagents (minions)

Usage:
  npx pi-minions          Install the extension
  npx pi-minions --remove Remove the extension
  npx pi-minions --help   Show this help

Installation directory: ${EXTENSION_DIR}
`);
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("✓ pi-minions removed");
	} else {
		console.log("pi-minions is not installed");
	}
	process.exit(0);
}

// Install
console.log("Installing pi-minions...\n");

// Ensure parent directory exists
const parentDir = path.dirname(EXTENSION_DIR);
if (!fs.existsSync(parentDir)) {
	fs.mkdirSync(parentDir, { recursive: true });
}

// Check if already installed
if (fs.existsSync(EXTENSION_DIR)) {
	const isGitRepo = fs.existsSync(path.join(EXTENSION_DIR, ".git"));
	if (isGitRepo) {
		console.log("Updating existing installation...");
		try {
			execSync("git pull", { cwd: EXTENSION_DIR, stdio: "inherit" });
			console.log("\n✓ pi-minions updated");
		} catch (err) {
			console.error("Failed to update. Try removing and reinstalling:");
			console.error("  npx pi-minions --remove && npx pi-minions");
			process.exit(1);
		}
	} else {
		console.log(`Directory exists but is not a git repo: ${EXTENSION_DIR}`);
		console.log("Remove it first with: npx pi-minions --remove");
		process.exit(1);
	}
} else {
	// Fresh install
	console.log(`Cloning to ${EXTENSION_DIR}...`);
	try {
		execSync(`git clone ${REPO_URL} "${EXTENSION_DIR}"`, { stdio: "inherit" });
		console.log("\n✓ pi-minions installed");
	} catch (err) {
		console.error("Failed to clone repository");
		process.exit(1);
	}
}

console.log(`
The extension is now available in pi. Tools added:
  • subagent       - Delegate tasks to agents (single, chain, parallel)
  • subagent_status - Check async run status

Features: worktree isolation + auto-merge on by default for parallel tasks.

Documentation: ${EXTENSION_DIR}/README.md
`);
