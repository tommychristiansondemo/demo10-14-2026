import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { PolicyRecord } from "@claimclarify/shared";
import { InMemoryPolicyStore } from "./store";
import { getCoverage, getDeductibles, getPriorClaims } from "./lookup-tools";

/**
 * Feature: claimclarify, Property 5: Policy not-found leaves store unchanged
 *
 * For any policyId that is absent from the store, each policy-lookup tool
 * (`get_coverage`, `get_deductibles`, `get_prior_claims`) returns a structured
 * NOT_FOUND result identifying the missing policyId, and the store's contents
 * are identical before and after the call.
 *
 * Validates: Requirements 4.5
 */

/** Generator for a single, well-formed policy record. */
const policyRecordArb = (policyId: string): fc.Arbitrary<PolicyRecord> =>
  fc.record({
    policyId: fc.constant(policyId),
    holderName: fc.string(),
    coverage: fc.record({
      collision: fc.boolean(),
      comprehensive: fc.boolean(),
      liabilityLimitUsd: fc.integer({ min: 0, max: 1_000_000 }),
      rentalReimbursement: fc.boolean(),
    }),
    deductibles: fc.record({
      collisionUsd: fc.integer({ min: 0, max: 10_000 }),
      comprehensiveUsd: fc.integer({ min: 0, max: 10_000 }),
    }),
    priorClaims: fc.array(
      fc.record({
        claimId: fc.string(),
        date: fc.constant("2023-01-01"),
        amountUsd: fc.integer({ min: 0, max: 100_000 }),
        atFault: fc.boolean(),
      }),
      { maxLength: 5 },
    ),
  });

/**
 * Smart generator producing:
 *   - a set of records with pairwise-distinct base policyIds, and
 *   - an `absentId` that is guaranteed not to collide with any stored id.
 *
 * Collision is avoided by giving every stored id a shared, reserved prefix and
 * prefixing the absent id with a DIFFERENT reserved prefix, so by construction
 * the absent id can never equal a stored id.
 */
const STORED_PREFIX = "POL-";
const ABSENT_PREFIX = "ABSENT-";

const storeAndAbsentIdArb = fc
  .record({
    // Distinct suffixes guarantee distinct stored ids after prefixing.
    idSuffixes: fc.uniqueArray(
      fc.string({ minLength: 1, maxLength: 20 }),
      { maxLength: 8 },
    ),
    absentSuffix: fc.string({ maxLength: 40 }),
  })
  .chain(({ idSuffixes, absentSuffix }) => {
    const absentId = `${ABSENT_PREFIX}${absentSuffix}`;
    const recordArbs = idSuffixes.map((suffix) =>
      policyRecordArb(`${STORED_PREFIX}${suffix}`),
    );
    return fc.record({
      records:
        recordArbs.length === 0
          ? fc.constant([] as PolicyRecord[])
          : fc.tuple(...recordArbs),
      absentId: fc.constant(absentId),
    });
  });

describe("Property 5: Policy not-found leaves store unchanged (Req 4.5)", () => {
  const tools = [
    ["get_coverage", getCoverage],
    ["get_deductibles", getDeductibles],
    ["get_prior_claims", getPriorClaims],
  ] as const;

  it("absent policyId yields NOT_FOUND naming it; store identical before/after", () => {
    fc.assert(
      fc.property(storeAndAbsentIdArb, ({ records, absentId }) => {
        const store = new InMemoryPolicyStore(records);

        // Snapshot the full store contents before any lookups.
        const before = records.map((r) => store.getByPolicyId(r.policyId));
        const sizeBefore = store.size;

        for (const [, tool] of tools) {
          const result = tool(store, { policyId: absentId });

          // Each tool must return a structured NOT_FOUND naming the id.
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("expected failure");
          expect(result.error.type).toBe("NOT_FOUND");
          expect(result.error.message).toContain(absentId);
        }

        // Store contents are identical before and after the calls.
        const after = records.map((r) => store.getByPolicyId(r.policyId));
        expect(store.size).toBe(sizeBefore);
        expect(after).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });
});
