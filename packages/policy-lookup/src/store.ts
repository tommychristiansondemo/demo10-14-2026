/**
 * Read-only policy store abstraction for the Policy_Lookup_Server, plus an
 * in-memory fake implementation used by tests and property tests.
 *
 * The three lookup tools (`get_coverage`, `get_deductibles`, `get_prior_claims`)
 * build on this interface (task 4.2). The store exposes read-only access to
 * policy data; it never writes or deletes (Req 10.2).
 *
 * See design.md "Policy_Lookup_Server" and "Policy Record (Policy_Table item)".
 */
import type {
  PolicyRecord,
  PolicyCoverage,
  PolicyDeductibles,
  PriorClaim,
} from "@claimclarify/shared";

/**
 * Read-only lookups over the policy data set. Implementations (DynamoDB adapter
 * in task 12, in-memory fake for tests) must never mutate the underlying store.
 *
 * Each getter returns the stored data for an existing `policyId`, or
 * `undefined` when the `policyId` is absent so callers can produce a
 * structured NOT_FOUND result (Req 4.5).
 */
export interface PolicyStore {
  /** Return the full policy record for `policyId`, or `undefined` if absent. */
  getByPolicyId(policyId: string): PolicyRecord | undefined;
  /** Return the coverage details for `policyId`, or `undefined` if absent (Req 4.2). */
  getCoverage(policyId: string): PolicyCoverage | undefined;
  /** Return the deductible amounts for `policyId`, or `undefined` if absent (Req 4.3). */
  getDeductibles(policyId: string): PolicyDeductibles | undefined;
  /** Return the prior claim history for `policyId`, or `undefined` if absent (Req 4.4). */
  getPriorClaims(policyId: string): PriorClaim[] | undefined;
}

/** Deep clone a value so callers cannot mutate the store's internal data. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory {@link PolicyStore} used by unit and property tests. Records are
 * cloned on both insert and read so the stored data is immutable from a
 * caller's perspective, matching the read-only contract (Req 10.2).
 */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly records = new Map<string, PolicyRecord>();

  /**
   * Build a store seeded with the given records. The last record wins if two
   * records share a `policyId`; seeding-integrity enforcement lives in the
   * dedicated seed helpers (task 9), not here.
   */
  constructor(records: readonly PolicyRecord[] = []) {
    for (const record of records) {
      this.records.set(record.policyId, clone(record));
    }
  }

  getByPolicyId(policyId: string): PolicyRecord | undefined {
    const record = this.records.get(policyId);
    return record === undefined ? undefined : clone(record);
  }

  getCoverage(policyId: string): PolicyCoverage | undefined {
    const record = this.records.get(policyId);
    return record === undefined ? undefined : clone(record.coverage);
  }

  getDeductibles(policyId: string): PolicyDeductibles | undefined {
    const record = this.records.get(policyId);
    return record === undefined ? undefined : clone(record.deductibles);
  }

  getPriorClaims(policyId: string): PriorClaim[] | undefined {
    const record = this.records.get(policyId);
    return record === undefined ? undefined : clone(record.priorClaims);
  }

  /** Number of records in the store. Test helper only. */
  get size(): number {
    return this.records.size;
  }
}
