/**
 * Theme system for the Exocortex TUI.
 *
 * Defines the Theme interface and exports the active theme.
 * Every file that needs colors imports from here — no hardcoded
 * ANSI codes anywhere else in the TUI.
 */

import { whale } from "./themes/whale";

// ── Theme interface ─────────────────────────────────────────────────

export interface Theme {
  name: string;

  // Reset
  reset: string;

  // Style modifiers
  bold: string;
  dim: string;
  italic: string;

  // Foreground colors
  accent: string;      // Primary accent
  text: string;        // Default text
  muted: string;       // Muted gray (explicit fg color, not dim attribute)
  error: string;       // Errors, interruptions
  warning: string;     // Streaming indicator
  success: string;     // Connected indicator
  prompt: string;      // Input prompt ❯
  tool: string;        // Tool call labels

  // Vim mode indicators
  vimNormal: string;      // Normal mode label
  vimInsert: string;      // Insert mode label

  // Background colors
  topbarBg: string;       // Top bar
  userBg: string;         // User message bubble
  sidebarBg: string;      // Sidebar body
  sidebarSelBg: string;   // Sidebar selected item

  // Border colors
  borderFocused: string;  // Focused panel border
  borderUnfocused: string; // Unfocused panel border

  // Style end
  boldOff: string;        // End bold
}

// ── Active theme ────────────────────────────────────────────────────

export const theme: Theme = whale;
