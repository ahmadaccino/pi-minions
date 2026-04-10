/**
 * Worktree merge utilities — analyze and auto-apply parallel worktree patches
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorktreeDiff, WorktreeSetup } from "./worktree.ts";

// ============================================================================
// Types
// ============================================================================

export interface SharedFileInfo {
	path: string;
	modifiedBy: number[]; // worktree indices
	isLikelyAdditive: boolean;
}

export interface WorktreeMergeAnalysis {
	sharedFiles: SharedFileInfo[];
	newFiles: Array<{ path: string; worktreeIndex: number }>;
	totalFilesChanged: number;
	estimatedAutoMergeable: number;
	estimatedManualMerge: number;
}

export interface PatchApplyResult {
	index: number;
	agent: string;
	applied: boolean;
	newFilesExtracted: string[];
	failedFiles: string[];
	error?: string;
}

export interface ConflictResolution {
	file: string;
	resolved: boolean;
	method: "auto-additive" | "manual-needed";
}

export interface WorktreeApplyResult {
	patchResults: PatchApplyResult[];
	conflictResolutions: ConflictResolution[];
	remainingConflicts: string[];
	validationPassed: boolean;
	validationOutput?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function gitChecked(cwd: string, args: string[]): string {
	const result = git(cwd, args);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

/**
 * Parse a patch file to extract the list of files it modifies.
 * Returns { newFiles: string[], modifiedFiles: string[] }
 */
function parsePatchFiles(patchPath: string): { newFiles: string[]; modifiedFiles: string[] } {
	let content: string;
	try {
		content = fs.readFileSync(patchPath, "utf-8");
	} catch {
		return { newFiles: [], modifiedFiles: [] };
	}

	const newFiles: string[] = [];
	const modifiedFiles: string[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Match "diff --git a/path b/path"
		const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		if (!diffMatch) continue;

		const filePath = diffMatch[2]!;
		// Check if the next few lines indicate a new file
		let isNew = false;
		for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
			if (lines[j]!.startsWith("new file mode")) {
				isNew = true;
				break;
			}
			if (lines[j]!.startsWith("diff --git")) break;
		}

		if (isNew) {
			newFiles.push(filePath);
		} else {
			modifiedFiles.push(filePath);
		}
	}

	return { newFiles, modifiedFiles };
}

// ============================================================================
// Merge Analysis
// ============================================================================

/**
 * Analyze worktree diffs to determine merge complexity.
 * Identifies shared files, new files, and estimates auto-mergeability.
 */
export function analyzeWorktreeMerge(diffs: WorktreeDiff[]): WorktreeMergeAnalysis {
	// Map: filePath → Set of worktree indices that modify it
	const fileToWorktrees = new Map<string, Set<number>>();
	// Map: filePath → whether it's a new file (created, not modified)
	const fileIsNew = new Map<string, boolean>();

	for (const diff of diffs) {
		if (diff.filesChanged === 0) continue;
		const { newFiles, modifiedFiles } = parsePatchFiles(diff.patchPath);

		for (const f of newFiles) {
			if (!fileToWorktrees.has(f)) fileToWorktrees.set(f, new Set());
			fileToWorktrees.get(f)!.add(diff.index);
			fileIsNew.set(f, true);
		}
		for (const f of modifiedFiles) {
			if (!fileToWorktrees.has(f)) fileToWorktrees.set(f, new Set());
			fileToWorktrees.get(f)!.add(diff.index);
			if (!fileIsNew.has(f)) fileIsNew.set(f, false);
		}
	}

	const sharedFiles: SharedFileInfo[] = [];
	const newFiles: Array<{ path: string; worktreeIndex: number }> = [];
	let totalFilesChanged = 0;

	for (const [filePath, worktreeIndices] of fileToWorktrees) {
		totalFilesChanged++;
		if (worktreeIndices.size > 1 && !fileIsNew.get(filePath)) {
			sharedFiles.push({
				path: filePath,
				modifiedBy: Array.from(worktreeIndices).sort(),
				// Heuristic: if a file is modified by multiple worktrees,
				// it's likely additive if all patches are pure insertions.
				// For now, assume additive (sequential apply will verify).
				isLikelyAdditive: true,
			});
		} else if (worktreeIndices.size === 1) {
			if (fileIsNew.get(filePath)) {
				newFiles.push({
					path: filePath,
					worktreeIndex: Array.from(worktreeIndices)[0]!,
				});
			}
		}
	}

	return {
		sharedFiles,
		newFiles,
		totalFilesChanged,
		estimatedAutoMergeable: sharedFiles.filter((f) => f.isLikelyAdditive).length,
		estimatedManualMerge: sharedFiles.filter((f) => !f.isLikelyAdditive).length,
	};
}

