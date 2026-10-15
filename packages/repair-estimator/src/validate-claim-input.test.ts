import { describe, it, expect } from "vitest";
import { VEHICLE_YEAR_MIN, VISIBLE_DAMAGE_PANELS_MAX } from "@claimclarify/shared";
import { validateClaimInput, maxVehicleYear } from "./index";

const VALID = {
  vehicleYear: 2019,
  impactLocation: "front" as const,
  driveable: false,
  airbagDeployed: true,
  visibleDamagePanels: 4,
};

describe("validateClaimInput", () => {
  it("accepts a well-formed Claim_Input and returns the normalized value", () => {
    const result = validateClaimInput(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(VALID);
    }
  });

  it("accepts boundary vehicleYear values (min and currentYear+1)", () => {
    expect(validateClaimInput({ ...VALID, vehicleYear: VEHICLE_YEAR_MIN }).ok).toBe(true);
    expect(validateClaimInput({ ...VALID, vehicleYear: maxVehicleYear() }).ok).toBe(true);
  });

  it("accepts boundary visibleDamagePanels values (0 and max)", () => {
    expect(validateClaimInput({ ...VALID, visibleDamagePanels: 0 }).ok).toBe(true);
    expect(
      validateClaimInput({ ...VALID, visibleDamagePanels: VISIBLE_DAMAGE_PANELS_MAX }).ok,
    ).toBe(true);
  });

  it("accepts every permitted impactLocation", () => {
    for (const impactLocation of ["front", "rear", "side", "roof", "undercarriage"] as const) {
      expect(validateClaimInput({ ...VALID, impactLocation }).ok).toBe(true);
    }
  });

  const failureCases: Array<[string, unknown, string]> = [
    ["non-object input", 42, "claimInput"],
    ["null input", null, "claimInput"],
    ["array input", [], "claimInput"],
    ["missing vehicleYear", { ...VALID, vehicleYear: undefined }, "vehicleYear"],
    ["non-integer vehicleYear", { ...VALID, vehicleYear: 2019.5 }, "vehicleYear"],
    ["vehicleYear below min", { ...VALID, vehicleYear: VEHICLE_YEAR_MIN - 1 }, "vehicleYear"],
    ["vehicleYear above max", { ...VALID, vehicleYear: maxVehicleYear() + 1 }, "vehicleYear"],
    ["missing impactLocation", { ...VALID, impactLocation: undefined }, "impactLocation"],
    ["unknown impactLocation", { ...VALID, impactLocation: "hood" }, "impactLocation"],
    ["missing driveable", { ...VALID, driveable: undefined }, "driveable"],
    ["non-boolean driveable", { ...VALID, driveable: "yes" }, "driveable"],
    ["missing airbagDeployed", { ...VALID, airbagDeployed: undefined }, "airbagDeployed"],
    ["non-boolean airbagDeployed", { ...VALID, airbagDeployed: 1 }, "airbagDeployed"],
    ["missing visibleDamagePanels", { ...VALID, visibleDamagePanels: undefined }, "visibleDamagePanels"],
    ["non-integer visibleDamagePanels", { ...VALID, visibleDamagePanels: 2.5 }, "visibleDamagePanels"],
    ["negative visibleDamagePanels", { ...VALID, visibleDamagePanels: -1 }, "visibleDamagePanels"],
    [
      "visibleDamagePanels above max",
      { ...VALID, visibleDamagePanels: VISIBLE_DAMAGE_PANELS_MAX + 1 },
      "visibleDamagePanels",
    ],
  ];

  it.each(failureCases)(
    "rejects %s with a VALIDATION_ERROR naming the field and no estimate",
    (_label, input, expectedField) => {
      const result = validateClaimInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("VALIDATION_ERROR");
        expect(result.error.field).toBe(expectedField);
        expect(typeof result.error.message).toBe("string");
        expect("value" in result).toBe(false);
      }
    },
  );
});
