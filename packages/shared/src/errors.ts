/**
 * Structured error result shared across all ClaimClarify components.
 *
 * See design.md "Structured Error Result (shared across components — Req 13.4, 13.5)".
 */

/**
 * The set of structured error categories a component can return.
 *
 * - `VALIDATION_ERROR`: input failed schema/constraint validation (Req 13.4).
 * - `NOT_FOUND`: a requested resource (e.g. a policy id) does not exist (Req 4.5).
 * - `DEPENDENCY_ERROR`: a downstream dependency returned an error (Req 13.5).
 * - `TIMEOUT`: a downstream dependency did not respond in time (Req 2.5, 3.5).
 * - `CONFIG_ERROR`: a required configuration value/secret could not be retrieved (Req 15.3).
 */
export type StructuredErrorType =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DEPENDENCY_ERROR"
  | "TIMEOUT"
  | "CONFIG_ERROR";

/**
 * The ordered tuple of all structured error types. Useful for validation,
 * generators, and exhaustiveness checks.
 */
export const STRUCTURED_ERROR_TYPES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "DEPENDENCY_ERROR",
  "TIMEOUT",
  "CONFIG_ERROR",
] as const satisfies readonly StructuredErrorType[];

/**
 * A structured error. `field` is populated for validation errors to name the
 * failing field; `dependency` is populated for dependency/timeout errors to
 * name the failed dependency. `message` is always a human-readable description.
 */
export interface StructuredError {
  type: StructuredErrorType;
  /** Present for VALIDATION_ERROR: the name of the failing field. */
  field?: string;
  /** Present for DEPENDENCY_ERROR / TIMEOUT: the name of the failed dependency. */
  dependency?: string;
  message: string;
}

/**
 * Envelope wrapping a {@link StructuredError}, matching the on-the-wire shape
 * used by MCP tools and the API layer.
 */
export interface StructuredErrorResult {
  error: StructuredError;
}

/** Type guard: is the given value a well-formed {@link StructuredError}? */
export function isStructuredError(value: unknown): value is StructuredError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    (STRUCTURED_ERROR_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.message === "string" &&
    (candidate.field === undefined || typeof candidate.field === "string") &&
    (candidate.dependency === undefined || typeof candidate.dependency === "string")
  );
}
