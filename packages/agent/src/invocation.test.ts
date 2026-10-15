/**
 * Unit tests for the agent invocation layer: routing (policy / repair / both),
 * trace-id propagation, the 20s per-tool timeout, dependency-error wrapping,
 * and response composition (Req 3.1, 3.2, 3.3, 3.5, 3.6, 11.5, 12.5).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Traced, ToolInvocation } from "@claimclarify/shared";

import {
  invokeAgent,
  routedGroupsFor,
  PER_TOOL_TIMEOUT_MS,
  type ToolSelection,
} from "./invocation";
import type { ToolClient } from "./tool-client";

/**
 * A fake tool client that records every invocation it receives and returns a
 * configured result (or throws) per tool name. No live AWS/transport.
 */
function fakeClient(
  behavior: Record<string, (input: unknown) => Promise<unknown>>
): { client: ToolClient; calls: Traced<ToolInvocation>[] } {
  const calls: Traced<ToolInvocation>[] = [];
  const client: ToolClient = {
    async invoke(invocation) {
      calls.push(invocation);
      const handler = behavior[invocation.tool];
      if (!handler) {
        throw new Error(`no behavior for ${invocation.tool}`);
      }
      return handler(invocation.input);
    },
  };
  return { client, calls };
}

const explicit = (selections: readonly ToolSelection[]) =>
  ({ kind: "explicit" as const, selections });

afterEach(() => {
  vi.useRealTimers();
});

describe("routedGroupsFor", () => {
  it("routes policy-only queries to the policy group", () => {
    expect(routedGroupsFor([{ tool: "get_coverage", input: {} }])).toEqual([
      "policy-lookup",
    ]);
  });

  it("routes repair-only queries to the repair group", () => {
    expect(routedGroupsFor([{ tool: "estimate_repair", input: {} }])).toEqual([
      "repair-estimator",
    ]);
  });

  it("routes to both groups when both tools are selected, deduped", () => {
    const groups = routedGroupsFor([
      { tool: "get_coverage", input: {} },
      { tool: "get_deductibles", input: {} },
      { tool: "estimate_repair", input: {} },
    ]);
    expect(groups).toEqual(["policy-lookup", "repair-estimator"]);
  });
});

describe("invokeAgent routing + composition", () => {
  it("invokes the selected policy tool and composes a success response", async () => {
    const { client, calls } = fakeClient({
      get_coverage: async () => ({ limit: 50000 }),
    });

    const result = await invokeAgent(
      client,
      explicit([{ tool: "get_coverage", input: { policyId: "P1" } }]),
      "what is my coverage",
      { traceId: "trace-1" }
    );

    expect(result.routedGroups).toEqual(["policy-lookup"]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].ok).toBe(true);
    expect(result.response).toContain("get_coverage");
    expect(calls).toHaveLength(1);
  });

  it("invokes both groups and references both in the composed response", async () => {
    const { client } = fakeClient({
      get_coverage: async () => ({ limit: 50000 }),
      estimate_repair: async () => ({ severity: "moderate", estimatedCostUsd: 3200 }),
    });

    const result = await invokeAgent(
      client,
      explicit([
        { tool: "get_coverage", input: { policyId: "P1" } },
        { tool: "estimate_repair", input: { vehicleYear: 2020 } },
      ]),
      "coverage and repair",
      { traceId: "trace-2" }
    );

    expect(result.routedGroups).toEqual(["policy-lookup", "repair-estimator"]);
    expect(result.response).toContain("get_coverage");
    expect(result.response).toContain("estimate_repair");
  });

  it("supports classifier-based routing as an injectable decision input", async () => {
    const { client, calls } = fakeClient({
      estimate_repair: async () => ({ severity: "minor" }),
    });

    const result = await invokeAgent(
      client,
      {
        kind: "classifier",
        classify: (q) =>
          q.includes("repair")
            ? [{ tool: "estimate_repair", input: {} }]
            : [{ tool: "get_coverage", input: {} }],
      },
      "estimate the repair cost",
      { traceId: "trace-3" }
    );

    expect(calls.map((c) => c.tool)).toEqual(["estimate_repair"]);
    expect(result.routedGroups).toEqual(["repair-estimator"]);
  });
});

describe("invokeAgent trace propagation (Req 12.5)", () => {
  it("stamps the identical shared traceId onto every tool invocation", async () => {
    const { client, calls } = fakeClient({
      get_coverage: async () => ({}),
      estimate_repair: async () => ({}),
    });

    await invokeAgent(
      client,
      explicit([
        { tool: "get_coverage", input: {} },
        { tool: "estimate_repair", input: {} },
      ]),
      "both",
      { traceId: "shared-trace-xyz" }
    );

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.traceId === "shared-trace-xyz")).toBe(true);
  });
});

describe("invokeAgent failure handling (Req 3.5, 3.6)", () => {
  it("wraps a tool failure as a named DEPENDENCY_ERROR and still composes", async () => {
    const { client } = fakeClient({
      get_coverage: async () => ({ limit: 50000 }),
      estimate_repair: async () => {
        throw new Error("estimator exploded");
      },
    });

    const result = await invokeAgent(
      client,
      explicit([
        { tool: "get_coverage", input: {} },
        { tool: "estimate_repair", input: {} },
      ]),
      "both",
      { traceId: "trace-fail" }
    );

    const failure = result.outcomes.find((o) => !o.ok);
    expect(failure).toBeDefined();
    if (failure && failure.ok === false) {
      expect(failure.error.type).toBe("DEPENDENCY_ERROR");
      expect(failure.error.dependency).toBe("estimate_repair");
      expect(failure.error.traceId).toBe("trace-fail");
    }
    // Partial failure: success is still referenced, failure is named.
    expect(result.response).toContain("get_coverage");
    expect(result.response).toContain("estimate_repair");
  });

  it("applies the per-tool timeout and yields a TIMEOUT error naming the tool", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient({
      // Never resolves within the timeout window.
      get_prior_claims: () => new Promise(() => {}),
    });

    const promise = invokeAgent(
      client,
      explicit([{ tool: "get_prior_claims", input: {} }]),
      "prior claims",
      { traceId: "trace-timeout", perToolTimeoutMs: 20_000 }
    );

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;

    const outcome = result.outcomes[0];
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.error.type).toBe("TIMEOUT");
      expect(outcome.error.dependency).toBe("get_prior_claims");
    }
    expect(result.response).toContain("get_prior_claims");
  });

  it("defaults the per-tool timeout to 20 seconds", () => {
    expect(PER_TOOL_TIMEOUT_MS).toBe(20_000);
  });
});
