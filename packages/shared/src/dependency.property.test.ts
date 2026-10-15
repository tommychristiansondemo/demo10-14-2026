import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { normalizeDependencyError } from "./index";

/**
 * Feature: claimclarify, Property 15: Structured dependency-error shape
 *
 * For any downstream dependency failure, the calling component returns a
 * structured error result whose `type` is `DEPENDENCY_ERROR` (or `TIMEOUT`)
 * and whose `dependency` names the failed dependency, preserving the shared
 * `traceId` for correlation.
 *
 * Validates: Requirements 13.5
 */
describe("Property 15: Structured dependency-error shape (Req 13.5)", () => {
  // Non-empty dependency names: anything a component might call downstream.
  const dependencyName = fc.string({ minLength: 1, maxLength: 64 });

  // Arbitrary causes: Errors, strings, numbers, objects, null/undefined — the
  // normalizer must handle any thrown/returned value without leaking it.
  const cause = fc.oneof(
    fc.string().map((m) => new Error(m)),
    fc.string(),
    fc.integer(),
    fc.record({ code: fc.string(), detail: fc.string() }),
    fc.constant(null),
    fc.constant(undefined)
  );

  // Whether the downstream failure is a timeout (-> TIMEOUT) or a generic
  // dependency failure (-> DEPENDENCY_ERROR).
  const timeout = fc.boolean();

  // traceId is sometimes provided (and must be preserved) and sometimes absent.
  const traceId = fc.option(fc.string(), { nil: undefined });

  it("normalizes any downstream failure to DEPENDENCY_ERROR/TIMEOUT naming the dependency", () => {
    fc.assert(
      fc.property(
        dependencyName,
        cause,
        timeout,
        traceId,
        (name, failureCause, isTimeout, maybeTraceId) => {
          const result = normalizeDependencyError(
            name,
            { cause: failureCause, timeout: isTimeout },
            maybeTraceId
          );

          // type reflects the timeout flag.
          expect(result.type).toBe(isTimeout ? "TIMEOUT" : "DEPENDENCY_ERROR");

          // dependency always names the failed dependency.
          expect(result.dependency).toBe(name);

          // traceId is preserved when provided; defaults to "" when absent.
          expect(result.traceId).toBe(maybeTraceId ?? "");

          // message is always a non-empty human-readable string that does not
          // leak structured internals (it is a plain string).
          expect(typeof result.message).toBe("string");
          expect(result.message.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("accepts a bare boolean timeout flag as shorthand", () => {
    fc.assert(
      fc.property(dependencyName, fc.boolean(), fc.string(), (name, isTimeout, tid) => {
        const result = normalizeDependencyError(name, isTimeout, tid);
        expect(result.type).toBe(isTimeout ? "TIMEOUT" : "DEPENDENCY_ERROR");
        expect(result.dependency).toBe(name);
        expect(result.traceId).toBe(tid);
      }),
      { numRuns: 100 }
    );
  });
});
