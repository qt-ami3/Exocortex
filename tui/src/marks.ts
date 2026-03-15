/**
 * Conversation marks — emoji prefixes embedded in conversation titles.
 *
 * Marks are a lightweight tagging system: pressing a digit key (1-9)
 * in the sidebar prepends an emoji to the conversation title. No
 * daemon changes, no migration — just renames.
 *
 * Detection: check if the title starts with a known mark emoji + space.
 * Toggling: same key strips it, different key swaps it, 0 clears.
 */

// ── Mark definitions ──────────────────────────────────────────────

export interface Mark {
  key: number;        // 1-9
  emoji: string;      // Emoji character
  label: string;      // Human-readable label
  /** Terminal display width of the emoji (almost always 2). */
  width: number;
}

export const MARKS: readonly Mark[] = [
  { key: 1, emoji: "🕐", label: "scheduled", width: 2 },
  { key: 2, emoji: "🔥", label: "urgent",    width: 2 },
  { key: 3, emoji: "🧪", label: "experiment", width: 2 },
  { key: 4, emoji: "📝", label: "reference", width: 2 },
  { key: 5, emoji: "🐛", label: "bug",       width: 2 },
  { key: 6, emoji: "💡", label: "idea",      width: 2 },
  { key: 7, emoji: "🔒", label: "protected", width: 2 },
  { key: 8, emoji: "✅", label: "done",      width: 2 },
  { key: 9, emoji: "👁", label: "watching",  width: 2 },
] as const;

/** Lookup mark by digit key (1-9). */
export function getMark(key: number): Mark | undefined {
  return MARKS.find(m => m.key === key);
}

// ── All known mark emojis (for prefix detection) ──────────────────

const MARK_EMOJI_SET = new Set(MARKS.map(m => m.emoji));

// ── Title manipulation ────────────────────────────────────────────

/**
 * Get the mark emoji from a title's prefix, or null if unmarked.
 * Matches "🕐 Some title" → "🕐".
 */
export function getMarkPrefix(title: string): string | null {
  for (const emoji of MARK_EMOJI_SET) {
    if (title.startsWith(emoji + " ")) return emoji;
  }
  return null;
}

/** Get the full Mark object for a title's prefix, or null. */
export function getMarkFromTitle(title: string): Mark | null {
  const emoji = getMarkPrefix(title);
  if (!emoji) return null;
  return MARKS.find(m => m.emoji === emoji) ?? null;
}

/** Strip any known mark emoji prefix from a title. */
export function stripMark(title: string): string {
  const prefix = getMarkPrefix(title);
  if (!prefix) return title;
  return title.slice(prefix.length + 1); // +1 for the trailing space
}

/**
 * Toggle a mark on a title.
 *
 * - If the title already has the same mark → strip it (toggle off).
 * - If the title has a different mark or none → set this mark.
 * - key=0 always clears any mark.
 */
export function toggleMark(title: string, key: number): string {
  if (key === 0) return stripMark(title);

  const mark = getMark(key);
  if (!mark) return title;

  const currentEmoji = getMarkPrefix(title);
  const bare = stripMark(title);

  if (currentEmoji === mark.emoji) {
    // Same mark → remove
    return bare;
  }
  // Different or no mark → set
  return mark.emoji + " " + bare;
}
