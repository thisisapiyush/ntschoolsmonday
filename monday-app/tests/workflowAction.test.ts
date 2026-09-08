import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";
import express from "express";
import { createWorkflowActionRouter } from "../src/workflowAction.js";
import { createEchoStore } from "../src/echoSuppression.js";
import type { EchoStorage } from "../src/echoSuppression.js";
import type { WorkPackagesSchema } from "../src/boardSchema.js";

const SIGNING_SECRET = "test-monday-signing-secret-key";

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

async function makeToken(secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ accountId: 123, userId: 456 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

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
    createWorkflowActionRouter({
      signingSecret: SIGNING_SECRET,
      mondayClient,
      jira,
      echoStore,
      schema: SCHEMA,
      boardId: "5030564582",
    })
  );

  return { app, mondayClient, jira, echoStore };
}

async function postAction(
  app: express.Express,
  opts?: { token?: string; itemId?: string }
) {
  const { default: request } = await import("supertest");
  const token = opts?.token ?? (await makeToken(SIGNING_SECRET));
  const body = {
    payload: {
      inputFields: {
        itemId: opts?.itemId ?? "99001",
      },
      inboundFieldValues: {},
    },
    runtimeMetadata: {
      actionUuid: "test-action-uuid",
      triggerUuid: "test-trigger-uuid",
    },
  };

  const res = await request(app)
    .post("/workflow/action/sync-status")
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/json")
    .send(body);

  return { status: res.status, body: res.body as Record<string, unknown> };
}

describe("workflow action block", () => {
  it("rejects requests with no JWT", async () => {
    const { app } = buildApp();
    const { default: request } = await import("supertest");
    const res = await request(app)
      .post("/workflow/action/sync-status")
      .set("Content-Type", "application/json")
      .send({ payload: { inputFields: {} } });

    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong signing secret", async () => {
    const { app } = buildApp();
    const token = await makeToken("wrong-secret");
    const { status } = await postAction(app, { token });
    expect(status).toBe(401);
  });

  it("skips items with no Jira key", async () => {
    const { app, jira } = buildApp({ jiraKey: null });
    const { status, body } = await postAction(app);
    expect(status).toBe(200);
    expect(body["message"]).toBe("No Jira counterpart");
    expect(jira.get).not.toHaveBeenCalled();
  });

  it("transitions Jira issue on valid status change", async () => {
    const { app, jira } = buildApp();
    const { status, body } = await postAction(app);
    expect(status).toBe(200);
    expect(body["message"]).toBe("Transition complete");
    expect(jira.postNoContent).toHaveBeenCalledWith(
      "issue/NTSR-42/transitions",
      { transition: { id: "21" } }
    );
  });

  it("surfaces constraint when no transition is available", async () => {
    const { app, mondayClient } = buildApp({ transitionAvailable: false });
    const { status, body } = await postAction(app);
    expect(status).toBe(200);
    expect(body["message"]).toBe("No matching transition");
    const updateCall = mondayClient.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("create_update")
    );
    expect(updateCall).toBeDefined();
  });

  it("suppresses echo when marker exists", async () => {
    const echoStore = createEchoStore({
      storage: makeMemoryStorage(),
      windowMs: 60000,
    });
    await echoStore.record("NTSR-42", "status", "In Progress");

    const { app, jira } = buildApp({ echoStore });
    const { status, body } = await postAction(app);
    expect(status).toBe(200);
    expect(body["message"]).toBe("Echo suppressed");
    expect(jira.postNoContent).not.toHaveBeenCalled();
  });

  it("skips unmapped monday status", async () => {
    const { app, jira } = buildApp({ statusLabel: "Blocked" });
    const { status, body } = await postAction(app);
    expect(status).toBe(200);
    expect(body["message"]).toBe("Unmapped status");
    expect(jira.get).not.toHaveBeenCalled();
  });
});
