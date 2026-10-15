/**
 * Integration tests for Bedrock_Agent orchestration / routing (Req 3.1, 3.2,
 * 3.3).
 *
 * These exercise the full orchestration path through the public
 * {@link BedrockAgent} surface — routing decision (explicit selections and a
 * classifier), the invocation layer, trace-id propagation, and response
 * composition — against a sandboxed, recording {@link ToolClient} fake. No live
 * AWS/MCP transport is used; the fake records every invocation it receives so
 * the tests can assert exactly which MCP tools the agent invoked for a given
 * query, and that composition happened over those outcomes.
 *
 * Scenarios covered:
 *  - Policy-only query invokes the expected policy tool(s) before composing (Req 3.1).
 *  - Repair-only query invokes `estimate_repair` before composing (Req 3.2).
 *  - Combined query invokes BOTH policy and repair tools before composing (Req 3.3).
 *
 * See design.md "Testing Strategy > Integration Tests":
 *   "Agent orchestration/routing: policy-only, repair-only, and combined
 *    queries invoke the expected tool(s) before composing (3.1, 3.2, 3.3) —
 *    mocked or sandboxed agent."
 */
import { describe, expect, it } from "vitest";
import type { Traced, ToolInvocation } from "@claimclarify/shared";

import {
  BedrockAgent,
  classifierRouting,
  explicitRouting,
} from "./agent";
import { routedGroupsFor, type ToolSelection } from "./invocation";
import { groupForTool, type ToolClient, type ToolGroup } from "./tool-client";

/**
 * A sandboxed, recording MCP tool client. It records, in order, every
 * invocation the orchestrator hands it (already stamped with the shared
 * `traceId`) and returns a canned result per tool name. No network / AWS.
 */
function recordingClient(results: Record<string, unknown>): {
  client: ToolClient;
  calls: Traced<ToolInvocation>[];
  toolsCalled(): string[];
  groupsCalled(): ToolGroup[];
} {
  const calls: Traced<ToolInvocation>[] = [];
  const client: ToolClient = {
    async invoke(invocation) {
      calls.push(invocation);
      if (!(invocation.tool in results)) {
        throw new Error(`unexpected tool invoked: ${invocation.tool}`);
      }
      return results[invocation.tool];
    },
  };
  return {
    client,
    calls,
    toolsCalled: () => calls.map((c) => c.tool),
    groupsCalled: () => {
      const groups: ToolGroup[] = [];
      for (const call of calls) {
        const group = groupForTool(call.tool);
        if (group && !groups.includes(group)) groups.push(group);
      }
      return groups;
    },
  };
}

/** A canned coverage result for the policy-lookup `get_coverage` tool. */
const COVERAGE_RESULT = { collision: true, liabilityLimitUsd: 100000 };
/** A canned deductibles result for the policy-lookup `get_deductibles` tool. */
const DEDUCTIBLES_RESULT = { collisionUsd: 500, comprehensiveUsd: 250 };
/** A canned estimate result for the repair-estimator `estimate_repair` tool. */
const ESTIMATE_RESULT = {
  severity: "moderate",
  estimatedCostUsd: 3200,
  turnaroundDays: 5,
};

const TRACE_ID = "trace-orchestration-it";

