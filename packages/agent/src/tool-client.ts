/**
 * Injectable MCP tool-client interface (Req 3.1, 11.5, 12.5).
 *
 * The agent orchestration layer never talks to AWS, a network socket, or the
 * MCP transport directly. Instead it depends on this {@link ToolClient}
 * abstraction. The production implementation wires each tool to its MCP server
 * over a transport-encrypted (TLS) connection; unit tests inject a fake client
 * so routing/compose/timeout behaviour can be exercised deterministically with
 * no live AWS or transport.
 *
 * Every invocation carries the shared `traceId` that was created at the
 * API_Layer and propagated through the agent (Req 12.5): the orchestrator
 * stamps each {@link Traced} tool invocation via `propagateTraceId` before
 * handing it to the client, so the client — and the downstream MCP server —
 * always sees the identical id.
 *
 * See design.md "3. Bedrock_Agent".
 */

import type { Traced, ToolInvocation } from "@claimclarify/shared";

/**
 * The two MCP tool groups the agent is configured with (Req 3.1).
 *
 * - `policy-lookup` exposes the three read-only policy tools
 *   (`get_coverage`, `get_deductibles`, `get_prior_claims`).
 * - `repair-estimator` exposes the single `estimate_repair` tool.
 */
export type ToolGroup = "policy-lookup" | "repair-estimator";

/** The policy-lookup MCP tool names (Req 4.2, 4.3, 4.4). */
export const POLICY_LOOKUP_TOOLS = [
  "get_coverage",
  "get_deductibles",
  "get_prior_claims",
] as const;

/** The repair-estimator MCP tool name (Req 6.1). */
export const REPAIR_ESTIMATOR_TOOLS = ["estimate_repair"] as const;

/** Union of every MCP tool name the agent can invoke. */
export type ToolName =
  | (typeof POLICY_LOOKUP_TOOLS)[number]
  | (typeof REPAIR_ESTIMATOR_TOOLS)[number];

/**
 * Static definition of a tool group: which MCP server group it belongs to and
 * the set of tool names it exposes. This is the agent's declarative "the agent
 * is defined with the two MCP tool groups" configuration (Req 3.1).
 */
export interface ToolGroupDefinition {
  group: ToolGroup;
  tools: readonly ToolName[];
}

/** The agent's two configured MCP tool groups. */
export const TOOL_GROUPS: readonly ToolGroupDefinition[] = [
  { group: "policy-lookup", tools: POLICY_LOOKUP_TOOLS },
  { group: "repair-estimator", tools: REPAIR_ESTIMATOR_TOOLS },
];

/** Map a tool name to the group that owns it, or `undefined` if unknown. */
export function groupForTool(tool: string): ToolGroup | undefined {
  if ((POLICY_LOOKUP_TOOLS as readonly string[]).includes(tool)) {
    return "policy-lookup";
  }
  if ((REPAIR_ESTIMATOR_TOOLS as readonly string[]).includes(tool)) {
    return "repair-estimator";
  }
  return undefined;
}

/**
 * Injectable client that performs a single MCP tool invocation.
 *
 * Implementations receive a {@link Traced} invocation (already stamped with the
 * shared `traceId`) and resolve with the tool's result payload, or reject /
 * throw on a transport, server, or tool error. The orchestration layer is
 * responsible for applying the per-tool timeout and normalizing any
 * rejection — the client itself only models the call.
 *
 * The production implementation opens a transport-encrypted (TLS) MCP
 * connection to the AgentCore Runtime; test implementations are plain fakes.
 */
export interface ToolClient {
  /**
   * Invoke a single MCP tool.
   *
   * @param invocation the tool invocation, already stamped with the shared
   *                   `traceId` (Req 12.5).
   * @returns the tool's result payload on success.
   * @throws on transport/server/tool failure (normalized by the orchestrator).
   */
  invoke(invocation: Traced<ToolInvocation>): Promise<unknown>;
}