// ============================================================================
// Auto-Apply
// ============================================================================

/**
 * Check if a file has conflict markers.
 */
function hasConflictMarkers(filePath: string): boolean {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return /^<{7}\s/m.test(content) && /^={7}$/m.test(content) && /^>{7}\s/m.test(content);
	} catch {
		return false;
	}
}

/**
 * Attempt to resolve conflict markers in a file by keeping both sides.
 * Only works for simple additive conflicts where both sides add different content.
 * Returns true if resolution succeeded.
 */
function resolveAdditiveConflict(filePath: string): boolean {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return false;
	}

	// Pattern: <<<<<<< ours\n(ours content)\n=======\n(theirs content)\n>>>>>>> theirs
	const conflictRegex = /^<{7}\s.*\n([\s\S]*?)^={7}$\n([\s\S]*?)^>{7}\s.*$/gm;
	let resolved = content;
	let hadConflicts = false;

	resolved = content.replace(conflictRegex, (_match, ours: string, theirs: string) => {
		hadConflicts = true;
		// Keep both sides — ours first, then theirs
		const oursClean = ours.trimEnd();
		const theirsClean = theirs.trimEnd();
		if (oursClean && theirsClean) {
			return `${oursClean}\n${theirsClean}`;
		}
		return oursClean || theirsClean;
	});

	if (!hadConflicts) return false;

	// Verify no conflict markers remain
	if (/^<{7}\s/m.test(resolved)) return false;

	try {
		fs.writeFileSync(filePath, resolved, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Get list of files with conflict markers in a repo.
 */
function findConflictFiles(cwd: string): string[] {
	const result = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
	if (result.status !== 0) return [];
	return result.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Apply all worktree patches sequentially to the main branch.
 * 
 * Strategy:
 * 1. Sort patches: fewest shared file modifications first
 * 2. For each patch:
 *    a. Try `git apply --3way`
 *    b. If partial failure, extract new files with `--include`
 *    c. For conflict markers in shared files, attempt additive resolution
 * 3. Stage all changes
 * 4. Return structured result
 */
export function applyWorktreePatches(
	cwd: string,
	diffs: WorktreeDiff[],
	analysis: WorktreeMergeAnalysis,
): WorktreeApplyResult {
	const patchResults: PatchApplyResult[] = [];
	const conflictResolutions: ConflictResolution[] = [];
	const allConflictFiles = new Set<string>();

	// Sort: patches with fewer shared file modifications first
	const sharedFileSet = new Set(analysis.sharedFiles.map((f) => f.path));
	const sortedDiffs = [...diffs]
		.filter((d) => d.filesChanged > 0)
		.sort((a, b) => {
			const aShared = parsePatchFiles(a.patchPath).modifiedFiles.filter((f) => sharedFileSet.has(f)).length;
			const bShared = parsePatchFiles(b.patchPath).modifiedFiles.filter((f) => sharedFileSet.has(f)).length;
			return aShared - bShared;
		});

	for (const diff of sortedDiffs) {
		if (!fs.existsSync(diff.patchPath)) {
			patchResults.push({
				index: diff.index,
				agent: diff.agent,
				applied: false,
				newFilesExtracted: [],
				failedFiles: [],
				error: "Patch file not found",
			});
			continue;
		}

		const patchContent = fs.readFileSync(diff.patchPath, "utf-8").trim();
		if (!patchContent) {
			patchResults.push({
				index: diff.index,
				agent: diff.agent,
				applied: true,
				newFilesExtracted: [],
				failedFiles: [],
			});
			continue;
		}

		// Try full apply with --3way
		const applyResult = git(cwd, ["apply", "--3way", diff.patchPath]);
		
		if (applyResult.status === 0) {
			// Clean apply
			patchResults.push({
				index: diff.index,
				agent: diff.agent,
				applied: true,
				newFilesExtracted: [],
				failedFiles: [],
			});
			continue;
		}

		// Partial failure — try to extract new files individually
		const { newFiles, modifiedFiles } = parsePatchFiles(diff.patchPath);
		const extractedNewFiles: string[] = [];
		const failedFiles: string[] = [];

		// Apply new files one by one
		for (const newFile of newFiles) {
			const includeResult = git(cwd, ["apply", `--include=${newFile}`, diff.patchPath]);
			if (includeResult.status === 0) {
				extractedNewFiles.push(newFile);
			} else {
				failedFiles.push(newFile);
			}
		}

		// Check which modified files have conflict markers
		for (const modFile of modifiedFiles) {
			const fullPath = path.join(cwd, modFile);
			if (hasConflictMarkers(fullPath)) {
				allConflictFiles.add(modFile);
			}
		}

		patchResults.push({
			index: diff.index,
			agent: diff.agent,
			applied: false,
			newFilesExtracted: extractedNewFiles,
			failedFiles,
			error: applyResult.stderr.trim().split("\n").slice(0, 3).join("; "),
		});
	}

	// Attempt to resolve conflict markers in shared files
	for (const conflictFile of allConflictFiles) {
		const fullPath = path.join(cwd, conflictFile);
		if (!hasConflictMarkers(fullPath)) continue;

		const resolved = resolveAdditiveConflict(fullPath);
		conflictResolutions.push({
			file: conflictFile,
			resolved,
			method: resolved ? "auto-additive" : "manual-needed",
		});
	}

	// Check for any remaining conflict markers across all tracked files
	const remainingConflicts: string[] = [];
	const conflictCheck = git(cwd, ["grep", "-l", "^<<<<<<<", "--", "*.ts", "*.tsx", "*.js", "*.json", "*.md"]);
	if (conflictCheck.status === 0 && conflictCheck.stdout.trim()) {
		remainingConflicts.push(...conflictCheck.stdout.trim().split("\n").filter(Boolean));
	}

	// Stage everything
	git(cwd, ["add", "-A"]);

	return {
		patchResults,
		conflictResolutions,
		remainingConflicts,
		validationPassed: remainingConflicts.length === 0,
	};
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Run a validation command after merge (e.g., `npx tsc --noEmit`).
 */
export function runValidation(cwd: string, command: string): { passed: boolean; output: string } {
	const result = spawnSync("sh", ["-c", command], {
		cwd,
		encoding: "utf-8",
		timeout: 60000,
		maxBuffer: 5 * 1024 * 1024,
	});

	const output = (result.stdout || "") + (result.stderr || "");
	return {
		passed: result.status === 0,
		output: output.trim().split("\n").slice(-20).join("\n"), // Last 20 lines
	};
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format merge analysis for display in the worktree summary.
 */
export function formatMergeAnalysis(analysis: WorktreeMergeAnalysis): string {
	if (analysis.sharedFiles.length === 0 && analysis.newFiles.length === 0) {
		return "";
	}

	const lines: string[] = ["", "=== Merge Analysis ==="];

	if (analysis.sharedFiles.length > 0) {
		lines.push("Shared files (modified by multiple tasks):");
		for (const sf of analysis.sharedFiles) {
			const tasks = sf.modifiedBy.map((i) => i + 1).join(",");
			const status = sf.isLikelyAdditive ? "additive, auto-mergeable" : "may need manual merge";
			lines.push(`  ${sf.path} — tasks ${tasks} (${status})`);
		}
	}

	lines.push(`New files: ${analysis.newFiles.length} (no conflicts)`);
	lines.push(
		`Estimated: ${analysis.estimatedAutoMergeable} auto-resolvable, ${analysis.estimatedManualMerge} manual`,
	);

	return lines.join("\n");
}

/**
 * Format auto-apply results for display.
 */
export function formatApplyResult(result: WorktreeApplyResult): string {
	const lines: string[] = ["", "=== Auto-Merge Result ==="];

	const applied = result.patchResults.filter((p) => p.applied).length;
	const total = result.patchResults.length;
	const icon = applied === total ? "✓" : "◐";
	lines.push(`${icon} Applied ${applied}/${total} patches cleanly`);

	// Show partially applied patches
	for (const pr of result.patchResults) {
		if (!pr.applied && pr.newFilesExtracted.length > 0) {
			lines.push(`  Task ${pr.index + 1} (${pr.agent}): ${pr.newFilesExtracted.length} new files extracted`);
			if (pr.failedFiles.length > 0) {
				lines.push(`    ⚠ ${pr.failedFiles.length} files need manual integration`);
			}
		}
	}

	// Show conflict resolutions
	const autoResolved = result.conflictResolutions.filter((c) => c.resolved);
	if (autoResolved.length > 0) {
		lines.push(`✓ Auto-resolved ${autoResolved.length} shared file conflicts (kept both sides)`);
	}

	const manualNeeded = result.conflictResolutions.filter((c) => !c.resolved);
	if (manualNeeded.length > 0) {
		lines.push(`⚠ ${manualNeeded.length} files need manual conflict resolution:`);
		for (const c of manualNeeded) {
			lines.push(`    ${c.file}`);
		}
	}

	if (result.remainingConflicts.length > 0) {
		lines.push(`✗ ${result.remainingConflicts.length} files still have conflict markers:`);
		for (const f of result.remainingConflicts) {
			lines.push(`    ${f}`);
		}
	} else {
		lines.push("✓ No conflict markers found");
	}

	if (result.validationOutput) {
		lines.push(result.validationPassed ? "✓ Validation passed" : "✗ Validation failed");
	}

	return lines.join("\n");
}
