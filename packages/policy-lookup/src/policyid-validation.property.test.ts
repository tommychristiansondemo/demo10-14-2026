import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { POLICY_ID_MAX_LENGTH } from "@claimclarify/shared";
import { validatePolicyId, POLICY_ID_FIELD } from "./validation";

/**
 * Feature: claimclarify, Property 6: Policy identifier validation
 *
 * For any tool input whose `policyId` is absent, empty, or longer than 64
 * characters, the Policy_Lookup_Server returns a structured VALIDATION_ERROR
 * identifying the invalid input and leaves the store unchanged.
 *
 * `validatePolicyId` is pure (performs no I/O), so "store unchanged" is
 * inherent: the property asserts the function returns a pure structured result
 * without throwing. A complementary check confirms that valid ids (1..64
 * characters) are accepted and echoed back unchanged.
 *
 * Validates: Requirements 4.6, 13.2
 */
describe("Property 6: Policy identifier validation (Req 4.6, 13.2)", () => {
  // Generator over invalid policyId inputs spanning every rejection reason:
  //   - absent values (undefined / null)
  //   - empty string
  //   - over-length strings (length 65..N)
  //   - non-string values
  const invalidPolicyId: fc.Arbitrary<unknown> = fc.oneof(
    // Absent inputs.
    fc.constant(undefined),
    fc.constant(null),
    // Empty string.
    fc.constant(""),
    // Over-length strings: lengths strictly greater than the max (65..max+64).
    fc
      .integer({ min: POLICY_ID_MAX_LENGTH + 1, max: POLICY_ID_MAX_LENGTH + 64 })
      .chain((len) => fc.string({ minLength: len, maxLength: len })),
    // Non-string values that are also present (not undefined/null).
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.object(),
    fc.array(fc.anything())
  );

  it("rejects absent, empty, over-length, or non-string ids with a VALIDATION_ERROR naming policyId", () => {
    fc.assert(
      fc.property(invalidPolicyId, (input) => {
        // Pure call must never throw regardless of input.
        const result = validatePolicyId(input);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.type).toBe("VALIDATION_ERROR");
          expect(result.error.field).toBe(POLICY_ID_FIELD);
          expect(typeof result.error.message).toBe("string");
          expect(result.error.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Complementary check: any string whose length is within [1, 64] is accepted
  // and returned unchanged. This guards against an over-eager validator that
  // would reject valid identifiers.
  const validPolicyId: fc.Arbitrary<string> = fc
    .integer({ min: 1, max: POLICY_ID_MAX_LENGTH })
    .chain((len) => fc.string({ minLength: len, maxLength: len }));

  it("accepts ids of length 1..64 and returns them unchanged", () => {
    fc.assert(
      fc.property(validPolicyId, (id) => {
        const result = validatePolicyId(id);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.policyId).toBe(id);
        }
      }),
      { numRuns: 100 }
    );
  });
});
