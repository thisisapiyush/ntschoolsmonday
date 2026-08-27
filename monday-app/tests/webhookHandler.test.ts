import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import express from "express";
import { createWebhookRouter } from "../src/webhookHandler.js";
import type { IssueSync } from "../src/issueSync.js";

const CLIENT_SECRET = "test-client-secret-for-jwt-verification";

function makeIssueSync(): IssueSync & { calls: Array<{ payload: unknown; correlationId: string }> } {
  const calls: Array<{ payload: unknown; correlationId: string }> = [];
  return {
    calls,
    processEvent: async (payload, correlationId) => {
      calls.push({ payload, correlationId });
    },
    loadMapping: async () => ({}),
    saveMapping: async () => {},
    isDuplicate: async () => false,
  };
}

async function makeToken(
  secret: string,
  overrides?: { exp?: number; alg?: string }
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const builder = new SignJWT({ sub: "test" })
    .setProtectedHeader({ alg: overrides?.alg ?? "HS256" })
    .setIssuedAt();

  if (overrides?.exp !== undefined) {
    builder.setExpirationTime(overrides.exp);
  } else {
    builder.setExpirationTime("1h");
  }

  return builder.sign(key);
}

function buildApp(issueSync: IssueSync): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter({ clientSecret: CLIENT_SECRET, issueSync }));
  return app;
}

async function postWebhook(
  app: express.Express,
  opts: {
    token?: string;
    body?: unknown;
    correlationId?: string;
  }
): Promise<{ status: number; body: unknown }> {
  const { default: request } = await import("supertest");
  const req = request(app).post("/webhook/jira");

  if (opts.token) {
    req.set("Authorization", `Bearer ${opts.token}`);
  }
  if (opts.correlationId) {
    req.set("X-Atlassian-Webhook-Identifier", opts.correlationId);
  }

  const res = await req
    .set("Content-Type", "application/json")
    .send(opts.body ?? {});

  return { status: res.status, body: res.body as unknown };
}

describe("webhook JWT verification", () => {
  it("rejects requests with no Authorization header", async () => {
    const sync = makeIssueSync();
    const app = buildApp(sync);
    const { status } = await postWebhook(app, {});
    expect(status).toBe(401);
    expect(sync.calls).toHaveLength(0);
  });

  it("rejects requests with wrong secret", async () => {
    const sync = makeIssueSync();
    const app = buildApp(sync);
    const token = await makeToken("wrong-secret");
    const { status } = await postWebhook(app, { token });
    expect(status).toBe(401);
    expect(sync.calls).toHaveLength(0);
  });

  it("accepts requests with valid JWT", async () => {
    const sync = makeIssueSync();
    const app = buildApp(sync);
    const token = await makeToken(CLIENT_SECRET);
    const payload = {
      webhookEvent: "jira:issue_created",
      issue: {
        key: "NTSR-1",
        fields: { summary: "Test - School", status: { name: "To Do" } },
      },
    };
    const { status } = await postWebhook(app, {
      token,
      body: payload,
      correlationId: "test-1",
    });
    expect(status).toBe(200);
  });

  it("rejects expired JWT", async () => {
    const sync = makeIssueSync();
    const app = buildApp(sync);
    const token = await makeToken(CLIENT_SECRET, {
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const { status } = await postWebhook(app, { token });
    expect(status).toBe(401);
  });
});
