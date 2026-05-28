import { Router, Response } from "express";
import { z } from "zod";
import pool from "../db/pool";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { isAdmin } from "../middleware/admin";
import { Competition } from "../entities/Competition";
import { CompetitionParticipant } from "../entities/CompetitionParticipant";
import { logger } from "../logger";

const router = Router();

type PostgresError = Error & { code?: string };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as PostgresError).code === "23505"
  );
}

// Zod schemas for validation
const listCompetitionsSchema = z.object({
  is_active: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const getCompetitionSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listParticipantsSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
  }),
});

const competitionIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const createCompetitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(5000).optional(),
    entry_fee: z.coerce.number().int().min(0),
    start_date: z.string().datetime(),
    end_date: z.string().datetime(),
  })
  .superRefine((data, ctx) => {
    const start = new Date(data.start_date);
    const end = new Date(data.end_date);
    const now = Date.now();

    if (start.getTime() >= end.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["start_date"],
        message: "start_date must be before end_date",
      });
    }

    if (end.getTime() <= now) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_date"],
        message: "end_date must be in the future",
      });
    }
  });

const updateCompetitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(5000).optional(),
    entry_fee: z.coerce.number().int().min(0).optional(),
    start_date: z.string().datetime().optional(),
    end_date: z.string().datetime().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "At least one field must be provided",
      });
      return;
    }

    if (data.start_date && data.end_date) {
      const start = new Date(data.start_date);
      const end = new Date(data.end_date);
      if (start.getTime() >= end.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["start_date"],
          message: "start_date must be before end_date",
        });
      }
    }
  });

