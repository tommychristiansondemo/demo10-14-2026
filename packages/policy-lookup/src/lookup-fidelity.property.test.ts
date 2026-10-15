import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { PolicyRecord } from "@claimclarify/shared";
import { POLICY_ID_MAX_LENGTH } from "@claimclarify/shared";
import { InMemoryPolicyStore } from "./store";
import { getCoverage, getDeductibles, getPriorClaims } from "./lookup-tools";

/**
 * Feature: claimclarify, Property 4: Policy lookup fidelity
 *
 * For any policy record present in the store and any of the three lookup tools
 * (`get_coverage`, `get_deductibles`, `get_prior_claims`), invoking that tool
 * with the record's `policyId` returns exactly the corresponding data stored
 * for that policy.
 *
 * Validates: Requirements 4.2, 4.3, 4.4
 */

// Generator for a single prior-claim entry.
const priorClaimArb: fc.Arbitrary<PolicyRecord["priorClaims"][number]> =
  fc.record({
    claimId: fc.string({ minLength: 1, maxLength: 16 }),
    date: fc.date({ min: new Date("2000-01-01"), max: new Date("2030-12-31") }).map(
      (d) => d.toISOString().slice(0, 10),
    ),
    amountUsd: fc.integer({ min: 0, max: 100000 }),
    atFault: fc.boolean(),
  });

// Generator for a valid policy record with all three data sections populated.
// The policyId respects the server's constraints (non-empty, <= 64 chars).
function policyRecordArb(policyId: string): fc.Arbitrary<PolicyRecord> {
  return fc.record({
    policyId: fc.constant(policyId),
    holderName: fc.string({ minLength: 1, maxLength: 40 }),
    coverage: fc.record({
      collision: fc.boolean(),
      comprehensive: fc.boolean(),
      liabilityLimitUsd: fc.integer({ min: 0, max: 1000000 }),
      rentalReimbursement: fc.boolean(),
    }),
    deductibles: fc.record({
      collisionUsd: fc.integer({ min: 0, max: 5000 }),
      comprehensiveUsd: fc.integer({ min: 0, max: 5000 }),
    }),
    priorClaims: fc.array(priorClaimArb, { maxLength: 5 }),
  });
}

// Policy-store generator: produces a non-empty set of records with pairwise
// distinct, valid policyIds (each coverage/deductibles/priorClaims populated).
const policyStoreArb: fc.Arbitrary<PolicyRecord[]> = fc
  .uniqueArray(
    // Valid policyId: non-empty and within the 64-char maximum.
    fc.string({ minLength: 1, maxLength: POLICY_ID_MAX_LENGTH }),
    { minLength: 1, maxLength: 8 },
  )
  .chain((ids) => fc.tuple(...ids.map((id) => policyRecordArb(id))));

describe("Property 4: Policy lookup fidelity (Req 4.2, 4.3, 4.4)", () => {
  it("each lookup tool returns exactly the stored data for a present policyId", () => {
    fc.assert(
      fc.property(
        policyStoreArb,
        // Pick which present record to look up by index into the record set.
        fc.nat(),
        (records, pickRaw) => {
          const store = new InMemoryPolicyStore(records);
          const target = records[pickRaw % records.length];

          const coverage = getCoverage(store, { policyId: target.policyId });
          expect(coverage).toEqual({ ok: true, data: target.coverage });

          const deductibles = getDeductibles(store, {
            policyId: target.policyId,
          });
          expect(deductibles).toEqual({ ok: true, data: target.deductibles });

          const priorClaims = getPriorClaims(store, {
            policyId: target.policyId,
          });
          expect(priorClaims).toEqual({ ok: true, data: target.priorClaims });
        },
      ),
      { numRuns: 100 },
    );
  });
});
