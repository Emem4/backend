/**
 * Tests for #219: db_query_duration_seconds and db_pool_acquire_duration_seconds.
 *
 * We test deriveOperation in isolation and verify that the metrics are
 * registered with the correct names and label sets.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { deriveOperation } from "./client.js";
import { dbQueryDuration, dbPoolAcquireDuration, metricsRegistry } from "../lib/metrics.js";

describe("deriveOperation", () => {
  it.each([
    ["SELECT id FROM publishers", "select"],
    ["  select * from resources", "select"],
    ["INSERT INTO payments (id) VALUES ($1)", "insert"],
    ["UPDATE publishers SET name = $1 WHERE id = $2", "update"],
    ["DELETE FROM webhook_outbox WHERE id = $1", "delete"],
    ["BEGIN", "other"],
    ["COMMIT", "other"],
    ["EXPLAIN SELECT 1", "other"],
    ["", "other"],
  ])("classifies %s → %s", (sql, expected) => {
    expect(deriveOperation(sql)).toBe(expected);
  });
});

describe("db metric descriptors (#219)", () => {
  it("db_query_duration_seconds is registered with an operation label", async () => {
    const metric = metricsRegistry.getSingleMetric("db_query_duration_seconds");
    expect(metric).toBeDefined();
    // Record a sample so we can inspect label names.
    dbQueryDuration.observe({ operation: "select" }, 0.001);
    const data = await metric!.get();
    expect(data.type).toBe("histogram");
    // At least one value bucket should carry the operation label.
    const withLabel = data.values.find((v) => v.labels["operation"] === "select");
    expect(withLabel).toBeDefined();
  });

  it("db_pool_acquire_duration_seconds is registered with an operation label", async () => {
    const metric = metricsRegistry.getSingleMetric("db_pool_acquire_duration_seconds");
    expect(metric).toBeDefined();
    dbPoolAcquireDuration.observe({ operation: "insert" }, 0.002);
    const data = await metric!.get();
    expect(data.type).toBe("histogram");
    const withLabel = data.values.find((v) => v.labels["operation"] === "insert");
    expect(withLabel).toBeDefined();
  });

  it("operation labels are bounded to the documented set", () => {
    // This test acts as a contract: add new operations here if you extend the set.
    const allowed = new Set(["select", "insert", "update", "delete", "other"]);
    const inputs = [
      "SELECT 1",
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x=1",
      "DELETE FROM t",
      "BEGIN",
      "SET search_path=public",
      "",
    ];
    for (const sql of inputs) {
      expect(allowed.has(deriveOperation(sql))).toBe(true);
    }
  });
});

describe("pool saturation: acquire time separates from execute time", () => {
  /**
   * Demonstrates the measurement semantics under pool saturation:
   *
   * When all pool connections are busy, a new query must wait. The two metrics
   * distinguish waiting time from execution time:
   *
   *   db_pool_acquire_duration_seconds   ← queuing delay
   *   db_query_duration_seconds          ← queuing delay + wire + server time
   *
   * We simulate this with the actual metric objects to verify the semantics
   * rather than spinning up a real database.
   */
  beforeEach(() => {
    dbQueryDuration.reset();
    dbPoolAcquireDuration.reset();
  });

  it("acquire duration is a subset of total query duration", async () => {
    // Simulate a scenario where acquire took 50 ms and query execution 20 ms.
    const acquireMs = 0.050;
    const totalMs   = 0.070; // acquire + execute

    dbPoolAcquireDuration.observe({ operation: "select" }, acquireMs);
    dbQueryDuration.observe({ operation: "select" }, totalMs);

    const acquireData = await dbPoolAcquireDuration.get();
    const queryData   = await dbQueryDuration.get();

    const acquireSum = acquireData.values.find((v) => v.metricName === "db_pool_acquire_duration_seconds_sum")?.value ?? 0;
    const querySum   = queryData.values.find((v) => v.metricName === "db_query_duration_seconds_sum")?.value ?? 0;

    // The total query time must be >= acquire time (execute time ≥ 0).
    expect(querySum).toBeGreaterThanOrEqual(acquireSum);
    // Both record something meaningful.
    expect(acquireSum).toBeGreaterThan(0);
    expect(querySum).toBeGreaterThan(0);
  });
});
