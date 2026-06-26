import request from "supertest";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { createApp } from "../api";
import { pool } from "../db";

// Mock the database
jest.mock("../db", () => ({
  pool: {
    query: jest.fn(),
  },
}));

// Mock the cache module
jest.mock("../cache", () => ({
  cached: jest.fn((key, ttl, fn) => fn()),
  getMetrics: jest.fn(() => ({ hits: 0, misses: 0, size: 0 })),
}));

// Mock the events module
jest.mock("../events", () => ({
  getLastIndexedLedger: jest.fn(() => Promise.resolve(1000)),
}));

// Mock the index module
jest.mock("../index", () => ({
  startTime: Date.now() - 60000, // 1 minute ago
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe("API Endpoints", () => {
  let app: any;
  let mockServer: SorobanRpc.Server;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock SorobanRpc.Server
    mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1050 }),
    } as any;
    
    app = createApp(mockServer);
  });

  describe("GET /config-history", () => {
    it("should return paginated config update history", async () => {
      const mockRows = [
        {
          id: 2,
          ledger: 120,
          old_settings: { voting_delay: 1 },
          new_settings: { voting_delay: 2 },
          ledger_closed_at: "2026-06-01T12:00:00Z",
          created_at: "2026-06-01T12:00:05Z",
        },
        {
          id: 1,
          ledger: 100,
          old_settings: { voting_delay: 0 },
          new_settings: { voting_delay: 1 },
          ledger_closed_at: "2026-05-30T09:00:00Z",
          created_at: "2026-05-30T09:00:03Z",
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: mockRows,
        rowCount: mockRows.length,
      });

      const response = await request(app).get("/config-history?limit=2&offset=0");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockRows);
      expect(response.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM config_updates ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2",
        [2, 0],
      );
    });

    it("should return 500 on database error", async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error("Database error"));

      const response = await request(app).get("/config-history");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });
  });

  describe("GET /proposals/:id", () => {
    it("should return a proposal when found", async () => {
      const mockProposal = {
        id: 5,
        proposer: "GABC123...",
        description: "Fund the security audit",
        start_ledger: 54000,
        end_ledger: 54500,
        votes_for: 12000,
        votes_against: 3000,
        votes_abstain: 500,
        executed: false,
        cancelled: false,
        queued: false,
        created_at: "2026-04-20T10:00:00Z",
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [mockProposal],
        rowCount: 1,
      });

      const response = await request(app).get("/proposals/5");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockProposal);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM proposals WHERE id = $1",
        [5]
      );
    });

    it("should return 404 when proposal not found", async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const response = await request(app).get("/proposals/999");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Proposal not found" });
    });

    it("should return 400 for invalid proposal ID", async () => {
      const response = await request(app).get("/proposals/invalid");

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid proposal ID" });
    });

    it("should return 400 for negative proposal ID", async () => {
      const response = await request(app).get("/proposals/-1");

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid proposal ID" });
    });

    it("should return 500 on database error", async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error("Database error"));

      const response = await request(app).get("/proposals/5");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });
  });

  describe("GET /stats", () => {
    it("should return governance stats", async () => {
      const mockStats = {
        total_proposals: 47,
        active_proposals: 3,
        total_votes_cast: 1204,
        unique_voters: 89,
        total_delegates: 34,
        participation_rate: 0.42,
        last_updated: "2026-04-25T08:00:00Z",
      };

      const mockServer = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1050 }),
      } as any;

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 47 }] })
        .mockResolvedValueOnce({ rows: [{ count: 3 }] })
        .mockResolvedValueOnce({ rows: [{ count: 1204 }] })
        .mockResolvedValueOnce({ rows: [{ count: 89 }] })
        .mockResolvedValueOnce({ rows: [{ count: 34 }] })
        .mockResolvedValueOnce({ rows: [{ total: 5000, count: 10 }] });

      const statsApp = createApp(mockServer);
      const response = await request(statsApp).get("/stats");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total_proposals: 47,
        active_proposals: 3,
        total_votes_cast: 1204,
        unique_voters: 89,
        total_delegates: 34,
        participation_rate: 0.42,
      });
      expect(response.body.last_updated).toBeDefined();
    });

    it("should return participation_rate as 0 when no executed proposals", async () => {
      const mockServer = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1050 }),
      } as any;

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ count: 10 }] })
        .mockResolvedValueOnce({ rows: [{ count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ total: 0, count: 0 }] });

      const statsApp = createApp(mockServer);
      const response = await request(statsApp).get("/stats");

      expect(response.status).toBe(200);
      expect(response.body.participation_rate).toBe(0);
    });

    it("should return 500 on database error", async () => {
      const mockServer = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1050 }),
      } as any;

      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error("Database error"));

      const statsApp = createApp(mockServer);
      const response = await request(statsApp).get("/stats");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });
  });

