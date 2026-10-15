/**
 * Pure, deterministic `Claim_Input` schema validation for the
 * Repair_Estimator_Server (Req 6.5, 13.3, 13.4).
 *
 * This logic lives in the estimator package (no AWS I/O) so it can be imported
 * by both the MCP server and the property-based tests. See design.md
 * "Claim_Input (Repair_Estimator_Server)" for the validation rules.
 */
import {
  IMPACT_LOCATIONS,
  VEHICLE_YEAR_MIN,
  VISIBLE_DAMAGE_PANELS_MAX,
  type ClaimInput,
  type ImpactLocation,
  type StructuredError,
} from "@claimclarify/shared";

/** Discriminated result of validating a candidate `Claim_Input`. */
export type ValidateClaimInputResult =
  | { ok: true; value: ClaimInput }
  | { ok: false; error: StructuredError };

/**
 * The maximum permitted vehicle model year, derived from the current year.
 *
 * A parameter (defaulting to the current year) keeps the function pure and
 * deterministic for tests while matching the `currentYear + 1` rule at runtime.
 */
export function maxVehicleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** True iff `value` is a finite integer (not NaN/Infinity, not fractional). */
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function validationError(field: string, message: string): StructuredError {
  return { type: "VALIDATION_ERROR", field, message };
}

/**
 * Validate a candidate `Claim_Input` against the expected input schema.
 *
 * On success returns `{ ok: true, value }` with the normalized, well-typed
 * `ClaimInput`. On the first failing field returns `{ ok: false, error }` where
 * `error` is a structured `VALIDATION_ERROR` naming the failing field; in the
 * failure case no estimate is produced (Req 6.5, 13.3, 13.4).
 *
 * Fields are checked in a stable order so the reported `field` is deterministic.
 *
 * @param input candidate value (untrusted/unknown shape)
 * @param currentYearMax maximum permitted `vehicleYear` (defaults to currentYear + 1)
 */
export function validateClaimInput(
  input: unknown,
  currentYearMax: number = maxVehicleYear(),
): ValidateClaimInputResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error: validationError(
        "claimInput",
        "Claim_Input must be a non-null object.",
      ),
    };
  }

  const candidate = input as Record<string, unknown>;

  // vehicleYear: integer, 1980 <= year <= currentYear + 1.
  const { vehicleYear } = candidate;
  if (vehicleYear === undefined || vehicleYear === null) {
    return {
      ok: false,
      error: validationError("vehicleYear", "vehicleYear is required."),
    };
  }
  if (!isInteger(vehicleYear)) {
    return {
      ok: false,
      error: validationError("vehicleYear", "vehicleYear must be an integer."),
    };
  }
  if (vehicleYear < VEHICLE_YEAR_MIN || vehicleYear > currentYearMax) {
    return {
      ok: false,
      error: validationError(
        "vehicleYear",
        `vehicleYear must be between ${VEHICLE_YEAR_MIN} and ${currentYearMax} inclusive.`,
      ),
    };
  }

  // impactLocation: one of the predefined set.
  const { impactLocation } = candidate;
  if (impactLocation === undefined || impactLocation === null) {
    return {
      ok: false,
      error: validationError("impactLocation", "impactLocation is required."),
    };
  }
  if (
    typeof impactLocation !== "string" ||
    !(IMPACT_LOCATIONS as readonly string[]).includes(impactLocation)
  ) {
    return {
      ok: false,
      error: validationError(
        "impactLocation",
        `impactLocation must be one of: ${IMPACT_LOCATIONS.join(", ")}.`,
      ),
    };
  }

  // driveable: boolean (required).
  const { driveable } = candidate;
  if (driveable === undefined || driveable === null) {
    return {
      ok: false,
      error: validationError("driveable", "driveable is required."),
    };
  }
  if (typeof driveable !== "boolean") {
    return {
      ok: false,
      error: validationError("driveable", "driveable must be a boolean."),
    };
  }

  // airbagDeployed: boolean (required).
  const { airbagDeployed } = candidate;
  if (airbagDeployed === undefined || airbagDeployed === null) {
    return {
      ok: false,
      error: validationError("airbagDeployed", "airbagDeployed is required."),
    };
  }
  if (typeof airbagDeployed !== "boolean") {
    return {
      ok: false,
      error: validationError(
        "airbagDeployed",
        "airbagDeployed must be a boolean.",
      ),
    };
  }

  // visibleDamagePanels: integer, 0 <= n <= 20.
  const { visibleDamagePanels } = candidate;
  if (visibleDamagePanels === undefined || visibleDamagePanels === null) {
    return {
      ok: false,
      error: validationError(
        "visibleDamagePanels",
        "visibleDamagePanels is required.",
      ),
    };
  }
  if (!isInteger(visibleDamagePanels)) {
    return {
      ok: false,
      error: validationError(
        "visibleDamagePanels",
        "visibleDamagePanels must be an integer.",
      ),
    };
  }
  if (
    visibleDamagePanels < 0 ||
    visibleDamagePanels > VISIBLE_DAMAGE_PANELS_MAX
  ) {
    return {
      ok: false,
      error: validationError(
        "visibleDamagePanels",
        `visibleDamagePanels must be between 0 and ${VISIBLE_DAMAGE_PANELS_MAX} inclusive.`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      vehicleYear,
      impactLocation: impactLocation as ImpactLocation,
      driveable,
      airbagDeployed,
      visibleDamagePanels,
    },
  };
}
