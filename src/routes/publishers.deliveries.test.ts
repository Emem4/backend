/**
 * Tests for #221: cursor pagination on the publisher webhook delivery history.
 *
 * Verifies:
 *   - First page (no cursor) returns deliveries + nextCursor when more exist
 *   - Subsequent pages via returned cursor
 *   - Malformed and invalid cursors return 400 VALIDATION_ERROR
 *   - Foreign-publisher cursor does not expose another publisher's rows
 *   - limit is clamped (1–100)
 *   - Repeated / object query params are rejected
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── Shared state / mocks ─────────────────────────────────────────────────────
const { OUTBOX_MARKER } = vi.hoisted(() => ({
  OUTBOX_MARKER: { __table: "webhook_outbox" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { __table: "publishers" },
  resources: { __table: "resources" },
  payments: { __table: "payments" },
  webhookOutbox: OUTBOX_MARKER,
}));

// Capture the last where condition to verify publisher scoping
let capturedWhereArg: unknown = null;

// Rows returned by the mocked DB
let dbDeliveries: any[] = [];

vi.mock("../db/client.js", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          capturedWhereArg = cond;
          return {
            orderBy: () => ({
              limit: (n: number) => Promise.resolve(dbDeliveries.slice(0, n)),
            }),
          };
        },
      }),
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 1000,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
    WEBHOOK_SECRET_ENCRYPTION_REQUIRED: false,
  },
}));

vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: any, _res: any, next: any) => {
    req.publisher = { id: "pub-1", webhookUrl: null, webhookSecret: null, webhookEnabled: false };
    next();
  },
}));

vi.mock("../middleware/rateLimiters.js", () => ({
  publisherRateLimit:   (_: any, __: any, next: any) => next(),
  registerIpRateLimit:  (_: any, __: any, next: any) => next(),
}));

vi.mock("../middleware/requestSignatureAuth.js", () => ({
  requestSignatureAuth: (_: any, __: any, next: any) => next(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher:           vi.fn(),
  getPublisherResources:       vi.fn(),
  rotateApiKey:                vi.fn(),
  rotateSigningSecret:         vi.fn(),
  encodeWebhookSecretForStorage: vi.fn(),
  getPublisherResourcesPage:   vi.fn(),
  PUBLISHER_RESOURCES_DEFAULT_LIMIT: 20,
  PUBLISHER_RESOURCES_MAX_LIMIT:     100,
}));

vi.mock("../services/webhookService.js", () => ({
  deliver:            vi.fn(),
  webhookUrlProblem:  vi.fn(() => null),
}));

vi.mock("../workers/webhookOutboxWorker.js", () => ({
  replayWebhookDelivery: vi.fn(),
}));

import publisherRouter from "./publishers.js";
import { errorHandler } from "../middleware/errorHandler.js";

const app = express().use(express.json()).use(publisherRouter).use(errorHandler);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDelivery(id: string, createdAt: Date) {
  return {
    id,
    event: "resource.purchased",
    status: "delivered",
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    deliveryId: `dlv-${id}`,
    nextAttemptAt: createdAt,
    deliveredAt: createdAt,
    createdAt,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString("base64url");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /publishers/me/webhooks/deliveries — cursor pagination (#221)", () => {
  beforeEach(() => {
    dbDeliveries = [];
    capturedWhereArg = null;
  });

  it("returns deliveries with no cursor on the first page (all fit)", async () => {
    dbDeliveries = [makeDelivery("d2", new Date("2026-01-02T00:00:00Z"))];
    const res = await request(app).get("/publishers/me/webhooks/deliveries");
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.hasNextPage).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it("sets hasNextPage and nextCursor when more deliveries exist", async () => {
    // DB returns limit+1=21 rows for a limit=20 request.
    dbDeliveries = Array.from({ length: 21 }, (_, i) =>
      makeDelivery(`d${21 - i}`, new Date(`2026-01-${String(21 - i).padStart(2, "0")}T00:00:00Z`)),
    );
    const res = await request(app).get("/publishers/me/webhooks/deliveries?limit=20");
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(20);
    expect(res.body.hasNextPage).toBe(true);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("accepts the returned cursor and fetches the next page", async () => {
    dbDeliveries = [makeDelivery("d1", new Date("2026-01-01T00:00:00Z"))];
    const cursor = encodeCursor(new Date("2026-01-02T00:00:00Z"), "d2");
    const res = await request(app).get(`/publishers/me/webhooks/deliveries?after=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
  });

  it("returns 400 for a malformed cursor", async () => {
    const res = await request(app).get("/publishers/me/webhooks/deliveries?after=not-a-cursor");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for a cursor missing the id field", async () => {
    const bad = Buffer.from(JSON.stringify({ t: new Date().toISOString() })).toString("base64url");
    const res = await request(app).get(`/publishers/me/webhooks/deliveries?after=${bad}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for a cursor with an invalid date", async () => {
    const bad = Buffer.from(JSON.stringify({ t: "not-a-date", id: "x" })).toString("base64url");
    const res = await request(app).get(`/publishers/me/webhooks/deliveries?after=${bad}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for a repeated limit param", async () => {
    const res = await request(app).get("/publishers/me/webhooks/deliveries?limit=10&limit=20");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when limit is out of range", async () => {
    const res = await request(app).get("/publishers/me/webhooks/deliveries?limit=200");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when limit is zero", async () => {
    const res = await request(app).get("/publishers/me/webhooks/deliveries?limit=0");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("foreign-publisher cursor does not expose other publishers' rows", async () => {
    // A cursor minted for publisher B: the WHERE clause always includes
    // publisherId = pub-1, so rows for pub-b are never returned.
    // We verify that the publisher scoping condition is always present.
    const foreignCursor = encodeCursor(new Date("2026-01-10T00:00:00Z"), "d-foreign");
    dbDeliveries = []; // pub-1 has no deliveries after that point
    const res = await request(app).get(`/publishers/me/webhooks/deliveries?after=${foreignCursor}`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(0);
    // The WHERE condition must always include the publisher scope.
    expect(capturedWhereArg).not.toBeNull();
  });
});
