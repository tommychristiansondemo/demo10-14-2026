/**
 * Property-based test for Property 14: Structured validation-error shape.
 *
 * Feature: claimclarify, Property 14: Structured validation-error shape
 *
 * For any invalid input to any validating component (Chat_UI message validator,
 * API_Layer request validator, Policy_Lookup_Server policyId validator,
 * Repair_Estimator_Server Claim_Input validator), the returned error result
 * conforms to the structured error schema with its `type` set to
 * `VALIDATION_ERROR` and its `field` populated with the failing field.
 *
 * This single property test exercises all four validators across the workspace:
 * - validateMessageLength / validateChatRequest from @claimclarify/shared
 * - validatePolicyId from @claimclarify/policy-lookup
 * - validateClaimInput from this (repair-estimator) package
 *
 * Validates: Requirements 13.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  MESSAGE_MAX_LENGTH,
  MAX_PAYLOAD_BYTES,
  POLICY_ID_MAX_LENGTH,
  VEHICLE_YEAR_MIN,
  VISIBLE_DAMAGE_PANELS_MAX,
  validateMessageLength,
  validateChatRequest,
  type StructuredError,
} from "@claimclarify/shared";
import { validatePolicyId } from "@claimclarify/policy-lookup";
import { validateClaimInput, maxVehicleYear } from "./index";

const NUM_RUNS = 200; // minimum 100 iterations required; use 200 for margin.

/**
 * Assert that a produced error is a well-formed structured validation error:
 * `type === 'VALIDATION_ERROR'` and `field` is a non-empty string (Req 13.4).
 */
function assertValidationErrorShape(error: StructuredError): void {
  expect(error.type).toBe("VALIDATION_ERROR");
  expect(typeof error.field).toBe("string");
  expect((error.field as string).length).toBeGreaterThan(0);
  // The structured error schema also requires a human-readable message.
  expect(typeof error.message).toBe("string");
}

// A valid Claim_Input used as the base for mutating a single field invalid.
const VALID_CLAIM = {
  vehicleYear: 2019,
  impactLocation: "front" as const,
  driveable: false,
  airbagDeployed: true,
  visibleDamagePanels: 4,
};

describe("Property 14: Structured validation-error shape", () => {
  // Feature: claimclarify, Property 14: Structured validation-error shape
  it("message validator: any out-of-range message yields VALIDATION_ERROR with a populated field", () => {
    // Generate strings whose length is outside [1, MESSAGE_MAX_LENGTH]:
    // either empty, or longer than the maximum.
    const invalidMessage = fc.oneof(
      fc.constant(""),
      fc
        .integer({ min: MESSAGE_MAX_LENGTH + 1, max: MESSAGE_MAX_LENGTH + 500 })
        .map((len) => "a".repeat(len)),
    );

    fc.assert(
      fc.property(invalidMessage, (message) => {
        const result = validateMessageLength(message);
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          assertValidationErrorShape(result.error);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: claimclarify, Property 14: Structured validation-error shape
  it("request validator: any invalid request body yields VALIDATION_ERROR with a populated field", () => {
    // A collection of generators each producing a request body that violates
    // some constraint of the API_Layer request schema (Req 2.3/13.1).
    const invalidRequest = fc.oneof(
      // Non-object / wrong-type bodies.
      fc.constant(null),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.anything()),
      // Object missing `message`.
      fc.record({ sessionId: fc.string() }),
      // `message` present but not a string.
      fc.record({ message: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)) }),
      // Empty `message`.
      fc.constant({ message: "" }),
      // Over-length `message`.
      fc
        .integer({ min: MESSAGE_MAX_LENGTH + 1, max: MESSAGE_MAX_LENGTH + 200 })
        .map((len) => ({ message: "a".repeat(len) })),
      // Non-string `sessionId` with an otherwise valid message.
      fc.record({ message: fc.constant("hello"), sessionId: fc.integer() }),
      // Oversized payload exceeding MAX_PAYLOAD_BYTES.
      fc.constant({ message: "a".repeat(MAX_PAYLOAD_BYTES + 10) }),
    );

    fc.assert(
      fc.property(invalidRequest, (body) => {
        const result = validateChatRequest(body);
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          assertValidationErrorShape(result.error);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: claimclarify, Property 14: Structured validation-error shape
  it("policyId validator: any invalid policyId yields VALIDATION_ERROR with a populated field", () => {
    // Generate policyIds that are absent, non-string, empty, or over-length.
    const invalidPolicyId = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.boolean(),
      fc.object(),
      fc.constant(""),
      fc
        .integer({ min: POLICY_ID_MAX_LENGTH + 1, max: POLICY_ID_MAX_LENGTH + 200 })
        .map((len) => "P".repeat(len)),
    );

    fc.assert(
      fc.property(invalidPolicyId, (id) => {
        const result = validatePolicyId(id);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          assertValidationErrorShape(result.error);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: claimclarify, Property 14: Structured validation-error shape
  it("Claim_Input validator: any invalid Claim_Input yields VALIDATION_ERROR with a populated field", () => {
    // Each generator produces a Claim_Input that is invalid in exactly one of
    // its fields (or is a non-object entirely), spanning every validated field.
    const invalidClaim = fc.oneof(
      // Non-object inputs.
      fc.constant(null),
      fc.integer(),
      fc.string(),
      fc.array(fc.anything()),
      // Invalid vehicleYear (missing / non-integer / out of range).
      fc
        .oneof(
          fc.constant(undefined),
          fc.double({ min: 1980.1, max: 2050.9, noInteger: true }),
          fc.integer({ min: -5000, max: VEHICLE_YEAR_MIN - 1 }),
          fc.integer({ min: maxVehicleYear() + 1, max: maxVehicleYear() + 500 }),
        )
        .map((vehicleYear) => ({ ...VALID_CLAIM, vehicleYear })),
      // Invalid impactLocation (missing / unknown).
      fc
        .oneof(fc.constant(undefined), fc.constant("hood"), fc.constant("left"), fc.integer())
        .map((impactLocation) => ({ ...VALID_CLAIM, impactLocation })),
      // Invalid driveable (missing / non-boolean).
      fc
        .oneof(fc.constant(undefined), fc.string(), fc.integer())
        .map((driveable) => ({ ...VALID_CLAIM, driveable })),
      // Invalid airbagDeployed (missing / non-boolean).
      fc
        .oneof(fc.constant(undefined), fc.string(), fc.integer())
        .map((airbagDeployed) => ({ ...VALID_CLAIM, airbagDeployed })),
      // Invalid visibleDamagePanels (missing / non-integer / out of range).
      fc
        .oneof(
          fc.constant(undefined),
          fc.double({ min: 0.1, max: 19.9, noInteger: true }),
          fc.integer({ min: -500, max: -1 }),
          fc.integer({ min: VISIBLE_DAMAGE_PANELS_MAX + 1, max: VISIBLE_DAMAGE_PANELS_MAX + 500 }),
        )
        .map((visibleDamagePanels) => ({ ...VALID_CLAIM, visibleDamagePanels })),
    );

    fc.assert(
      fc.property(invalidClaim, (claim) => {
        const result = validateClaimInput(claim);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          assertValidationErrorShape(result.error);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
