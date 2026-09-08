import { Router } from "express";
import { jwtVerify, errors as joseErrors } from "jose";
import { z } from "zod";
import type { MondayClient } from "./mondayClient.js";
import type { JiraClient } from "./jiraClient.js";
import type { EchoStore } from "./echoSuppression.js";
import type { WorkPackagesSchema } from "./boardSchema.js";
import { syncStatusToJira, log } from "./statusSync.js";
import type { SyncDeps } from "./statusSync.js";

const ActionPayloadSchema = z.object({
  payload: z.object({
    inputFields: z.record(z.unknown()),
    inboundFieldValues: z.record(z.unknown()).optional(),
  }),
  runtimeMetadata: z
    .object({
      actionUuid: z.string(),
      triggerUuid: z.string(),
    })
    .optional(),
});

export function createWorkflowActionRouter(opts: {
  signingSecret: string;
  mondayClient: MondayClient;
  jira: JiraClient;
  echoStore: EchoStore;
  schema: WorkPackagesSchema;
  boardId: string;
}): Router {
  const router = Router();
  const secretKey = new TextEncoder().encode(opts.signingSecret);

  async function verifyMondayJwt(
    authHeader: string | undefined
  ): Promise<boolean> {
    if (!authHeader) return false;
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    try {
      await jwtVerify(token, secretKey, {
        algorithms: ["HS256", "HS384", "HS512"],
      });
      return true;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        console.error("[WORKFLOW] Rejected expired JWT");
      } else if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        console.error("[WORKFLOW] JWT signature verification failed");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[WORKFLOW] JWT verification error: ${message}`);
      }
      return false;
    }
  }

  const deps: SyncDeps = {
    mondayClient: opts.mondayClient,
    jira: opts.jira,
    echoStore: opts.echoStore,
    schema: opts.schema,
  };

  router.post("/workflow/action/sync-status", async (req, res) => {
    const correlationId: string =
      req.body?.runtimeMetadata?.actionUuid ?? `workflow-${Date.now()}`;

    const verified = await verifyMondayJwt(req.headers.authorization);
    if (!verified) {
      log("ERROR", { correlationId }, "JWT verification failed");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = ActionPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      log("ERROR", { correlationId }, `Invalid payload: ${parsed.error.message}`);
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    const inputFields = parsed.data.payload.inputFields;
    const raw = inputFields["itemId"];
    const itemId = raw != null ? String(raw) : "";

    if (!itemId) {
      log("ERROR", { correlationId }, "No itemId in payload inputFields");
      res.status(400).json({ error: "Missing itemId" });
      return;
    }

    const previousValueRaw =
      inputFields["previousColumnValue"] ??
      inputFields["previous_value"];
    const previousMondayStatus =
      typeof previousValueRaw === "string" ? previousValueRaw : undefined;

    const result = await syncStatusToJira(
      deps,
      itemId,
      correlationId,
      previousMondayStatus
    );

    if (result.transient) {
      res.json({
        severityCode: 4000,
        notificationErrorTitle: result.errorTitle,
        notificationErrorDescription: result.message,
        runtimeErrorDescription: result.errorDetail,
      });
    } else {
      res.json({ message: result.message });
    }
  });

  return router;
}