describe("GET /proposals with cursor pagination", () => {
    const mockProposals = [
      { id: 47, description: "Proposal 47" },
      { id: 46, description: "Proposal 46" },
      { id: 45, description: "Proposal 45" },
    ];

    it("should return proposals with cursor pagination (before)", async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: mockProposals,
          rowCount: 3,
        })
        .mockResolvedValueOnce({
          rows: [{ id: 44 }], // hasMore check
          rowCount: 1,
        });

      const response = await request(app).get("/proposals?before=47&limit=3");

      expect(response.status).toBe(200);
      expect(response.body.proposals).toEqual(mockProposals);
      expect(response.body.nextCursor).toBe(45);
      expect(response.body.prevCursor).toBe(47);
      expect(response.body.hasMore).toBe(true);
    });

    it("should return proposals with cursor pagination (after)", async () => {
      const reversedProposals = [...mockProposals].reverse();
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: reversedProposals, // Will be reversed back
          rowCount: 3,
        })
        .mockResolvedValueOnce({
          rows: [{ id: 48 }], // hasMore check
          rowCount: 1,
        });

      const response = await request(app).get("/proposals?after=44&limit=3");

      expect(response.status).toBe(200);
      expect(response.body.proposals).toEqual(mockProposals);
      expect(response.body.hasMore).toBe(true);
    });

    it("should fall back to offset pagination when no cursor provided", async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: mockProposals,
        rowCount: 3,
      });

      const response = await request(app).get("/proposals?offset=0&limit=3");

      expect(response.status).toBe(200);
      expect(response.body.proposals).toEqual(mockProposals);
      expect(response.body.total).toBe(3);
      expect(response.body.nextCursor).toBeUndefined();
    });

    it("should handle hasMore=false when no more results", async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: mockProposals,
          rowCount: 3,
        })
        .mockResolvedValueOnce({
          rows: [], // No more results
          rowCount: 0,
        });

      const response = await request(app).get("/proposals?before=47&limit=3");

      expect(response.status).toBe(200);
      expect(response.body.hasMore).toBe(false);
    });

    it("should return 500 on database error", async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error("Database error"));

      const response = await request(app).get("/proposals?before=47&limit=3");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting tests (issue #437)
// ---------------------------------------------------------------------------
describe("Rate limiting", () => {
  /**
   * Each test creates a fresh app instance so the in-process rate-limit
   * store is reset between test cases.
   *
   * NOTE: The general limiter allows 100 req / 15 min and the strict limiter
   * allows 30 req / 15 min.  We exhaust each by sending one extra request
   * beyond the limit and asserting the final response is HTTP 429.
   */
  let rateLimitApp: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const freshServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1050 }),
    } as any;
    rateLimitApp = createApp(freshServer);

    // Default mock so route handlers don't throw on DB calls.
    (pool.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("should include X-RateLimit-* headers on normal requests", async () => {
    const response = await request(rateLimitApp)
      .get("/proposals/1")
      .set("X-Forwarded-For", "192.0.2.1");

    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(response.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("should return 429 after exceeding the general rate limit (100 req/15 min)", async () => {
    const responses: number[] = [];
    for (let i = 0; i <= 100; i++) {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const r = await request(rateLimitApp)
        .get("/proposals/1")
        .set("X-Forwarded-For", "192.0.2.10");
      responses.push(r.status);
    }

    // The 101st request (index 100) must be rate-limited.
    expect(responses[100]).toBe(429);
    // All earlier requests must not be 429.
    expect(responses.slice(0, 100).every((s) => s !== 429)).toBe(true);
  });

  it("should return 429 with Retry-After header when rate limited", async () => {
    for (let i = 0; i <= 100; i++) {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await request(rateLimitApp)
        .get("/proposals/1")
        .set("X-Forwarded-For", "192.0.2.11");
    }

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const limited = await request(rateLimitApp)
      .get("/proposals/1")
      .set("X-Forwarded-For", "192.0.2.11");

    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.body.error).toMatch(/too many requests/i);
  });

  it("should apply stricter limit (30 req/15 min) to /delegates", async () => {
    const responses: number[] = [];
    for (let i = 0; i <= 30; i++) {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const r = await request(rateLimitApp)
        .get("/delegates")
        .set("X-Forwarded-For", "192.0.2.20");
      responses.push(r.status);
    }

    expect(responses[30]).toBe(429);
    expect(responses.slice(0, 30).every((s) => s !== 429)).toBe(true);
  });

  it("should apply stricter limit (30 req/15 min) to /profile/:address", async () => {
    const responses: number[] = [];
    for (let i = 0; i <= 30; i++) {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [{ count: "0", sum: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ sum: "0" }] })
        .mockResolvedValueOnce({ rows: [{ sum: "0" }] });
      const r = await request(rateLimitApp)
        .get("/profile/GABC123")
        .set("X-Forwarded-For", "192.0.2.21");
      responses.push(r.status);
    }

    expect(responses[30]).toBe(429);
    expect(responses.slice(0, 30).every((s) => s !== 429)).toBe(true);
  });

  it("should track rate limits independently per IP address", async () => {
    // Exhaust the limit for IP A.
    for (let i = 0; i <= 100; i++) {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await request(rateLimitApp)
        .get("/proposals/1")
        .set("X-Forwarded-For", "192.0.2.30");
    }

    // IP B should still be within its own limit.
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const ipBResponse = await request(rateLimitApp)
      .get("/proposals/1")
      .set("X-Forwarded-For", "192.0.2.31");

    expect(ipBResponse.status).not.toBe(429);
  });
});
