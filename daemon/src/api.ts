import type { ProviderId, ModelId, EffortLevel, ApiMessage, ApiContentBlock } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { ApiToolCall, ContentBlock, StreamResult, StreamCallbacks, StreamOptions } from "./providers/types";
import { AuthError } from "./providers/errors";

export type { ApiMessage, ApiContentBlock };
export type { ApiToolCall, ContentBlock, StreamResult, StreamCallbacks, StreamOptions };
export { AuthError };

export async function streamMessage(
  provider: ProviderId,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  return getProviderAdapter(provider).streamMessage(messages, model, callbacks, options);
}
