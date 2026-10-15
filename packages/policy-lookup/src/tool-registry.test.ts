/**
 * Unit tests for the MCP tool registration & dispatch layer.
 *
 * Exercise the dispatcher over a fake async store with recording logger/metrics
 * fakes — no MCP transport or live AWS. Verifies: fidelity on success,
 * NOT_FOUND on absent id, VALIDATION_ERROR short-circuit without store access
 * (Req 13.2), DEPENDENCY_ERROR normalization on store failure, and that logs &
 * metrics carry the shared traceId (Req 12.1, 12.2, 12.5).
 */
import { describe, expect, it, vi } from "vitest";

import type { PolicyRecord } from "@claimclarify/shared";

import type { AsyncPolicyStore } from "./dynamodb-store";
import {
  PolicyToolRegistry,
  listPolicyToolDefinitions,
  POLICY_TOOL_NAMES,
} from "./tool-registry";
import type { LogEntry, Logger, MetricEntry, Metrics } from "./observability";

const RECORD: PolicyRecord = {
  policyId: "POL-100001",
  holderName: "Dana Adjuster",
  coverage: {
    collision: true,
    comprehensive: false,
    liabilityLimitUsd: 50000,
    rentalReimbursement: true,
  },
  deductibles: { collisionUsd: 1000, comprehensiveUsd: 500 },
  priorClaims: [
    { claimId: "CLM-9", date: "2022-01-01", amountUsd: 100, atFault: false },
  ],
};

function recorders(): {
  logger: Logger;
  metrics: Metrics;
  logs: LogEntry[];
  measured: MetricEntry[];
} {
  const logs: LogEntry[] = [];
  const measured: MetricEntry[] = [];
  return {
    logs,
    measured,
    logger: { log: (e) => logs.push(e) },
    metrics: { record: (e) => measured.push(e) },
  };
}

function presentStore(record: PolicyRecord): AsyncPolicyStore {
  return { fetch: async (id) => (id === record.policyId ? record : undefined) };
}

describe("PolicyToolRegistry", () => {
  it("advertises exactly the three policy tools", () => {
    const defs = listPolicyToolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      [...POLICY_TOOL_NAMES].sort(),
    );
    for (const def of defs) {
      expect(def.inputSchema.required).toContain("policyId");
    }
  });

  it("returns exactly the stored data for an existing policy", async () => {
    const { logger, metrics, logs, measured } = recorders();
    const registry = new PolicyToolRegistry({
      store: presentStore(RECORD),
      logger,
      metrics,
    });

    const coverage = await registry.dispatch(
      "get_coverage",
      { policyId: "POL-100001" },
      { traceId: "trace-1" },
    );
    expect(coverage).toEqual({ ok: true, data: RECORD.coverage });

    const deductibles = await registry.dispatch(
      "get_deductibles",
      { policyId: "POL-100001" },
      { traceId: "trace-1" },
    );
    expect(deductibles).toEqual({ ok: true, data: RECORD.deductibles });

    const prior = await registry.dispatch(
      "get_prior_claims",
      { policyId: "POL-100001" },
      { traceId: "trace-1" },
    );
    expect(prior).toEqual({ ok: true, data: RECORD.priorClaims });

    // Each success emits a log and a metric carrying the shared traceId.
    expect(logs.every((l) => l.traceId === "trace-1")).toBe(true);
    expect(measured.every((m) => m.traceId === "trace-1" && !m.error)).toBe(
      true,
    );
    expect(measured).toHaveLength(3);
  });

  it("returns NOT_FOUND for an absent policy id", async () => {
    const registry = new PolicyToolRegistry({ store: presentStore(RECORD) });
    const result = await registry.dispatch(
      "get_coverage",
      { policyId: "POL-DOES-NOT-EXIST" },
      { traceId: "t" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("NOT_FOUND");
      expect(result.error.message).toContain("POL-DOES-NOT-EXIST");
    }
  });

  it("short-circuits invalid input with VALIDATION_ERROR and does not read the store", async () => {
    const fetch = vi.fn(async () => RECORD);
    const { logger, metrics, measured } = recorders();
    const registry = new PolicyToolRegistry({
      store: { fetch },
      logger,
      metrics,
    });

    const result = await registry.dispatch(
      "get_coverage",
      { policyId: "" },
      { traceId: "trace-v" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("policyId");
    }
    // The store must not be touched when validation fails (Req 13.2).
    expect(fetch).not.toHaveBeenCalled();
    expect(measured[0]).toMatchObject({ traceId: "trace-v", error: true });
  });

  it("normalizes a store failure into a DEPENDENCY_ERROR", async () => {
    const registry = new PolicyToolRegistry({
      store: {
        fetch: async () => {
          throw new Error("DynamoDB throttled");
        },
      },
    });

    const result = await registry.dispatch(
      "get_deductibles",
      { policyId: "POL-100001" },
      { traceId: "t" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("DEPENDENCY_ERROR");
      expect(result.error.dependency).toBe("Policy_Table");
    }
  });

  it("measures latency using the injected clock", async () => {
    const { logger, metrics, measured } = recorders();
    let t = 1000;
    const registry = new PolicyToolRegistry({
      store: presentStore(RECORD),
      logger,
      metrics,
      now: () => (t += 5),
    });

    await registry.dispatch(
      "get_coverage",
      { policyId: "POL-100001" },
      { traceId: "t" },
    );
    expect(measured[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});
