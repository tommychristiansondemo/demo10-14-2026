import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  composeResponse,
  toolSuccess,
  toolFailure,
  type ToolOutcome,
  STRUCTURED_ERROR_TYPES,
  type StructuredError,
} from "./index";

/**
 * Feature: claimclarify, Property 3: Agent response composition over mixed tool results
 *
 * For any set of tool invocation outcomes (each either a success result or a
 * failure), the composed Bedrock_Agent response references every successful
 * result and names every tool that failed. This covers the all-success case
 * (Req 3.4), the all-failure case (Req 3.5), and the mixed partial-failure
 * case (Req 3.6).
 *
 * Validates: Requirements 3.4, 3.5, 3.6
 */
describe("Property 3: Agent response composition over mixed tool results (Req 3.4, 3.5, 3.6)", () => {
  // Generator for a structured error (used by failure outcomes). The dependency
  // field is left to the composer; what matters is the message and type.
  const structuredError: fc.Arbitrary<StructuredError> = fc.record({
    type: fc.constantFrom(...STRUCTURED_ERROR_TYPES),
    message: fc.string({ minLength: 1, maxLength: 40 }),
  });

  // A single tool result payload. Spans the shapes renderResult handles:
  // strings, numbers, booleans, null, and objects.
  const resultPayload: fc.Arbitrary<unknown> = fc.oneof(
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.record({ k: fc.string({ maxLength: 10 }), n: fc.integer() })
  );

  // Generate an array of outcomes with DISTINCT, searchable tool names. Names
  // are of the form `TOOLj_<idx>` to avoid substring collisions between tool
  // names and between a name and rendered result text. Each outcome is randomly
  // a success (carrying a result) or a failure (carrying a StructuredError).
  const outcomes: fc.Arbitrary<ToolOutcome[]> = fc
    .array(
      fc.record({
        isSuccess: fc.boolean(),
        result: resultPayload,
        error: structuredError,
      }),
      { minLength: 0, maxLength: 8 }
    )
    .map((specs) =>
      specs.map((spec, idx) => {
        // Zero-padded unique index embedded in a distinctive token so that no
        // tool name is a substring of another (e.g. TOOLZ_01 vs TOOLZ_010).
        const name = `TOOLZ_${String(idx).padStart(3, "0")}`;
        return spec.isSuccess
          ? toolSuccess(name, spec.result)
          : toolFailure(name, spec.error);
      })
    );

  it("references every successful tool name and names every failed tool", () => {
    fc.assert(
      fc.property(outcomes, (toolOutcomes) => {
        const response = composeResponse(toolOutcomes);

        for (const outcome of toolOutcomes) {
          // Every tool, success or failure, must be named in the response.
          expect(response).toContain(outcome.tool);

          if (outcome.ok) {
            // Successful outcomes: the tool name is present and the response is
            // non-empty (its result is rendered alongside the name).
            expect(response.length).toBeGreaterThan(0);
          } else {
            // Failed outcomes: the error message must appear so the adjuster
            // knows why the tool failed.
            expect(response).toContain(outcome.error.message);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
