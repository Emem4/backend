import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

// All timestamp columns are `timestamptz` (#178): every row this app has
// ever written was produced by `defaultNow()` or `new Date()` on a
// connection running in UTC (see drizzle/0020_timestamptz.sql), so the
// historical `timestamp without time zone` values are UTC wall-clock times.
// The migration reinterprets them as such (`AT TIME ZONE 'UTC'`) rather than
// the session's zone, which is what makes the conversion lossless.
export const resourceTypeEnum = pgEnum("resource_type", ["file", "link"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "skipped",
  // Held for a human admin decision (low confidence / injection hold) (#188).
  "review_required",
]);

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "settled",
  "failed",
]);

export const thumbnailStatusEnum = pgEnum("thumbnail_status_enum", [
  "none",
  "pending",
  "ready",
  "failed",
]);

export const resourceScanStatusEnum = pgEnum("resource_scan_status", [
  "pending",
  "clean",
  "infected",
]);

// Publishers — humans or AI agents that publish resources
export const publishers = pgTable(
  "publishers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    walletAddress: text("wallet_address").notNull(),
    apiKeyHash: text("api_key_hash").notNull(),
    // Per-publisher rate limit in requests per minute. Null means the global
    // default applies.
    rateLimitRpm: integer("rate_limit_rpm"),
    // Webhook delivery configuration. Nullable so publishers can opt in later.
    webhookUrl: text("webhook_url"),
    // Encrypted with WEBHOOK_ENCRYPTION_KEY as `v1:<keyId>:<base64>` (legacy
    // rows may be un-prefixed ciphertext or plaintext) — see src/utils/crypto.ts.
    webhookSecret: text("webhook_secret"),
    // Subscribed WebhookEvent values; null/empty means all events.
    webhookEvents: text("webhook_events").array(),
    webhookEnabled: boolean("webhook_enabled").notNull().default(false),
    // Per-publisher HMAC signing secret (shown once on creation/rotation, stored
    // encrypted). Used by requestSignatureAuth (#42) instead of the raw API key
    // so possession of the key alone is insufficient to forge a valid signature.
    // Stored as `v1:<keyId>:<base64>` so keys rotate without an atomic rewrite.
    signingSecret: text("signing_secret"),
    // Set when the publisher rotates their API key. Any key whose hash matches
    // a row with a non-null api_key_revoked_at is rejected by apiKeyAuth (#40).
    apiKeyRevokedAt: timestamp("api_key_revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Every authenticated request looks up a publisher by api_key_hash.
    // The unique index makes that lookup O(log n) instead of a sequential
    // scan, and also enforces hash uniqueness at the DB level (#41).
    apiKeyHashIdx: uniqueIndex("idx_publishers_api_key_hash").on(table.apiKeyHash),
  }),
);

