import type { ModelId, ProviderId } from "../messages";
import { getDefaultProvider } from "../providers/registry";
import type { CompleteOptions } from "../llm";
import type { ToolExecutionContext } from "./types";

const SUMMARY_MODEL_BY_PROVIDER: Record<ProviderId, ModelId> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
};

export function getInnerLlmSummaryOptions(context?: ToolExecutionContext): Pick<CompleteOptions, "provider" | "model"> {
  const provider = context?.provider ?? getDefaultProvider().id;
  return {
    provider,
    model: SUMMARY_MODEL_BY_PROVIDER[provider],
  };
}
