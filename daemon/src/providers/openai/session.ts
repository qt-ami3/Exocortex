import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../../log";
import type { OAuthProfile, StoredTokens } from "../../store";
import {
  OPENAI_CODEX_CLIENT_VERSION,
  OPENAI_MODELS_URL,
  OPENAI_ORIGINATOR,
  OPENAI_USERINFO_URL,
} from "./constants";

const CODEX_AUTH_PATH = join(homedir(), ".config", "codex", "auth.json");

export interface StoredOpenAIAuth {
  tokens: StoredTokens;
  profile: OAuthProfile | null;
  updatedAt: string;
  source: "codex" | "oauth";
  authMode: string | null;
  accountId: string | null;
  idToken: string | null;
}

export interface OpenAITokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
}

interface DecodedClaims {
  sub?: string;
  email?: string;
  name?: string;
  scope?: string;
  chatgpt_plan_type?: string;
  exp?: number;
}

function decodeJwt(token: string | null | undefined): DecodedClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as DecodedClaims;
  } catch {
    return null;
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ sub?: string; email?: string; name?: string } | null> {
  try {
    const res = await fetch(OPENAI_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ sub?: string; email?: string; name?: string }>;
  } catch {
    return null;
  }
}

function mapSubscription(claims: DecodedClaims | null): string | null {
  return claims?.chatgpt_plan_type ?? null;
}

function buildScopes(token: OpenAITokenResponse, accessClaims: DecodedClaims | null): string[] {
  const scope = token.scope ?? accessClaims?.scope ?? "";
  return scope.split(" ").map((part) => part.trim()).filter(Boolean);
}

export async function buildStoredAuth(
  token: OpenAITokenResponse,
  source: StoredOpenAIAuth["source"],
  opts?: {
    accountId?: string | null;
    authMode?: string | null;
    fallbackRefreshToken?: string | null;
    fallbackIdToken?: string | null;
  },
): Promise<StoredOpenAIAuth> {
  const accessClaims = decodeJwt(token.access_token);
  const idToken = token.id_token ?? opts?.fallbackIdToken ?? null;
  const idClaims = decodeJwt(idToken);
  const userInfo = await fetchUserInfo(token.access_token);

  return {
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? opts?.fallbackRefreshToken ?? null,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: buildScopes(token, accessClaims),
      subscriptionType: mapSubscription(accessClaims) ?? mapSubscription(idClaims),
      rateLimitTier: null,
    },
    profile: {
      accountUuid: opts?.accountId ?? userInfo?.sub ?? idClaims?.sub ?? accessClaims?.sub ?? "",
      email: userInfo?.email ?? idClaims?.email ?? accessClaims?.email ?? "",
      displayName: userInfo?.name ?? idClaims?.name ?? accessClaims?.name ?? null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source,
    authMode: opts?.authMode ?? null,
    accountId: opts?.accountId ?? null,
    idToken,
  };
}

function requestHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    originator: OPENAI_ORIGINATOR,
    "User-Agent": "exocortexd/openai",
  };
}

function requestHeadersWithAccount(accessToken: string, accountId?: string | null): HeadersInit {
  return {
    ...requestHeaders(accessToken),
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

export async function verifyAuth(accessToken: string, accountId?: string | null): Promise<boolean> {
  try {
    const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
    const res = await fetch(url, {
      headers: requestHeadersWithAccount(accessToken, accountId),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function loadCodexAuthFile(): CodexAuthFile | null {
  if (!existsSync(CODEX_AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as CodexAuthFile;
  } catch (err) {
    log("warn", `openai auth: failed to parse ${CODEX_AUTH_PATH}: ${err}`);
    return null;
  }
}

export function hasLocalCodexAuthFile(): boolean {
  return existsSync(CODEX_AUTH_PATH);
}

export async function importCodexSession(
  refreshStoredAuth: (
    refreshToken: string,
    opts?: { source?: StoredOpenAIAuth["source"]; accountId?: string | null; authMode?: string | null; fallbackIdToken?: string | null },
  ) => Promise<StoredOpenAIAuth>,
): Promise<StoredOpenAIAuth | null> {
  const codex = loadCodexAuthFile();
  const refreshToken = codex?.tokens?.refresh_token;
  const accessToken = codex?.tokens?.access_token;
  if (!refreshToken && !accessToken) return null;

  if (refreshToken) {
    return refreshStoredAuth(refreshToken, {
      source: "codex",
      accountId: codex?.tokens?.account_id ?? null,
      authMode: codex?.auth_mode ?? null,
      fallbackIdToken: codex?.tokens?.id_token ?? null,
    });
  }

  if (!accessToken || !(await verifyAuth(accessToken, codex?.tokens?.account_id ?? null))) return null;

  const claims = decodeJwt(accessToken);
  return {
    tokens: {
      accessToken,
      refreshToken: null,
      expiresAt: claims?.exp ? claims.exp * 1000 : Date.now() + 15 * 60 * 1000,
      scopes: (claims?.scope ?? "").split(" ").filter(Boolean),
      subscriptionType: mapSubscription(claims),
      rateLimitTier: null,
    },
    profile: {
      accountUuid: codex?.tokens?.account_id ?? claims?.sub ?? "",
      email: claims?.email ?? "",
      displayName: claims?.name ?? null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source: "codex",
    authMode: codex?.auth_mode ?? null,
    accountId: codex?.tokens?.account_id ?? null,
    idToken: codex?.tokens?.id_token ?? null,
  };
}