// Resources — digital assets published on the marketplace
export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    title: text("title").notNull(),
    description: text("description"),
    price: text("price").notNull(),
    walletAddress: text("wallet_address").notNull(),
    // A resource's type and backing location must agree (#175). There are
    // exactly three valid shapes (documented in docs/resource-lifecycle.md):
    //   staged file    — file / storage_path NULL / external_url NULL
    //   finalized file — file / storage_path set / external_url NULL
    //   link           — link / storage_path NULL / external_url set
    // `storagePath` is nullable only so an upload can pass through the staged
    // shape before its object is written; a link is created already finalized.
    resourceType: resourceTypeEnum("resource_type").notNull(),
    storagePath: text("storage_path"),
    thumbnailPath: text("thumbnail_path"),
    // Thumbnail generation state so the background worker can pick up
    // resources that still need a thumbnail (#89).
    thumbnailStatus: thumbnailStatusEnum("thumbnail_status").notNull().default("none"),
    // Transient-storage-fault retries so far; corrupt/unsupported images skip
    // this and fail immediately instead of incrementing it (#167).
    thumbnailAttempts: integer("thumbnail_attempts").notNull().default(0),
    contentHash: text("content_hash"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    // Files remain unavailable until a configured scanner marks them clean.
    scanStatus: resourceScanStatusEnum("scan_status").notNull().default("pending"),
    // Retained object size in bytes (#234). Persisted so per-publisher storage
    // quota accounting can be reconciled against actual stored objects.
    sizeBytes: integer("size_bytes"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationId: text("verification_id"),
    // Monotonic per-resource verification generation (#183). Each new check
    // claims the next value; a check may only write its verdict while the
    // resource still carries the generation it claimed, so a slow older check
    // can't overwrite a newer verdict or verificationId.
    verificationGeneration: integer("verification_generation").notNull().default(0),
    listed: boolean("listed").notNull().default(false),
    // Set when an administrator delists the resource. Publisher-initiated
    // delists leave it null. Blocks relisting via POST /verify-content (#18).
    adminDelistedAt: timestamp("admin_delisted_at", { withTimezone: true }),
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    // Number of on-chain registration attempts made so far. Persisted so the
    // retry budget survives worker restarts (#84). Also doubles as a fencing
    // token (#164): retryResource() conditions its terminal writes on this
    // value staying unchanged, so a write from a call that outlived its
    // timeout can't clobber a newer attempt's state.
    onchainAttempts: integer("onchain_attempts").notNull().default(0),
    // Set when onchainStatus transitions to "pending". The retry worker uses
    // this (not createdAt) for its cutoff so a freshly pending old resource
    // isn't retried before a live registration can finish (#82).
    onchainPendingSince: timestamp("onchain_pending_since", { withTimezone: true }),
    // Tags set on-chain via SET_TAGS events (#103). Null means never synced.
    tags: text("tags").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    catalogFilterSortIdx: index("idx_resources_catalog_filter_sort").on(
      table.listed,
      table.verificationStatus,
      table.createdAt,
    ),
    // Catalog tag filtering (#222): exact-match containment queries
    // (`tags @> ARRAY[...]`) on the tags array are served by this GIN index.
    tagsGinIdx: index("idx_resources_tags_gin").using("gin", table.tags),
    // Publisher dashboards list a single publisher's resources (#285).
    publisherIdx: index("idx_resources_publisher_id").on(table.publisherId),
    // Verification-status filters that aren't anchored to `listed` can't use the
    // composite catalog index, so they get their own (#285).
    verificationStatusIdx: index("idx_resources_verification_status").on(table.verificationStatus),
    // The thumbnail worker polls for resources awaiting generation (#89).
    thumbnailStatusIdx: index("idx_resources_thumbnail_status").on(table.thumbnailStatus),
    // The stale-registration query filters on status + pending-since and
    // orders oldest-first with id as a tiebreaker; this composite index
    // covers both the filter and the sort (#169).
    stuckRegistrationIdx: index("idx_resources_stuck_registration").on(
      table.onchainStatus,
      table.onchainPendingSince,
      table.id,
    ),
    // Retry-state assumption: attempts never go negative (#177).
    onchainAttemptsNonNegative: check(
      "resources_onchain_attempts_nonneg",
      sql`${table.onchainAttempts} >= 0`,
    ),
    thumbnailAttemptsNonNegative: check(
      "resources_thumbnail_attempts_nonneg",
      sql`${table.thumbnailAttempts} >= 0`,
    ),
    // Generation is a monotonic counter (#183).
    verificationGenerationNonNegative: check(
      "resources_verification_generation_nonneg",
      sql`${table.verificationGeneration} >= 0`,
    ),
    // Retained byte sizes can't be negative (#234).
    sizeBytesNonNegative: check(
      "resources_size_bytes_nonneg",
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    // #175: enforce the documented resource shapes in Postgres so no caller can
    // persist an impossible combination (e.g. a link with a stored object, or a
    // file with an external URL). The first branch is the short-lived staged
    // upload state; the other two are finalized rows.
    backingShapeValid: check(
      "resources_backing_shape_valid",
      sql`(
        (${table.resourceType} = 'file' AND ${table.storagePath} IS NULL AND ${table.externalUrl} IS NULL)
        OR (${table.resourceType} = 'file' AND ${table.storagePath} IS NOT NULL AND ${table.externalUrl} IS NULL)
        OR (${table.resourceType} = 'link' AND ${table.storagePath} IS NULL AND ${table.externalUrl} IS NOT NULL)
      )`,
    ),
  }),
);

