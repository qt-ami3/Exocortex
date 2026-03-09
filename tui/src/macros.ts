/**
 * Macro command definitions and expansion.
 *
 * Macros are text-replacement shortcuts that live entirely in the TUI.
 * They expand inline in user messages before sending to the daemon.
 * e.g. "/go" becomes "Go ahead and implement that".
 *
 * Macros can appear anywhere in a message — start, middle, after a
 * newline — and are expanded at word boundaries. They are never sent
 * to the daemon as slash commands; the daemon only sees the expanded text.
 */

import type { CompletionItem } from "./commands";

// ── Macro definitions ─────────────────────────────────────────────

/** Autocomplete entries for macros (name + short description). */
export const MACRO_LIST: CompletionItem[] = [
  { name: "/consider", desc: "Am I right or wrong?" },
  { name: "/commit", desc: "Commit and push" },
  { name: "/noop", desc: "Thoughts only, no edits" },
  { name: "/plan", desc: "Plan only, no edits" },
  { name: "/fix", desc: "Go ahead and fix it" },
  { name: "/go", desc: "Go ahead and implement" },
  { name: "/questions", desc: "Any questions?" },
  { name: "/thoughts", desc: "Tell me your thoughts" },
  { name: "/long", desc: "Work until complete" },
  { name: "/diagnose", desc: "Pinpoint the cause" },
  { name: "/worktree", desc: "Work in a git worktree" },
];

/** Expansion text for each macro (and macro + arg variants). */
export const MACRO_MAP: Record<string, string> = {
  "/consider": "Consider what I'm saying. Am I right or wrong?",
  "/commit": "If you haven't already, commit your work and push it.",
  "/commit exocortex": "If you haven't already, commit and push the work inside the Exocortex directory (~/Workspace/Exocortex).",
  "/noop": "Don't write or edit any files yet. Just tell me your thoughts on this.",
  "/plan": "Come up with a plan for this and tell me it. Don't write or edit any files.",
  "/plan other": "Draft a plan for this as a prompt for another instance. Write it as a kebab-case markdown file inside ~/.config/exocortex/playground/. The file should be self-contained so I can send it to another instance and he gets all the context he needs to work on it.",
  "/fix": "Go ahead and fix it",
  "/go": "Go ahead and implement that",
  "/questions": "Before we proceed, any questions?",
  "/thoughts": "Can you tell me your thoughts on this?",
  "/long": "This is a long running task, work tirelessly until you can verify that everything is complete and correct",
  "/diagnose": "Can you pinpoint the exact cause and tell me your diagnosis?",
  "/worktree": "Work in a git worktree for this task. When I say I'm satisfied, rebase onto the original branch, resolve conflicts, merge back, and clean up.",
};

/** Optional sub-arguments for macros (keyed by macro name). */
export const MACRO_ARGS: Record<string, CompletionItem[]> = {
  "/commit": [
    { name: "exocortex", desc: "Commit ~/Workspace/Exocortex" },
  ],
  "/plan": [
    { name: "other", desc: "Draft plan for another instance" },
  ],
};

// ── Expansion ─────────────────────────────────────────────────────

/**
 * Expand macro commands in user message text.
 *
 * Tries "command + arg" first (e.g. "/commit exocortex"), then falls
 * back to the bare command (preserving unrecognized arg words).
 * Only matches at word boundaries (start of line or after whitespace).
 */
export function expandMacros(text: string): string {
  return text.replace(/(?<=^|\s)(\/[\w-]+)(?:[ \t]+([\w-]+))?/gm, (_full, cmd, arg) => {
    if (arg) {
      const withArg = cmd + " " + arg;
      if (MACRO_MAP[withArg]) return MACRO_MAP[withArg];
    }
    if (MACRO_MAP[cmd]) {
      return arg ? MACRO_MAP[cmd] + " " + arg : MACRO_MAP[cmd];
    }
    return arg ? cmd + " " + arg : cmd;
  });
}
