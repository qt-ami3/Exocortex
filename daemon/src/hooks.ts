/**
 * Hook system — user-configurable shell commands at lifecycle points.
 *
 * Hooks are defined in config/hooks.json:
 *
 *   {
 *     "PreToolUse": [
 *       { "command": "./lint-check.sh", "if": "Edit(**.py)", "timeout": 30 }
 *     ],
 *     "PostToolUse": [
 *       { "command": "./log-tool.sh" }
 *     ],
 *     "UserPromptSubmit": [
 *       { "command": "./filter-prompt.sh", "timeout": 10 }
 *     ]
 *   }
 *
 * Hook commands receive JSON context on stdin. PreToolUse and
 * UserPromptSubmit hooks can block execution or modify input by
 * returning JSON on stdout with a `decision` field.
 *
 * The `if` condition uses ToolName(pattern) syntax — the tool name
 * is matched case-insensitively, and the pattern is glob-matched
 * against the tool's primary input field (e.g. file_path for Edit,
 * command for Bash).
 *
 * Config is hot-reloaded: changes to hooks.json are picked up on
 * the next hook invocation without restarting the daemon.
 */

import { readFileSync, statSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { configDir } from "@exocortex/shared/paths";
import { log } from "./log";

// ── Types ────────────────────────────────────────────────────────────

interface HookDef {
  command: string;
  if?: string;
  timeout?: number;
}

interface HooksConfig {
  PreToolUse?: HookDef[];
  PostToolUse?: HookDef[];
  UserPromptSubmit?: HookDef[];
}

interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  updatedText?: string;
}

export interface PreToolHookResult {
  blocked: boolean;
  reason: string;
  updatedInput?: Record<string, unknown>;
}

export interface PromptHookResult {
  blocked: boolean;
  reason: string;
  updatedText?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const HOOKS_PATH = join(configDir(), "hooks.json");
const DEFAULT_TIMEOUT = 30; // seconds

/** Primary input field per tool — used for pattern matching. */
const PRIMARY_FIELD: Record<string, string> = {
  bash: "command",
  read: "file_path",
  write: "file_path",
  edit: "file_path",
  glob: "pattern",
  grep: "pattern",
  browse: "url",
  context: "action",
};

// ── Config loading (hot-reload via mtime) ────────────────────────────

let _config: HooksConfig = {};
let _lastMtime = 0;

function getConfig(): HooksConfig {
  try {
    const stat = statSync(HOOKS_PATH);
    if (stat.mtimeMs === _lastMtime) return _config;
    _lastMtime = stat.mtimeMs;
    _config = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
    const count = Object.values(_config)
      .reduce((sum, hooks) => sum + (Array.isArray(hooks) ? hooks.length : 0), 0);
    log("info", `hooks: loaded ${count} hook(s) from ${HOOKS_PATH}`);
  } catch {
    if (_lastMtime !== 0) {
      log("info", "hooks: config removed or unreadable, clearing hooks");
    }
    _config = {};
    _lastMtime = 0;
  }
  return _config;
}

// ── Glob matching ────────────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 *   *  → match any character except /
 *   ** → match any character (including /)
 *   ?  → match one character (not /)
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}

// ── Condition matching ───────────────────────────────────────────────

/**
 * Check if a hook's `if` condition matches the current tool invocation.
 *
 * Condition syntax: `ToolName(pattern)` or just `ToolName`.
 * Tool name is case-insensitive. Pattern is glob-matched against
 * the tool's primary input field.
 */
function matchesCondition(
  condition: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  const match = condition.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return false;

  const [, condTool, condPattern] = match;
  if (condTool.toLowerCase() !== toolName.toLowerCase()) return false;
  if (!condPattern) return true;

  const field = PRIMARY_FIELD[toolName] ?? "";
  const value = String(input[field] ?? "");
  return globToRegex(condPattern).test(value);
}

// ── Hook command execution ───────────────────────────────────────────

function executeHook(command: string, context: unknown, timeoutSec: number): Promise<HookOutput> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;

    const child = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    const timer = setTimeout(() => {
      child.kill();
      if (!done) {
        done = true;
        log("warn", `hooks: timed out after ${timeoutSec}s: ${command}`);
        resolve({});
      }
    }, timeoutSec * 1000);

    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        log("error", `hooks: spawn error: ${err.message}`);
        resolve({});
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (done) return;
      done = true;

      // Try JSON output first — takes priority over exit code
      const out = stdout.trim();
      if (out) {
        try {
          resolve(JSON.parse(out));
          return;
        } catch { /* not JSON, fall through */ }
      }

      // No JSON → use exit code: non-zero = block
      if (code !== 0) {
        resolve({ decision: "block", reason: stderr.trim() || `Hook exited with code ${code}` });
      } else {
        resolve({});
      }
    });

    child.stdin.write(JSON.stringify(context));
    child.stdin.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run PreToolUse hooks for a tool invocation.
 * Returns whether the call should be blocked and any input modifications.
 * Hooks run sequentially — a block from any hook stops the chain.
 */
export async function runPreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PreToolHookResult> {
  const hooks = getConfig().PreToolUse;
  if (!hooks?.length) return { blocked: false, reason: "" };

  let currentInput = input;

  for (const hook of hooks) {
    if (!matchesCondition(hook.if, toolName, currentInput)) continue;

    const context = { event: "PreToolUse", tool: toolName, input: currentInput };
    const result = await executeHook(hook.command, context, hook.timeout ?? DEFAULT_TIMEOUT);

    if (result.decision === "block") {
      log("info", `hooks: PreToolUse blocked ${toolName}: ${result.reason ?? "no reason"}`);
      return { blocked: true, reason: result.reason ?? "Blocked by hook" };
    }

    if (result.updatedInput) {
      currentInput = result.updatedInput;
    }
  }

  return {
    blocked: false,
    reason: "",
    updatedInput: currentInput !== input ? currentInput : undefined,
  };
}

/**
 * Run PostToolUse hooks after a tool completes.
 * Informational only — cannot block or modify the result.
 */
export async function runPostToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): Promise<void> {
  const hooks = getConfig().PostToolUse;
  if (!hooks?.length) return;

  for (const hook of hooks) {
    if (!matchesCondition(hook.if, toolName, input)) continue;

    const context = { event: "PostToolUse", tool: toolName, input, output, isError };
    await executeHook(hook.command, context, hook.timeout ?? DEFAULT_TIMEOUT);
  }
}

/**
 * Run UserPromptSubmit hooks before a user message enters the conversation.
 * Can block the message or modify the text.
 */
export async function runUserPromptSubmitHooks(
  text: string,
): Promise<PromptHookResult> {
  const hooks = getConfig().UserPromptSubmit;
  if (!hooks?.length) return { blocked: false, reason: "" };

  let currentText = text;

  for (const hook of hooks) {
    const context = { event: "UserPromptSubmit", text: currentText };
    const result = await executeHook(hook.command, context, hook.timeout ?? DEFAULT_TIMEOUT);

    if (result.decision === "block") {
      log("info", `hooks: UserPromptSubmit blocked: ${result.reason ?? "no reason"}`);
      return { blocked: true, reason: result.reason ?? "Blocked by hook" };
    }

    if (result.updatedText) {
      currentText = result.updatedText;
    }
  }

  return {
    blocked: false,
    reason: "",
    updatedText: currentText !== text ? currentText : undefined,
  };
}
