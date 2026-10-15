/**
 * Dependency-error normalization (pure).
 *
 * When a component calls a downstream dependency that fails, it must not leak
 * the raw downstream error. Instead it returns a structured error whose `type`
 * is `DEPENDENCY_ERROR` (or `TIMEOUT` when the failure is a timeout) and whose
 * `dependency` names the failed dependency, preserving the shared `traceId`
 * for cross-layer correlation.
 *
 * See design.md "Propagation principle (Req 13.5)" and
 * "Structured Error Result (shared across components — Req 13.4, 13.5)".
 */

import type { StructuredError } from "./errors";

/**
 * A structured dependency error carrying the shared trace id for correlation.
 * `type` is constrained to the two downstream-failure categories and
 * `dependency` is always populated.
 */
export interface DependencyError extends StructuredError {
  type: "DEPENDENCY_ERROR" | "TIMEOUT";
  dependency: string;
  traceId: string;
}

/**
 * Describes a downstream failure to normalize. `timeout` distinguishes a
 * timeout (yielding `TIMEOUT`) from a generic dependency failure (yielding
 * `DEPENDENCY_ERROR`).
 */
export interface DependencyFailure {
  /** The underlying failure (an Error, a value, or anything thrown/returned). */
  cause?: unknown;
  /** When true, the failure is a timeout and maps to `type = TIMEOUT`. */
  timeout?: boolean;
}

/**
 * Extract a human-readable message from an arbitrary downstream cause without
 * leaking structured internals.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (cause === undefined || cause === null) {
    return "no additional detail";
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Normalize a downstream failure into a structured {@link DependencyError}.
 *
 * The result always has `dependency` set to `dependencyName`, `traceId` set to
 * the shared trace id, and `type` set to `TIMEOUT` when `failure.timeout` is
 * truthy, otherwise `DEPENDENCY_ERROR` (Req 13.5).
 *
 * @param dependencyName name of the failed downstream dependency
 * @param failure        the downstream failure (cause + optional timeout flag);
 *                       a bare `boolean` is accepted as shorthand for the
 *                       timeout flag
 * @param traceId        the shared trace id to preserve for correlation
 */
export function normalizeDependencyError(
  dependencyName: string,
  failure?: DependencyFailure | boolean,
  traceId = ""
): DependencyError {
  const normalizedFailure: DependencyFailure =
    typeof failure === "boolean" ? { timeout: failure } : failure ?? {};

  const isTimeout = normalizedFailure.timeout === true;
  const detail = describeCause(normalizedFailure.cause);
  const message = isTimeout
    ? `Dependency '${dependencyName}' timed out: ${detail}`
    : `Dependency '${dependencyName}' failed: ${detail}`;

  return {
    type: isTimeout ? "TIMEOUT" : "DEPENDENCY_ERROR",
    dependency: dependencyName,
    message,
    traceId,
  };
}
