import { Router } from "express";
import { jwtVerify, decodeProtectedHeader, errors as joseErrors } from "jose";
import { z } from "zod";
import type { IssueSync, WebhookPayload } from "./issueSync.js";

const WebhookIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    status: z.object({ name: z.string() }),
  }),
});

const WebhookPayloadSchema = z.object({
  webhookEvent: z.string(),
  issue: WebhookIssueSchema,
  changelog: z
    .object({
      items: z
        .array(
          z.object({
            field: z.string(),
            fromString: z.string().nullable(),
            toString: z.string().nullable(),
          })
        )
        .optional(),
    })
    .optional(),
});

let firstVerification = true;

async function verifyJwt(
  authHeader: string | undefined,
  clientSecret: string
): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7);
  const secretKey = new TextEncoder().encode(clientSecret);

  try {
    const header = decodeProtectedHeader(token);
    const alg = header.alg ?? "";

    if (!alg.startsWith("HS")) {
      console.error(
        `[WEBHOOK] Rejected JWT with unsupported algorithm: ${alg}`
      );
      return false;
    }

    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256", "HS384", "HS512"],
    });

    if (firstVerification) {
      console.log(
        `[WEBHOOK] First JWT verified. Header: ${JSON.stringify(header)}, Claims: ${JSON.stringify(payload)}`
      );
      firstVerification = false;
    }

    return true;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      console.error("[WEBHOOK] Rejected expired JWT");
    } else if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      console.error("[WEBHOOK] JWT signature verification failed");
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WEBHOOK] JWT verification error: ${message}`);
    }
    return false;
  }
}

export function createWebhookRouter(opts: {
  clientSecret: string;
  issueSync: IssueSync;
}): Router {
  const router = Router();

  router.post("/webhook/jira", async (req, res) => {
    const correlationId =
      (req.headers["x-atlassian-webhook-identifier"] as string | undefined) ??
      `unknown-${Date.now()}`;

    const verified = await verifyJwt(
      req.headers.authorization,
      opts.clientSecret
    );
    if (!verified) {
      console.error(
        `[WEBHOOK] correlationId=${correlationId} Verification failed, rejecting`
      );
      res.status(401).json({ error: "Webhook verification failed" });
      return;
    }

    res.status(200).json({ ok: true });

    const parsed = WebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      console.error(
        `[WEBHOOK] correlationId=${correlationId} Invalid payload: ${parsed.error.message}`
      );
      return;
    }

    const payload: WebhookPayload = parsed.data;

    const event = payload.webhookEvent;
    if (event !== "jira:issue_created" && event !== "jira:issue_updated") {
      console.log(
        `[WEBHOOK] correlationId=${correlationId} Ignoring event type: ${event}`
      );
      return;
    }

    opts.issueSync.processEvent(payload, correlationId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[WEBHOOK] correlationId=${correlationId} Unhandled processing error: ${message}`
      );
    });
  });

  return router;
}
