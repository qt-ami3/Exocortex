/**
 * Tool style resolution.
 *
 * Resolves tool display data for rendering. Uses daemon-provided
 * registry as the base, with optional user overrides for bash
 * sub-commands loaded from ~/.config/exocortex/tool-styles.json.
 *
 * User overrides match the beginning of bash command strings.
 * Example config:
 * {
 *   "gmail": { "label": "Gmail", "color": "#4ddbb7" },
 *   "docker": { "label": "Docker", "color": "#0db7ed" }
 * }
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ToolDisplayInfo } from "./messages";
import { theme, hexToAnsi } from "./theme";

// ── Types ──────────────────────────────────────────────────────────

interface UserToolStyle {
  label: string;
  color: string;
}

export interface ResolvedToolDisplay {
  label: string;
  detail: string;
  fg: string;     // ANSI truecolor escape
  /** Original command prefix that matched (user styles only). Used for multi-line re-application. */
  cmd?: string;
}

// ── User overrides ─────────────────────────────────────────────────

let userStyles: Record<string, UserToolStyle> = {};

function loadUserStyles(): void {
  try {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const path = join(xdg, "exocortex", "tool-styles.json");
    const data = readFileSync(path, "utf8");
    userStyles = JSON.parse(data);
  } catch {
    userStyles = {};
  }
}
loadUserStyles();

/**
 * Try to match a command string against a single user style entry.
 * Returns resolved display if the command starts with the key.
 */
function tryMatch(command: string, cmd: string, style: UserToolStyle): ResolvedToolDisplay | null {
  if (command === cmd || command.startsWith(cmd + " ") || command.startsWith(cmd + "\n")) {
    const detail = command.slice(cmd.length).trimStart();
    return { label: style.label, detail, fg: hexToAnsi(style.color), cmd };
  }
  return null;
}

/**
 * Match a bash command summary against user-defined tool styles.
 *
 * First tries matching the trimmed command directly. If that fails,
 * skips leading comment lines (# ...) and blank lines, then retries
 * against the first real command line. This handles cases where the
 * AI prepends comments like "# Fetch latest mentions\ngmail ...".
 */
function matchUserStyle(summary: string): ResolvedToolDisplay | null {
  const trimmed = summary.trimStart();
  for (const [cmd, style] of Object.entries(userStyles)) {
    const m = tryMatch(trimmed, cmd, style);
    if (m) return m;
  }

  // Retry: skip leading comment and blank lines
  const lines = trimmed.split("\n");
  const firstCmd = lines.findIndex(l => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("#");
  });
  if (firstCmd > 0) {
    const cmdLine = lines[firstCmd].trimStart();
    for (const [cmd, style] of Object.entries(userStyles)) {
      const m = tryMatch(cmdLine, cmd, style);
      if (m) return m;
    }
  }

  return null;
}

// ── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve display properties for a tool call.
 *
 * For bash commands, checks user overrides first (matching the
 * start of the command string). Falls back to daemon-provided
 * registry, then to a generic default.
 */
export function resolveToolDisplay(
  toolName: string,
  summary: string,
  registry: ToolDisplayInfo[],
): ResolvedToolDisplay {
  const info = registry.find(t => t.name === toolName);

  // Bash: check user overrides for sub-command matching
  if (toolName === "bash") {
    const match = matchUserStyle(summary);
    if (match) return match;
  }

  // Use daemon-provided registry
  if (info) {
    return {
      label: info.label,
      detail: summary,
      fg: hexToAnsi(info.color),
    };
  }

  // Fallback — use theme's tool color
  return { label: toolName, detail: summary, fg: theme.tool };
}
