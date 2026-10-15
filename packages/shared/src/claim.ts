/**
 * Repair_Estimator_Server input (`Claim_Input`) and output (`EstimateResult`)
 * contracts, plus the predefined severity set.
 *
 * See design.md "Claim_Input (Repair_Estimator_Server)" and
 * "Severity levels (predefined set — Req 6.2)".
 */

/** The predefined set of collision damage severity levels (Req 6.2). */
export const SEVERITY_LEVELS = [
  "minor",
  "moderate",
  "severe",
  "total_loss",
] as const;

/** A severity level drawn from the predefined set. */
export type Severity = (typeof SEVERITY_LEVELS)[number];

/** The predefined set of permitted impact locations. */
export const IMPACT_LOCATIONS = [
  "front",
  "rear",
  "side",
  "roof",
  "undercarriage",
] as const;

/** An impact location drawn from the predefined set. */
export type ImpactLocation = (typeof IMPACT_LOCATIONS)[number];

/** Minimum permitted vehicle model year (Req: Claim_Input validation rules). */
export const VEHICLE_YEAR_MIN = 1980;
/** Maximum number of visible damage panels (Req: Claim_Input validation rules). */
export const VISIBLE_DAMAGE_PANELS_MAX = 20;

/**
 * The structured claim attributes submitted to the Repair_Estimator_Server.
 */
export interface ClaimInput {
  /** Integer, 1980 <= year <= currentYear + 1. */
  vehicleYear: number;
  impactLocation: ImpactLocation;
  driveable: boolean;
  airbagDeployed: boolean;
  /** Integer, 0 <= n <= 20. */
  visibleDamagePanels: number;
}

/**
 * A successful repair estimate: severity classification, non-negative cost in
 * USD, and non-negative turnaround in whole days (Req 6.2, 6.3, 6.4).
 */
export interface EstimateResult {
  severity: Severity;
  estimatedCostUsd: number;
  turnaroundDays: number;
}
