/**
 * WorktreeManager — per-session git worktree isolation for the knowledge base.
 *
 * Creates a worktree per Claude session so concurrent sessions (interactive,
 * cron triggers, monitor alerts) never interfere with each other's git state.
 * Changes are merged back to main when a session ends.
 *
 * @module git/worktree-manager
 */

import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";
import * as path from "node:path";
import process from "node:process";

const exec = promisify(execCallback);

/** Options for running git commands. */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/** Run a git command, returning stdout. Throws on non-zero exit. */
async function git(cwd: string, args: string): Promise<string> {
  const { stdout } = await exec(`git ${args}`, { cwd, env: gitEnv() });
  return stdout.trim();
}

/** Run a git command, ignoring errors (best-effort). */
async function gitQuiet(cwd: string, args: string): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

export class WorktreeManager {
  /** Path to the main worktree (e.g. /workspace). */
  private mainRepo: string;
  /** Base directory for session worktrees (e.g. /workspace/.worktrees). */
  private baseDir: string;
  /** Active worktrees: identifier → absolute worktree path. */
  private active = new Map<string, string>();
  /** Serialises merge-to-main operations so only one runs at a time. */
  private mergeChain: Promise<void> = Promise.resolve();
  /** Whether worktree support is enabled (disabled on init failure). */
  private enabled = true;

