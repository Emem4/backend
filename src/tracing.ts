/**
 * OpenTelemetry distributed tracing (#307).
 *
 * Must be the FIRST thing the process loads — auto-instrumentation patches
 * `node:http`, `undici` (the global `fetch`, used by the Stellar SDK and
 * the x402 facilitator client), and Express, and that only works if it
 * runs before those modules are first imported. Loaded via `--import`
 * (see package.json's `start`/`dev` scripts), not a regular import.
 *
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set: nothing is started,
 * nothing is exported, zero overhead locally.
 *
 * Shutdown integration (#218):
 * When tracing is active the SDK's own SIGTERM/SIGINT listeners race with
 * gracefulShutdown() in src/index.ts. If gracefulShutdown() calls
 * process.exit() before the SDK finishes flushing, in-flight spans are
 * silently dropped. We fix this by:
 *
 *   1. Not registering SDK signal listeners here at all.
 *   2. Exporting shutdownTracing(), which gracefulShutdown() awaits inside
 *      the existing drain deadline before it calls process.exit().
 *   3. Bounding the tracing flush with OTEL_SHUTDOWN_TIMEOUT_MS (default
 *      3 000 ms) so a hung or slow exporter cannot block shutdown
 *      indefinitely.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/** Maximum time (ms) to wait for the SDK to flush before giving up. */
const OTEL_SHUTDOWN_TIMEOUT_MS = Number(process.env.OTEL_SHUTDOWN_TIMEOUT_MS ?? 3_000);

let _sdk: NodeSDK | undefined;

if (otlpEndpoint) {
  _sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "synapsvault-server",
    }),
    traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      // Node's global `fetch` runs on undici, not node:http — required for
      // outbound Soroban RPC and x402 facilitator calls to carry trace context.
      new UndiciInstrumentation(),
    ],
  });

  _sdk.start();

  // ── #218: Do NOT register signal handlers here ───────────────────────────
  // The previous code registered SIGTERM/SIGINT handlers on the SDK so it
  // could flush spans on exit. Those handlers raced with gracefulShutdown()
  // in src/index.ts: if the process called process.exit() before the SDK
  // finished flushing, spans were dropped silently.
  //
  // Signal handling is now fully owned by src/index.ts. gracefulShutdown()
  // calls shutdownTracing() inside its drain deadline, ensuring the SDK
  // completes (or times out) before process.exit() runs.
}

/**
 * Flush and shut down the OpenTelemetry SDK.
 *
 * Returns a promise that resolves once the SDK has finished exporting all
 * buffered spans, or after OTEL_SHUTDOWN_TIMEOUT_MS if the exporter stalls.
 * Always resolves — never rejects — so a buggy or unreachable collector
 * cannot block graceful shutdown.
 *
 * Call this inside the gracefulShutdown deadline, before process.exit().
 */
export async function shutdownTracing(): Promise<void> {
  if (!_sdk) return;

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, OTEL_SHUTDOWN_TIMEOUT_MS));
  const flush = _sdk.shutdown().catch(() => undefined);

  await Promise.race([flush, timeout]);
}
