/**
 * Seed policy data set and seed-integrity validation for ClaimClarify.
 *
 * This module provides pure logic and data importable by both the CDK seeding
 * custom resource (task 17.1) and the property tests (task 9.4). It contains no
 * AWS I/O.
 *
 * - {@link SEED_POLICIES}: the realistic sample {@link PolicyRecord}s that the
 *   IaC_Template seeds into the Policy_Table (Req 5.2).
 * - {@link validateSeedSet}: enforces the seed-integrity invariants — at least
 *   5 records, each with coverage/deductibles/priorClaims sections present, and
 *   pairwise-distinct `policyId` values (Req 5.2, 5.3).
 *
 * The duplicate-aware seed-apply helper lives in task 9.2, not here.
 *
 * See design.md "Policy Record (Policy_Table item)" and "Property 7: Seed integrity".
 */

import type { PolicyRecord } from "./policy";

/** Minimum number of records a valid seed set must contain (Req 5.2). */
export const MIN_SEED_RECORDS = 5;

/**
 * The seed policy data set applied to the Policy_Table. Each record carries
 * coverage, deductible, and prior-claim data, and every `policyId` is unique
 * (Req 5.2, 5.3). Values model realistic auto-insurance policies for the demo.
 */
export const SEED_POLICIES: readonly PolicyRecord[] = [
  {
    policyId: "POL-100001",
    holderName: "Dana Whitfield",
    coverage: {
      collision: true,
      comprehensive: true,
      liabilityLimitUsd: 100000,
      rentalReimbursement: false,
    },
    deductibles: {
      collisionUsd: 500,
      comprehensiveUsd: 250,
    },
    priorClaims: [
      { claimId: "CLM-0001", date: "2023-04-12", amountUsd: 3200, atFault: true },
    ],
  },
  {
    policyId: "POL-100002",
    holderName: "Marcus Alvarez",
    coverage: {
      collision: true,
      comprehensive: false,
      liabilityLimitUsd: 50000,
      rentalReimbursement: true,
    },
    deductibles: {
      collisionUsd: 1000,
      comprehensiveUsd: 0,
    },
    priorClaims: [],
  },
  {
    policyId: "POL-100003",
    holderName: "Priya Nair",
    coverage: {
      collision: true,
      comprehensive: true,
      liabilityLimitUsd: 250000,
      rentalReimbursement: true,
    },
    deductibles: {
      collisionUsd: 250,
      comprehensiveUsd: 100,
    },
    priorClaims: [
      { claimId: "CLM-0002", date: "2021-11-03", amountUsd: 850, atFault: false },
      { claimId: "CLM-0003", date: "2024-02-18", amountUsd: 5400, atFault: true },
    ],
  },
  {
    policyId: "POL-100004",
    holderName: "Evelyn Chen",
    coverage: {
      collision: false,
      comprehensive: true,
      liabilityLimitUsd: 100000,
      rentalReimbursement: false,
    },
    deductibles: {
      collisionUsd: 0,
      comprehensiveUsd: 500,
    },
    priorClaims: [
      { claimId: "CLM-0004", date: "2022-07-29", amountUsd: 1500, atFault: false },
    ],
  },
  {
    policyId: "POL-100005",
    holderName: "Theodore Brooks",
    coverage: {
      collision: true,
      comprehensive: true,
      liabilityLimitUsd: 300000,
      rentalReimbursement: true,
    },
    deductibles: {
      collisionUsd: 750,
      comprehensiveUsd: 500,
    },
    priorClaims: [
      { claimId: "CLM-0005", date: "2020-01-15", amountUsd: 12000, atFault: true },
      { claimId: "CLM-0006", date: "2023-09-22", amountUsd: 2300, atFault: false },
      { claimId: "CLM-0007", date: "2024-05-30", amountUsd: 640, atFault: false },
    ],
  },
  {
    policyId: "POL-100006",
    holderName: "Sofia Romano",
    coverage: {
      collision: true,
      comprehensive: false,
      liabilityLimitUsd: 50000,
      rentalReimbursement: false,
    },
    deductibles: {
      collisionUsd: 1500,
      comprehensiveUsd: 0,
    },
    priorClaims: [],
  },
];

/**
 * Result of {@link validateSeedSet}. On success, `ok` is `true`. On failure,
 * `ok` is `false` and `error` is a structured description of the first
 * invariant violated.
 */
export type SeedValidationResult =
  | { ok: true }
  | { ok: false; error: SeedValidationError };

/**
 * A structured seed-integrity error. `reason` names the violated invariant and
 * `details` carries contextual data (e.g. the duplicated policyId or the record
 * index missing a section).
 */
export interface SeedValidationError {
  reason: "TOO_FEW_RECORDS" | "MISSING_SECTION" | "DUPLICATE_POLICY_ID";
  message: string;
  /** For MISSING_SECTION: the index of the offending record. */
  index?: number;
  /** For MISSING_SECTION: the name of the missing/invalid section. */
  section?: "policyId" | "coverage" | "deductibles" | "priorClaims";
  /** For DUPLICATE_POLICY_ID: the policyId that appears more than once. */
  policyId?: string;
}

/** Is the value a non-null, non-array object (a candidate data section)? */
function isObjectSection(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a seed data set against the seed-integrity invariants (Req 5.2, 5.3):
 *
 * 1. the set contains at least {@link MIN_SEED_RECORDS} records;
 * 2. every record has a non-empty `policyId` and the required `coverage`,
 *    `deductibles`, and `priorClaims` sections present;
 * 3. all `policyId` values are pairwise distinct.
 *
 * Returns `{ ok: true }` when every invariant holds, otherwise `{ ok: false }`
 * with a structured error describing the first violation found. The input is
 * never mutated.
 */
export function validateSeedSet(
  records: readonly PolicyRecord[]
): SeedValidationResult {
  if (records.length < MIN_SEED_RECORDS) {
    return {
      ok: false,
      error: {
        reason: "TOO_FEW_RECORDS",
        message: `Seed set must contain at least ${MIN_SEED_RECORDS} records, found ${records.length}.`,
      },
    };
  }

  for (let index = 0; index < records.length; index++) {
    const record = records[index];

    if (typeof record.policyId !== "string" || record.policyId.length === 0) {
      return missingSection(index, "policyId");
    }
    if (!isObjectSection(record.coverage)) {
      return missingSection(index, "coverage");
    }
    if (!isObjectSection(record.deductibles)) {
      return missingSection(index, "deductibles");
    }
    if (!Array.isArray(record.priorClaims)) {
      return missingSection(index, "priorClaims");
    }
  }

  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.policyId)) {
      return {
        ok: false,
        error: {
          reason: "DUPLICATE_POLICY_ID",
          message: `Duplicate policyId '${record.policyId}' found in seed set; policyIds must be pairwise distinct.`,
          policyId: record.policyId,
        },
      };
    }
    seen.add(record.policyId);
  }

  return { ok: true };
}

/** Build a MISSING_SECTION {@link SeedValidationResult} for a record/section. */
function missingSection(
  index: number,
  section: NonNullable<SeedValidationError["section"]>
): SeedValidationResult {
  return {
    ok: false,
    error: {
      reason: "MISSING_SECTION",
      message: `Record at index ${index} is missing or has an invalid '${section}' section.`,
      index,
      section,
    },
  };
}
