import express, { Request, Response, NextFunction } from "express";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { pool } from "./db";
import { cached, getMetrics } from "./cache";
import { getLastIndexedLedger } from "./events";
import { startTime } from "./index";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";

// ---------------------------------------------------------------------------
// In-process rate limiter (issue #437)
//
// Tracks request counts per IP in a sliding window. No external dependency
// required — the store is a plain Map that is pruned on every request so
// memory usage stays bounded.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Build an Express middleware that limits each IP to `max` requests within
 * a rolling `windowMs` millisecond window.
 *
 * When the limit is exceeded the middleware responds with HTTP 429 and a
 * JSON body that includes a `Retry-After` header (seconds until the window
 * resets) so well-behaved clients can back off automatically.
 */
function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const { windowMs, max, message = "Too many requests, please try again later." } = options;

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const now = Date.now();

    // Prune stale entries to keep the store from growing unboundedly.
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now - entry.windowStart > windowMs) {
        rateLimitStore.delete(key);
      }
    }

    const entry = rateLimitStore.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      // First request in this window (or window has expired).
      rateLimitStore.set(ip, { count: 1, windowStart: now });
      res.setHeader("X-RateLimit-Limit", max);
      res.setHeader("X-RateLimit-Remaining", max - 1);
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));
      next();
      return;
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetAt = Math.ceil((entry.windowStart + windowMs) / 1000);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

/** General-purpose limiter: 100 requests per 15-minute window per IP. */
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});

/**
 * Stricter limiter for expensive / enumeration-prone endpoints.
 *
 * Applied to:
 *   - GET /delegates  (N+1 query risk)
 *   - GET /profile/:address  (enumeration attack surface)
 *
 * Allows 30 requests per 15-minute window per IP.
 */
const strictLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many requests to this endpoint, please slow down.",
});

const TTL = {
  proposals: 30_000, // 30 seconds
  proposalVotes: 15_000, // 15 seconds
  delegates: 60_000, // 60 seconds
  profile: 30_000, // 30 seconds
  stats: 60_000, // 60 seconds
};

const HEALTH_LAG_THRESHOLD = Number(process.env.HEALTH_LAG_THRESHOLD ?? 100);
const STELLAR_LEDGER_CLOSE_TIME_SECONDS = 5; // Stellar ledgers close approximately every 5 seconds
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const INVALID_ADDRESS_ERROR = "Invalid Stellar address";

function isValidStellarPublicKey(address: string): boolean {
  return STELLAR_PUBLIC_KEY_REGEX.test(address);
}

interface HealthResponse {
  status: "ok" | "degraded";
  last_indexed_ledger: number;
  current_ledger: number;
  lag_ledgers: number;
  lag_seconds: number;
  total_proposals_indexed: number;
  total_votes_indexed: number;
  total_delegates_indexed: number;
  uptime_seconds: number;
  timestamp: string;
}

async function getHealthStatus(server: SorobanRpc.Server): Promise<HealthResponse> {
  // Fetch current ledger from RPC
  const latestLedger = await server.getLatestLedger();
  const currentLedger = latestLedger.sequence;

  // Get last indexed ledger from database
  const lastIndexedLedger = await getLastIndexedLedger();

  // Calculate lag
  const lagLedgers = Math.max(0, currentLedger - lastIndexedLedger);
  const lagSeconds = lagLedgers * STELLAR_LEDGER_CLOSE_TIME_SECONDS;

  // Get counts from database
  const [proposalsResult, votesResult, delegatesResult] = await Promise.all([
    pool.query("SELECT COUNT(*) as count FROM proposals"),
    pool.query("SELECT COUNT(*) as count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT delegator) as count FROM delegates"),
  ]);

  const totalProposals = Number(proposalsResult.rows[0]?.count ?? 0);
  const totalVotes = Number(votesResult.rows[0]?.count ?? 0);
  const totalDelegates = Number(delegatesResult.rows[0]?.count ?? 0);

  // Calculate uptime
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Determine status
  const status = lagLedgers > HEALTH_LAG_THRESHOLD ? "degraded" : "ok";

  return {
    status,
    last_indexed_ledger: lastIndexedLedger,
    current_ledger: currentLedger,
    lag_ledgers: lagLedgers,
    lag_seconds: lagSeconds,
    total_proposals_indexed: totalProposals,
    total_votes_indexed: totalVotes,
    total_delegates_indexed: totalDelegates,
    uptime_seconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
  };
}

interface StatsResponse {
  total_proposals: number;
  active_proposals: number;
  total_votes_cast: number;
  unique_voters: number;
  total_delegates: number;
  participation_rate: number;
  last_updated: string;
}