// Durable antivirus scan jobs. Pending jobs survive process restarts and keep
// retry scheduling state in Postgres.
export const resourceScanJobs = pgTable(
  "resource_scan_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .unique()
      .references(() => resources.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    statusNextIdx: index("idx_resource_scan_jobs_status_next").on(
      table.status,
      table.nextAttemptAt,
    ),
    attemptsNonNegative: check("resource_scan_jobs_attempts_nonneg", sql`${table.attempts} >= 0`),
    statusValid: check(
      "resource_scan_jobs_status_valid",
      sql`${table.status} IN ('pending', 'completed')`,
    ),
  }),
);

// Catalog version token (#224). A single row holds a monotonically increasing
// counter bumped on every catalog/metadata mutation. Replicas compare their
// locally cached version against this shared token to detect remote
// invalidations instead of waiting for TTL expiry.
export const catalogVersion = pgTable(
  "catalog_version",
  {
    // Fixed singleton key so exactly one row exists.
    id: text("id").primaryKey().default("global"),
    // Monotonic token; bumped on every catalog/metadata mutation.
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    versionNonNegative: check("catalog_version_version_nonneg", sql`${table.version} >= 0`),
  }),
);

// Per-publisher storage accounting (#234). One row per publisher tracks bytes
// reserved by in-flight uploads and bytes retained by stored objects, so the
// quota gate is shared across replicas and concurrent uploads can't overshoot.
export const publisherStorageUsage = pgTable(
  "publisher_storage_usage",
  {
    publisherId: text("publisher_id")
      .primaryKey()
      .references(() => publishers.id),
    // Bytes reserved by uploads that have not yet committed or released.
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    // Bytes retained by successfully stored objects.
    usedBytes: integer("used_bytes").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    reservedBytesNonNegative: check(
      "publisher_storage_usage_reserved_nonneg",
      sql`${table.reservedBytes} >= 0`,
    ),
    usedBytesNonNegative: check(
      "publisher_storage_usage_used_nonneg",
      sql`${table.usedBytes} >= 0`,
    ),
  }),
);

// Storage reservations (#234). Each in-flight upload reserves bytes before the
// storage write; the reservation is committed (moved to used) on success or
// released on failure.
export const storageReservations = pgTable(
  "storage_reservations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    resourceId: text("resource_id").references(() => resources.id),
    // Bytes reserved for this upload.
    bytes: integer("bytes").notNull(),
    // "reserved" while in flight, "committed" once stored, "released" on failure.
    status: text("status").notNull().default("reserved"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    publisherStatusIdx: index("idx_storage_reservations_publisher_status").on(
      table.publisherId,
      table.status,
    ),
    bytesPositive: check("storage_reservations_bytes_positive", sql`${table.bytes} > 0`),
  }),
);

// Pending cleanups — storage deletes that failed and must be retried later.
// Populated by `delistResource` when the DB update succeeds but the storage
// delete fails (#87).
export const pendingCleanup = pgTable(
  "pending_cleanup",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    storagePath: text("storage_path").notNull(),
    resourceId: text("resource_id").references(() => resources.id),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The cleanup worker polls the earliest due jobs first.
    createdAtIdx: index("idx_pending_cleanup_created_at").on(table.createdAt),
    nextAttemptAtIdx: index("idx_pending_cleanup_next_attempt").on(
      table.nextAttemptAt,
      table.createdAt,
    ),
    attemptsNonNegative: check("pending_cleanup_attempts_nonneg", sql`${table.attempts} >= 0`),
  }),
);

