/**
 * Unit tests for the `estimate_repair` tool handler (Req 6.1–6.5, 12.1, 12.2,
 * 12.5, 13.3, 13.4, 15.2, 15.3).
 *
 * These example-based tests cover the handler's observable behavior without the
 * MCP transport or any live AWS: valid input yields a well-formed estimate,
 * invalid input yields a VALIDATION_ERROR with no estimate, a missing config
 * key yields a CONFIG_ERROR (no source-embedded fallback), and logs/metrics are
 * emitted with the shared traceId.
 */
import { describe, expect, it } from "vitest";
import { InMemoryConfigSource, type ClaimInput } from "@claimclarify/shared";

import {
  ENVIRONMENT_CONFIG_KEY,
  ESTIMATE_REPAIR_TOOL,
  handleEstimateRepair,
  type EstimateRepairDeps,
} from "./estimate-repair-tool";
import type {
  LogFields,
  Logger,
  MetricDimensions,
  MetricName,
  Metrics,
} from "./observability";

interface LogRecord {
  level: "info" | "error";
  message: string;
  fields: LogFields;
}

interface MetricRecord {
  name: MetricName;
  value: number;
  dimensions: MetricDimensions;
}

/** Capturing logger + metrics so tests can assert on emitted observability. */
function makeSpies() {
  const logs: LogRecord[] = [];
  const metrics: MetricRecord[] = [];
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const metricsSink: Metrics = {
    count: (name, value, dimensions) =>
      metrics.push({ name, value, dimensions }),
    timing: (name, value, dimensions) =>
      metrics.push({ name, value, dimensions }),
  };
  return { logs, metrics, logger, metricsSink };
}

function makeDeps(
  overrides: {
    configEntries?: Record<string, string>;
    currentYearMax?: number;
    now?: () => number;
  } = {},
): { deps: EstimateRepairDeps; spies: ReturnType<typeof makeSpies> } {
  const spies = makeSpies();
  const deps: EstimateRepairDeps = {
    config: new InMemoryConfigSource(
      overrides.configEntries ?? { [ENVIRONMENT_CONFIG_KEY]: "classroom" },
    ),
    observability: { logger: spies.logger, metrics: spies.metricsSink },
    currentYearMax: overrides.currentYearMax ?? 2026,
    now: overrides.now,
  };
  return { deps, spies };
}

const validClaim: ClaimInput = {
  vehicleYear: 2019,
  impactLocation: "front",
  driveable: false,
  airbagDeployed: true,
  visibleDamagePanels: 4,
};

describe("handleEstimateRepair", () => {
  it("returns a well-formed estimate for valid input (Req 6.2, 6.3, 6.4)", () => {
    const { deps } = makeDeps();
    const result = handleEstimateRepair(validClaim, "trace-1", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(["minor", "moderate", "severe", "total_loss"]).toContain(
        result.estimate.severity,
      );
      expect(result.estimate.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(result.estimate.turnaroundDays).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns VALIDATION_ERROR naming the field and no estimate for invalid input (Req 6.5, 13.3, 13.4)", () => {
    const { deps } = makeDeps();
    const result = handleEstimateRepair(
      { ...validClaim, impactLocation: "hood" },
      "trace-2",
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("impactLocation");
    }
    expect(result).not.toHaveProperty("estimate");
  });

  it("returns CONFIG_ERROR with no fallback when the config key is missing (Req 15.2, 15.3)", () => {
    const { deps } = makeDeps({ configEntries: {} });
    const result = handleEstimateRepair(validClaim, "trace-3", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("CONFIG_ERROR");
    }
  });

  it("does not validate or estimate when config retrieval fails", () => {
    // Even a syntactically invalid claim must surface CONFIG_ERROR first,
    // proving config is required at runtime before any processing (Req 15.2).
    const { deps } = makeDeps({ configEntries: {} });
    const result = handleEstimateRepair({}, "trace-4", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("CONFIG_ERROR");
    }
  });

  it("emits invocation + latency metrics and logs tagged with the shared traceId (Req 12.1, 12.2, 12.5)", () => {
    let clock = 1000;
    const { deps, spies } = makeDeps({ now: () => clock++ });
    handleEstimateRepair(validClaim, "trace-5", deps);

    // Every log carries the shared traceId and tool name (Req 12.5).
    expect(spies.logs.length).toBeGreaterThan(0);
    for (const record of spies.logs) {
      expect(record.fields.traceId).toBe("trace-5");
      expect(record.fields.tool).toBe(ESTIMATE_REPAIR_TOOL);
    }

    const names = spies.metrics.map((m) => m.name);
    expect(names).toContain("Invocations");
    expect(names).toContain("LatencyMillis");
    for (const metric of spies.metrics) {
      expect(metric.dimensions.traceId).toBe("trace-5");
      expect(metric.dimensions.tool).toBe(ESTIMATE_REPAIR_TOOL);
    }
  });

  it("emits an Errors metric on validation failure (Req 12.2)", () => {
    const { deps, spies } = makeDeps();
    handleEstimateRepair({ ...validClaim, vehicleYear: 1900 }, "trace-6", deps);
    expect(spies.metrics.map((m) => m.name)).toContain("Errors");
  });

  it("is deterministic for identical valid input", () => {
    const { deps: a } = makeDeps();
    const { deps: b } = makeDeps();
    const r1 = handleEstimateRepair(validClaim, "t", a);
    const r2 = handleEstimateRepair(validClaim, "t", b);
    expect(r1).toEqual(r2);
  });
});
