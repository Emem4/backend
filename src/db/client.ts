import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import { rootLogger } from "../lib/logger.js";
import { dbPoolTotal, dbQueryDuration, dbPoolAcquireDuration } from "../lib/metrics.js";
import * as schema from "./schema.js";

// ── #214: Locality via URL.hostname ─────────────────────────────────────────
// Use the parsed hostname to decide whether the connection is local so that a
// remote host, username or database name that contains "localhost" or
// "127.0.0.1" as a substring can never accidentally disable TLS.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackUrl(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── #215: Supported DATABASE_URL query options ───────────────────────────────
// Supported options and their precedence rules:
//
//   sslmode — explicitly handled; "disable" / "allow" / "prefer" permit no-TLS
//             on loopback only (for local dev convenience). "require" keeps
//             rejectUnauthorized:true. "verify-ca" / "verify-full" also keep
//             rejectUnauthorized:true. Any value that would disable certificate
//             verification on a non-loopback host is rejected at startup.
//
// All other query parameters (application_name, options, etc.) are silently
// stripped because postgres.js does not forward URL query params and they
// must be set via the config object. Document additional params here as needed.
type SslMode =
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

function parseSslMode(urlString: string): SslMode | null {
  try {
    const { searchParams } = new URL(urlString);
    const raw = searchParams.get("sslmode");
    if (!raw) return null;
    return raw as SslMode;
  } catch {
    return null;
  }
}

/** Strip the query string to get a clean URL for postgres.js. */
function stripQueryString(urlString: string): string {
  try {
    const u = new URL(urlString);
    u.search = "";
    return u.toString();
  } catch {
    return urlString;
  }
}

const rawUrl = config.DATABASE_URL;
const dbUrl = stripQueryString(rawUrl);
const isLocal = isLoopbackUrl(rawUrl);
const explicitSslMode = parseSslMode(rawUrl);

// Reject unsafe sslmode overrides on remote hosts (#215).
const INSECURE_MODES: SslMode[] = ["disable", "allow", "prefer"];
if (!isLocal && explicitSslMode && INSECURE_MODES.includes(explicitSslMode)) {
  const msg =
    `DATABASE_URL sslmode="${explicitSslMode}" disables certificate verification ` +
    `for a non-loopback host. Use sslmode=require, verify-ca, or verify-full.`;
  rootLogger.error({ event: "db_config_insecure_sslmode", sslmode: explicitSslMode }, msg);
  console.error(`[config] ${msg}`);
  process.exit(1);
}

// Determine the effective SSL setting.
// - Local connections: no TLS unless the caller explicitly requests it via
//   sslmode=require / verify-ca / verify-full.
// - Remote connections: TLS with certificate verification by default; a
//   private CA can be supplied via DATABASE_CA_CERT.
const caCert = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");

function resolvessl():
  | false
  | { rejectUnauthorized: boolean; ca?: string } {
  if (isLocal && (!explicitSslMode || INSECURE_MODES.includes(explicitSslMode as SslMode))) {
    return false;
  }
  // require / verify-ca / verify-full (or remote with no sslmode):
  return { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) };
}

// Log sanitized URL for debugging (hide password).
const sanitizedUrl = dbUrl.replace(/:([^:@]+)@/, ":***@");
rootLogger.info({ url: sanitizedUrl, ssl: resolvessl() !== false, isLocal }, "DB connecting");

// ── #219: Query latency and pool-acquisition instrumentation ─────────────────
//
// We measure two distinct durations for every database query:
//
//   db_query_duration_seconds — total round-trip time from when the caller
//     issues the query to when the last result row is received. This includes
//     both pool-acquire wait and actual query execution. High values indicate
//     either pool saturation or slow queries.
//
//   db_pool_acquire_duration_seconds — time from when the caller issues the
//     query to when postgres.js acquires a connection and begins sending the
//     query bytes. High values mean the pool is saturated: all connections
//     are busy and new queries must wait for one to free up.
//
//   The difference (db_query_duration - db_pool_acquire_duration) isolates
//   the wire + execution time from the queuing time, letting you distinguish
//   "slow query" from "pool too small" in dashboards and alerts.
//
// The `operation` label is derived from the first SQL keyword
// (select / insert / update / delete / "other"). This keeps label cardinality
// bounded — never use a row ID or query string as a label value.
//
// Implementation: postgres.js fires `debug(connectionId, query, params, types)`
// synchronously on each connection right before the query bytes are sent to
// Postgres, after pool acquisition. We use a FIFO queue (_pendingAcquire) keyed
// by a monotonically increasing sequence number. The sequence number is
// assigned at the call site, the matching entry is consumed by the debug
// callback in arrival order. Under pool saturation the debug order matches the
// submission order because postgres.js dispatches queued queries FIFO; with an
// idle pool both fire immediately so the FIFO assumption holds trivially.
// This is best-effort: for the purpose of operational metrics, the small
// ordering noise under high concurrency is acceptable.