// Verifications — AI originality check results
export const verifications = pgTable(
  "verifications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    isOriginal: boolean("is_original").notNull(),
    confidence: real("confidence").notNull(), // 0.0 - 1.0
    flags: text("flags"), // JSON stringified array of issues
    // Token usage + estimated spend for the verification model call (#283).
    // Nullable so historical rows predating usage tracking remain valid.
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCost: text("estimated_cost"), // USD, stringified for precision
    // Review-input contract the verdict was produced under (#189); null on legacy rows.
    inputContractVersion: text("input_contract_version"),
    // Provenance of the verdict (#185): which model produced it and which
    // immutable prompt/policy version was in force. Null on legacy rows so
    // historical verdicts stay readable; reporting can group by these.
    model: text("model"),
    promptVersion: text("prompt_version"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // /agent/status fetches the most recent verifications for its activity
    // list, and aggregate queries filter/order by recency (#98).
    checkedAtIdx: index("idx_verifications_checked_at").on(table.checkedAt),
    // Verification lookups by resource (#107).
    resourceIdIdx: index("idx_verifications_resource_id").on(table.resourceId),
    // Spend reporting groups new verdicts by model and prompt version (#185).
    modelPromptVersionIdx: index("idx_verifications_model_prompt_version").on(
      table.model,
      table.promptVersion,
    ),
    // Confidence is a probability; token counts can't be negative (#176).
    confidenceRange: check(
      "verifications_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    promptTokensNonNegative: check(
      "verifications_prompt_tokens_nonneg",
      sql`${table.promptTokens} IS NULL OR ${table.promptTokens} >= 0`,
    ),
    completionTokensNonNegative: check(
      "verifications_completion_tokens_nonneg",
      sql`${table.completionTokens} IS NULL OR ${table.completionTokens} >= 0`,
    ),
    totalTokensNonNegative: check(
      "verifications_total_tokens_nonneg",
      sql`${table.totalTokens} IS NULL OR ${table.totalTokens} >= 0`,
    ),
  }),
);

// Daily verification spend budget (#186). One row per UTC day holds the
// reserved (in-flight) and consumed (settled) spend so the budget gate is
// shared across replicas and concurrent requests can't overspend.
export const verificationSpendBudget = pgTable(
  "verification_spend_budget",
  {
    // UTC day, formatted YYYY-MM-DD.
    budgetDate: text("budget_date").primaryKey(),
    // Reserved spend for checks that have started but not yet settled, USD.
    reservedSpend: text("reserved_spend").notNull().default("0"),
    // Consumed spend for completed checks, USD.
    consumedSpend: text("consumed_spend").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Amounts are non-negative decimal strings; the cast fails on garbage.
    reservedSpendNonNegative: check(
      "verification_spend_budget_reserved_nonneg",
      sql`${table.reservedSpend}::numeric >= 0`,
    ),
    consumedSpendNonNegative: check(
      "verification_spend_budget_consumed_nonneg",
      sql`${table.consumedSpend}::numeric >= 0`,
    ),
  }),
);

// Payments — tracks x402 payments for resources
export const payments = pgTable(
  "payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    payerAddress: text("payer_address").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    amount: text("amount").notNull(), // USDC amount
    // Set when the payment was a /verify-content fee rather than a purchase;
    // agent earnings are summed from these rows (#99).
    verificationId: text("verification_id").references(() => verifications.id),
    // Delivery state of the purchased content: "delivered" once the file was
    // served, "undelivered" when the download failed after payment (#86),
    // "pending" while streaming, "aborted" if the response closed early (#194).
    deliveryStatus: text("delivery_status").notNull().default("delivered"),
    // Settlement state of the payment. Only settled payments count toward
    // earnings (#99).
    status: paymentStatusEnum("status").notNull().default("pending"),
    // Purchase snapshot — what was bought and on what terms, frozen at
    // purchase time so receipts survive later resource edits. NULL
    // receipt_version marks a legacy row recorded before snapshots existed;
    // those are never back-filled (see src/lib/purchaseSnapshot.ts).
    receiptVersion: integer("receipt_version"),
    network: text("network"),
    asset: text("asset"),
    resourceTitle: text("resource_title"),
    resourceType: text("resource_type"),
    resourceContentHash: text("resource_content_hash"),
    paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
    // Stable settlement identity: sha256 of the x402 payment authorization
    // header (covers v1/v2 payloads). Unique so replays/retries can't count
    // one settlement twice (#192). Null for legacy rows.
    settlementKey: text("settlement_key"),
    // Chain transaction / facilitator reference of the settlement (#190).
    settlementTxHash: text("settlement_tx_hash"),
    settlementNetwork: text("settlement_network"),
    // Failure classification only; never payment authorization material (#190).
    settlementFailureReason: text("settlement_failure_reason"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    settlementKeyUnique: uniqueIndex("uq_payments_settlement_key").on(table.settlementKey),
    // Reconciliation scans pending rows by age (#191).
    pendingIdx: index("idx_payments_pending_paid_at").on(table.paidAt).where(sql`${table.status} = 'pending'`),
    // Payment history is queried per payer wallet (#285).
    payerAddressIdx: index("idx_payments_payer_address").on(table.payerAddress),
    // Publisher analytics aggregate per resource (#100), and analytics and
    // delist lookups filter payments by resource (#107).
    resourceIdIdx: index("idx_payments_resource_id").on(table.resourceId),
    // Agent-status earnings sum per recipient (#99).
    recipientAddressIdx: index("idx_payments_recipient_address").on(table.recipientAddress),
    // Admin reconciliation filters exceptions by settlement / delivery state
    // and orders oldest-first.
    statusPaidAtIdx: index("idx_payments_status_paid_at").on(table.status, table.paidAt),
    deliveryStatusPaidAtIdx: index("idx_payments_delivery_status_paid_at").on(
      table.deliveryStatus,
      table.paidAt,
    ),
  }),
);

