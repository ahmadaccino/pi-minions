# Smart Worktree Merge — Implementation Plan

## Problem

When parallel subagents run in worktrees, the merge back into the main branch is entirely manual. The parent agent must:
1. Apply patches one-by-one with `git apply --3way`
2. Manually resolve conflicts (even additive, non-contradictory ones)
3. Extract new files when patches partially fail
4. Manually integrate changes to shared files (schema, layouts, configs)
5. Verify no conflict markers remain

In practice, merging takes ~60% of total wall-clock time for multi-feature implementations.

## Solution: Three Features

### Feature 1: Worktree Merge Analysis (`worktree-merge.ts`)

After worktree diffs are captured but before cleanup, analyze all patches to detect:
- **Shared files**: files modified by 2+ worktrees
- **New-only files**: files created (not modified) by a single worktree
- **Conflict risk**: whether shared file changes overlap or are purely additive

Add a `analyzeWorktreeMerge()` function that returns:
```typescript
interface WorktreeMergeAnalysis {
  sharedFiles: Array<{
    path: string;
    modifiedBy: number[];  // worktree indices
    isLikelyAdditive: boolean;  // heuristic: all changes are insertions to different regions
  }>;
  newFiles: Array<{
    path: string;
    worktreeIndex: number;
  }>;
  totalFilesChanged: number;
  estimatedConflicts: number;
}
```

The analysis is returned in `formatWorktreeDiffSummary()` output so the parent agent sees it.

### Feature 2: Auto-Apply Worktree Patches (`worktree-apply.ts`)

New file with an `applyWorktreePatches()` function that:
1. Applies patches in order using `git apply --3way`
2. For partially failed patches, extracts and applies new files individually with `--include`
3. For conflict markers in shared files, attempts auto-resolution when both sides are additive (insertions to different regions of the same file)
4. Returns a structured result:

```typescript
interface WorktreeApplyResult {
  applied: number;
  conflicts: Array<{
    file: string;
    worktreeIndices: number[];
    autoResolved: boolean;
  }>;
  failedFiles: string[];  // files that couldn't be applied or auto-resolved
  needsManualMerge: string[];  // files with real overlapping changes
}
```

The parent agent gets this as a new `subagent` tool result section, so it can see exactly what needs manual attention (if anything).

### Feature 3: Post-Merge Validation

After applying patches, run validation:
1. Check for remaining conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
2. Optionally run a user-specified validation command (e.g., `npx tsc --noEmit`)
3. Report results

---

## Implementation Details

### Files to Create
- `worktree-merge.ts` — Analysis + auto-apply + validation logic

### Files to Modify
- `worktree.ts` — Export `analyzeWorktreeMerge()` alongside existing exports, use repo state helpers
- `index.ts` — After parallel worktree execution, call analyze and optionally auto-apply
- `types.ts` — Add `WorktreeMergeAnalysis` and `WorktreeApplyResult` types
- `schemas.ts` — Add `autoMerge` boolean parameter to the worktree parallel schema
- `render.ts` — Render merge analysis and apply results in the tool output

### Merge Strategy: Additive Detection

For shared files, determine if changes are additive (non-overlapping insertions):
1. Parse each patch's hunks for the shared file
2. Check if any hunks from different worktrees overlap in line ranges
3. If no overlaps → mark as `isLikelyAdditive: true`
4. For additive changes: apply patches sequentially, re-running `git apply --3way` after each

### Auto-Apply Flow

```
1. Sort patches: apply worktrees with fewest shared file modifications first
2. For each patch:
   a. Try `git apply --3way`
   b. If partial failure:
      - Extract new files with `git apply --include=<new-files>`
      - For modified files that failed: check if conflict is additive
      - If additive: resolve by keeping both sides
      - If not: add to needsManualMerge list
3. Check for conflict markers in all modified files
4. Run validation command if configured
5. Return structured result
```

### Schema Addition

Add to the `subagent` tool parameters:
```typescript
autoMerge: Type.Optional(Type.Boolean({
  description: "When using worktree isolation, automatically apply and merge all worktree patches back into the main branch. Default: false."
}))
```

### Output Format

The worktree diff summary will include merge analysis:
```
=== Worktree Changes ===

--- Task 1 (worker): 16 files changed, +3458 -31 ---
 convex/schema.ts | 63 +++
 ...

--- Task 2 (worker): 8 files changed, +1190 -30 ---
 convex/schema.ts | 41 +++
 ...

=== Merge Analysis ===
Shared files (modified by multiple tasks):
  convex/schema.ts     — tasks 1,2,3,4,5 (additive, auto-mergeable)
  convex/crons.ts      — tasks 1,2 (additive, auto-mergeable)
  app/(band)/_layout.tsx — tasks 1,3 (additive, auto-mergeable)

New files: 23 (no conflicts)
Estimated conflicts: 0 auto-resolvable, 0 manual

=== Auto-Merge Result ===
✓ Applied 5/5 patches
✓ Auto-resolved 3 shared files
✓ No conflict markers found
✓ Validation passed (tsc --noEmit)

Full patches: /tmp/pi-worktree-diffs/...
```
