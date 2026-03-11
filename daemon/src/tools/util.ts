/**
 * Shared utilities for tool implementations.
 */

export const MAX_OUTPUT_CHARS = 30_000;

/** Truncate output to MAX_OUTPUT_CHARS with a message. */
export function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${text.length} characters)`;
}

// ── Input validation helpers ──────────────────────────────────────

/** Extract a string from tool input, returning undefined if missing or wrong type. */
export function getString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

/** Extract a number from tool input, returning undefined if missing or wrong type. */
export function getNumber(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}

/** Extract a boolean from tool input, returning undefined if missing or wrong type. */
export function getBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === "boolean" ? v : undefined;
}
