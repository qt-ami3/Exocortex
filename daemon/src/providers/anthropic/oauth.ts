import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { generateCodeChallenge, generateCodeVerifier, generateState, openUrlInBrowser } from "../oauth";
import type { LoginCallbacks } from "../types";

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";

export const ANTHROPIC_OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
] as const;

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

interface CallbackResult {
  code: string;
  state: string;
}

async function startCallbackServer(
  expectedState: string,
): Promise<{ port: number; waitForCallback: () => Promise<CallbackResult>; shutdown: () => void }> {
  const server = createServer();
  let resolveCallback: ((result: CallbackResult) => void) | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;

  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 39152 + Math.floor(Math.random() * 10000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      port = candidate;
      break;
    }
  }
  if (port === 0) throw new Error("Could not find available port for OAuth callback");

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400);
      res.end(`Auth failed: ${error}`);
      rejectCallback?.(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !state || state !== expectedState) {
      res.writeHead(400);
      res.end("Invalid callback");
      rejectCallback?.(new Error("OAuth state mismatch"));
      return;
    }

    res.writeHead(302, { Location: SUCCESS_URL });
    res.end();
    resolveCallback?.({ code, state });
  });

  const waitForCallback = (): Promise<CallbackResult> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth callback timed out")), 300_000);
    resolveCallback = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    rejectCallback = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });

  return { port, waitForCallback, shutdown: () => server.close() };
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  state: string,
  redirectUri: string,
): Promise<AnthropicTokenResponse> {
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<AnthropicTokenResponse>;
}

export async function runAnthropicBrowserOAuth(callbacks?: LoginCallbacks): Promise<AnthropicTokenResponse> {
  const say = callbacks?.onProgress ?? (() => {});
  const openUrl = callbacks?.onOpenUrl ?? openUrlInBrowser;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const { port, waitForCallback, shutdown } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    const url = new URL(ANTHROPIC_AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES.join(" "));
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    say("Opening browser for authentication...");
    openUrl(url.toString());

    const { code } = await waitForCallback();
    say("Exchanging authorization code...");
    return await exchangeCode(code, codeVerifier, state, redirectUri);
  } finally {
    shutdown();
  }
}