/** Derive a bounded operation label from the first keyword of a SQL string. */
export function deriveOperation(sql: string): string {
  const first = sql.trimStart().split(/[\s(]/)[0]?.toLowerCase() ?? "";
  switch (first) {
    case "select": return "select";
    case "insert": return "insert";
    case "update": return "update";
    case "delete": return "delete";
    default:       return "other";
  }
}

// FIFO queue: sequence number → wall-clock ms at query submission.
const _pendingAcquire: Array<[number, number]> = [];
let _seq = 0;

const client = postgres(dbUrl, {
  ssl: resolvessl(),
  max: config.DB_POOL_MAX,
  // postgres.js takes these two in seconds; config is in milliseconds.
  idle_timeout: Math.ceil(config.DB_POOL_IDLE_TIMEOUT_MS / 1000),
  connect_timeout: Math.ceil(config.DB_POOL_CONNECT_TIMEOUT_MS / 1000),
  connection: {
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  },
  transform: { undefined: null },
  // debug(connectionId, queryString, params, types) fires after pool
  // acquisition, before the query bytes are written to the wire.
  debug: (_connectionId: number, queryString: string, _params: unknown[], _types: unknown[]) => {
    const acquireEnd = Date.now();
    const entry = _pendingAcquire.shift();
    if (entry) {
      const [, acquireStart] = entry;
      const op = deriveOperation(queryString);
      dbPoolAcquireDuration.observe({ operation: op }, (acquireEnd - acquireStart) / 1000);
    }
  },
});

/**
 * Instrumented wrapper around the raw postgres.js tagged-template call.
 *
 * Records the submission timestamp before handing off to the underlying client,
 * then observes the total round-trip duration once the query settles.
 * The debug callback (registered above) consumes the matching pending entry
 * to record pool-acquire time independently.
 */
function instrumentedQuery(
  strings: TemplateStringsArray,
  ...values: unknown[]
): ReturnType<typeof client> {
  const seq = _seq++;
  const start = Date.now();
  _pendingAcquire.push([seq, start]);

  const result = client(strings, ...values);
  // Cast through any because the postgres.js type for a pending query is a
  // PromiseLike with extra methods; we only need .then/.finally here.
  (result as unknown as Promise<unknown>).finally(() => {
    // If debug already popped the entry we still want total duration.
    // Remove any stale entry for this sequence (should already be gone).
    const idx = _pendingAcquire.findIndex(([s]) => s === seq);
    if (idx !== -1) _pendingAcquire.splice(idx, 1);

    const op = deriveOperation(typeof strings === "object" ? (strings[0] ?? "") : "");
    dbQueryDuration.observe({ operation: op }, (Date.now() - start) / 1000);
  }).catch(() => undefined);

  return result;
}

client`SELECT current_database() as db, current_schema() as schema`.then((rows) => {
  rootLogger.info({ db: rows[0]?.db, schema: rows[0]?.schema }, "DB connected OK");
}).catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  rootLogger.error({
    message: String(e?.message ?? ""),
    code: String(e?.code ?? ""),
    detail: String(e?.detail ?? ""),
    hint: String(e?.hint ?? ""),
    url: sanitizedUrl,
  }, "DB connection FAILED");
});

// Drizzle receives the raw client; it drives the tagged-template calls.
// Direct uses of pgClient (e.g. advisory locks, leader heartbeats in index.ts)
// also go through the raw client — that is intentional since those are
// operational control-plane queries rather than application data queries.
export const db = drizzle(client, { schema });
export const pgClient = client;

// Expose for use in integration tests that want to verify instrumented timing.
export { instrumentedQuery as _instrumentedQuery };

let poolLogInterval: ReturnType<typeof setInterval> | undefined;

export function startPoolMetrics(intervalMs = 30_000): void {
  if (poolLogInterval) return;
  poolLogInterval = setInterval(() => {
    dbPoolTotal.set(config.DB_POOL_MAX);
    rootLogger.debug({ event: "db_pool_stats", max: config.DB_POOL_MAX }, "DB pool stats");
  }, intervalMs);
  poolLogInterval.unref?.();
}

export function stopPoolMetrics(): void {
  if (poolLogInterval) {
    clearInterval(poolLogInterval);
    poolLogInterval = undefined;
  }
}
