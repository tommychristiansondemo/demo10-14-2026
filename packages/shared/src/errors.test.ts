import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  STRUCTURED_ERROR_TYPES,
  isStructuredError,
  type StructuredError,
} from "./index";

describe("shared types & tooling smoke", () => {
  it("exposes all five structured error types", () => {
    expect(STRUCTURED_ERROR_TYPES).toEqual([
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "DEPENDENCY_ERROR",
      "TIMEOUT",
      "CONFIG_ERROR",
    ]);
  });

  it("isStructuredError accepts any well-formed structured error (fast-check smoke)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STRUCTURED_ERROR_TYPES),
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (type, message, field, dependency) => {
          const err: StructuredError = { type, message, field, dependency };
          expect(isStructuredError(err)).toBe(true);
        }
      )
    );
  });

  it("isStructuredError rejects non-structured values", () => {
    expect(isStructuredError(null)).toBe(false);
    expect(isStructuredError({ type: "NOPE", message: "x" })).toBe(false);
    expect(isStructuredError({ type: "TIMEOUT" })).toBe(false);
  });
});
