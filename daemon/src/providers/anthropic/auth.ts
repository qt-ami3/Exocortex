/**
 * OAuth authentication for exocortexd.
 *
 * Handles token refresh, profile fetching, and auth lifecycle for Anthropic.
 */

import { log } from "../../log";
import { ANTHROPIC_BASE_URL } from "./constants";
import {
  clearProviderAuth,
  isTokenExpired,
  loadProviderAuth,
  saveProviderAuth,
  type StoredTokens,
  type OAuthProfile,
  type StoredAuth,
} from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";
import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_TOKEN_URL,
  runAnthropicBrowserOAuth,
  type AnthropicTokenResponse,
} from "./oauth";

const ANTHROPIC_PROVIDER_ID = "anthropic";

interface ProfileResponse {
  account: { uuid: string; email: string; display_name: string | null };
  organization: {
    uuid: string; name: string; organization_type: string;
    rate_limit_tier: string; billing_type: string;
  };
}

interface RolesResponse {
  organization_role: string | null;
  workspace_role: string | null;
}

async function fetchProfile(accessToken: string): Promise<ProfileResponse | null> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    return res.ok ? (res.json() as Promise<ProfileResponse>) : null;
  } catch {
    return null;
  }
}

async function fetchRoles(accessToken: string): Promise<RolesResponse | null> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/claude_cli/roles`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? (res.json() as Promise<RolesResponse>) : null;
  } catch {
    return null;
  }
}

function mapSubscription(orgType: string | null | undefined): string | null {
  switch (orgType) {
    case "claude_max": return "max";
    case "claude_pro": return "pro";
    case "claude_enterprise": return "enterprise";
    case "claude_team": return "team";
    default: return null;
  }
}

function loadStoredAuth(): StoredAuth | null {
  return loadProviderAuth<StoredAuth>(ANTHROPIC_PROVIDER_ID);
}

function saveStoredAuth(auth: StoredAuth): void {
  saveProviderAuth(ANTHROPIC_PROVIDER_ID, auth);
}

let inflightRefresh: Promise<StoredTokens> | null = null;

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh(refreshToken).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function doRefresh(refreshToken: string): Promise<StoredTokens> {
  log("info", "auth: refreshing tokens");
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      scope: ANTHROPIC_OAUTH_SCOPES.join(" "),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes("invalid_grant")) {
      throw new AuthError(`Session expired — use login to re-authenticate. (${text})`);
    }
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as AnthropicTokenResponse;
  const profile = await fetchProfile(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(" ") ?? [...ANTHROPIC_OAUTH_SCOPES],
    subscriptionType: mapSubscription(profile?.organization?.organization_type),
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
  };
}

export async function verifyAuth(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/claude_cli/client_data`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getVerifiedAccessToken(): Promise<string> {
  const auth = loadStoredAuth();
  if (!auth?.tokens?.accessToken) {
    throw new AuthError("Anthropic is not authenticated. Run `bun run src/main.ts login anthropic`.");
  }

  if (isTokenExpired(auth.tokens)) {
    if (!auth.tokens.refreshToken) {
      throw new AuthError("Anthropic token expired and no refresh token is available.");
    }
    const newTokens = await refreshTokens(auth.tokens.refreshToken);
    saveStoredAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
    return newTokens.accessToken;
  }

  return auth.tokens.accessToken;
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const existing = loadStoredAuth();

  if (existing?.tokens?.accessToken && !isTokenExpired(existing.tokens)) {
    const valid = await verifyAuth(existing.tokens.accessToken);
    if (valid) {
      return { status: "already_authenticated", email: existing.profile?.email ?? null };
    }
  }

  if (existing?.tokens?.refreshToken) {
    try {
      const newTokens = await refreshTokens(existing.tokens.refreshToken);
      saveStoredAuth({ ...existing, tokens: newTokens, updatedAt: new Date().toISOString() });
      return { status: "refreshed", email: existing.profile?.email ?? null };
    } catch {
      // refresh failed — fall through to full login
    }
  }

  const result = await login(callbacks);
  saveStoredAuth({ tokens: result.tokens, profile: result.profile, updatedAt: new Date().toISOString() });
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export function hasConfiguredCredentials(): boolean {
  const auth = loadStoredAuth();
  return !!auth?.tokens?.accessToken || !!auth?.tokens?.refreshToken;
}

export function clearAuth(): boolean {
  return clearProviderAuth(ANTHROPIC_PROVIDER_ID);
}

function buildLoginResult(
  tokenData: AnthropicTokenResponse,
  profile: ProfileResponse | null,
  roles: RolesResponse | null,
): LoginResult {
  return {
    tokens: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      scopes: tokenData.scope?.split(" ") ?? [...ANTHROPIC_OAUTH_SCOPES],
      subscriptionType: mapSubscription(profile?.organization?.organization_type),
      rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    },
    profile: profile ? {
      accountUuid: profile.account.uuid,
      email: profile.account.email,
      displayName: profile.account.display_name,
      organizationUuid: profile.organization?.uuid ?? null,
      organizationName: profile.organization?.name ?? null,
      organizationType: profile.organization?.organization_type ?? null,
      organizationRole: roles?.organization_role ?? null,
      workspaceRole: roles?.workspace_role ?? null,
    } : null,
  };
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  const tokenData = await runAnthropicBrowserOAuth(cbs);
  const profile = await fetchProfile(tokenData.access_token);
  const roles = await fetchRoles(tokenData.access_token);
  return buildLoginResult(tokenData, profile, roles);
}
