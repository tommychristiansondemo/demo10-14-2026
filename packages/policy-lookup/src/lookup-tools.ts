/**
 * The three read-only lookup tools of the Policy_Lookup_Server:
 * `get_coverage`, `get_deductibles`, and `get_prior_claims` (task 4.2).
 *
 * Each tool is pure logic over the {@link PolicyStore} interface (the
 * DynamoDB-backed adapter arrives in task 12). Every tool:
 *
 * - validates `policyId` via {@link validatePolicyId} first, returning the
 *   structured VALIDATION_ERROR on failure (Req 4.6, 13.2, 13.4);
 * - returns exactly the stored data for an existing `policyId`
 *   (Req 4.2, 4.3, 4.4);
 * - returns a structured NOT_FOUND naming the missing id when absent, leaving
 *   the store unchanged (Req 4.5);
 * - never writes or deletes — all store access is read-only (Req 10.2).
 *
 * See design.md "Policy_Lookup_Server".
 */
import type {
  PolicyCoverage,
  PolicyDeductibles,
  PriorClaim,
  StructuredError,
} from "@claimclarify/shared";

import type { PolicyStore } from "./store";
import { POLICY_ID_FIELD, validatePolicyId } from "./validation";

/**
 * Discriminated result returned by every lookup tool.
 *
 * - On success, `ok` is `true` and `data` is exactly the stored value.
 * - On failure, `ok` is `false` and `error` is a structured VALIDATION_ERROR
 *   (invalid `policyId`) or NOT_FOUND (absent `policyId`).
 */
export type LookupResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StructuredError };

/** Raw (untrusted) input shape accepted by each lookup tool. */
export interface PolicyLookupInput {
  policyId?: unknown;
}

/** Build a NOT_FOUND structured error naming the missing `policyId` (Req 4.5). */
function notFoundError(policyId: string): StructuredError {
  return {
    type: "NOT_FOUND",
    field: POLICY_ID_FIELD,
    message: `No policy found for ${POLICY_ID_FIELD} '${policyId}'`,
  };
}

/**
 * Shared skeleton for the three lookup tools: validate `policyId`, then read
 * the requested slice from the store, mapping an absent record to NOT_FOUND.
 *
 * `read` returns the stored value or `undefined` when the policy is absent.
 * The store is only ever read, never mutated (Req 10.2).
 */
function lookup<T>(
  store: PolicyStore,
  input: PolicyLookupInput,
  read: (store: PolicyStore, policyId: string) => T | undefined,
): LookupResult<T> {
  const validation = validatePolicyId(input?.policyId);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const { policyId } = validation;
  const data = read(store, policyId);
  if (data === undefined) {
    return { ok: false, error: notFoundError(policyId) };
  }

  return { ok: true, data };
}

/**
 * `get_coverage` tool: return the coverage details for the given `policyId`
 * (Req 4.2). Invalid id → VALIDATION_ERROR; absent id → NOT_FOUND; store
 * unchanged.
 */
export function getCoverage(
  store: PolicyStore,
  input: PolicyLookupInput,
): LookupResult<PolicyCoverage> {
  return lookup(store, input, (s, id) => s.getCoverage(id));
}

/**
 * `get_deductibles` tool: return the deductible amounts for the given
 * `policyId` (Req 4.3). Invalid id → VALIDATION_ERROR; absent id → NOT_FOUND;
 * store unchanged.
 */
export function getDeductibles(
  store: PolicyStore,
  input: PolicyLookupInput,
): LookupResult<PolicyDeductibles> {
  return lookup(store, input, (s, id) => s.getDeductibles(id));
}

/**
 * `get_prior_claims` tool: return the prior claim history for the given
 * `policyId` (Req 4.4). Invalid id → VALIDATION_ERROR; absent id → NOT_FOUND;
 * store unchanged.
 */
export function getPriorClaims(
  store: PolicyStore,
  input: PolicyLookupInput,
): LookupResult<PriorClaim[]> {
  return lookup(store, input, (s, id) => s.getPriorClaims(id));
}
