/**
 * Policy data model stored in the Policy_Table and returned by the
 * Policy_Lookup_Server.
 *
 * See design.md "Policy Record (Policy_Table item)".
 */

/** Maximum allowed length of a policy identifier (Req 4.6). */
export const POLICY_ID_MAX_LENGTH = 64;

/** Coverage details for a policy. */
export interface PolicyCoverage {
  collision: boolean;
  comprehensive: boolean;
  liabilityLimitUsd: number;
  rentalReimbursement: boolean;
}

/** Deductible amounts for a policy. */
export interface PolicyDeductibles {
  collisionUsd: number;
  comprehensiveUsd: number;
}

/** A single prior claim entry in a policy's history. */
export interface PriorClaim {
  claimId: string;
  /** ISO-8601 date string (YYYY-MM-DD). */
  date: string;
  amountUsd: number;
  atFault: boolean;
}

/**
 * A full policy record. `policyId` is the partition key and is unique across
 * the Policy_Table (Req 5.3).
 */
export interface PolicyRecord {
  policyId: string;
  holderName: string;
  coverage: PolicyCoverage;
  deductibles: PolicyDeductibles;
  priorClaims: PriorClaim[];
}
