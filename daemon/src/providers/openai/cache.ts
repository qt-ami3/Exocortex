import { OPENAI_ORIGINATOR } from "./constants";
import type { StreamOptions } from "../types";

export interface OpenAIRequestSession {
  accessToken: string;
  accountId: string | null;
}

export function buildOpenAIRequestHeaders(
  session: OpenAIRequestSession,
  options: StreamOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: OPENAI_ORIGINATOR,
    "User-Agent": "exocortexd/openai",
  };

  if (options.promptCacheKey) {
    headers.session_id = options.promptCacheKey;
    headers["x-client-request-id"] = options.promptCacheKey;
  }

  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  return headers;
}

export function buildPromptCacheBodyFields(options: StreamOptions): Record<string, string> {
  return options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {};
}