// GET /competitions - List all competitions with pagination
router.get(
  "/",
  validate({ query: listCompetitionsSchema }),
  async (req, res) => {
    const { is_active, limit, offset } = req.query as any;

    try {
      let queryText = `
        SELECT
          c.*,
          COUNT(cp.id) AS participant_count
        FROM competitions c
        LEFT JOIN competition_participants cp ON c.id = cp.competition_id
        WHERE 1=1
      `;
      const queryParams: unknown[] = [];
      let paramIndex = 1;

      if (is_active !== undefined) {
        queryText += ` AND c.is_active = $${paramIndex}`;
        queryParams.push(is_active);
        paramIndex++;
      }

      queryText += ` GROUP BY c.id ORDER BY c.start_date DESC`;
      queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryParams.push(limit, offset);

      const result = await pool.query(queryText, queryParams);

      let countQuery = "SELECT COUNT(*) FROM competitions WHERE 1=1";
      const countParams: unknown[] = [];

      if (is_active !== undefined) {
        countQuery += " AND is_active = $1";
        countParams.push(is_active);
      }

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      res.json({
        competitions: result.rows,
        total,
        limit,
        offset,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching competitions");
      res.status(500).json({ error: "Failed to fetch competitions" });
    }
  },
);

// GET /competitions/:id - Get single competition with user participation state
router.get(
  "/:id",
  authenticate,
  validate({ params: getCompetitionSchema }),
  async (req: AuthRequest, res: Response) => {
    const competitionId = Number((req.params as Record<string, string>).id);
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const result = await pool.query(
        `SELECT c.*, COUNT(cp.id) AS participant_count
         FROM competitions c
         LEFT JOIN competition_participants cp ON c.id = cp.competition_id
         WHERE c.id = $1
         GROUP BY c.id`,
        [competitionId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = result.rows[0];
      const response: Record<string, unknown> = { competition };

      const participantResult = await pool.query(
        "SELECT id FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );
      response.is_joined = participantResult.rows.length > 0;

      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Error fetching competition");
      res.status(500).json({ error: "Failed to fetch competition" });
    }
  },
);

// GET /competitions/:id/participants - Get competition participants
router.get(
  "/:id/participants",
  validate({
    params: listParticipantsSchema.shape.params,
    query: listParticipantsSchema.shape.query,
  }),
  async (req, res) => {
    const { id: competitionId } = req.params as any;
    const { limit, offset } = req.query as any;

    try {
      const compResult = await pool.query(
        "SELECT id FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const queryText = `
        SELECT
          cp.*,
          u.wallet_address
        FROM competition_participants cp
        JOIN users u ON cp.user_id = u.id
        WHERE cp.competition_id = $1
        ORDER BY cp.joined_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await pool.query(queryText, [competitionId, limit, offset]);

      const countResult = await pool.query(
        "SELECT COUNT(*) FROM competition_participants WHERE competition_id = $1",
        [competitionId],
      );
      const total = parseInt(countResult.rows[0].count);

      res.json({
        participants: result.rows,
        total,
        limit,
        offset,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching participants");
      res.status(500).json({ error: "Failed to fetch participants" });
    }
  },
);

// POST /competitions/:id/join - Join a competition
router.post(
  "/:id/join",
  authenticate,
  validate({ params: competitionIdSchema }),
  async (req: AuthRequest, res) => {

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const competitionId = (req.params as any).id;
      const userId = req.userId!;

      const compResult = await client.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = compResult.rows[0];

      if (!competition.is_active) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Competition is not active" });
      }

      if (new Date() >= new Date(competition.start_date)) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Competition has already started" });
      }

      const insertResult = await client.query<CompetitionParticipant>(
        `INSERT INTO competition_participants (competition_id, user_id, entry_fee_paid)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [competitionId, userId, competition.entry_fee],
      );

      await client.query("COMMIT");

      res.status(201).json({
        message: "Successfully joined competition",
        participant: insertResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        logger.warn(
          { competitionId: (req.params as any).id, userId: req.userId },
          "Duplicate competition join prevented by unique constraint",
        );
        return res.status(409).json({ error: "Already joined this competition" });
      }
      logger.error({ err: error }, "Error joining competition");
      res.status(500).json({ error: "Failed to join competition" });
    } finally {
      client.release();
    }
  },
);

// DELETE /competitions/:id/leave - Leave a competition
router.delete(
  "/:id/leave",
  authenticate,
  validate({ params: competitionIdSchema }),
  async (req: AuthRequest, res) => {

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const competitionId = (req.params as any).id;
      const userId = req.userId!;

      const compResult = await client.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = compResult.rows[0];

      if (new Date() >= new Date(competition.start_date)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Cannot leave competition after it has started",
        });
      }

      const participantResult = await client.query<CompetitionParticipant>(
        "SELECT * FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );

      if (participantResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "Not a participant in this competition" });
      }

      const participant = participantResult.rows[0];

      await client.query(
        "DELETE FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );

      await client.query("COMMIT");

      res.json({
        message: "Successfully left competition",
        refund: participant.entry_fee_paid.toString(),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error({ err: error }, "Error leaving competition");
      res.status(500).json({ error: "Failed to leave competition" });
    } finally {
      client.release();
    }
  },
);

// POST /competitions - Create competition (admin only)
router.post(
  "/",
  isAdmin,
  validate({ body: createCompetitionSchema }),
  async (req, res) => {
    const { name, description, entry_fee, start_date, end_date } = req.body as z.infer<
      typeof createCompetitionSchema
    >;

    try {
      const result = await pool.query<Competition>(
        `INSERT INTO competitions (name, description, entry_fee, start_date, end_date, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, true, NULL)
         RETURNING *`,
        [name, description ?? null, entry_fee, new Date(start_date), new Date(end_date)],
      );

      return res.status(201).json({ competition: result.rows[0] });
    } catch (error) {
      logger.error({ err: error }, "Error creating competition");
      return res.status(500).json({ error: "Failed to create competition" });
    }
  },
);

// PUT /competitions/:id - Update competition (admin only)
router.put(
  "/:id",
  isAdmin,
  validate({ params: competitionIdSchema, body: updateCompetitionSchema }),
  async (req, res) => {
    const id = Number((req.params as Record<string, string>).id);
    const updates = req.body as z.infer<typeof updateCompetitionSchema>;

    try {
      const existing = await pool.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [id],
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = existing.rows[0];
      if (new Date() >= new Date(competition.start_date)) {
        return res.status(400).json({
          error: "Competition can only be updated before start_date",
        });
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      const append = (field: string, value: unknown) => {
        fields.push(`${field} = $${idx}`);
        values.push(value);
        idx += 1;
      };

      if (updates.name !== undefined) append("name", updates.name);
      if (updates.description !== undefined) append("description", updates.description);
      if (updates.entry_fee !== undefined) append("entry_fee", updates.entry_fee);
      if (updates.start_date !== undefined) append("start_date", new Date(updates.start_date));
      if (updates.end_date !== undefined) append("end_date", new Date(updates.end_date));
      if (updates.is_active !== undefined) append("is_active", updates.is_active);
      append("updated_at", new Date());

      const result = await pool.query<Competition>(
        `UPDATE competitions
         SET ${fields.join(", ")}
         WHERE id = $${idx}
         RETURNING *`,
        [...values, id],
      );

      return res.status(200).json({ competition: result.rows[0] });
    } catch (error) {
      logger.error({ err: error }, "Error updating competition");
      return res.status(500).json({ error: "Failed to update competition" });
    }
  },
);

// DELETE /competitions/:id - Soft delete competition (admin only)
router.delete(
  "/:id",
  isAdmin,
  validate({ params: competitionIdSchema }),
  async (req, res) => {
    const id = Number((req.params as Record<string, string>).id);

    try {
      const existing = await pool.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [id],
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const participantCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM competition_participants WHERE competition_id = $1",
        [id],
      );

      if (Number(participantCount.rows[0]?.count ?? "0") > 0) {
        return res.status(400).json({
          error: "Cannot delete competition with existing participants",
        });
      }

      await pool.query(
        "UPDATE competitions SET is_active = false, updated_at = NOW() WHERE id = $1",
        [id],
      );

      return res.status(204).send();
    } catch (error) {
      logger.error({ err: error }, "Error deleting competition");
      return res.status(500).json({ error: "Failed to delete competition" });
    }
  },
);

export default router;
