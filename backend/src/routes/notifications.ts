import { Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import pool from "../db/pool";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { logger } from "../logger";

const router = Router();

const PREF_KEYS = [
  "created_self",
  "active",
  "voting_ends_soon",
  "outcome",
  "queued",
  "executed",
] as const;

type PrefKey = (typeof PREF_KEYS)[number];

function defaultPreferences() {
  return {
    created_self: true,
    active: true,
    voting_ends_soon: true,
    outcome: true,
    queued: true,
    executed: true,
  };
}

const preferencesSchema = z.object({
  created_self: z.boolean().optional(),
  active: z.boolean().optional(),
  voting_ends_soon: z.boolean().optional(),
  outcome: z.boolean().optional(),
  queued: z.boolean().optional(),
  executed: z.boolean().optional(),
});

const listNotificationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  unread_only: z.enum(["true", "false"]).transform(v => v === "true").optional().default("false" as any),
});

const createNotificationSchema = z.object({
  type: z.string().trim().min(1).max(64),
  proposal_id: z.coerce.number().int().min(0).optional(),
  message: z.string().optional(),
});

const markReadSchema = z.object({
  ids: z.array(z.coerce.number().int()).optional(),
  all: z.boolean().optional(),
});

const webhookSchema = z.object({
  callback_url: z.string().url(),
  event_filter: z.array(z.string().min(1).max(64)).optional().default([]),
});

const VALID_EVENTS = new Set([
  "created_self",
  "active",
  "voting_ends_soon",
  "outcome",
  "queued",
  "executed",
]);

// GET /notifications/preferences - get current preferences (auth required)
router.get("/preferences", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await pool.query(
      `SELECT ${PREF_KEYS.join(", ")} FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    res.json(result.rows[0] ?? defaultPreferences());
  } catch (error) {
    logger.error({ err: error }, "Error fetching notification preferences");
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// POST /notifications/preferences - save preferences (auth required)
router.post(
  "/preferences",
  authenticate,
  validate({ body: preferencesSchema }),
  async (req: AuthRequest, res) => {

    const userId = req.userId!;
    const next: Record<PrefKey, boolean> = defaultPreferences();
    for (const k of PREF_KEYS) {
      if (typeof req.body[k] === "boolean") next[k] = req.body[k];
    }

    try {
      await pool.query(
        `INSERT INTO notification_preferences (user_id, ${PREF_KEYS.join(", ")})
         VALUES ($1, ${PREF_KEYS.map((_, i) => `$${i + 2}`).join(", ")})
         ON CONFLICT (user_id) DO UPDATE SET
           ${PREF_KEYS.map((k, i) => `${k} = $${i + 2}`).join(", ")}`,
        [userId, ...PREF_KEYS.map((k) => next[k])],
      );

      res.json(next);
    } catch (error) {
      logger.error({ err: error }, "Error saving notification preferences");
      res.status(500).json({ error: "Failed to save preferences" });
    }
  },
);

// GET /notifications - fetch user's notification history (auth required)
router.get(
  "/",
  authenticate,
  validate({ query: listNotificationsSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { limit, offset, unread_only: unreadOnly } = req.query as any;

    try {
      const whereUnread = unreadOnly ? "AND read = false" : "";
      const rows = await pool.query(
        `SELECT id, type, proposal_id, message, read, created_at
         FROM notification_history
         WHERE user_id = $1 ${whereUnread}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN read = false THEN 1 ELSE 0 END)::int AS unread
         FROM notification_history
         WHERE user_id = $1`,
        [userId],
      );

      res.json({
        data: rows.rows,
        meta: {
          total: count.rows[0]?.total ?? 0,
          unread: count.rows[0]?.unread ?? 0,
          limit,
          offset,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching notification history");
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  },
);

// POST /notifications - add a history entry (auth required)
router.post(
  "/",
  authenticate,
  validate({ body: createNotificationSchema }),
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const type = (req.body.type as string).trim();
    const proposalId = req.body.proposal_id as number | undefined;
    const message = (req.body.message as string | undefined) ?? null;

    try {
      const inserted = await pool.query(
        `INSERT INTO notification_history (user_id, type, proposal_id, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, type, proposal_id, message, read, created_at`,
        [userId, type, proposalId ?? null, message],
      );
      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      logger.error({ err: error }, "Error inserting notification");
      res.status(500).json({ error: "Failed to create notification" });
    }
  },
);

// POST /notifications/mark-read - mark notifications as read (auth required)
router.post(
  "/mark-read",
  authenticate,
  validate({ body: markReadSchema }),
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const markAll = req.body.all === true;
    const ids = (req.body.ids as number[] | undefined) ?? [];

    try {
      if (markAll) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND read = false",
          [userId],
        );
      } else if (ids.length > 0) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND id = ANY($2::int[])",
          [userId, ids],
        );
      }

      const unread = await pool.query(
        "SELECT COUNT(*)::int AS unread FROM notification_history WHERE user_id = $1 AND read = false",
        [userId],
      );
      res.json({ unread: unread.rows[0]?.unread ?? 0 });
    } catch (error) {
      logger.error({ err: error }, "Error marking notifications read");
      res.status(500).json({ error: "Failed to mark read" });
    }
  },
);

// POST /notifications/webhook - register a webhook subscription (auth required)
router.post(
  "/webhook",
  authenticate,
  validate({ body: webhookSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { callback_url, event_filter } = req.body as {
      callback_url: string;
      event_filter: string[];
    };

    for (const ev of event_filter) {
      if (!VALID_EVENTS.has(ev)) {
        res.status(400).json({
          error: `Invalid event: ${ev}. Valid events: ${[...VALID_EVENTS].join(", ")}`,
        });
        return;
      }
    }

    try {
      const hmac_secret = crypto.randomBytes(32).toString("hex");

      const inserted = await pool.query(
        `INSERT INTO webhook_subscriptions (user_id, callback_url, hmac_secret, event_filter)
         VALUES ($1, $2, $3, $4)
         RETURNING id, callback_url, event_filter, active, created_at`,
        [userId, callback_url, hmac_secret, event_filter],
      );

      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      logger.error({ err: error }, "Error registering webhook");
      res.status(500).json({ error: "Failed to register webhook" });
    }
  },
);

export default router;