  constructor(mainRepo: string) {
    this.mainRepo = mainRepo;
    this.baseDir = path.join(mainRepo, ".worktrees");
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Get or create a worktree for the given identifier.
   * Returns the worktree path, or the main repo path on failure (fallback).
   */
  async acquire(identifier: string): Promise<string> {
    if (!this.enabled) return this.mainRepo;

    // Reuse existing worktree for this identifier
    const existing = this.active.get(identifier);
    if (existing) {
      try {
        await Deno.stat(existing);
        return existing;
      } catch {
        // Worktree dir disappeared — recreate
        this.active.delete(identifier);
      }
    }

    try {
      // Ensure base directory exists
      await Deno.mkdir(this.baseDir, { recursive: true });

      // Update main to latest remote state
      await this.pullMain();

      const branchName = `wt/${identifier}`;
      const worktreePath = path.join(this.baseDir, identifier);

      // Remove stale worktree entry if git still tracks it
      await gitQuiet(this.mainRepo, `worktree prune`);

      // Remove leftover directory if it exists (crashed previous run)
      try {
        await Deno.stat(worktreePath);
        await gitQuiet(this.mainRepo, `worktree remove "${worktreePath}" --force`);
        // Remove branch too if it exists
        await gitQuiet(this.mainRepo, `branch -D "${branchName}"`);
      } catch {
        // Directory doesn't exist — good
      }

      // Delete branch if it's left over from a previous session
      await gitQuiet(this.mainRepo, `branch -D "${branchName}"`);

      // Create worktree on a new branch from HEAD (which is main)
      await git(this.mainRepo, `worktree add "${worktreePath}" -b "${branchName}"`);

      this.active.set(identifier, worktreePath);
      console.log(`[WorktreeManager] Created worktree: ${identifier} → ${worktreePath}`);
      return worktreePath;
    } catch (err) {
      console.error(
        `[WorktreeManager] Failed to create worktree for ${identifier}, falling back to main:`,
        err instanceof Error ? err.message : err,
      );
      return this.mainRepo;
    }
  }

  /**
   * Commit any uncommitted changes in the worktree (crash-safe backup).
   * Call this after each turn completes.
   */
  async commitWorktree(identifier: string): Promise<void> {
    const wtPath = this.active.get(identifier);
    if (!wtPath) return;

    try {
      const status = await gitQuiet(wtPath, "status --porcelain");
      if (status) {
        await git(wtPath, "add -A");
        await git(wtPath, `commit -q -m "assistant: sync memory"`);
        console.log(`[WorktreeManager] Committed changes in worktree: ${identifier}`);
      }
    } catch (err) {
      console.warn(
        `[WorktreeManager] Commit failed for ${identifier}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Merge the worktree's branch back to main, push, and clean up.
   * Serialised via the merge mutex — safe to call concurrently.
   */
  async release(identifier: string): Promise<void> {
    if (!this.active.has(identifier)) return;
    // Chain onto the merge mutex so merges are sequential
    const op = this.mergeChain.then(() => this.doRelease(identifier));
    this.mergeChain = op.catch(() => {}); // swallow to keep chain alive
    await op;
  }

  /**
   * Get the worktree path for an identifier, or undefined if none.
   */
  getWorktreePath(identifier: string): string | undefined {
    return this.active.get(identifier);
  }

  /**
   * Check whether an identifier has an active worktree.
   */
  has(identifier: string): boolean {
    return this.active.has(identifier);
  }

  /**
   * Clean up all orphaned worktrees from a previous bot instance.
   * Called once at startup before the bot starts handling messages.
   */
  async cleanupOrphaned(): Promise<void> {
    if (!this.enabled) return;

    try {
      await Deno.stat(this.baseDir);
    } catch {
      return; // No worktree directory — nothing to clean
    }

    const orphans: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (entry.isDirectory) orphans.push(entry.name);
      }
    } catch {
      return;
    }

    if (orphans.length === 0) return;

    console.log(`[WorktreeManager] Found ${orphans.length} orphaned worktree(s): ${orphans.join(", ")}`);
    for (const id of orphans) {
      this.active.set(id, path.join(this.baseDir, id));
      try {
        await this.release(id);
        console.log(`[WorktreeManager] Cleaned up orphan: ${id}`);
      } catch (err) {
        console.error(
          `[WorktreeManager] Failed to clean up orphan ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /** Actual merge-and-cleanup logic (called under the mutex). */
  private async doRelease(identifier: string): Promise<void> {
    const wtPath = this.active.get(identifier);
    if (!wtPath) return;

    const branchName = `wt/${identifier}`;

    try {
      // 1. Commit any remaining changes
      await this.commitWorktree(identifier);

      // 2. Check if the branch has any commits beyond main
      let hasDiff = false;
      try {
        const diffStat = await git(this.mainRepo, `diff --stat main..."${branchName}"`);
        hasDiff = diffStat.length > 0;
      } catch {
        // Branch may not exist or may be same as main
        hasDiff = false;
      }

      if (hasDiff) {
        // 3. Get latest main
        await this.pullMain();

        // 4. Merge the session branch
        await git(this.mainRepo, `merge "${branchName}" --no-edit`);
        console.log(`[WorktreeManager] Merged ${branchName} into main`);

        // 5. Push
        await git(this.mainRepo, "push -q origin main");
        console.log(`[WorktreeManager] Pushed main after merging ${identifier}`);
      } else {
        console.log(`[WorktreeManager] No changes in ${identifier}, skipping merge`);
      }
    } catch (err) {
      console.error(
        `[WorktreeManager] Merge failed for ${identifier} — keeping worktree for manual resolution:`,
        err instanceof Error ? err.message : err,
      );
      // Try to abort a failed merge so main isn't left in a dirty state
      await gitQuiet(this.mainRepo, "merge --abort");
      // Don't clean up — the worktree stays for manual inspection
      this.active.delete(identifier);
      return;
    }

    // 6. Clean up worktree and branch
    try {
      await gitQuiet(this.mainRepo, `worktree remove "${wtPath}" --force`);
      await gitQuiet(this.mainRepo, `branch -D "${branchName}"`);
      await gitQuiet(this.mainRepo, "worktree prune");
    } catch (cleanErr) {
      console.warn(
        `[WorktreeManager] Cleanup warning for ${identifier}:`,
        cleanErr instanceof Error ? cleanErr.message : cleanErr,
      );
    }

    this.active.delete(identifier);
    console.log(`[WorktreeManager] Released worktree: ${identifier}`);
  }

  /** Pull latest main from origin. */
  private async pullMain(): Promise<void> {
    try {
      await git(this.mainRepo, "fetch origin main -q");
      // Rebase local main onto remote — handles both clean and diverged states
      await git(this.mainRepo, "rebase origin/main");
    } catch (err) {
      // If rebase fails, abort and try reset as fallback
      await gitQuiet(this.mainRepo, "rebase --abort");
      console.warn(
        "[WorktreeManager] Pull/rebase failed, trying reset:",
        err instanceof Error ? err.message : err,
      );
      try {
        await git(this.mainRepo, "reset --hard origin/main");
      } catch {
        console.error("[WorktreeManager] Reset also failed — main may be stale");
      }
    }
  }
}
