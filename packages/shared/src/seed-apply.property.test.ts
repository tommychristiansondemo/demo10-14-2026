import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applySeed } from "./seed-apply";
import type { PolicyRecord } from "./policy";

/**
 * Feature: claimclarify, Property 8: Duplicate-identifier seeding is rejected
 *
 * For any seed batch that contains a `policyId` already present in the
 * `Policy_Table`, the IaC_Template reports a duplicate-identifier error and the
 * pre-existing record for that `policyId` is left unchanged (not overwritten).
 *
 * Validates: Requirements 5.4
 */
describe("Property 8: Duplicate-identifier seeding is rejected (Req 5.4)", () => {
  /** Build a PolicyRecord from a policyId and an integer seed for its fields. */
  function makeRecord(policyId: string, variant: number): PolicyRecord {
    return {
      policyId,
      holderName: `Holder ${variant}`,
      coverage: {
        collision: variant % 2 === 0,
        comprehensive: variant % 3 === 0,
        liabilityLimitUsd: 50000 + variant * 1000,
        rentalReimbursement: variant % 5 === 0,
      },
      deductibles: {
        collisionUsd: (variant % 4) * 250,
        comprehensiveUsd: (variant % 3) * 100,
      },
      priorClaims:
        variant % 2 === 0
          ? []
          : [
              {
                claimId: `CLM-${variant}`,
                date: "2023-01-01",
                amountUsd: variant * 10,
                atFault: variant % 2 === 1,
              },
            ],
    };
  }

  // Generator: a set of distinct policyIds to seed the existing table state,
  // plus the index of the one that will be duplicated in the applied batch,
  // and distinct extra ids for other (non-colliding) batch records.
  const scenario = fc
    .uniqueArray(
      fc.string({ minLength: 1, maxLength: 12 }).map((s) => `POL-${s}`),
      { minLength: 1, maxLength: 6, selector: (id) => id }
    )
    .chain((existingIds) =>
      fc.record({
        existingIds: fc.constant(existingIds),
        // Which existing id the batch will collide with.
        collisionIndex: fc.integer({ min: 0, max: existingIds.length - 1 }),
        // Distinct variants so existing vs batch records differ in field values.
        existingVariants: fc.array(fc.integer({ min: 0, max: 1000 }), {
          minLength: existingIds.length,
          maxLength: existingIds.length,
        }),
        // Field variant for the duplicate batch record (differs from existing).
        duplicateVariant: fc.integer({ min: 1001, max: 2000 }),
        // Extra non-colliding batch records (fresh ids), placed around the dup.
        extraIds: fc.uniqueArray(
          fc.string({ minLength: 1, maxLength: 10 }).map((s) => `NEW-${s}`),
          { minLength: 0, maxLength: 4, selector: (id) => id }
        ),
        extraVariants: fc.array(fc.integer({ min: 2001, max: 3000 }), {
          minLength: 4,
          maxLength: 4,
        }),
        // Where in the batch to place the duplicate record.
        dupPosition: fc.nat(),
      })
    );

  it("rejects a batch containing an existing policyId, leaves the record unchanged, and does not mutate inputs", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const {
          existingIds,
          collisionIndex,
          existingVariants,
          duplicateVariant,
          extraIds,
          extraVariants,
          dupPosition,
        } = s;

        // Build the existing table state (list of records with unique ids).
        const existing: PolicyRecord[] = existingIds.map((id, i) =>
          makeRecord(id, existingVariants[i])
        );
        const duplicatedId = existingIds[collisionIndex];
        const originalRecord = existing[collisionIndex];

        // Deep snapshot of the existing input to detect any mutation.
        const existingSnapshot = JSON.parse(JSON.stringify(existing));

        // The duplicate batch record reuses an existing id but with different
        // field values, so an overwrite would be observable.
        const duplicateRecord = makeRecord(duplicatedId, duplicateVariant);

        // Extra non-colliding records (fresh NEW- ids).
        const extraRecords = extraIds.map((id, i) =>
          makeRecord(id, extraVariants[i])
        );

        // Insert the duplicate at a position within the batch.
        const batch = [...extraRecords];
        const pos = batch.length === 0 ? 0 : dupPosition % (batch.length + 1);
        batch.splice(pos, 0, duplicateRecord);

        const batchSnapshot = JSON.parse(JSON.stringify(batch));

        const result = applySeed(existing, batch);

        // The batch must be rejected with a duplicate-identifier error.
        expect(result.ok).toBe(false);
        if (result.ok) return; // narrow for TS; unreachable given assertion above
        expect(result.error.reason).toBe("DUPLICATE_POLICY_ID");
        expect(result.error.policyId).toBe(duplicatedId);

        // The pre-existing record for the duplicated id is unchanged: compare
        // against the original existing state (not the overwriting batch record).
        expect(existing[collisionIndex]).toEqual(originalRecord);
        expect(originalRecord).not.toEqual(duplicateRecord);

        // applySeed never mutates its inputs.
        expect(existing).toEqual(existingSnapshot);
        expect(batch).toEqual(batchSnapshot);
      }),
      { numRuns: 100 }
    );
  });
});
