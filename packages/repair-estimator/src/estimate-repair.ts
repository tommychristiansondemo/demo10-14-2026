/**
 * Pure, deterministic repair estimation for the Repair_Estimator_Server
 * (Req 6.2, 6.3, 6.4).
 *
 * This module maps an already-validated `Claim_Input` to an `EstimateResult`:
 * a `severity` drawn from the predefined set, a non-negative `estimatedCostUsd`,
 * and a non-negative, whole-day `turnaroundDays`. The logic is pure and
 * deterministic (no AWS I/O, no clock, no randomness): the same input always
 * yields the same output, which lets the property-based tests (task 3.3,
 * Property 9) exercise it in isolation.
 *
 * Callers are expected to run `validateClaimInput` first; `estimateRepair`
 * assumes its argument is a well-formed `ClaimInput` (vehicleYear in range,
 * impactLocation in the predefined set, booleans present, visibleDamagePanels
 * in 0..20). See design.md "Repair_Estimator_Server".
 */
import {
  SEVERITY_LEVELS,
  type ClaimInput,
  type EstimateResult,
  type ImpactLocation,
  type Severity,
} from "@claimclarify/shared";

/**
 * Relative structural risk weight per impact location. Undercarriage and roof
 * impacts tend to indicate more serious structural damage than a front/rear
 * fender bender, so they contribute more to the severity score.
 */
const IMPACT_WEIGHT: Record<ImpactLocation, number> = {
  front: 2,
  rear: 2,
  side: 3,
  roof: 4,
  undercarriage: 4,
};

/** Per-severity base repair cost in USD (deterministic reference figures). */
const BASE_COST_USD: Record<Severity, number> = {
  minor: 500,
  moderate: 2500,
  severe: 8000,
  total_loss: 20000,
};

/** Per-severity base turnaround in whole days. */
const BASE_TURNAROUND_DAYS: Record<Severity, number> = {
  minor: 1,
  moderate: 4,
  severe: 10,
  total_loss: 21,
};

/** Added repair cost per visible damaged panel, in USD. */
const COST_PER_PANEL_USD = 350;

/** Added turnaround per visible damaged panel, in whole days. */
const DAYS_PER_PANEL = 1;

/**
 * Reference base year for the deterministic vehicle-age surcharge. Fixed (not
 * the current year) so the estimate stays pure and reproducible across runs;
 * matches the `vehicleYear` validation ceiling era (`currentYear + 1`).
 */
const SEVERITY_BASE_YEAR = 2025;

/**
 * Compute an integer damage score from the validated claim attributes. Higher
 * scores indicate more serious damage. The score combines fixed penalties for
 * airbag deployment and non-driveability with the impact-location weight and
 * the number of visibly damaged panels.
 */
function damageScore(claim: ClaimInput): number {
  let score = 0;
  score += IMPACT_WEIGHT[claim.impactLocation];
  score += claim.airbagDeployed ? 5 : 0;
  score += claim.driveable ? 0 : 3;
  score += claim.visibleDamagePanels;
  return score;
}

/**
 * Classify a validated claim into one of the predefined severity levels.
 *
 * Thresholds partition the damage score across the full ordered severity set
 * `{minor, moderate, severe, total_loss}`. The result is always a member of
 * `SEVERITY_LEVELS`.
 */
function classifySeverity(claim: ClaimInput): Severity {
  const score = damageScore(claim);
  if (score <= 3) {
    return "minor";
  }
  if (score <= 8) {
    return "moderate";
  }
  if (score <= 15) {
    return "severe";
  }
  return "total_loss";
}

/**
 * Produce a deterministic repair estimate for an already-validated claim.
 *
 * @param claim a well-formed `ClaimInput` (validate with `validateClaimInput`
 *   before calling)
 * @returns an `EstimateResult` whose `severity` is from the predefined set and
 *   whose `estimatedCostUsd` and `turnaroundDays` are both non-negative whole
 *   numbers (Property 9 holds for every valid `ClaimInput`).
 */
export function estimateRepair(claim: ClaimInput): EstimateResult {
  const severity = classifySeverity(claim);

  // Older vehicles cost slightly more to source parts for; derive a small,
  // non-negative age surcharge from the vehicle age relative to the base year.
  // `vehicleAge` is clamped at 0 so a future model year never yields a negative
  // adjustment, keeping cost >= 0 for any valid input.
  const vehicleAge = Math.max(0, SEVERITY_BASE_YEAR - claim.vehicleYear);
  const ageSurchargeUsd = vehicleAge * 25;

  const estimatedCostUsd =
    BASE_COST_USD[severity] +
    claim.visibleDamagePanels * COST_PER_PANEL_USD +
    ageSurchargeUsd;

  const turnaroundDays =
    BASE_TURNAROUND_DAYS[severity] +
    claim.visibleDamagePanels * DAYS_PER_PANEL;

  // Guard the non-negativity invariant explicitly. Every term above is already
  // non-negative for valid input, so these clamps never alter a valid result;
  // they document and defend Property 9 (Req 6.3, 6.4).
  return {
    severity,
    estimatedCostUsd: Math.max(0, estimatedCostUsd),
    turnaroundDays: Math.max(0, turnaroundDays),
  };
}

/** Re-exported for callers/tests that need the ordered severity set. */
export { SEVERITY_LEVELS };