// Failed events — on-chain events whose handler threw, kept for retry so the
// listener checkpoint can stop before them without losing the event (#101).
export const failedEvents = pgTable(
  "failed_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    eventId: text("event_id").notNull(),
    ledger: integer("ledger").notNull(),
    topic: text("topic").notNull(),
    payload: text("payload").notNull(), // JSON stringified event payload
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    eventIdIdx: index("idx_failed_events_event_id").on(table.eventId),
    ledgerIdx: index("idx_failed_events_ledger").on(table.ledger),
    attemptsNonNegative: check("failed_events_attempts_nonneg", sql`${table.attempts} >= 0`),
  }),
);

// Ledger checkpoints — durable event-listener progress (#105).
// Stored in Postgres so the listener resumes from the last processed ledger
// even when the container is recreated without a persistent volume. The
// on-disk file remains only as a fallback.
export const ledgerCheckpoints = pgTable("ledger_checkpoints", {
  // Registry contract the checkpoint belongs to, so switching contracts never
  // resumes from another contract's ledger.
  contractId: text("contract_id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Moderation events — immutable audit log of admin actions on resources (#50).
// Written whenever an admin delists a resource so the action is reviewable later.
export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    // The resource that was acted upon.
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    // The moderation action taken (e.g. "admin_delist").
    action: text("action").notNull(),
    // Optional free-text reason supplied by the admin.
    reason: text("reason"),
    // Identifier of the actor (admin key digest or "admin" when unset).
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Fast lookup of all moderation events for a given resource.
    resourceIdIdx: index("idx_moderation_events_resource_id").on(table.resourceId),
  }),
);

// Idempotency records shared across replicas (#71).
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    key: text("key").primaryKey(),
    record: jsonb("record").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // The expiry sweep selects expired keys ordered by expires_at in bounded
    // batches (#173); this index keeps that scan cheap as the table grows.
    expiresAtIdx: index("idx_idempotency_records_expires_at").on(table.expiresAt),
  }),
);

// Webhook outbox — persists pending deliveries so they survive restarts (#48).
// A background worker picks them up and retries with exponential backoff.
export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    // pending → being retried, delivered → success, failed → exhausted attempts
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    // Stable delivery ID echoed in X-SynapsVault-Id (#45).
    deliveryId: text("delivery_id"),
    // Worker polls for rows where next_attempt_at <= now() and status = 'pending'.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Worker polls pending rows ordered by next_attempt_at.
    statusNextIdx: index("idx_webhook_outbox_status_next").on(table.status, table.nextAttemptAt),
    // Publisher delivery-history endpoint queries by publisher_id + created_at.
    publisherIdIdx: index("idx_webhook_outbox_publisher_id").on(table.publisherId, table.createdAt),
    // Retention cleanup queries terminal rows by status and delivered_at (#157).
    statusDeliveredIdx: index("idx_webhook_outbox_status_delivered").on(table.status, table.deliveredAt),
    attemptsNonNegative: check("webhook_outbox_attempts_nonneg", sql`${table.attempts} >= 0`),
    maxAttemptsPositive: check("webhook_outbox_max_attempts_positive", sql`${table.maxAttempts} > 0`),
  }),
);
