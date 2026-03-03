/**
 * Message and block model for exocortexd.
 *
 * This is the domain model — the core data structures that represent
 * conversations. Blocks are the atoms of an AI message. Messages are
 * the units of a conversation. Everything about shape, metadata, and
 * construction of messages lives here.
 *
 * Also owns the API-level message types (ApiMessage, ApiContentBlock)
 * since stored conversations use this format for API replay.
 */

// ── Models ──────────────────────────────────────────────────────────

export type ModelId = "sonnet" | "haiku" | "opus";

export const MODEL_MAP: Record<ModelId, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  opus:   "claude-opus-4-6",
};

// ── Blocks ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export type Block = ThinkingBlock | TextBlock | ToolCallBlock | ToolResultBlock;

// ── API-level types (for stored conversations / API replay) ─────────

export type ApiContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

// ── Messages ────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  model?: ModelId;
  tokens?: number;
  /** Timestamp (ms) when the daemon began processing this message. */
  startedAt: number;
  /** Timestamp (ms) when the daemon finished. Null while streaming. */
  endedAt: number | null;
}

/**
 * System messages are daemon-generated notices (errors, status changes).
 * They are shown to the user and persisted in the conversation,
 * but never sent to the AI.
 */
export interface SystemMessage {
  role: "system";
  text: string;
}

export type Message = UserMessage | AIMessage | SystemMessage;

// ── Conversation state ──────────────────────────────────────────────

export interface Conversation {
  id: string;
  model: ModelId;
  messages: ApiMessage[];
  streaming: boolean;
  abortController: AbortController | null;
  createdAt: number;
}

export function createConversation(id: string, model: ModelId): Conversation {
  return {
    id,
    model,
    messages: [],
    streaming: false,
    abortController: null,
    createdAt: Date.now(),
  };
}
