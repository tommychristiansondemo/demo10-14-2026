/**
 * Trace-context creation and propagation (Req 12.5).
 *
 * A single `traceId` is created at the API_Layer and propagated to the agent
 * invocation and onward to every MCP tool invocation emitted while handling a
 * request, so logs/metrics/traces across layers correlate to one adjuster
 * request.
 *
 * See design.md "Trace Context (Req 12.5)" and
 * "Property 13: Shared trace-id propagation".
 */
import { randomUUID } from "node:crypto";

/**
 * A payload that carries the shared request `traceId`. The agent invocation
 * payload and every MCP tool invocation payload are {@link Traced}.
 */
export type Traced<T> = T & { traceId: string };

/**
 * A single MCP tool invocation emitted while handling a request. `tool` names
 * the MCP tool (e.g. `get_coverage`, `estimate_repair`) and `input` is the
 * tool-specific argument payload. Once stamped it carries the shared
 * `traceId`.
 */
export interface ToolInvocation<TInput = unknown> {
  tool: string;
  input: TInput;
  traceId?: string;
}

/**
 * Create a fresh `traceId` at the API_Layer for a single adjuster request
 * (Req 12.5). Uses `crypto.randomUUID`, so each call yields a distinct,
 * well-formed identifier.
 */
export function createTraceId(): string {
  return randomUUID();
}

/**
 * Stamp the shared `traceId` onto a single payload (the agent invocation
 * payload or an individual MCP tool invocation). Returns a new object; the
 * input is not mutated. An existing `traceId` on the payload is overwritten so
 * the API-layer identifier always wins (Req 12.5).
 */
export function withTraceId<T extends object>(
  traceId: string,
  payload: T
): Traced<T> {
  return { ...payload, traceId };
}

/**
 * Thread the shared `traceId` onto every MCP tool invocation emitted for a
 * request. Returns a new array of stamped invocations in the original order;
 * inputs are not mutated. This is the propagation step that guarantees
 * Property 13: every emitted tool invocation carries the identical API-layer
 * `traceId` (Req 12.5).
 */
export function propagateTraceId<TInput>(
  traceId: string,
  invocations: readonly ToolInvocation<TInput>[]
): Traced<ToolInvocation<TInput>>[] {
  return invocations.map((invocation) => withTraceId(traceId, invocation));
}
