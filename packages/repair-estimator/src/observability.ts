/**
 * Injectable observability interfaces for the Repair_Estimator_Server
 * (Req 12.1, 12.2, 12.5).
 *
 * Logs and metrics are emitted through small, framework-agnostic interfaces so
 * the server stays unit-testable without live CloudWatch/AWS: tests inject
 * in-memory fakes and assert on what was recorded. Every emission carries the
 * shared `traceId` created at the API_Layer so logs/metrics correlate to one
 * adjuster request across layers (Req 12.5).
 *
 * At deploy time these interfaces are backed by CloudWatch (structured logs +
 * EMF/PutMetricData); that wiring lives in the CDK/runtime layer, not here.
 */

/** A single structured log event emitted by the server. */
export interface LogFields {
  /** The shared request trace identifier (Req 12.5). */
  readonly traceId: string;
  /** The MCP tool being handled, e.g. `estimate_repair`. */
  readonly tool: string;
  /** Arbitrary additional structured context. */
  readonly [key: string]: unknown;
}

/**
 * Structured logger for the server. Implementations forward to CloudWatch Logs
 * (or stdout in local/dev). Each call includes the shared `traceId` via
 * {@link LogFields} (Req 12.1, 12.5).
 */
export interface Logger {
  info(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

/**
 * The metric names published for the Repair_Estimator_Server (Req 12.2):
 * invocation count, error count, and latency.
 */
export type MetricName = "Invocations" | "Errors" | "LatencyMillis";

/** Dimensions attached to every published metric. */
export interface MetricDimensions {
  /** The shared request trace identifier (Req 12.5). */
  readonly traceId: string;
  /** The MCP tool the metric describes. */
  readonly tool: string;
}

/**
 * Metrics sink for the server. Implementations publish to CloudWatch (EMF or
 * PutMetricData). The three required metrics map to {@link MetricName}
 * (Req 12.2); every data point is tagged with the shared `traceId` (Req 12.5).
 */
export interface Metrics {
  count(name: MetricName, value: number, dimensions: MetricDimensions): void;
  timing(name: MetricName, millis: number, dimensions: MetricDimensions): void;
}

/** The observability dependencies injected into the server. */
export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/** A {@link Logger} that discards everything. Useful as a safe default/no-op. */
export const noopLogger: Logger = {
  info: () => {},
  error: () => {},
};

/** A {@link Metrics} sink that discards everything. Useful as a no-op default. */
export const noopMetrics: Metrics = {
  count: () => {},
  timing: () => {},
};

/** A no-op {@link Observability} bundle (logger + metrics both discarding). */
export const noopObservability: Observability = {
  logger: noopLogger,
  metrics: noopMetrics,
};
