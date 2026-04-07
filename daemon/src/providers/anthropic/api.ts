/**
 * Anthropic Messages API streaming client.
 */

import { loadProviderAuth, saveProviderAuth, type StoredAuth } from "../../store";
import { log } from "../../log";
import { type ModelId, type ApiMessage } from "../../messages";
import type { StreamResult, StreamCallbacks, StreamOptions } from "../types";
import { refreshTokens, getVerifiedAccessToken } from "./auth";
import { buildAnthropicRequest } from "./request";
import { readAnthropicStream, RetryableStreamError } from "./stream";

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 10;
const ANTHROPIC_PROVIDER_ID = "anthropic";

async function forceRefreshToken(failedToken: string): Promise<string> {
  const auth = loadProviderAuth<StoredAuth>(ANTHROPIC_PROVIDER_ID);
  if (!auth?.tokens?.refreshToken) throw new Error("No refresh token");
  if (auth.tokens.accessToken !== failedToken) return auth.tokens.accessToken;
  const newTokens = await refreshTokens(auth.tokens.refreshToken);
  saveProviderAuth(ANTHROPIC_PROVIDER_ID, { ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
  return newTokens.accessToken;
}

function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  const delaySec = Math.round(delay / 1000);
  log("warn", `api: ${errMsg}, retry ${attempt + 1}/${MAX_RETRIES} in ${delaySec}s`);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec);
  return new Promise((r) => setTimeout(r, delay));
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { system, signal, maxTokens = 32000, tools, effort } = options;
  let accessToken = await getVerifiedAccessToken();
  let authRetried = false;
  let retryAttempt = 0;

  while (true) {
    const { url, init } = buildAnthropicRequest(accessToken, messages, model, maxTokens, system, tools, effort);
    const res = await fetch(url, { ...init, signal });

    if (!authRetried && (res.status === 401 || (res.status === 403 && (await res.clone().text()).includes("revoked")))) {
      log("warn", `api: ${res.status}, refreshing token`);
      accessToken = await forceRefreshToken(accessToken);
      authRetried = true;
      continue;
    }

    if (res.status === 429 || res.status === 529 || res.status === 503) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks);
        continue;
      }
      const text = await res.text();
      throw new RetryableStreamError(`API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      log("error", `api: error (${res.status}): ${text.slice(0, 500)}`);
      throw new Error(`API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readAnthropicStream(res, callbacks, STREAM_STALL_TIMEOUT);
    } catch (err) {
      if (err instanceof RetryableStreamError && retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, (err as Error).message, callbacks);
        continue;
      }
      throw err;
    }
  }
}
