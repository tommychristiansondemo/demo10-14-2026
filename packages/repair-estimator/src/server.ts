/**
 * MCP server wiring for the Repair_Estimator_Server (Req 6.1, 12.5, 13.3, 15.2).
 *
 * This module exposes the `estimate_repair` tool over the Model Context
 * Protocol using the official MCP SDK (`@modelcontextprotocol/sdk`). It uses the
 * SDK's low-level {@link Server} with the standard `tools/list` and `tools/call`
 * request handlers, so the server speaks real MCP while keeping input
 * validation authoritative in our own pure logic (`validateClaimInput`) rather
 * than delegating to a schema validator. The actual tool behavior lives in
 * {@link handleEstimateRepair} (`./estimate-repair-tool.ts`), which is injected
 * here, so the server can be driven directly from unit tests without any
 * transport or live AWS (Req 6.1).
 *
 * The shared `traceId` for a tool invocation is read from the MCP request
 * arguments (`_traceId`) when the agent propagates it, so logs/metrics correlate
 * to one adjuster request (Req 12.5). Config is read from the Config_Store at
 * runtime inside the handler (Req 15.2).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  IMPACT_LOCATIONS,
  VEHICLE_YEAR_MIN,
  VISIBLE_DAMAGE_PANELS_MAX,
} from "@claimclarify/shared";

import {
  ESTIMATE_REPAIR_TOOL,
  handleEstimateRepair,
  type EstimateRepairDeps,
} from "./estimate-repair-tool";

/** Server identity advertised to MCP clients. */
const SERVER_INFO = {
  name: "claimclarify-repair-estimator",
  version: "0.1.0",
} as const;

/**
 * JSON Schema describing the `estimate_repair` tool input (`Claim_Input`),
 * advertised to clients via `tools/list`. This mirrors the validation rules in
 * `validateClaimInput`; `validateClaimInput` remains the authoritative gate at
 * invocation time (Req 6.5, 13.3). `maxYear` is injected so discovery reflects
 * the runtime `currentYear + 1` ceiling.
 */
function claimInputSchema(maxYear: number): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      vehicleYear: {
        type: "integer",
        minimum: VEHICLE_YEAR_MIN,
        maximum: maxYear,
        description: `Vehicle model year, ${VEHICLE_YEAR_MIN}..${maxYear} inclusive.`,
      },
      impactLocation: {
        type: "string",
        enum: [...IMPACT_LOCATIONS],
        description: "Collision impact location.",
      },
      driveable: { type: "boolean", description: "Whether the vehicle is driveable." },
      airbagDeployed: {
        type: "boolean",
        description: "Whether any airbag deployed.",
      },
      visibleDamagePanels: {
        type: "integer",
        minimum: 0,
        maximum: VISIBLE_DAMAGE_PANELS_MAX,
        description: `Count of visibly damaged panels, 0..${VISIBLE_DAMAGE_PANELS_MAX}.`,
      },
    },
    required: [
      "vehicleYear",
      "impactLocation",
      "driveable",
      "airbagDeployed",
      "visibleDamagePanels",
    ],
    additionalProperties: false,
  };
}

/** The `estimate_repair` tool descriptor returned by `tools/list`. */
function estimateRepairToolDescriptor(maxYear: number): Tool {
  return {
    name: ESTIMATE_REPAIR_TOOL,
    description:
      "Classify collision damage severity and estimate repair cost (USD) and turnaround (days) for a Claim_Input.",
    inputSchema: claimInputSchema(maxYear),
  };
}

/**
 * Extract the shared `traceId` propagated by the Bedrock_Agent on the tool
 * arguments (Req 12.5). The agent threads the API-layer trace id into each MCP
 * invocation; we read it from the reserved `_traceId` argument. When absent
 * (e.g. a direct client call), fall back to an empty string so logging still
 * runs without throwing.
 */
function extractTraceId(args: Record<string, unknown> | undefined): string {
  const value = args?._traceId;
  return typeof value === "string" ? value : "";
}

/**
 * Strip the reserved trace argument from the tool arguments before validation,
 * so the propagation envelope never trips `additionalProperties: false`.
 */
function stripTraceEnvelope(
  args: Record<string, unknown> | undefined,
): unknown {
  if (args === undefined) {
    return undefined;
  }
  const { _traceId, ...claimInput } = args;
  void _traceId;
  return claimInput;
}

/**
 * Build (but do not connect) the Repair_Estimator_Server MCP {@link Server}
 * with the `estimate_repair` tool registered.
 *
 * The returned server advertises the tool via `tools/list` and dispatches
 * `tools/call` for `estimate_repair` to {@link handleEstimateRepair}. On
 * success the estimate is returned as `structuredContent` plus a text summary;
 * on failure the structured error is returned with `isError: true` and no
 * estimate (Req 6.5, 13.4). Connecting the server to a transport (stdio or
 * HTTP) is the deployment layer's responsibility (task 18), which keeps this
 * module unit-testable without a live transport.
 *
 * @param deps injected Config_Store + observability dependencies.
 */
export function createRepairEstimatorServer(deps: EstimateRepairDeps): Server {
  const maxYear = deps.currentYearMax ?? new Date().getUTCFullYear() + 1;
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [estimateRepairToolDescriptor(maxYear)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (name !== ESTIMATE_REPAIR_TOOL) {
      // Unknown tool: structured, non-throwing error result.
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    const traceId = extractTraceId(args);
    const claimInput = stripTraceEnvelope(args);
    const result = handleEstimateRepair(claimInput, traceId, deps);

    if (!result.ok) {
      return {
        isError: true,
        structuredContent: { error: result.error },
        content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
      };
    }

    return {
      structuredContent: result.estimate as unknown as Record<string, unknown>,
      content: [{ type: "text", text: JSON.stringify(result.estimate) }],
    };
  });

  return server;
}
