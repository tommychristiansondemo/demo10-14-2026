/**
 * Unit tests for the MCP server wiring.
 *
 * Uses an injected fake MCP server to verify the three tools are registered and
 * that each registered handler delegates to the registry's dispatcher, mapping
 * results into the MCP tool-call envelope — all without the real transport or
 * live AWS.
 */
import { describe, expect, it } from "vitest";

import type { PolicyRecord } from "@claimclarify/shared";

import type { AsyncPolicyStore } from "./dynamodb-store";
import {
  createPolicyLookupMcpServer,
  type McpServerLike,
  type McpToolCallResult,
} from "./mcp-server";
import { POLICY_TOOL_NAMES } from "./tool-registry";
import { NoopMetrics } from "./observability";

const RECORD: PolicyRecord = {
  policyId: "POL-7",
  holderName: "H",
  coverage: {
    collision: true,
    comprehensive: true,
    liabilityLimitUsd: 1,
    rentalReimbursement: false,
  },
  deductibles: { collisionUsd: 1, comprehensiveUsd: 1 },
  priorClaims: [],
};

interface Registered {
  name: string;
  handler: (
    args: { policyId?: unknown },
    extra: { requestId?: string | number },
  ) => Promise<McpToolCallResult>;
}

function fakeServer(): { server: McpServerLike; registered: Registered[] } {
  const registered: Registered[] = [];
  const server: McpServerLike = {
    registerTool(name, _config, handler) {
      registered.push({ name, handler });
      return undefined;
    },
    async connect() {
      // no-op
    },
  };
  return { server, registered };
}

const store: AsyncPolicyStore = {
  fetch: async (id) => (id === RECORD.policyId ? RECORD : undefined),
};

describe("createPolicyLookupMcpServer", () => {
  it("registers exactly the three policy tools", () => {
    const { server, registered } = fakeServer();
    createPolicyLookupMcpServer({
      store,
      metrics: new NoopMetrics(),
      logger: { log: () => undefined },
      createServer: () => server,
    });

    expect(registered.map((r) => r.name).sort()).toEqual(
      [...POLICY_TOOL_NAMES].sort(),
    );
  });

  it("delegates a successful call to the pure tool and wraps it in the MCP envelope", async () => {
    const { server, registered } = fakeServer();
    createPolicyLookupMcpServer({
      store,
      metrics: new NoopMetrics(),
      logger: { log: () => undefined },
      createServer: () => server,
    });

    const coverageTool = registered.find((r) => r.name === "get_coverage")!;
    const result = await coverageTool.handler(
      { policyId: "POL-7" },
      { requestId: "req-42" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ data: RECORD.coverage });
    expect(JSON.parse(result.content[0].text)).toEqual(RECORD.coverage);
  });

  it("maps a NOT_FOUND result into an error envelope", async () => {
    const { server, registered } = fakeServer();
    createPolicyLookupMcpServer({
      store,
      metrics: new NoopMetrics(),
      logger: { log: () => undefined },
      createServer: () => server,
    });

    const tool = registered.find((r) => r.name === "get_deductibles")!;
    const result = await tool.handler(
      { policyId: "nope" },
      { requestId: 1 },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { type: string };
    expect(parsed.type).toBe("NOT_FOUND");
  });

  it("uses the resolved request id as the trace id by default", async () => {
    const traceIds: string[] = [];
    const { server, registered } = fakeServer();
    createPolicyLookupMcpServer({
      store,
      metrics: { record: (e) => traceIds.push(e.traceId) },
      logger: { log: () => undefined },
      createServer: () => server,
    });

    const tool = registered.find((r) => r.name === "get_coverage")!;
    await tool.handler({ policyId: "POL-7" }, { requestId: "req-99" });
    expect(traceIds).toContain("req-99");
  });
});
