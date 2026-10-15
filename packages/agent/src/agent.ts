/**
 * Bedrock_Agent definition and orchestration entry point (Req 3.1).
 *
 * The agent is defined with its two MCP tool groups and an injected
 * {@link ToolClient} (so no live AWS/transport is needed), plus the routing
 * decision input used to choose which tools a query needs. `handleQuery`
 * delegates to the invocation layer, which applies the per-tool timeout,
 * propagates the shared `traceId`, calls the tool client over a
 * transport-encrypted connection (production impl), and composes the response.
 *
 * See design.md "3. Bedrock_Agent".
 */

import {
  invokeAgent,
  type AgentResult,
  type RoutingDecision,
  type ToolClassifier,
  type ToolSelection,
} from "./invocation";
import { TOOL_GROUPS, type ToolClient, type ToolGroupDefinition } from "./tool-client";

/** Configuration required to construct the Bedrock_Agent orchestrator. */
export interface AgentConfig {
  /**
   * The MCP tool client used for every tool invocation. Production supplies a
   * TLS-backed MCP client; tests supply a fake (Req 11.5, 12.5).
   */
  toolClient: ToolClient;
  /**
   * Default routing decision: how to decide which tools a query needs. A
   * classifier is the common case; an explicit selection is useful for tests
   * and deterministic flows. Can be overridden per call.
   */
  routing: RoutingDecision;
  /** Optional override for the per-tool timeout (defaults to 20s). */
  perToolTimeoutMs?: number;
}

/**
 * The Bedrock_Agent orchestrator. Encapsulates the two configured MCP tool
 * groups and the wiring needed to answer an adjuster query end to end.
 */
export class BedrockAgent {
  /** The two MCP tool groups this agent is defined with (Req 3.1). */
  readonly toolGroups: readonly ToolGroupDefinition[] = TOOL_GROUPS;

  constructor(private readonly config: AgentConfig) {}

  /**
   * Handle a single adjuster query.
   *
   * @param query   the natural-language adjuster query.
   * @param traceId the shared trace id created at the API_Layer (Req 12.5).
   * @param routing optional per-call routing override; defaults to the agent's
   *                configured routing.
   */
  handleQuery(
    query: string,
    traceId: string,
    routing: RoutingDecision = this.config.routing
  ): Promise<AgentResult> {
    return invokeAgent(this.config.toolClient, routing, query, {
      traceId,
      perToolTimeoutMs: this.config.perToolTimeoutMs,
    });
  }
}

/** Convenience: build an explicit routing decision from tool selections. */
export function explicitRouting(
  selections: readonly ToolSelection[]
): RoutingDecision {
  return { kind: "explicit", selections };
}

/** Convenience: build a classifier-based routing decision. */
export function classifierRouting(classify: ToolClassifier): RoutingDecision {
  return { kind: "classifier", classify };
}
