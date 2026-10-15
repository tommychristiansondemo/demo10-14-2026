/**
 * Property-based test for seed-integrity validation.
 *
 * Feature: claimclarify, Property 7: Seed integrity
 *
 * *For any* seed data set the IaC_Template applies, the seeded `Policy_Table`
 * contains at least 5 records, every record contains coverage, deductible, and
 * prior-claim data, and all `policyId` values are pairwise distinct.
 *
 * **Validates: Requirements 5.2, 5.3**
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { PolicyRecord } from "./policy";
import { SEED_POLICIES, MIN_SEED_RECORDS, validateSeedSet } from "./index";

/** Minimum fast-check iterations required by the design's testing strategy. */
const NUM_RUNS = 300;

/** Generate the coverage section of a policy record. */
const coverageArbitrary = fc.record({
  collision: fc.boolean(),
  comprehensive: fc.boolean(),
  liabilityLimitUsd: fc.integer({ min: 0, max: 1_000_000 }),
  rentalReimbursement: fc.boolean(),
});

/** Generate the deductibles section of a policy record. */
const deductiblesArbitrary = fc.record({
  collisionUsd: fc.integer({ min: 0, max: 5_000 }),
  comprehensiveUsd: fc.integer({ min: 0, max: 5_000 }),
});

/** Generate a single prior-claim entry. */
const priorClaimArbitrary = fc.record({
  claimId: fc.string({ minLength: 1, maxLength: 12 }),
  date: fc.constant("2023-01-01"),
  amountUsd: fc.integer({ min: 0, max: 50_000 }),
  atFault: fc.boolean(),
});

/**
 * Build a well-formed {@link PolicyRecord} with the given `policyId`. Every
 * section (coverage/deductibles/priorClaims) is present and well-typed, so the
 * only remaining invariant the surrounding set must satisfy is uniqueness.
 */
function recordWithId(policyId: string): fc.Arbitrary<PolicyRecord> {
  return fc.record({
    policyId: fc.constant(policyId),
    holderName: fc.string({ minLength: 1, maxLength: 20 }),
    coverage: coverageArbitrary,
    deductibles: deductiblesArbitrary,
    priorClaims: fc.array(priorClaimArbitrary, { maxLength: 4 }),
  });
}

/**
 * Policy-store generator producing a VALID seed set: at least
 * {@link MIN_SEED_RECORDS} records, each with all data sections, and with
 * pairwise-distinct `policyId` values (guaranteed via a uniqueness constraint
 * on the id source).
 */
const validSeedSetArbitrary: fc.Arbitrary<PolicyRecord[]> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
    minLength: MIN_SEED_RECORDS,
    maxLength: MIN_SEED_RECORDS + 8,
  })
  .chain((ids) =>
    fc.tuple(...ids.map((id) => recordWithId(id)))
  )
  .map((records) => [...records]);

/** The invalid-set shapes we deliberately construct, keyed by expected reason. */
type InvalidKind = "TOO_FEW_RECORDS" | "MISSING_SECTION" | "DUPLICATE_POLICY_ID";

/**
 * Generator producing INVALID seed sets paired with the failure reason the
 * validator must report. Covers each distinct invariant violation:
 * too few records, a missing data section, and a duplicated policyId.
 */
const invalidSeedSetArbitrary: fc.Arbitrary<{
  kind: InvalidKind;
  records: PolicyRecord[];
  section?: string;
}> = fc.oneof(
  // TOO_FEW_RECORDS: a well-formed set with fewer than MIN_SEED_RECORDS records.
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 0,
      maxLength: MIN_SEED_RECORDS - 1,
    })
    .chain((ids) => fc.tuple(...ids.map((id) => recordWithId(id))))
    .map((records) => ({
      kind: "TOO_FEW_RECORDS" as const,
      records: [...records],
    })),

  // MISSING_SECTION: a sufficiently large, otherwise-valid set with one record
  // whose coverage/deductibles/priorClaims section is stripped out.
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: MIN_SEED_RECORDS,
      maxLength: MIN_SEED_RECORDS + 4,
    })
    .chain((ids) =>
      fc
        .tuple(...ids.map((id) => recordWithId(id)))
        .chain((records) =>
          fc
            .tuple(
              fc.integer({ min: 0, max: records.length - 1 }),
              fc.constantFrom("coverage", "deductibles", "priorClaims")
            )
            .map(([index, section]) => {
              const mutated = records.map((r) => ({ ...r }));
              // Remove the chosen section to violate the "has data" invariant.
              delete (mutated[index] as Record<string, unknown>)[section];
              return {
                kind: "MISSING_SECTION" as const,
                records: mutated as unknown as PolicyRecord[],
                section,
              };
            })
        )
    ),

  // DUPLICATE_POLICY_ID: a well-formed set in which one policyId is repeated.
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: MIN_SEED_RECORDS,
      maxLength: MIN_SEED_RECORDS + 4,
    })
    .chain((ids) =>
      fc
        .tuple(...ids.map((id) => recordWithId(id)))
        .chain((records) =>
          fc
            .tuple(
              fc.integer({ min: 0, max: records.length - 1 }),
              fc.integer({ min: 1, max: records.length - 1 })
            )
            .map(([source, offset]) => {
              // Pick a target distinct from the source so the copy below always
              // introduces a genuine duplicate (never a self-copy no-op).
              const target = (source + offset) % records.length;
              const mutated = records.map((r) => ({ ...r }));
              // Force a duplicate by copying source's id onto target.
              mutated[target] = {
                ...mutated[target],
                policyId: mutated[source].policyId,
              };
              return {
                kind: "DUPLICATE_POLICY_ID" as const,
                records: [...mutated],
              };
            })
        )
    )
);

describe("Property 7: Seed integrity (Req 5.2, 5.3)", () => {
  it("accepts any set with >=5 records, full sections, and distinct policyIds", () => {
    fc.assert(
      fc.property(validSeedSetArbitrary, (records) => {
        const result = validateSeedSet(records);
        expect(result.ok).toBe(true);

        // Sanity-check the invariants the generator is meant to guarantee.
        expect(records.length).toBeGreaterThanOrEqual(MIN_SEED_RECORDS);
        const ids = records.map((r) => r.policyId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const record of records) {
          expect(record.coverage).toBeTypeOf("object");
          expect(record.deductibles).toBeTypeOf("object");
          expect(Array.isArray(record.priorClaims)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("rejects invalid sets with the correct failure reason", () => {
    fc.assert(
      fc.property(invalidSeedSetArbitrary, ({ kind, records, section }) => {
        const result = validateSeedSet(records);
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }

        // For the duplicate case a stripped section could also exist only when
        // we mutate it; our generators keep these shapes disjoint, so the
        // reported reason must match the kind we constructed.
        expect(result.error.reason).toBe(kind);

        if (kind === "MISSING_SECTION") {
          expect(result.error.section).toBe(section);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("accepts the shipped SEED_POLICIES data set", () => {
    const result = validateSeedSet(SEED_POLICIES);
    expect(result.ok).toBe(true);
    expect(SEED_POLICIES.length).toBeGreaterThanOrEqual(MIN_SEED_RECORDS);
    const ids = SEED_POLICIES.map((r) => r.policyId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
