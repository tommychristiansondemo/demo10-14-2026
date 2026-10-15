/**
 * Observability primitives for the Policy_Lookup_Server: an injectable
 * {@link Logger} and {@link Metrics} interface, both stamped with the shared
 * request `traceId` so logs/metrics correlate to one adjuster request
 * (Req 12.1, 12.2, 12.5).
 *
 * These interfaces are deliberately minimal and dependency-free so the server
 * can be unit-tested without CloudWatch or any AWS I/O. Production wiring
 * supplies CloudWatch-backed implementations; tests supply in-memory fakes.
 */

/** A structured log entry emitted by the server. */
export interface LogEntry {
  /** Log level. */
  level: "info" | "warn" | "error";
  /** The MCP tool the entry relates to (e.g. `get_coverage`). */
  tool: string;
  /** Human-readable message. */
  message: string;
  /** Shared request trace identifier (Req 12.5). */
  traceId: string;
  /** Optional structured context (never includes secrets). */
  context?: Record<string, unknown>;
}

/**
 * Injectable structured logger (Req 12.1). The default implementation writes to
 * the console; production supplies a CloudWatch Logs-backed logger.
 */
export interface Logger {
  log(entry: LogEntry): void;
}

/** A single metric emission (Req 12.2). */
export interface MetricEntry {
  /** The MCP tool the metric relates to. */
  tool: string;
  /** Shared request trace identifier (Req 12.5). */
  traceId: string;
  /** Observed latency for the tool invocation, in milliseconds. */
  latencyMs: number;
  /** Whether the invocation produced an error result. */
  error: boolean;
}

/**
 * Injectable metrics sink publishing invocation count, error count, and
 * latency per tool invocation (Req 12.2). The default implementation is a
 * no-op; production supplies a CloudWatch metrics-backed implementation.
 */
export interface Metrics {
  record(entry: MetricEntry): void;
}

/** A {@link Logger} that writes structured JSON lines to the console. */
export class ConsoleLogger implements Logger {
  log(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error") {
      console.error(line);
    } else if (entry.level === "warn") {
      console.warn(line);
    } else {
      console.info(line);
    }
  }
}

/** A {@link Metrics} sink that discards all entries. Safe default for tests. */
export class NoopMetrics implements Metrics {
  record(entry: MetricEntry): void {
    void entry;
  }
}
