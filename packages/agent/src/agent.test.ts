/**
 * Unit tests for the BedrockAgent orchestrator: tool-group definition and
 * end-to-end query handling with injected fakes (Req 3.1, 3.2, 3.3).
 */
import { describe, expect, it } from "vitest";

import { BedrockAgent, explicitRouting, classifierRouting } from "./agent";
import type { ToolClient } from "./tool-client";

const fakeClient = (results: Record<string, unknown>): ToolClient => ({
  async invoke(invocation) {
    return results[invocation.tool];
  },
});

describe("BedrockAgent", () => {
  it("is defined with the two MCP tool groups", () => {
    const agent = new BedrockAgent({
      toolClient: fakeClient({}),
      routing: explicitRouting([]),
    });
    expect(agent.toolGroups.map((g) => g.group)).toEqual([
      "policy-lookup",
      "repair-estimator",
    ]);
    const policy = agent.toolGroups.find((g) => g.group === "policy-lookup");
    expect(policy?.tools).toEqual([
      "get_coverage",
      "get_deductibles",
      "get_prior_claims",
    ]);
    const repair = agent.toolGroups.find((g) => g.group === "repair-estimator");
    expect(repair?.tools).toEqual(["estimate_repair"]);
  });

  it("handles a query end-to-end using the configured classifier routing", async () => {
    const agent = new BedrockAgent({
      toolClient: fakeClient({
        get_coverage: { limit: 50000 },
        estimate_repair: { severity: "moderate" },
      }),
      routing: classifierRouting((q) => {
        const selections = [];
        if (q.includes("coverage")) selections.push({ tool: "get_coverage", input: {} });
        if (q.includes("repair")) selections.push({ tool: "estimate_repair", input: {} });
        return selections;
      }),
    });

    const result = await agent.handleQuery("coverage and repair", "trace-e2e");

    expect(result.routedGroups).toEqual(["policy-lookup", "repair-estimator"]);
    expect(result.response).toContain("get_coverage");
    expect(result.response).toContain("estimate_repair");
  });

  it("allows a per-call routing override", async () => {
    const agent = new BedrockAgent({
      toolClient: fakeClient({ estimate_repair: { severity: "minor" } }),
      routing: explicitRouting([{ tool: "get_coverage", input: {} }]),
    });

    const result = await agent.handleQuery(
      "ignored",
      "trace-override",
      explicitRouting([{ tool: "estimate_repair", input: {} }])
    );

    expect(result.routedGroups).toEqual(["repair-estimator"]);
  });
});
