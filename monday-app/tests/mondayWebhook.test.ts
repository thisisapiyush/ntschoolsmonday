import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createMondayWebhookRouter } from "../src/mondayWebhook.js";
import { createEchoStore } from "../src/echoSuppression.js";
import type { EchoStorage } from "../src/echoSuppression.js";
import type { WorkPackagesSchema } from "../src/boardSchema.js";

const WEBHOOK_TOKEN = "test-webhook-secret-token";

function makeMemoryStorage(): EchoStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

const SCHEMA: WorkPackagesSchema = {
  statusColumnId: "status_col",
  statusLabels: new Map([
    ["Backlog", 0],
    ["In progress", 1],
    ["Done", 2],
  ]),
  jiraKeyColumnId: "jira_key_col",
  jiraLinkColumnId: "jira_link_col",
  lastSyncedColumnId: "last_synced_col",
  siteColumnId: "site_col",
};

function makeMondayClient(opts?: {
  jiraKey?: string | null;
  statusLabel?: string | null;
}) {
  const jiraKey = opts?.jiraKey === undefined ? "NTSR-42" : opts.jiraKey;
  const statusLabel =
    opts?.statusLabel === undefined ? "In progress" : opts.statusLabel;
  return {
    query: vi.fn().mockResolvedValue({
      items: [
        {
          column_values: [
            { id: "jira_key_col", text: jiraKey },
            { id: "status_col", text: statusLabel },
          ],
        },
      ],
    }),
  };
}

function makeMockJira(opts?: { transitionAvailable?: boolean }) {
  const available = opts?.transitionAvailable ?? true;
  return {
    get: vi.fn().mockResolvedValue({
      transitions: available
        ? [{ id: "21", name: "Start Progress", to: { name: "In Progress" } }]
        : [],
    }),
    post: vi.fn().mockResolvedValue({ id: "comment-1" }),
    postNoContent: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn(),
  };
}

function buildApp(overrides?: {
  jiraKey?: string | null;
  statusLabel?: string | null;
  transitionAvailable?: boolean;
  echoStore?: ReturnType<typeof createEchoStore>;
}) {
  const mondayClient = makeMondayClient({
    jiraKey: overrides?.jiraKey,
    statusLabel: overrides?.statusLabel,
  });
  const jira = makeMockJira({
    transitionAvailable: overrides?.transitionAvailable,
  });
  const echoStore =
    overrides?.echoStore ??
    createEchoStore({ storage: makeMemoryStorage(), windowMs: 60000 });

  const app = express();
  app.use(express.json());
  app.use(
    createMondayWebhookRouter({
      webhookToken: WEBHOOK_TOKEN,
      mondayClient,
      jira,
      echoStore,
      schema: SCHEMA,
    })
  );

  return { app, mondayClient, jira, echoStore };
}

function webhookEvent(overrides?: {
  pulseId?: number | null;
  columnId?: string;
}) {
  return {
    event: {
      userId: 123,
      boardId: 5030564582,
      pulseId: overrides?.pulseId === undefined ? 99001 : overrides.pulseId,
      pulseName: "Test Item",
      columnId: overrides?.columnId ?? "status_col",
      columnType: "color",
      columnTitle: "Status",
      value: { label: { index: 1, text: "In progress" } },
      previousValue: null,
      changedAt: 1693920000,
      isTopGroup: true,
      app: "monday",
      type: "update_column_value",
      triggerTime: "2024-09-05T12:00:00.000Z",
      subscriptionId: 456,
      triggerUuid: "test-trigger-uuid",
    },
  };
}

async function postWebhook(
  app: express.Express,
  body: unknown,
  token?: string
) {
  const { default: request } = await import("supertest");
  const res = await request(app)
    .post(`/webhook/monday/${token ?? WEBHOOK_TOKEN}`)
    .set("Content-Type", "application/json")
    .send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

describe("monday native webhook", () => {
  it("echoes challenge for handshake", async () => {
    const { app } = buildApp();
    const { status, body } = await postWebhook(app, {
      challenge: "abc123xyz",
    });
    expect(status).toBe(200);
    expect(body["challenge"]).toBe("abc123xyz");
  });

  it("rejects requests with wrong token", async () => {
    const { app } = buildApp();
    const { status } = await postWebhook(app, webhookEvent(), "wrong-token");
    expect(status).toBe(401);
  });

  it("ignores non-status column changes", async () => {
    const { app, jira } = buildApp();
    const { status, body } = await postWebhook(
      app,
      webhookEvent({ columnId: "other_col" })
    );
    expect(status).toBe(200);
    expect(body["message"]).toBe("Not a status column change");
    expect(jira.get).not.toHaveBeenCalled();
  });

  it("transitions Jira issue on status change", async () => {
    const { app, jira } = buildApp();
    const { status, body } = await postWebhook(app, webhookEvent());
    expect(status).toBe(200);
    expect(body["message"]).toBe("Transition complete");
    expect(jira.postNoContent).toHaveBeenCalledWith(
      "issue/NTSR-42/transitions",
      { transition: { id: "21" } }
    );
  });

  it("skips items with no Jira key", async () => {
    const { app, jira } = buildApp({ jiraKey: null });
    const { status, body } = await postWebhook(app, webhookEvent());
    expect(status).toBe(200);
    expect(body["message"]).toBe("No Jira counterpart");
    expect(jira.get).not.toHaveBeenCalled();
  });

  it("suppresses echo when marker exists", async () => {
    const echoStore = createEchoStore({
      storage: makeMemoryStorage(),
      windowMs: 60000,
    });
    await echoStore.record("NTSR-42", "status", "In Progress");

    const { app, jira } = buildApp({ echoStore });
    const { status, body } = await postWebhook(app, webhookEvent());
    expect(status).toBe(200);
    expect(body["message"]).toBe("Echo suppressed");
    expect(jira.postNoContent).not.toHaveBeenCalled();
  });

  it("returns 500 on transient Jira failure for retry", async () => {
    const mondayClient = makeMondayClient();
    const jira = makeMockJira();
    jira.get.mockRejectedValue(new Error("Jira timeout"));

    const app = express();
    app.use(express.json());
    app.use(
      createMondayWebhookRouter({
        webhookToken: WEBHOOK_TOKEN,
        mondayClient,
        jira,
        echoStore: createEchoStore({
          storage: makeMemoryStorage(),
          windowMs: 60000,
        }),
        schema: SCHEMA,
      })
    );

    const { status, body } = await postWebhook(app, webhookEvent());
    expect(status).toBe(500);
    expect(body["error"]).toContain("Jira timeout");
  });

  it("rejects events with no pulseId", async () => {
    const { app } = buildApp();
    const { status } = await postWebhook(
      app,
      webhookEvent({ pulseId: null })
    );
    expect(status).toBe(400);
  });
});
