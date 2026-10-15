/**
 * Property-based test for Claim_Input schema validation (Req 6.5, 13.3).
 *
 * Feature: claimclarify, Property 10: Estimator input validation
 *
 * Property 10: For any `Claim_Input` that is missing a required attribute or
 * contains an attribute value outside its permitted range, the
 * Repair_Estimator_Server returns a structured VALIDATION_ERROR identifying the
 * invalid field and returns no severity, cost, or turnaround.
 *
 * The generator below builds a well-formed base and then applies exactly one
 * invalidating mutation to a single field (missing value, wrong type, or
 * out-of-range value — including non-ASCII strings, non-integers, out-of-range
 * years/panels, invalid impactLocation, and non-boolean driveable/airbagDeployed).
 * This guarantees every generated case is actually invalid.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  IMPACT_LOCATIONS,
  VEHICLE_YEAR_MIN,
  VISIBLE_DAMAGE_PANELS_MAX,
} from "@claimclarify/shared";
import { validateClaimInput, maxVehicleYear } from "./index";

const MAX_YEAR = maxVehicleYear();

/** A generator of well-formed `Claim_Input` records (the mutation base). */
const validClaimArb = fc.record({
  vehicleYear: fc.integer({ min: VEHICLE_YEAR_MIN, max: MAX_YEAR }),
  impactLocation: fc.constantFrom(...IMPACT_LOCATIONS),
  driveable: fc.boolean(),
  airbagDeployed: fc.boolean(),
  visibleDamagePanels: fc.integer({ min: 0, max: VISIBLE_DAMAGE_PANELS_MAX }),
});

/** A finite, non-integer number (guaranteed fractional). */
const nonIntegerArb = fc
  .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
  .filter((n) => !Number.isInteger(n));

/** Non-ASCII strings, used to exercise impactLocation / string mis-typing. */
const nonAsciiStringArb = fc
  .string({ unit: fc.char16bits(), minLength: 1 })
  .filter((s) => /[^\u0000-\u007f]/.test(s));

/** An out-of-range (never valid) integer vehicle year. */
const invalidYearArb = fc.oneof(
  fc.integer({ max: VEHICLE_YEAR_MIN - 1 }),
  fc.integer({ min: MAX_YEAR + 1 }),
);

/** An out-of-range (never valid) integer panel count. */
const invalidPanelsArb = fc.oneof(
  fc.integer({ max: -1 }),
  fc.integer({ min: VISIBLE_DAMAGE_PANELS_MAX + 1 }),
);

/** A value that is never a valid impactLocation (wrong type or unknown string). */
const invalidImpactLocationArb = fc.oneof(
  nonAsciiStringArb,
  fc.string().filter((s) => !(IMPACT_LOCATIONS as readonly string[]).includes(s)),
  fc.integer(),
  fc.boolean(),
);

/** A value that is never a valid boolean. */
const nonBooleanArb = fc.oneof(
  fc.string(),
  fc.integer(),
  nonIntegerArb,
  fc.constant(0),
  fc.constant(1),
);

/**
 * Each mutation names the field it targets and produces an invalid value
 * (or `undefined` to simulate a missing required attribute).
 */
const mutationArb: fc.Arbitrary<{ field: string; value: unknown }> = fc.oneof(
  // Missing required attributes.
  fc.record({ field: fc.constant("vehicleYear"), value: fc.constant(undefined) }),
  fc.record({ field: fc.constant("impactLocation"), value: fc.constant(undefined) }),
  fc.record({ field: fc.constant("driveable"), value: fc.constant(undefined) }),
  fc.record({ field: fc.constant("airbagDeployed"), value: fc.constant(undefined) }),
  fc.record({ field: fc.constant("visibleDamagePanels"), value: fc.constant(undefined) }),
  // vehicleYear: non-integer or out-of-range.
  fc.record({ field: fc.constant("vehicleYear"), value: nonIntegerArb }),
  fc.record({ field: fc.constant("vehicleYear"), value: invalidYearArb }),
  // impactLocation: non-ASCII / unknown string / wrong type.
  fc.record({ field: fc.constant("impactLocation"), value: invalidImpactLocationArb }),
  // driveable / airbagDeployed: non-boolean.
  fc.record({ field: fc.constant("driveable"), value: nonBooleanArb }),
  fc.record({ field: fc.constant("airbagDeployed"), value: nonBooleanArb }),
  // visibleDamagePanels: non-integer or out-of-range.
  fc.record({ field: fc.constant("visibleDamagePanels"), value: nonIntegerArb }),
  fc.record({ field: fc.constant("visibleDamagePanels"), value: invalidPanelsArb }),
);

/** A guaranteed-invalid `Claim_Input`: a valid base with one bad field. */
const invalidClaimArb = fc
  .tuple(validClaimArb, mutationArb)
  .map(([base, mutation]) => {
    const candidate: Record<string, unknown> = { ...base };
    if (mutation.value === undefined) {
      delete candidate[mutation.field];
    } else {
      candidate[mutation.field] = mutation.value;
    }
    return candidate;
  });

describe("validateClaimInput — Property 10: Estimator input validation", () => {
  it("rejects any missing/out-of-range Claim_Input with a VALIDATION_ERROR naming a field and no estimate", () => {
    fc.assert(
      fc.property(invalidClaimArb, (input) => {
        const result = validateClaimInput(input, MAX_YEAR);

        // Sanity: the generated case must actually be invalid.
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.type).toBe("VALIDATION_ERROR");
        expect(typeof result.error.field).toBe("string");
        expect(result.error.field).not.toBe("");

        // No estimate value is produced in the failure case.
        expect("value" in result).toBe(false);
        const asAny = result as Record<string, unknown>;
        expect(asAny.severity).toBeUndefined();
        expect(asAny.estimatedCostUsd).toBeUndefined();
        expect(asAny.turnaroundDays).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Validates: Requirements 6.5, 13.3
 */
