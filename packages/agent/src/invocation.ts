/**
 * Agent invocation layer: routing, per-tool timeout, trace propagation, and
 * response composition (Req 3.1, 3.2, 3.3, 3.5, 3.6, 11.5, 12.5).
 *
 * This layer takes the tools selected for an adjuster query, stamps each
 * invocation with the shared `traceId` (Req 12.5), calls the injected
 * {@link ToolClient} for each — the production client uses a
 * transport-encrypted (TLS) connection (Req 11.5) — enforces a 20-second
 * per-tool timeout (Req 3.5), and feeds the outcomes into `composeResponse`
 * (task 6.1). Any tool failure or timeout is wrapped via
 * `normalizeDependencyError` (task 6.2) so the failed tool is named (Req 3.5,
 * 3.6).
 *
 * Real LLM-based routing is out of scope for unit tests, so the decision of
 * which tools to call is supplied through an injectable "decision input": an
 * explicit tool selection or a classifier function over the query. This keeps
 * routing (policy / repair / both) fully deterministic and testable.
 *
 * See design.md "3. Bedrock_Agent".
 */

import {
  composeResponse,
  normalizeDependencyError,
  propagateTraceId,
  type ToolInvocation,
  type ToolOutcome,
  type Traced,
} from "@claimclarify/shared";
import {
  groupForTool,
  type ToolClient,
  type ToolGroup,
} from "./tool-client";

/** The 20-second per-tool timeout mandated by the design (Req 3.5). */
export const PER_TOOL_TIMEOUT_MS = 20_000;

/**
 * An explicit selection of which tools to invoke for a query. Each entry names
 * the MCP tool and carries its tool-specific input payload. The orchestrator
 * routes to policy, repair, or both depending on which groups the selected
 * tools belong to (Req 3.1, 3.2, 3.3).
 */
export interface ToolSelection {
  tool: string;
  input: unknown;
}

/**
 * A classifier that decides which tools a query needs. Supplied as an
 * injectable decision input so unit tests can drive routing deterministically
 * in place of a real LLM. Returns the ordered list of tool selections.
 */
export type ToolClassifier = (query: string) => readonly ToolSelection[];

/**
 * The decision input for a single agent invocation: either an explicit list of
 * tool selections, or a classifier function evaluated against the query.
 */
export type RoutingDecision =
  | { kind: "explicit"; selections: readonly ToolSelection[] }
  | { kind: "classifier"; classify: ToolClassifier };

/** Options controlling a single agent invocation. */
export interface InvokeOptions {
  /** Shared trace id created at the API_Layer (Req 12.5). */
  traceId: string;
  /** Per-tool timeout in milliseconds; defaults to {@link PER_TOOL_TIMEOUT_MS}. */
  perToolTimeoutMs?: number;
}

/** The result of an agent invocation. */
export interface AgentResult {
  /** The composed natural-language response (Req 3.4, 3.5, 3.6). */
  response: string;
  /** The individual tool outcomes, in invocation order. */
  outcomes: ToolOutcome[];
  /** The distinct tool groups that were routed to for this query. */
  routedGroups: ToolGroup[];
}

/** Resolve the decision input into a concrete ordered list of selections. */
function resolveSelections(
  decision: RoutingDecision,
  query: string
): readonly ToolSelection[] {
  return decision.kind === "explicit"
    ? decision.selections
    : decision.classify(query);
}

/**
 * Determine which groups a set of selections routes to (policy / repair /
 * both), in first-seen order and without duplicates (Req 3.1, 3.2, 3.3).
 */
export function routedGroupsFor(
  selections: readonly ToolSelection[]
): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const selection of selections) {
    const group = groupForTool(selection.tool);
    if (group && !groups.includes(group)) {
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Race a tool-client call against a timeout. Resolves with the result on
 * success; rejects with `{ timeout: true }` when the timeout fires first, or
 * with the original cause on client failure.
 */
function callWithTimeout(
  client: ToolClient,
  invocation: Traced<ToolInvocation>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({ timeout: true });
    }, timeoutMs);
    // Ensure the timer never keeps the event loop alive on its own.
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }

    client.invoke(invocation).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject({ timeout: false, cause });
      }
    );
  });
}

/**
 * Invoke the agent for a single adjuster query.
 *
 * Routing: the decision input selects the tools; the orchestrator routes to
 * the policy group, the repair group, or both based on the selected tools
 * (Req 3.1, 3.2, 3.3).
 *
 * Trace propagation: every tool invocation is stamped with the shared
 * `traceId` via `propagateTraceId` before being handed to the client
 * (Req 12.5).
 *
 * Timeout & failure handling: each tool call is bounded by the per-tool
 * timeout (Req 3.5). A timeout yields a `TIMEOUT` dependency error; any other
 * failure yields a `DEPENDENCY_ERROR`; both name the failed tool via
 * `normalizeDependencyError` (Req 3.5, 3.6).
 *
 * Composition: all outcomes are fed into `composeResponse`, which references
 * every success and names every failure (Req 3.4, 3.5, 3.6).
 */
export async function invokeAgent(
  client: ToolClient,
  decision: RoutingDecision,
  query: string,
  options: InvokeOptions
): Promise<AgentResult> {
  const timeoutMs = options.perToolTimeoutMs ?? PER_TOOL_TIMEOUT_MS;
  const selections = resolveSelections(decision, query);
  const routedGroups = routedGroupsFor(selections);

  // Stamp the shared traceId onto every invocation (Req 12.5).
  const invocations: ToolInvocation[] = selections.map((selection) => ({
    tool: selection.tool,
    input: selection.input,
  }));
  const traced = propagateTraceId(options.traceId, invocations);

  const outcomes: ToolOutcome[] = [];

  for (let i = 0; i < traced.length; i += 1) {
    const invocation = traced[i];
    const toolName = selections[i].tool;
    try {
      const result = await callWithTimeout(client, invocation, timeoutMs);
      outcomes.push({ tool: toolName, ok: true, result });
    } catch (failure) {
      const normalized = failure as { timeout?: boolean; cause?: unknown };
      const error = normalizeDependencyError(
        toolName,
        { timeout: normalized?.timeout === true, cause: normalized?.cause },
        options.traceId
      );
      outcomes.push({ tool: toolName, ok: false, error });
    }
  }

  return {
    response: composeResponse(outcomes),
    outcomes,
    routedGroups,
  };
}
