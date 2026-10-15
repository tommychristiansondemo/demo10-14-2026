/**
 * Duplicate-aware seed-apply helper.
 *
 * Pure, deterministic logic shared between the CDK seeding custom resource
 * (task 17.1) and the property tests (task 9.5). It models a conditional-put
 * style batch apply against an existing `Policy_Table` state: a batch is only
 * applied if none of its `policyId`s already exist. If any `policyId` in the
 * batch is already present in the existing state, the apply reports a
 * duplicate-identifier error and leaves every pre-existing record unchanged —
 * it never overwrites an existing record (Req 5.4).
 *
 * This module performs no AWS I/O and never mutates the caller's inputs.
 *
 * See design.md "7. IaC_Template", the error-handling "duplicate policy id"
 * row, and "Property 8: Duplicate-identifier seeding is rejected" (Req 5.4).
 */

import type { PolicyRecord } from "./policy";

/**
 * The existing `Policy_Table` state the batch is applied against. Accepts
 * either a map keyed by `policyId` or a read-only list of records; the helper
 * never mutates it.
 */
export type ExistingPolicies =
  | ReadonlyMap<string, PolicyRecord>
  | readonly PolicyRecord[];

/**
 * A structured duplicate-identifier error. `policyId` names the first batch
 * record whose identifier already exists in the table.
 */
export interface SeedApplyError {
  reason: "DUPLICATE_POLICY_ID";
  message: string;
  policyId: string;
}

/**
 * The result of {@link applySeed}.
 *
 * - `{ ok: true, applied, resulting }`: no `policyId` collided with the
 *   existing state; `applied` is the batch records that were added and
 *   `resulting` is the full post-apply table state (existing + applied) as a
 *   fresh map. The caller's inputs are left untouched.
 * - `{ ok: false, error }`: a `policyId` in the batch already existed; nothing
 *   was applied and every pre-existing record is left unchanged.
 */
export type SeedApplyResult =
  | { ok: true; applied: PolicyRecord[]; resulting: Map<string, PolicyRecord> }
  | { ok: false; error: SeedApplyError };

/** Normalise the existing-state argument into a fresh, owned map. */
function toMap(
  existing: ExistingPolicies
): Map<string, PolicyRecord> {
  if (existing instanceof Map) {
    return new Map(existing);
  }
  const map = new Map<string, PolicyRecord>();
  for (const record of existing as readonly PolicyRecord[]) {
    map.set(record.policyId, record);
  }
  return map;
}

/**
 * Apply a seed batch to an existing `Policy_Table` state with conditional-put
 * semantics (Req 5.4).
 *
 * The batch is applied atomically: it succeeds only if none of its `policyId`s
 * already exist in `existing`. On the first `policyId` collision the function
 * returns a `DUPLICATE_POLICY_ID` error and applies nothing, leaving every
 * pre-existing record unchanged (never overwriting). A `policyId` duplicated
 * within the batch itself is likewise reported as a duplicate, since applying
 * the second occurrence would overwrite the first.
 *
 * This function is pure and never mutates `existing` or `toApply`; the returned
 * `resulting` map is a fresh object owned by the caller.
 *
 * @param existing the current table state (map keyed by policyId or record list).
 * @param toApply the batch of records to seed.
 */
export function applySeed(
  existing: ExistingPolicies,
  toApply: readonly PolicyRecord[]
): SeedApplyResult {
  const resulting = toMap(existing);

  // Track ids added by this batch so a within-batch duplicate is also caught
  // (applying it would overwrite the record added moments earlier).
  const existedBefore = new Set<string>(resulting.keys());
  const applied: PolicyRecord[] = [];

  for (const record of toApply) {
    if (resulting.has(record.policyId)) {
      const where = existedBefore.has(record.policyId)
        ? "already exists in the Policy_Table"
        : "appears more than once in the seed batch";
      return {
        ok: false,
        error: {
          reason: "DUPLICATE_POLICY_ID",
          message: `Policy id "${record.policyId}" ${where}; reporting duplicate-identifier error and leaving the existing record unchanged.`,
          policyId: record.policyId,
        },
      };
    }
    resulting.set(record.policyId, record);
    applied.push(record);
  }

  return { ok: true, applied, resulting };
}
