import type { ZodSchema } from "zod";
import type { TokenStore } from "./types.js";
import { isTokenExpiringSoon, refreshAccessToken, TokenRefreshError } from "./oauth.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export class NotAuthorisedError extends Error {
  constructor() {
    super("Not authorised. Visit /oauth/start to connect Jira.");
    this.name = "NotAuthorisedError";
  }
}

export function createJiraClient(config: {
  clientId: string;
  clientSecret: string;
  tokenStore: TokenStore;
}) {
  async function getAccessToken(): Promise<{
    accessToken: string;
    cloudId: string;
  }> {
    const tokens = await config.tokenStore.load();
    if (!tokens) {
      throw new NotAuthorisedError();
    }

    if (isTokenExpiringSoon(tokens.expiresAt)) {
      try {
        const refreshed = await refreshAccessToken({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: tokens.refreshToken,
        });

        const updated = {
          ...tokens,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };
        await config.tokenStore.save(updated);

        return { accessToken: updated.accessToken, cloudId: tokens.cloudId };
      } catch (err) {
        if (err instanceof TokenRefreshError) {
          await config.tokenStore.clear();
          throw new NotAuthorisedError();
        }
        throw err;
      }
    }

    return { accessToken: tokens.accessToken, cloudId: tokens.cloudId };
  }

  async function get<T>(path: string, schema: ZodSchema<T>): Promise<T> {
    const { accessToken, cloudId } = await getAccessToken();
    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `Jira API rate limited after ${MAX_RETRIES + 1} attempts`
          );
        }
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(
              BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random()),
              MAX_DELAY_MS
            );
        console.log(
          `Jira rate limited, retrying in ${Math.round(delay)}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (response.status === 401) {
        await config.tokenStore.clear();
        throw new NotAuthorisedError();
      }

      if (!response.ok) {
        throw new Error(
          `Jira API error: ${response.status} ${response.statusText}`
        );
      }

      const data: unknown = await response.json();
      return schema.parse(data);
    }

    throw new Error("Unexpected retry loop exit");
  }

  return { get, getAccessToken };
}

export type JiraClient = ReturnType<typeof createJiraClient>;
