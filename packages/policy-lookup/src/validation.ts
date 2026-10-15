/**
 * Policy identifier validation for the Policy_Lookup_Server.
 *
 * A tool input's `policyId` must be present, non-empty, and at most
 * `POLICY_ID_MAX_LENGTH` (64) characters. On failure the server returns a
 * structured VALIDATION_ERROR identifying the invalid input and leaves the
 * store unchanged (Req 4.6, 13.2, 13.4).
 */
import {
  POLICY_ID_MAX_LENGTH,
  type StructuredError,
} from "@claimclarify/shared";

/** The field name reported in validation errors for the policy identifier. */
export const POLICY_ID_FIELD = "policyId";

/**
 * Result of validating a policy identifier.
 *
 * - On success, `ok` is `true` and `policyId` is the validated string.
 * - On failure, `ok` is `false` and `error` is a VALIDATION_ERROR naming the
 *   `policyId` field; validation is pure and never mutates any store.
 */
export type PolicyIdValidationResult =
  | { ok: true; policyId: string }
  | { ok: false; error: StructuredError };

/**
 * Validate a policy identifier.
 *
 * Accepts iff the value is a string that is non-empty and no longer than
 * {@link POLICY_ID_MAX_LENGTH} characters. Absent (`undefined`/`null`),
 * non-string, empty, or over-length values are rejected with a structured
 * VALIDATION_ERROR whose `field` is `policyId` (Req 4.6, 13.2, 13.4).
 *
 * This function is pure: it performs no I/O and leaves any policy store
 * unchanged.
 */
export function validatePolicyId(id: unknown): PolicyIdValidationResult {
  if (id === undefined || id === null) {
    return {
      ok: false,
      error: {
        type: "VALIDATION_ERROR",
        field: POLICY_ID_FIELD,
        message: `${POLICY_ID_FIELD} is required but was absent`,
      },
    };
  }

  if (typeof id !== "string") {
    return {
      ok: false,
      error: {
        type: "VALIDATION_ERROR",
        field: POLICY_ID_FIELD,
        message: `${POLICY_ID_FIELD} must be a string`,
      },
    };
  }

  if (id.length === 0) {
    return {
      ok: false,
      error: {
        type: "VALIDATION_ERROR",
        field: POLICY_ID_FIELD,
        message: `${POLICY_ID_FIELD} must not be empty`,
      },
    };
  }

  if (id.length > POLICY_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        type: "VALIDATION_ERROR",
        field: POLICY_ID_FIELD,
        message: `${POLICY_ID_FIELD} must be at most ${POLICY_ID_MAX_LENGTH} characters, received ${id.length}`,
      },
    };
  }

  return { ok: true, policyId: id };
}
