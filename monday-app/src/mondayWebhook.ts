import { Router } from "express";
import type { MondayClient } from "./mondayClient.js";
import type { JiraClient } from "./jiraClient.js";
import type { EchoStore } from "./echoSuppression.js";
import type { WorkPackagesSchema } from "./boardSchema.js";
import { syncStatusToJira, log } from "./statusSync.js";
import type { SyncDeps } from "./statusSync.js";

export function createMondayWebhookRouter(opts: {
  webhookToken: string;
  mondayClient: MondayClient;
  jira: JiraClient;
  echoStore: EchoStore;
  schema: WorkPackagesSchema;
}): Router {
  const router = Router();

  const deps: SyncDeps = {
    mondayClient: opts.mondayClient,
    jira: opts.jira,
    echoStore: opts.echoStore,
    schema: opts.schema,
  };

  router.post("/webhook/monday/:token", async (req, res) => {
    if (req.params.token !== opts.webhookToken) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    if (req.body?.challenge != null) {
      res.json({ challenge: req.body.challenge });
      return;
    }

    const event = req.body?.event;
    if (!event) {
      res.status(400).json({ error: "Missing event payload" });
      return;
    }

    const correlationId = `monday-wh-${event.triggerUuid ?? Date.now()}`;

    if (event.pulseId == null) {
      log("ERROR", { correlationId }, "No pulseId in webhook event");
      res.status(400).json({ error: "Missing pulseId" });
      return;
    }

    if (event.columnId !== opts.schema.statusColumnId) {
      log(
        "INFO",
        { correlationId },
        `Ignoring column change for "${event.columnId}" (not status column)`
      );
      res.json({ message: "Not a status column change" });
      return;
    }

    const itemId = String(event.pulseId);
    const result = await syncStatusToJira(deps, itemId, correlationId);

    if (result.transient) {
      res.status(500).json({ error: result.message });
    } else {
      res.json({ message: result.message });
    }
  });

  return router;
}
