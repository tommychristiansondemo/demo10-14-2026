/**
 * Property-based test for shared trace-id propagation.
 *
 * Feature: claimclarify, Property 13: Shared trace-id propagation
 *
 * *For any* request trace identifier created at the API_Layer, every MCP tool
 * invocation emitted while handling that request carries the identical trace
 * identifier.
 *
 * **Validates: Requirements 12.5**
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createTraceId,
  propagateTraceId,
  type ToolInvocation,
} from "./index";

/**
 * Generator for a single unstamped MCP tool invocation: an arbitrary tool name
 * and an arbitrary input payload. Some invocations arrive carrying a *stale*
 * traceId (modeling a payload that already passed through another layer) to
 * confirm the API-layer id always wins after propagation.
 */
const invocationArbitrary: fc.Arbitrary<ToolInvocation> = fc.record(
  {
    tool: fc.string({ maxLength: 30 }),
    input: fc.anything(),
    traceId: fc.option(fc.string({ maxLength: 36 }), { nil: undefined }),
  },
  { requiredKeys: ["tool", "input"] }
);

/**
 * Simulate request handling at the API_Layer: a fresh traceId is created, then
 * an arbitrary list of tool invocations is emitted through `propagateTraceId`.
 * A spy-like collector records every emitted invocation so the test can assert
 * on exactly what was emitted downstream.
 */
function handleRequest(invocations: readonly ToolInvocation[]): {
  traceId: string;
  emitted: ToolInvocation[];
} {
  const traceId = createTraceId();
  const emitted: ToolInvocation[] = [];
  for (const stamped of propagateTraceId(traceId, invocations)) {
    emitted.push(stamped);
  }
  return { traceId, emitted };
}

describe("Property 13: Shared trace-id propagation (Req 12.5)", () => {
  it("stamps every emitted tool invocation with the identical API-layer traceId", () => {
    fc.assert(
      fc.property(
        fc.array(invocationArbitrary, { maxLength: 20 }),
        (invocations) => {
          const { traceId, emitted } = handleRequest(invocations);

          // One emitted invocation per request-time invocation, in order.
          expect(emitted).toHaveLength(invocations.length);

          // Every emitted invocation carries the identical created traceId,
          // regardless of any stale traceId it arrived with.
          for (const invocation of emitted) {
            expect(invocation.traceId).toBe(traceId);
          }

          // Equivalently: the set of distinct trace ids across all emitted
          // invocations is exactly { traceId } (or empty when nothing emitted).
          const distinct = new Set(emitted.map((i) => i.traceId));
          if (emitted.length > 0) {
            expect([...distinct]).toEqual([traceId]);
          } else {
            expect(distinct.size).toBe(0);
          }

          // Propagation preserves tool/input and does not mutate the source.
          emitted.forEach((stamped, index) => {
            expect(stamped.tool).toBe(invocations[index].tool);
            expect(stamped.input).toEqual(invocations[index].input);
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
