/**
 * Chat panel key routing.
 *
 * Owns the chat's inner focus (prompt vs history) and routes
 * keys accordingly. Delegates to promptline.ts for buffer editing
 * and handles history scrolling directly.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { resolveAction } from "./keybinds";
import { handlePromptKey } from "./promptline";

// ── Types ───────────────────────────────────────────────────────────

export type ChatFocus = "prompt" | "history";

export type ChatKeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "unhandled" };

// ── Key routing ─────────────────────────────────────────────────────

export function handleChatKey(key: KeyEvent, state: RenderState): ChatKeyResult {
  if (state.chatFocus === "prompt") {
    return handlePromptFocused(key, state);
  } else {
    return handleHistoryFocused(key, state);
  }
}

// ── Prompt focus ────────────────────────────────────────────────────

function handlePromptFocused(key: KeyEvent, state: RenderState): ChatKeyResult {
  const action = resolveAction(key);

  // Ctrl+N toggles: prompt → history
  if (action === "focus_history") {
    state.chatFocus = "history";
    return { type: "handled" };
  }

  // Delegate to promptline
  const result = handlePromptKey(state, key);
  if (result === "submit") return { type: "submit" };
  if (result === "handled") return { type: "handled" };

  // Unhandled by promptline (up/down on first/last line) → scroll
  if (action === "cursor_up") {
    scrollUp(state);
    return { type: "handled" };
  }
  if (action === "cursor_down") {
    scrollDown(state);
    return { type: "handled" };
  }

  return { type: "unhandled" };
}

// ── History focus ───────────────────────────────────────────────────

function handleHistoryFocused(key: KeyEvent, state: RenderState): ChatKeyResult {
  const action = resolveAction(key, "navigation");

  switch (action) {
    case "focus_prompt":
    case "focus_history":
      // i/a → prompt, Ctrl+N toggles back to prompt
      state.chatFocus = "prompt";
      return { type: "handled" };

    case "nav_up":
    case "cursor_up":
      scrollUp(state);
      return { type: "handled" };

    case "nav_down":
    case "cursor_down":
      scrollDown(state);
      return { type: "handled" };

    default:
      return { type: "unhandled" };
  }
}

// ── Scroll helpers ──────────────────────────────────────────────────

function maxScroll(state: RenderState): number {
  return Math.max(0, state.layout.totalLines - state.layout.messageAreaHeight);
}

export function scrollBy(state: RenderState, lines: number): void {
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + lines, maxScroll(state)));
}

export function scrollUp(state: RenderState): void { scrollBy(state, 3); }
export function scrollDown(state: RenderState): void { scrollBy(state, -3); }

export function scrollLineUp(state: RenderState): void { scrollBy(state, 1); }
export function scrollLineDown(state: RenderState): void { scrollBy(state, -1); }

export function scrollHalfUp(state: RenderState): void {
  scrollBy(state, Math.floor(state.rows / 2));
}
export function scrollHalfDown(state: RenderState): void {
  scrollBy(state, -Math.floor(state.rows / 2));
}

export function scrollPageUp(state: RenderState): void {
  scrollBy(state, state.rows);
}
export function scrollPageDown(state: RenderState): void {
  scrollBy(state, -state.rows);
}
