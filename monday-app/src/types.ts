import { z } from "zod";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  cloudId: string;
  siteUrl: string;
}

export interface StoredStates {
  [state: string]: number;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface StateStore {
  save(state: string, expiresAt: number): Promise<void>;
  consume(state: string): Promise<boolean>;
}

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.string(),
});

export const AccessibleResourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  avatarUrl: z.string(),
});

export const AccessibleResourcesSchema = z.array(AccessibleResourceSchema);

export const JiraIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    status: z.object({
      name: z.string(),
    }),
  }),
});

export const JiraSearchResponseSchema = z.object({
  issues: z.array(JiraIssueSchema),
  total: z.number(),
});
