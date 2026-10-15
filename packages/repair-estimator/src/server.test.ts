/**
 * End-to-end MCP wiring tests for the Repair_Estimator_Server (Req 6.1, 6.5,
 * 12.5, 13.3, 13.4, 15.2).
 *
 * These tests connect an MCP {@link Client} to {@link createRepairEstimatorServer}
 * over an in-memory transport pair, so they exercise real MCP `tools/list` and
 * `tools/call` dispatch without any network transport or live AWS. They confirm
 * the tool is advertised, that a valid Claim_Input yields a structured estimate,
 * that an invalid input yields a VALIDATION_ERROR result (isError, no estimate),
 * and that the propagated traceId reaches the injected logger/metrics (Req 12.5).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryConfigSource } from "@claimclarify/shared";

import { createRepairEstimatorServer } from "./server";
import {
  ENVIRONMENT_CONFIG_KEY,
  ESTIMATE_REPAIR_TOOL,
} from "./estimate-repair-tool";
import type {
  LogFields,
  Logger,
  MetricDimensions,
  MetricName,
  Metrics,
} from "./observability";

function makeSpies() {
  const traceIds: string[] = [];
  const logger: Logger = {
    info: (_m: string, f: LogFields) => traceIds.push(f.traceId),
    error: (_m: string, f: LogFields) => traceIds.push(f.traceId),
  };
  const metricTraceIds: string[] = [];
  const metricNames: MetricName[] = [];
  const metrics: Metrics = {
    count: (name: MetricName, _v: number, d: MetricDimensions) => {
      metricNames.push(name);
      metricTraceIds.push(d.traceId);
    },
    timing: (name: MetricName, _v: number, d: MetricDimensions) => {
      metricNames.push(name);
      metricTraceIds.push(d.traceId);
    },
  };
  return { traceIds, metricTraceIds, metricNames, logger, metrics };
}

async function connectClient(deps: Parameters<typeof createRepairEstimatorServer>[0]) {
  const server = createRepairEstimatorServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function baseDeps(spies = makeSpies()) {
  return {
    deps: {
      config: new InMemoryConfigSource({ [ENVIRONMENT_CONFIG_KEY]: "classroom" }),
      observability: { logger: spies.logger, metrics: spies.metrics },
      currentYearMax: 2026,
    },
    spies,
  };
}

const validClaim = {
  vehicleYear: 2019,
  impactLocation: "front",
  driveable: false,
  airbagDeployed: true,
  visibleDamagePanels: 4,
};

describe("createRepairEstimatorServer (MCP wiring)", () => {
  it("advertises the estimate_repair tool via tools/list (Req 6.1)", async () => {
    const { deps } = baseDeps();
    const { client, server } = await connectClient(deps);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(ESTIMATE_REPAIR_TOOL);
    const tool = tools.find((t) => t.name === ESTIMATE_REPAIR_TOOL);
    expect(tool?.inputSchema).toBeDefined();
    expect(tool?.inputSchema.required).toContain("vehicleYear");

    await client.close();
    await server.close();
  });

  it("returns a structured estimate for a valid Claim_Input (Req 6.2, 6.3, 6.4)", async () => {
    const { deps } = baseDeps();
    const { client, server } = await connectClient(deps);

    const result = await client.callTool({
      name: ESTIMATE_REPAIR_TOOL,
      arguments: { ...validClaim },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      severity: string;
      estimatedCostUsd: number;
      turnaroundDays: number;
    };
    expect(["minor", "moderate", "severe", "total_loss"]).toContain(
      structured.severity,
    );
    expect(structured.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(structured.turnaroundDays).toBeGreaterThanOrEqual(0);

    await client.close();
    await server.close();
  });

  it("validates before processing and returns a VALIDATION_ERROR with no estimate (Req 6.5, 13.3, 13.4)", async () => {
    const { deps } = baseDeps();
    const { client, server } = await connectClient(deps);

    const result = await client.callTool({
      name: ESTIMATE_REPAIR_TOOL,
      arguments: { ...validClaim, visibleDamagePanels: 99 },
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      error: { type: string; field?: string };
    };
    expect(structured.error.type).toBe("VALIDATION_ERROR");
    expect(structured.error.field).toBe("visibleDamagePanels");
    expect(result.structuredContent).not.toHaveProperty("severity");

    await client.close();
    await server.close();
  });

  it("propagates the shared traceId from the invocation into logs and metrics (Req 12.5)", async () => {
    const { deps, spies } = baseDeps();
    const { client, server } = await connectClient(deps);

    await client.callTool({
      name: ESTIMATE_REPAIR_TOOL,
      arguments: { ...validClaim, _traceId: "trace-xyz" },
    });

    expect(spies.traceIds.length).toBeGreaterThan(0);
    expect(spies.traceIds.every((id) => id === "trace-xyz")).toBe(true);
    expect(spies.metricTraceIds.every((id) => id === "trace-xyz")).toBe(true);
    expect(spies.metricNames).toContain("Invocations");

    await client.close();
    await server.close();
  });

  it("returns an isError result for an unknown tool name", async () => {
    const { deps } = baseDeps();
    const { client, server } = await connectClient(deps);

    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