describe("Bedrock_Agent orchestration/routing integration", () => {
  it("policy-only query invokes the policy tool(s) before composing (Req 3.1)", async () => {
    const { client, toolsCalled, groupsCalled, calls } = recordingClient({
      get_coverage: COVERAGE_RESULT,
      get_deductibles: DEDUCTIBLES_RESULT,
    });

    // Explicit routing to drive which tools are selected (policy-only).
    const selections: ToolSelection[] = [
      { tool: "get_coverage", input: { policyId: "POL-100001" } },
      { tool: "get_deductibles", input: { policyId: "POL-100001" } },
    ];
    const agent = new BedrockAgent({
      toolClient: client,
      routing: explicitRouting(selections),
    });

    const result = await agent.handleQuery(
      "What coverage and deductibles apply to policy POL-100001?",
      TRACE_ID
    );

    // The agent invoked exactly the expected policy tools, no repair tool.
    expect(toolsCalled()).toEqual(["get_coverage", "get_deductibles"]);
    expect(groupsCalled()).toEqual(["policy-lookup"]);

    // routedGroupsFor and the recorded invocations agree: policy-only.
    expect(result.routedGroups).toEqual(["policy-lookup"]);
    expect(result.routedGroups).toEqual(routedGroupsFor(selections));

    // The invocations happened before composition, over which composition ran:
    // every invoked tool's outcome is reflected in the composed response.
    expect(result.outcomes.map((o) => o.tool)).toEqual([
      "get_coverage",
      "get_deductibles",
    ]);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.response).toContain("get_coverage");
    expect(result.response).toContain("get_deductibles");
    expect(result.response).not.toContain("estimate_repair");

    // Trace id was propagated to every (sandboxed) invocation (Req 12.5).
    expect(calls.every((c) => c.traceId === TRACE_ID)).toBe(true);
  });

  it("repair-only query invokes estimate_repair before composing (Req 3.2)", async () => {
    const { client, toolsCalled, groupsCalled } = recordingClient({
      estimate_repair: ESTIMATE_RESULT,
    });

    // Classifier-based routing: a repair-centric query selects estimate_repair.
    const agent = new BedrockAgent({
      toolClient: client,
      routing: classifierRouting((query) => {
        const selections: ToolSelection[] = [];
        if (/coverage|deductible|policy|prior/i.test(query)) {
          selections.push({ tool: "get_coverage", input: {} });
        }
        if (/repair|damage|estimate|cost/i.test(query)) {
          selections.push({
            tool: "estimate_repair",
            input: { vehicleYear: 2020, impactLocation: "front" },
          });
        }
        return selections;
      }),
    });

    const result = await agent.handleQuery(
      "Estimate the repair cost for this collision damage.",
      TRACE_ID
    );

    // Only the repair tool was invoked, before composition.
    expect(toolsCalled()).toEqual(["estimate_repair"]);
    expect(groupsCalled()).toEqual(["repair-estimator"]);
    expect(result.routedGroups).toEqual(["repair-estimator"]);

    // Composition ran over the repair outcome.
    expect(result.outcomes.map((o) => o.tool)).toEqual(["estimate_repair"]);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.response).toContain("estimate_repair");
    expect(result.response).not.toContain("get_coverage");
  });

  it("combined query invokes BOTH policy and repair tools before composing (Req 3.3)", async () => {
    const { client, toolsCalled, groupsCalled } = recordingClient({
      get_coverage: COVERAGE_RESULT,
      estimate_repair: ESTIMATE_RESULT,
    });

    // Classifier that routes a mixed query to both groups.
    const agent = new BedrockAgent({
      toolClient: client,
      routing: classifierRouting((query) => {
        const selections: ToolSelection[] = [];
        if (/coverage|deductible|policy|prior/i.test(query)) {
          selections.push({
            tool: "get_coverage",
            input: { policyId: "POL-100001" },
          });
        }
        if (/repair|damage|estimate|cost/i.test(query)) {
          selections.push({
            tool: "estimate_repair",
            input: { vehicleYear: 2020, impactLocation: "front" },
          });
        }
        return selections;
      }),
    });

    const result = await agent.handleQuery(
      "Is this collision damage covered under policy POL-100001, and what is the repair estimate?",
      TRACE_ID
    );

    // Both tools were invoked — one from each group — before composing.
    expect(toolsCalled()).toEqual(["get_coverage", "estimate_repair"]);
    expect(groupsCalled()).toEqual(["policy-lookup", "repair-estimator"]);
    expect(result.routedGroups).toEqual([
      "policy-lookup",
      "repair-estimator",
    ]);

    // Composition incorporated BOTH tool outcomes (Req 3.3 -> 3.4).
    expect(result.outcomes.map((o) => o.tool)).toEqual([
      "get_coverage",
      "estimate_repair",
    ]);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.response).toContain("get_coverage");
    expect(result.response).toContain("estimate_repair");
  });
});
