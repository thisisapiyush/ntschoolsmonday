import { randomBytes } from "node:crypto";
import { TokenResponseSchema, AccessibleResourcesSchema } from "./types.js";

const ATLASSIAN_AUTH_URL = "https://auth.atlassian.com/authorize";
const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function generateState(): string {
  return randomBytes(32).toString("hex");
}

export function stateExpiresAt(): number {
  return Date.now() + STATE_TTL_MS;
}

export function isTokenExpiringSoon(expiresAt: number): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
}

export function buildAuthorizeUrl(config: {
  clientId: string;
  redirectUri: string;
}): { url: string; state: string; expiresAt: number } {
  const state = generateState();
  const expiresAt = stateExpiresAt();

  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access",
    state,
    response_type: "code",
    prompt: "consent",
  });

  return {
    url: `${ATLASSIAN_AUTH_URL}?${params.toString()}`,
    state,
    expiresAt,
  };
}

export async function exchangeCode(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code: config.code,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = TokenResponseSchema.parse(await response.json());

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function normalizeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export async function fetchCloudId(
  accessToken: string,
  siteUrl: string
): Promise<{ cloudId: string; siteUrl: string }> {
  const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Accessible resources request failed (${response.status})`
    );
  }

  const resources = AccessibleResourcesSchema.parse(await response.json());
  const targetHost = normalizeHost(siteUrl);

  const match = resources.find((r) => normalizeHost(r.url) === targetHost);

  if (!match) {
    const available =
      resources.map((r) => `"${r.name}" (${r.url})`).join(", ") || "none";
    throw new Error(
      `No accessible resource matches JIRA_SITE_URL "${siteUrl}". ` +
        `Available sites: ${available}`
    );
  }

  return { cloudId: match.id, siteUrl: match.url };
}

export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export async function refreshAccessToken(config: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new TokenRefreshError(
      `Token refresh failed (${response.status}). Re-authorisation needed via /oauth/start.`
    );
  }

  const data = TokenResponseSchema.parse(await response.json());

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
