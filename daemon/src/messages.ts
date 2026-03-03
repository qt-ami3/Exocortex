/**
 * Message and block model for exocortexd.
 *
 * This is the domain model — the core data structures that represent
 * conversations. Blocks are the atoms of an AI message. Messages are
 * the units of a conversation. Everything about shape, metadata, and
 * construction of messages lives here.
 */

import type { ApiMessage } from "./api";

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

// ── Stored conversation state ───────────────────────────────────────

export interface StoredMessage {
  role: "user" | "assistant";
  content: ApiMessage["content"];
}

export interface Conversation {
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  systemMessages: SystemMessage[];
  streaming: boolean;
  abortController: AbortController | null;
  createdAt: number;
}

export function createConversation(id: string, model: ModelId): Conversation {
  return {
    id,
    model,
    messages: [],
    systemMessages: [],
    streaming: false,
    abortController: null,
    createdAt: Date.now(),
  };
}
