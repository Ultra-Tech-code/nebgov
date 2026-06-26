import request from "supertest";
import app from "../index";
import pool from "../db/pool";
import jwt from "jsonwebtoken";

describe("Notification Endpoints", () => {
  let authToken: string;
  let userId: number;

  beforeAll(async () => {
    const userResult = await pool.query(
      "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
      ["GTESTNOTIFY123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    );
    userId = userResult.rows[0].id;
    authToken = jwt.sign(
      { userId, walletAddress: "GTESTNOTIFY123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      process.env.JWT_SECRET!,
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM notification_history WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM notification_preferences WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  });

  it("GET /notifications/preferences returns defaults when missing", async () => {
    const res = await request(app)
      .get("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("created_self", true);
    expect(res.body).toHaveProperty("active", true);
  });

  it("POST /notifications/preferences upserts preferences", async () => {
    const res = await request(app)
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ active: false, executed: true })
      .expect(200);

    expect(res.body.active).toBe(false);

    const res2 = await request(app)
      .get("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(res2.body.active).toBe(false);
    expect(res2.body.executed).toBe(true);
  });

  it("POST /notifications creates a history entry, GET returns it", async () => {
    const created = await request(app)
      .post("/notifications")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        type: "active",
        proposal_id: 123,
        message: "Proposal is active",
      })
      .expect(201);

    expect(created.body).toHaveProperty("id");
    expect(created.body.read).toBe(false);

    const res = await request(app)
      .get("/notifications?limit=50&offset=0")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty("unread");
    expect(res.body.meta.unread).toBeGreaterThanOrEqual(1);
  });

  it("POST /notifications/mark-read marks all as read", async () => {
    await request(app)
      .post("/notifications")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ type: "queued", proposal_id: 124, message: "Queued" })
      .expect(201);

    const marked = await request(app)
      .post("/notifications/mark-read")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ all: true })
      .expect(200);

    expect(marked.body.unread).toBe(0);
  });

  it("requires authentication", async () => {
    await request(app).get("/notifications").expect(401);
    await request(app).get("/notifications/preferences").expect(401);
    await request(app).post("/notifications/preferences").send({}).expect(401);
  });

  describe("Webhook Endpoints", () => {
    it("POST /notifications/webhook creates a subscription", async () => {
      const res = await request(app)
        .post("/notifications/webhook")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          callback_url: "https://example.com/webhook",
          event_filter: ["queued", "executed"],
        })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.callback_url).toBe("https://example.com/webhook");
      expect(res.body.event_filter).toEqual(["queued", "executed"]);
      expect(res.body.active).toBe(true);
    });

    it("POST /notifications/webhook rejects invalid event filter", async () => {
      await request(app)
        .post("/notifications/webhook")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          callback_url: "https://example.com/webhook",
          event_filter: ["invalid_event"],
        })
        .expect(400);
    });

    it("POST /notifications/webhook requires auth", async () => {
      await request(app)
        .post("/notifications/webhook")
        .send({ callback_url: "https://example.com/webhook" })
        .expect(401);
    });

    afterAll(async () => {
      await pool.query(
        "DELETE FROM webhook_subscriptions WHERE user_id = $1",
        [userId],
      );
    });
  });
});

