import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  validateMessageLength,
  MESSAGE_MIN_LENGTH,
  MESSAGE_MAX_LENGTH,
} from "./index";

/**
 * Feature: claimclarify, Property 1: Client-side message length validation
 *
 * For any input string, the Chat_UI submit validator accepts it if and only if
 * its length is between 1 and 2,000 characters inclusive; for any rejected
 * string the UI shows an allowed-range error (type VALIDATION_ERROR) and
 * retains the entered text unchanged.
 *
 * Validates: Requirements 1.3
 */
describe("Property 1: Client-side message length validation (Req 1.3)", () => {
  // Smart generator spanning the whole decision space:
  //   - length 0 (empty, must be rejected)
  //   - lengths within [1, 2000] (must be accepted)
  //   - lengths > 2000 (must be rejected)
  // Boundary lengths (1, 2000, 2001) are explicitly biased in to exercise the
  // acceptance edges, while a broad length range covers the general case.
  const anyLengthString = fc.oneof(
    // Empty string (below the minimum).
    fc.constant(""),
    // Strings whose length lands anywhere from 0 up to just past the maximum,
    // so acceptance and both rejection sides are all generated frequently.
    fc
      .integer({ min: 0, max: MESSAGE_MAX_LENGTH + 50 })
      .chain((len) => fc.string({ minLength: len, maxLength: len })),
    // Explicit boundary lengths to guarantee the edges are hit.
    ...[
      MESSAGE_MIN_LENGTH,
      MESSAGE_MAX_LENGTH - 1,
      MESSAGE_MAX_LENGTH,
      MESSAGE_MAX_LENGTH + 1,
    ].map((len) => fc.string({ minLength: len, maxLength: len }))
  );

  it("accepts iff length in [1,2000]; else returns allowed-range error and retains text", () => {
    fc.assert(
      fc.property(anyLengthString, (input) => {
        const result = validateMessageLength(input);
        const inRange =
          input.length >= MESSAGE_MIN_LENGTH &&
          input.length <= MESSAGE_MAX_LENGTH;

        // Acceptance holds if and only if the length is within the range.
        expect(result.accepted).toBe(inRange);

        if (result.accepted) {
          // Accepted results carry no retain-text signal.
          expect(result).toEqual({ accepted: true });
        } else {
          // Rejected results must carry the allowed-range VALIDATION_ERROR
          // naming the message field, and signal the UI to retain the text.
          expect(result.retainInput).toBe(true);
          expect(result.error.type).toBe("VALIDATION_ERROR");
          expect(result.error.field).toBe("message");
          expect(result.error.message).toContain(String(MESSAGE_MIN_LENGTH));
          expect(result.error.message).toContain(String(MESSAGE_MAX_LENGTH));
        }
      }),
      { numRuns: 100 }
    );
  });
});
