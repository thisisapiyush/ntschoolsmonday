import type { ZodSchema } from "zod";
import type { TokenStore } from "./types.js";
import {
  isTokenExpiringSoon,
  refreshAccessToken,
  TokenRefreshError,
} from "./oauth.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export class NotAuthorisedError extends Error {
  constructor() {
    super("Not authorised. Visit /oauth/start to connect Jira.");
    this.name = "NotAuthorisedError";
  }
}

export class JiraApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly path: string;

  constructor(
    status: number,
    statusText: string,
    body: string,
    path: string
  ) {
    super(`Jira API error on ${path}: ${status} ${statusText}`);
    this.name = "JiraApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.path = path;
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

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    schema: ZodSchema<T>,
    body?: unknown
  ): Promise<T> {
    const { accessToken, cloudId } = await getAccessToken();
    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new JiraApiError(
            429,
            "Too Many Requests",
            `Rate limited after ${MAX_RETRIES + 1} attempts`,
            path
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
        let responseBody: string;
        try {
          responseBody = await response.text();
        } catch {
          responseBody = "(could not read response body)";
        }
        throw new JiraApiError(
          response.status,
          response.statusText,
          responseBody,
          path
        );
      }

      const data: unknown = await response.json();
      return schema.parse(data);
    }

    throw new Error("Unexpected retry loop exit");
  }

  return {
    get: <T>(path: string, schema: ZodSchema<T>) =>
      request("GET", path, schema),
    post: <T>(path: string, body: unknown, schema: ZodSchema<T>) =>
      request("POST", path, schema, body),
    getAccessToken,
  };
}

export type JiraClient = ReturnType<typeof createJiraClient>;
