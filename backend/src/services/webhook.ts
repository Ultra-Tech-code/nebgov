import crypto from "crypto";
import pool from "../db/pool";
import { logger } from "../logger";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 10_000;
const TIMEOUT_MS = 10_000;

export interface WebhookSubscription {
  id: number;
  user_id: number;
  callback_url: string;
  hmac_secret: string;
  event_filter: string[];
  active: boolean;
}

export interface WebhookPayload {
  event: string;
  proposal_id?: number;
  timestamp: string;
  data: Record<string, unknown>;
}

function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function retryDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
}

export async function matchAndDeliverWebhooks(
  eventType: string,
  proposalId: number | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  const subs = await pool.query<WebhookSubscription>(
    `SELECT id, user_id, callback_url, hmac_secret, event_filter, active
     FROM webhook_subscriptions
     WHERE active = true
       AND (event_filter = '{}' OR $1 = ANY(event_filter))`,
    [eventType],
  );

  const payload: WebhookPayload = {
    event: eventType,
    proposal_id: proposalId,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const sub of subs.rows) {
    deliverWebhook(sub, payload).catch((err) => {
      logger.error({ err, webhookId: sub.id }, "Webhook delivery failed");
    });
  }
}

async function deliverWebhook(
  sub: WebhookSubscription,
  payload: WebhookPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = computeHmac(body, sub.hmac_secret);

  let lastError: string | null = null;
  let success = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(sub.callback_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": payload.event,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        success = true;
        break;
      }

      lastError = `HTTP ${response.status}: ${response.statusText}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    const delay = retryDelay(attempt);
    logger.warn(
      { webhookId: sub.id, attempt, lastError, nextRetryMs: delay },
      "Webhook delivery attempt failed, will retry",
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  const status = success ? "delivered" : "failed";

  await pool.query(
    `INSERT INTO webhook_delivery_log (webhook_id, event_type, payload, status, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sub.id, payload.event, JSON.stringify(payload), status, success ? 1 : MAX_RETRIES, lastError],
  );

  if (!success) {
    logger.error(
      { webhookId: sub.id, callbackUrl: sub.callback_url, lastError },
      "Webhook permanently failed after max retries",
    );
  }
}
