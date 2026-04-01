/**
 * CLAUDE.md discovery — loads project-level instructions from the filesystem.
 *
 * Traverses from the git root (or filesystem root) down to cwd, collecting:
 *   - CLAUDE.md at each directory level
 *   - .claude/CLAUDE.md at each level
 *   - .claude/rules/*.md at each level
 * Also loads user-level CLAUDE.md from the Exocortex config directory.
 *
 * Supports @include directives: a line like `@include path/to/file.md`
 * is replaced with the contents of the referenced file (relative to
 * the CLAUDE.md that contains the directive).
 *
 * Content is injected into the system prompt so the AI follows
 * project-specific guidelines automatically.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { execSync } from "child_process";
import { configDir } from "@exocortex/shared/paths";
import { log } from "./log";

// ── Git root detection ──────────────────────────────────────────────

function findGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8", cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// ── @include processing ─────────────────────────────────────────────

/** Replace `@include path` lines with the referenced file's contents. */
function processIncludes(content: string, baseDir: string): string {
  return content.replace(/^@include\s+(.+)$/gm, (_, filePath: string) => {
    const resolved = resolve(baseDir, filePath.trim());
    try {
      return readFileSync(resolved, "utf8");
    } catch {
      return `<!-- @include ${filePath.trim()}: file not found -->`;
    }
  });
}

// ── File reading helper ─────────────────────────────────────────────

function readMd(filePath: string, baseDir: string): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  return processIncludes(raw, baseDir);
}

// ── Discovery ───────────────────────────────────────────────────────

interface ClaudeMdEntry {
  label: string;
  content: string;
}

function discover(cwd: string): ClaudeMdEntry[] {
  const entries: ClaudeMdEntry[] = [];
  const gitRoot = findGitRoot(cwd);
  const stopAt = gitRoot ? resolve(gitRoot) : null;

  // 1. User-level CLAUDE.md (most general)
  const userDir = configDir();
  const userContent = readMd(join(userDir, "CLAUDE.md"), userDir);
  if (userContent) {
    entries.push({ label: "(user) CLAUDE.md", content: userContent });
  }

  // 2. Collect directories from cwd up to git root (or filesystem root)
  const dirs: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    dirs.push(dir);
    if (stopAt && dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  dirs.reverse(); // root → cwd order (outermost first)

  // 3. Check each level for CLAUDE.md files
  for (const d of dirs) {
    const rel = relative(cwd, d);
    const prefix = rel === "" ? "" : rel + "/";

    // CLAUDE.md at this level
    const content = readMd(join(d, "CLAUDE.md"), d);
    if (content) {
      entries.push({ label: `${prefix}CLAUDE.md`, content });
    }

    // .claude/CLAUDE.md
    const dotClaudeDir = join(d, ".claude");
    const dotContent = readMd(join(dotClaudeDir, "CLAUDE.md"), dotClaudeDir);
    if (dotContent) {
      entries.push({ label: `${prefix}.claude/CLAUDE.md`, content: dotContent });
    }

    // .claude/rules/*.md
    const rulesDir = join(dotClaudeDir, "rules");
    if (existsSync(rulesDir)) {
      try {
        const mdFiles = readdirSync(rulesDir).filter(f => f.endsWith(".md")).sort();
        for (const f of mdFiles) {
          const ruleContent = readMd(join(rulesDir, f), rulesDir);
          if (ruleContent) {
            entries.push({ label: `${prefix}.claude/rules/${f}`, content: ruleContent });
          }
        }
      } catch { /* rulesDir exists but unreadable — skip */ }
    }
  }

  return entries;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Discover and load all CLAUDE.md files relevant to the current working directory.
 * Returns a formatted string ready for system prompt injection, or empty string
 * if no files were found.
 */
export function loadClaudeMd(): string {
  const cwd = process.cwd();
  const entries = discover(cwd);

  if (entries.length === 0) return "";

  log("info", `claudemd: loaded ${entries.length} file(s): ${entries.map(e => e.label).join(", ")}`);

  const sections = entries.map(e => `## ${e.label}\n${e.content}`);
  return "# Project instructions\n\n" + sections.join("\n\n");
}
