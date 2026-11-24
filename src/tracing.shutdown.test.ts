/**
 * Tests for #218: OpenTelemetry shutdown is integrated into gracefulShutdown().
 *
 * Verifies:
 *   1. shutdownTracing() resolves immediately when no SDK is configured.
 *   2. When an SDK is active, shutdown() is awaited and completed spans flush.
 *   3. A hung exporter cannot block shutdown indefinitely — the timeout fires.
 *   4. No SIGTERM/SIGINT listeners are registered by tracing.ts itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Shared mock state (hoisted so vi.mock factories can reference it) ────────
const { mockShutdown, mockStart } = vi.hoisted(() => ({
  mockShutdown: vi.fn<() => Promise<void>>(),
  mockStart:    vi.fn<() => void>(),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class MockNodeSDK {
    start() { mockStart(); }
    shutdown() { return mockShutdown(); }
  },
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));
vi.mock("@opentelemetry/instrumentation-http",    () => ({ HttpInstrumentation:    class {} }));
vi.mock("@opentelemetry/instrumentation-express", () => ({ ExpressInstrumentation: class {} }));
vi.mock("@opentelemetry/instrumentation-undici",  () => ({ UndiciInstrumentation:  class {} }));
vi.mock("@opentelemetry/resources",               () => ({ resourceFromAttributes: vi.fn(() => ({})) }));
vi.mock("@opentelemetry/semantic-conventions",    () => ({ ATTR_SERVICE_NAME: "service.name" }));

// ── Helpers ──────────────────────────────────────────────────────────────────

describe("shutdownTracing — no SDK configured", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.resetModules();
    mockShutdown.mockReset();
    mockStart.mockReset();
  });

  it("resolves immediately when tracing is disabled", async () => {
    const { shutdownTracing } = await import("./tracing.js");
    await expect(shutdownTracing()).resolves.toBeUndefined();
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});

describe("shutdownTracing — SDK active", () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/v1/traces";
    vi.resetModules();
    mockShutdown.mockReset();
    mockStart.mockReset();
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SHUTDOWN_TIMEOUT_MS;
  });

  it("starts the SDK on import", async () => {
    await import("./tracing.js");
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("awaits sdk.shutdown() and resolves when it completes", async () => {
    mockShutdown.mockResolvedValue(undefined);
    const { shutdownTracing } = await import("./tracing.js");

    await expect(shutdownTracing()).resolves.toBeUndefined();
    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("resolves even when sdk.shutdown() rejects (exporter error)", async () => {
    mockShutdown.mockRejectedValue(new Error("exporter timeout"));
    const { shutdownTracing } = await import("./tracing.js");

    await expect(shutdownTracing()).resolves.toBeUndefined();
    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("resolves within the timeout when the exporter hangs", async () => {
    // A short timeout so the test completes quickly.
    process.env.OTEL_SHUTDOWN_TIMEOUT_MS = "50";
    // A never-resolving shutdown simulates a hung exporter.
    mockShutdown.mockReturnValue(new Promise(() => undefined));

    const { shutdownTracing } = await import("./tracing.js");

    const start = Date.now();
    await shutdownTracing();
    const elapsed = Date.now() - start;

    // Should resolve near 50 ms, not hang indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("does not register its own SIGTERM/SIGINT handlers (index.ts owns signals)", async () => {
    const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    mockShutdown.mockResolvedValue(undefined);
    await import("./tracing.js");
    const after = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    expect(after).toBe(before);
  });
});
