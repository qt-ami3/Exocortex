/**
 * Shared constants for exocortexd.
 *
 * Values used across multiple daemon modules live here to avoid
 * duplication and prevent circular imports.
 */

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Maximum context window size in tokens (model-dependent; using Claude's max). */
export const CONTEXT_LIMIT = 200_000;
