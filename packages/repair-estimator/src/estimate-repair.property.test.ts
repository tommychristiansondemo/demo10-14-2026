import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SEVERITY_LEVELS,
  IMPACT_LOCATIONS,
  VEHICLE_YEAR_MIN,
  VISIBLE_DAMAGE_PANELS_MAX,
  type ClaimInput,
} from "@claimclarify/shared";
import { estimateRepair } from "./estimate-repair";
import { maxVehicleYear } from "./validate-claim-input";

/**
 * Feature: claimclarify, Property 9: Estimator output is well-formed for valid input
 *
 * For any valid Claim_Input, the Repair_Estimator_Server returns a `severity`
 * drawn from the predefined set `{minor, moderate, severe, total_loss}`, an
 * `estimatedCostUsd` >= 0, and a `turnaroundDays` >= 0.
 *
 * Validates: Requirements 6.2, 6.3, 6.4
 */
describe("Property 9: Estimator output is well-formed for valid input (Req 6.2, 6.3, 6.4)", () => {
  // Upper bound for vehicleYear follows the validation rule: currentYear + 1.
  const VEHICLE_YEAR_MAX = maxVehicleYear();

  // Smart generator constrained to the valid Claim_Input space. Boundary values
  // for every field are explicitly biased in so the generator exercises the
  // acceptance edges that are most likely to break the well-formedness
  // invariants:
  //   - vehicleYear: min (1980) and max (currentYear + 1)
  //   - impactLocation: every member of the predefined set
  //   - driveable / airbagDeployed: both booleans
  //   - visibleDamagePanels: 0 and 20 (both ends of the permitted range)
  const validClaimInput: fc.Arbitrary<ClaimInput> = fc.record({
    vehicleYear: fc.oneof(
      // Full in-range span.
      fc.integer({ min: VEHICLE_YEAR_MIN, max: VEHICLE_YEAR_MAX }),
      // Explicit boundary years.
      fc.constantFrom(VEHICLE_YEAR_MIN, VEHICLE_YEAR_MAX),
    ),
    // Covers all impact locations, including the heaviest-weighted ones.
    impactLocation: fc.constantFrom(...IMPACT_LOCATIONS),
    driveable: fc.boolean(),
    airbagDeployed: fc.boolean(),
    visibleDamagePanels: fc.oneof(
      // Full in-range span.
      fc.integer({ min: 0, max: VISIBLE_DAMAGE_PANELS_MAX }),
      // Explicit boundary panel counts.
      fc.constantFrom(0, VISIBLE_DAMAGE_PANELS_MAX),
    ),
  });

  it("returns severity in the predefined set, cost >= 0, and turnaround >= 0 for any valid input", () => {
    fc.assert(
      fc.property(validClaimInput, (claim) => {
        const result = estimateRepair(claim);

        // severity is drawn from the predefined set (Req 6.2).
        expect(SEVERITY_LEVELS).toContain(result.severity);

        // estimatedCostUsd is a non-negative, finite number (Req 6.3).
        expect(typeof result.estimatedCostUsd).toBe("number");
        expect(Number.isFinite(result.estimatedCostUsd)).toBe(true);
        expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);

        // turnaroundDays is a non-negative, finite number (Req 6.4).
        expect(typeof result.turnaroundDays).toBe("number");
        expect(Number.isFinite(result.turnaroundDays)).toBe(true);
        expect(result.turnaroundDays).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
