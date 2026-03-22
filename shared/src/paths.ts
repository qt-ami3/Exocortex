/**
 * @exocortex/shared — Path resolution with git worktree isolation.
 *
 * Directory layout under CONFIG_DIR (~/.config/exocortex):
 *
 *   config root/        system.md, theme.json (tracked config)
 *   secrets/            env, credentials.json (never tracked)
 *   data/               conversations/, trash/ (bulk data, never tracked)
 *   runtime/            PID, socket, logs, usage.json (ephemeral)
 *   storage/            cron/, fix-auth.md (persistent user-local, not tracked)
 *
 * When running from a linked git worktree, runtime paths (socket, PID, logs)
 * and data paths (conversations) are namespaced by worktree name.
 * This lets multiple daemons coexist — one per worktree — without
 * conflicting. Secrets are always shared (same user, same API key).
 */

import { execSync } from "child_process";
import { homedir } from "os";
import { join, basename, resolve } from "path";

// ── Base config dir ─────────────────────────────────────────────────

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "exocortex",
);

// ── Worktree detection ──────────────────────────────────────────────

let _worktreeName: string | null | undefined; // undefined = not yet detected

/**
 * Detect if we're in a linked git worktree.
 * Returns the worktree name if so, null otherwise.
 * Result is cached after first call.
 */
function detectWorktree(): string | null {
  if (_worktreeName !== undefined) return _worktreeName;

  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // In a linked worktree, --git-dir is something like
    //   /path/to/main/.git/worktrees/<name>
    // while --git-common-dir is
    //   /path/to/main/.git
    // Resolve both to absolute paths to avoid relative/absolute mismatches.
    if (resolve(gitDir) !== resolve(gitCommonDir)) {
      _worktreeName = basename(gitDir);
    } else {
      _worktreeName = null;
    }
  } catch {
    // Not in a git repo, or git not available
    _worktreeName = null;
  }

  return _worktreeName;
}

// ── Public API ──────────────────────────────────────────────────────

/** Base config directory (~/.config/exocortex). */
export function configDir(): string {
  return CONFIG_DIR;
}

/** Secrets directory — API keys, OAuth tokens. Shared across worktrees. */
export function secretsDir(): string {
  return join(CONFIG_DIR, "secrets");
}

/** Data directory — conversations, trash. Namespaced by worktree. */
export function dataDir(): string {
  const wt = detectWorktree();
  return wt
    ? join(CONFIG_DIR, "data", "instances", wt)
    : join(CONFIG_DIR, "data");
}

/** Storage directory — cron scripts, docs. Persistent user-local files. */
export function storageDir(): string {
  return join(CONFIG_DIR, "storage");
}

/** Runtime dir for socket, PID, logs, usage. Namespaced by worktree. */
export function runtimeDir(): string {
  const wt = detectWorktree();
  return wt
    ? join(CONFIG_DIR, "runtime", wt)
    : join(CONFIG_DIR, "runtime");
}

/** Full path to the daemon socket. */
export function socketPath(): string {
  return join(runtimeDir(), "exocortexd.sock");
}

/** Full path to the daemon PID file. */
export function pidPath(): string {
  return join(runtimeDir(), "exocortexd.pid");
}

/** Conversations directory. Isolated per worktree to prevent data conflicts. */
export function conversationsDir(): string {
  return join(dataDir(), "conversations");
}

/** Trash directory for soft-deleted conversations. Isolated per worktree. */
export function trashDir(): string {
  return join(dataDir(), "trash");
}

/** The worktree name if in a linked worktree, null otherwise. */
export function worktreeName(): string | null {
  return detectWorktree();
}
