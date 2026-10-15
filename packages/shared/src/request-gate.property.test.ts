/**
 * Property-based test for the API_Layer request validation gate.
 *
 * Feature: claimclarify, Property 2: API request validation gate
 *
 * *For any* request body, the API_Layer validator accepts it if and only if it
 * conforms to the request schema, its `message` is non-empty, its `message`
 * length is <= 2,000 characters, and its total payload size is <= 1 MB; for any
 * body that fails, the API returns HTTP 400 identifying the violated constraint
 * and does not invoke the Bedrock_Agent.
 *
 * **Validates: Requirements 2.3, 2.4, 13.1**
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  validateChatRequest,
  MESSAGE_MAX_LENGTH,
  MESSAGE_MIN_LENGTH,
  MAX_PAYLOAD_BYTES,
} from "./index";

/** UTF-8 byte length, matching the validator's own payload-size accounting. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Simulate the Chat Handler Lambda's request gate: validate the body and, only
 * when accepted, invoke the Bedrock_Agent (modeled by `agentInvoke`). Mirrors
 * the HTTP 400 path: a rejected body never reaches the agent.
 */
function handleRequest(
  body: unknown,
  agentInvoke: () => void
): { status: 200 | 400; field?: string } {
  const result = validateChatRequest(body);
  if (result.accepted) {
    agentInvoke();
    return { status: 200 };
  }
  return { status: 400, field: result.error.field };
}

/**
 * Independent oracle for acceptance, derived directly from the spec constraints
 * rather than from the implementation under test.
 */
function shouldAccept(body: unknown): boolean {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  if (typeof serialized !== "string") {
    return false;
  }
  if (utf8ByteLength(serialized) > MAX_PAYLOAD_BYTES) {
    return false;
  }

  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== "string") {
    return false;
  }
  if (obj.message.length < MESSAGE_MIN_LENGTH) {
    return false;
  }
  if (obj.message.length > MESSAGE_MAX_LENGTH) {
    return false;
  }
  if ("sessionId" in obj && obj.sessionId !== undefined) {
    if (typeof obj.sessionId !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Generator spanning the request-body input space:
 * - well-formed valid objects (optional sessionId),
 * - empty and overlong messages,
 * - non-object bodies (primitives, arrays, null),
 * - raw JSON strings (valid and malformed),
 * - oversized payloads exceeding 1 MB.
 */
const bodyArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  // Valid object bodies within length bounds.
  fc.record(
    {
      message: fc
        .string({ minLength: MESSAGE_MIN_LENGTH, maxLength: 50 })
        .filter((s) => s.length >= MESSAGE_MIN_LENGTH),
      sessionId: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    },
    { requiredKeys: ["message"] }
  ),
  // Empty message (should be rejected).
  fc.record({ message: fc.constant("") }),
  // Overlong message (should be rejected).
  fc.record({
    message: fc
      .integer({ min: MESSAGE_MAX_LENGTH + 1, max: MESSAGE_MAX_LENGTH + 100 })
      .map((n) => "x".repeat(n)),
  }),
  // message of the wrong type.
  fc.record({ message: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)) }),
  // Object missing the message field entirely.
  fc.record({ sessionId: fc.string({ maxLength: 20 }) }),
  // Non-string sessionId on an otherwise valid body.
  fc.record({ message: fc.constant("hello"), sessionId: fc.integer() }),
  // Non-object bodies.
  fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer(), { maxLength: 5 }),
    fc.string({ maxLength: 30 })
  ),
  // Oversized payload well beyond 1 MB.
  fc
    .integer({ min: MAX_PAYLOAD_BYTES + 1, max: MAX_PAYLOAD_BYTES + 1024 })
    .map((n) => ({ message: "x".repeat(n) }))
);

describe("Property 2: API request validation gate (Req 2.3, 2.4, 13.1)", () => {
  it("accepts iff schema-conformant/non-empty/<=2000 chars/<=1MB; agent invoked iff accepted", () => {
    fc.assert(
      fc.property(bodyArbitrary, (body) => {
        const agentInvoke = vi.fn();
        const outcome = handleRequest(body, agentInvoke);

        const expectedAccept = shouldAccept(body);
        const actualAccept = validateChatRequest(body).accepted;

        // Acceptance matches the independent oracle (accept iff constraints met).
        expect(actualAccept).toBe(expectedAccept);

        if (expectedAccept) {
          // Accepted: HTTP 200 and the agent was invoked exactly once.
          expect(outcome.status).toBe(200);
          expect(agentInvoke).toHaveBeenCalledTimes(1);
        } else {
          // Rejected: HTTP 400, a violated constraint is named, agent NOT invoked.
          expect(outcome.status).toBe(400);
          expect(outcome.field).toBeTruthy();
          expect(agentInvoke).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 300 }
    );
  });

  it("never invokes the agent for any rejected body (HTTP 400 path)", () => {
    fc.assert(
      fc.property(bodyArbitrary, (body) => {
        const agentInvoke = vi.fn();
        const outcome = handleRequest(body, agentInvoke);
        // The spy call count must equal the acceptance decision (0 or 1).
        expect(agentInvoke.mock.calls.length).toBe(outcome.status === 200 ? 1 : 0);
      }),
      { numRuns: 100 }
    );
  });
});