async function getStatsStatus(server: SorobanRpc.Server): Promise<StatsResponse> {
  const latestLedger = await server.getLatestLedger();
  const currentLedger = latestLedger.sequence;

  const [
    totalProposalsRes,
    activeProposalsRes,
    totalVotesRes,
    uniqueVotersRes,
    totalDelegatesRes,
    executedProposalsRes,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM proposals"),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM proposals
       WHERE start_ledger <= $1 AND end_ledger >= $1 AND executed = false AND cancelled = false`,
      [currentLedger],
    ),
    pool.query("SELECT COUNT(*)::int AS count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT voter)::int AS count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT delegator)::int AS count FROM delegates"),
    pool.query(
      `SELECT
         COALESCE(SUM(votes_for + votes_against + votes_abstain), 0)::float8 AS total,
         COUNT(*)::int AS count
       FROM proposals WHERE executed = true`,
    ),
  ]);

  const totalProposals = Number(totalProposalsRes.rows[0]?.count ?? 0);
  const activeProposals = Number(activeProposalsRes.rows[0]?.count ?? 0);
  const totalVotes = Number(totalVotesRes.rows[0]?.count ?? 0);
  const uniqueVoters = Number(uniqueVotersRes.rows[0]?.count ?? 0);
  const totalDelegates = Number(totalDelegatesRes.rows[0]?.count ?? 0);
  const executedProposals = executedProposalsRes.rows[0];

  const totalVotesOnExecuted = Number(executedProposals?.total ?? 0);
  const executedCount = Number(executedProposals?.count ?? 0);

  const participationRate =
    executedCount > 0 ? totalVotesOnExecuted / executedCount : 0;

  return {
    total_proposals: totalProposals,
    active_proposals: activeProposals,
    total_votes_cast: totalVotes,
    unique_voters: uniqueVoters,
    total_delegates: totalDelegates,
    participation_rate: Math.round(participationRate * 100) / 100,
    last_updated: new Date().toISOString(),
  };
}

export function createApp(server: SorobanRpc.Server): express.Application {
  const app = express();
  app.use(express.json());

  // Apply general rate limiting to all routes (issue #437).
  // Health and docs endpoints are intentionally included so that monitoring
  // probes cannot be weaponised to exhaust the database connection pool.
  app.use(generalLimiter);

  // Swagger documentation
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(generateOpenApiDocument());
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));

  // GET /health
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await getHealthStatus(server);
      const httpStatus = health.status === "ok" ? 200 : 503;
      res.status(httpStatus).json(health);
    } catch (error) {
      console.error("Health check error:", error);
      res.status(503).json({
        status: "degraded",
        error: "Failed to retrieve health status",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /stats
  app.get("/stats", async (_req: Request, res: Response): Promise<void> => {
    const key = "stats";
    try {
      const data = await cached(key, TTL.stats, async () => getStatsStatus(server));
      res.json(data);
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /analytics/summary
  app.get(
    "/analytics/summary",
    async (_req: Request, res: Response): Promise<void> => {
      const key = "analytics:summary";
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const [
            totalProposalsRes,
            uniqueVotersRes,
            avgVotesRes,
            mostActiveProposersRes,
            outcomesRes,
            stateRes,
          ] = await Promise.all([
            pool.query("SELECT COUNT(*)::int AS total FROM proposals"),
            pool.query("SELECT COUNT(DISTINCT voter)::int AS total FROM votes"),
            pool.query(
              "SELECT COALESCE(AVG(votes_for + votes_against + votes_abstain), 0)::float AS avg FROM proposals",
            ),
            pool.query(
              `SELECT proposer, COUNT(*)::int AS count
               FROM proposals
               GROUP BY proposer
               ORDER BY count DESC
               LIMIT 5`,
            ),
            pool.query(
              `SELECT
                SUM(CASE WHEN executed THEN 1 ELSE 0 END)::int AS executed,
                SUM(CASE WHEN cancelled THEN 1 ELSE 0 END)::int AS cancelled,
                SUM(CASE WHEN queued THEN 1 ELSE 0 END)::int AS queued
               FROM proposals`,
            ),
            pool.query("SELECT last_ledger::int AS last_ledger FROM indexer_state WHERE id = 1"),
          ]);

          return {
            totalProposals: totalProposalsRes.rows[0]?.total ?? 0,
            totalUniqueVoters: uniqueVotersRes.rows[0]?.total ?? 0,
            averageVotesPerProposal: avgVotesRes.rows[0]?.avg ?? 0,
            mostActiveProposers: mostActiveProposersRes.rows ?? [],
            outcomes: outcomesRes.rows[0] ?? { executed: 0, cancelled: 0, queued: 0 },
            lastIndexedLedger: stateRes.rows[0]?.last_ledger ?? 0,
          };
        });
        res.json(data);
      } catch (error) {
        console.error("Profile lookup error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /proposals?offset=0&limit=20 or ?before=47&limit=20 or ?after=10&limit=20
  app.get("/proposals", async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    // Parse cursor IDs as BigInt to preserve u64 precision.
    const before = req.query.before ? BigInt(req.query.before as string) : undefined;
    const after = req.query.after ? BigInt(req.query.after as string) : undefined;
    const offset = Number(req.query.offset ?? 0);

    try {
      let query: string;
      let params: any[];
      let key: string;

      // Use cursor-based pagination if before/after is provided
      if (before !== undefined || after !== undefined) {
        if (before !== undefined) {
          // Fetch proposals with id < before
          query = "SELECT * FROM proposals WHERE id < $1 ORDER BY id DESC LIMIT $2";
          params = [before, limit];
          key = `proposals:before:${before}:${limit}`;
        } else {
          // Fetch proposals with id > after
          query = "SELECT * FROM proposals WHERE id > $1 ORDER BY id ASC LIMIT $2";
          params = [after, limit];
          key = `proposals:after:${after}:${limit}`;
        }
      } else {
        // Fall back to offset-based pagination for backwards compatibility
        query = "SELECT * FROM proposals ORDER BY id DESC LIMIT $1 OFFSET $2";
        params = [limit, offset];
        key = `proposals:${offset}:${limit}`;
      }

      const data = await cached(key, TTL.proposals, async () => {
        const result = await pool.query(query, params);
        const proposals = result.rows;

        // For cursor pagination, calculate next/prev cursors and hasMore.
        // Use BigInt to preserve u64 precision when comparing/passing IDs.
        if (before !== undefined || after !== undefined) {
          let nextCursor: string | undefined;
          let prevCursor: string | undefined;
          let hasMore = false;

          if (proposals.length > 0) {
            const ids = proposals.map((p: { id: string | number }) => BigInt(p.id));
            const minId = ids.reduce((a: bigint, b: bigint) => (a < b ? a : b));
            const maxId = ids.reduce((a: bigint, b: bigint) => (a > b ? a : b));

            if (before !== undefined) {
              // For "before" queries, next cursor is the smallest ID in results
              nextCursor = minId.toString();
              prevCursor = maxId.toString();

              const hasMoreResult = await pool.query(
                "SELECT 1 FROM proposals WHERE id < $1 LIMIT 1",
                [nextCursor]
              );
              hasMore = hasMoreResult.rows.length > 0;
            } else {
              // For "after" queries, reverse the order to match DESC ordering
              proposals.reverse();
              nextCursor = minId.toString();
              prevCursor = maxId.toString();

              const hasMoreResult = await pool.query(
                "SELECT 1 FROM proposals WHERE id > $1 LIMIT 1",
                [prevCursor]
              );
              hasMore = hasMoreResult.rows.length > 0;
            }
          }

          return {
            proposals,
            nextCursor,
            prevCursor,
            hasMore
          };
        } else {
          // For offset pagination, return legacy format
          return { proposals, total: result.rowCount ?? 0 };
        }
      });

      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/:id
  app.get("/proposals/:id", async (req: Request, res: Response): Promise<void> => {
    // Use BigInt to preserve full u64 precision — parseInt() silently truncates
    // values beyond Number.MAX_SAFE_INTEGER (2^53-1), causing wrong lookups.
    let id: bigint;
    try {
      id = BigInt(req.params.id);
      if (id < 1n) throw new RangeError("non-positive");
    } catch {
      res.status(400).json({ error: "Invalid proposal ID" });
      return;
    }

    try {
      const result = await pool.query('SELECT * FROM proposals WHERE id = $1', [id.toString()]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/:id/votes
  app.get(
    "/proposals/:id/votes",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const key = `proposal_votes:${id}`;
      try {
        const data = await cached(key, TTL.proposalVotes, async () => {
          const result = await pool.query(
            "SELECT * FROM votes WHERE proposal_id = $1 ORDER BY created_at DESC",
            [id],
          );
          return { votes: result.rows };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates?limit=20&offset=0
  app.get("/delegates", strictLimiter, async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const key = `delegates:${limit}:${offset}`;
    try {
      const data = await cached(key, TTL.delegates, async () => {
        const [countResult, result] = await Promise.all([
          pool.query(
            `WITH latest_delegations AS (
              SELECT DISTINCT ON (delegator) delegator, new_delegatee
              FROM delegates
              ORDER BY delegator, ledger DESC
            )
            SELECT COUNT(DISTINCT new_delegatee)::int AS total FROM latest_delegations`
          ),
          pool.query(
            `WITH latest_delegations AS (
              SELECT DISTINCT ON (delegator) delegator, new_delegatee
              FROM delegates
              ORDER BY delegator, ledger DESC
            )
            SELECT new_delegatee AS address, COUNT(*)::int AS delegator_count
            FROM latest_delegations
            GROUP BY new_delegatee
            ORDER BY delegator_count DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset],
          ),
        ]);
        const total = countResult.rows[0]?.total ?? 0;
        return {
          delegates: result.rows,
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /profile/:address
  app.get(
    "/profile/:address",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      // Validate before querying to avoid malformed input reaching the database.
      const normalizedAddress = req.params.address.trim().toUpperCase();
      if (!isValidStellarPublicKey(normalizedAddress)) {
        res.status(400).json({ error: INVALID_ADDRESS_ERROR });
        return;
      }

      const address = normalizedAddress;
      const key = `profile:${address}`;
      try {
        const data = await cached(key, TTL.profile, async () => {
          const [
            proposalsRes,
            votesRes,
            delegationsRes,
            wrapperDepositsRes,
            wrapperWithdrawalsRes,
          ] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM proposals WHERE proposer = $1", [
              address,
            ]),
            pool.query(
              "SELECT COUNT(*), SUM(weight) FROM votes WHERE voter = $1",
              [address],
            ),
            pool.query(
              "SELECT new_delegatee FROM delegates WHERE delegator = $1 ORDER BY ledger DESC LIMIT 1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_deposits WHERE account = $1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_withdrawals WHERE account = $1",
              [address],
            ),
          ]);

          const depositTotal = BigInt(wrapperDepositsRes.rows[0]?.sum ?? 0);
          const withdrawalTotal = BigInt(
            wrapperWithdrawalsRes.rows[0]?.sum ?? 0,
          );
          const wrappedBalance = depositTotal - withdrawalTotal;

          return {
            address,
            proposalsCreated: Number(proposalsRes.rows[0].count),
            votescast: Number(votesRes.rows[0].count),
            totalVotingPowerUsed: String(votesRes.rows[0].sum ?? 0),
            currentDelegatee: delegationsRes.rows[0]?.new_delegatee ?? address,
            wrapper: {
              depositTotal: depositTotal.toString(),
              withdrawalTotal: withdrawalTotal.toString(),
              wrappedBalance: wrappedBalance.toString(),
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/deposits?account=G...&limit&offset
  app.get(
    "/wrapper/deposits",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_deposits ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/withdrawals?account=G...&limit&offset
  app.get(
    "/wrapper/withdrawals",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_withdrawals ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury/transfers?limit&offset — paginated treasury batch transfer history
  app.get(
    "/treasury/transfers",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM treasury_transfers ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /config-history?limit&offset — paginated list of config updates
  app.get(
    "/config-history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM config_updates ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /upgrade-history?limit&offset — paginated list of governor upgrades
  app.get(
    "/upgrade-history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM governor_upgrades ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /leaderboard/voters?limit=20&offset=0 — voters ranked by participation count
  app.get(
    "/leaderboard/voters",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      const key = `leaderboard:voters:${limit}:${offset}`;

      try {
        const data = await cached(key, TTL.delegates, async () => {
          const result = await pool.query(
            `SELECT
              voter,
              COUNT(*)::int AS proposals_voted,
              SUM(weight)::bigint AS total_voting_weight,
              SUM(CASE WHEN support = 1 THEN 1 ELSE 0 END)::int AS for_count,
              SUM(CASE WHEN support = 0 THEN 1 ELSE 0 END)::int AS against_count,
              SUM(CASE WHEN support = 2 THEN 1 ELSE 0 END)::int AS abstain_count
            FROM votes
            GROUP BY voter
            ORDER BY proposals_voted DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset],
          );

          // Get total count
          const countResult = await pool.query(
            `SELECT COUNT(DISTINCT voter)::int AS total FROM votes`,
          );
          const total = countResult.rows[0]?.total ?? 0;

          return {
            voters: result.rows,
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          };
        });

        res.json(data);
      } catch (error) {
        console.error("Leaderboard voters error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return app;
}
