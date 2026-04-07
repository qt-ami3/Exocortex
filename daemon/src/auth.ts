import type { ProviderId } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "./providers/types";
import { AuthError } from "./providers/errors";

export { AuthError };
export type { LoginResult, LoginCallbacks, EnsureAuthResult };

export function login(provider: ProviderId, callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  return getProviderAdapter(provider).auth.login(callbacks);
}

export function ensureAuthenticated(provider: ProviderId, callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  return getProviderAdapter(provider).auth.ensureAuthenticated(callbacks);
}

export function refreshTokens(provider: ProviderId, refreshToken: string) {
  const refresh = getProviderAdapter(provider).auth.refreshTokens;
  if (!refresh) {
    throw new Error(`Token refresh is not supported for provider: ${provider}`);
  }
  return refresh(refreshToken);
}

export function verifyAuth(provider: ProviderId, accessToken: string): Promise<boolean> {
  return getProviderAdapter(provider).auth.verifyAuth(accessToken);
}

export function clearAuth(provider: ProviderId): boolean {
  return getProviderAdapter(provider).auth.clearAuth();
}

export function hasConfiguredCredentials(provider: ProviderId): boolean {
  return getProviderAdapter(provider).auth.hasConfiguredCredentials();
}
