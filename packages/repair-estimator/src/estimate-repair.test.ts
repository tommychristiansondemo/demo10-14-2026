/**
 * Unit tests for the deterministic `estimateRepair` logic (Req 6.2, 6.3, 6.4).
 *
 * These example-based tests pin down specific classifications and the
 * non-negativity / determinism invariants; the universal Property 9 test lives
 * in task 3.3.
 */
import { describe, expect, it } from "vitest";
import { SEVERITY_LEVELS, type ClaimInput } from "@claimclarify/shared";
import { estimateRepair } from "./estimate-repair";

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    vehicleYear: 2020,
    impactLocation: "front",
    driveable: true,
    airbagDeployed: false,
    visibleDamagePanels: 0,
    ...overrides,
  };
}

describe("estimateRepair", () => {
  it("classifies a light, driveable front impact as minor", () => {
    const result = estimateRepair(claim());
    expect(result.severity).toBe("minor");
    expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.turnaroundDays).toBeGreaterThanOrEqual(0);
  });

  it("escalates severity when the airbag deploys and vehicle is not driveable", () => {
    const result = estimateRepair(
      claim({ airbagDeployed: true, driveable: false, visibleDamagePanels: 2 }),
    );
    expect(["moderate", "severe", "total_loss"]).toContain(result.severity);
  });

  it("classifies heavy damage with airbag + undercarriage as total_loss", () => {
    const result = estimateRepair(
      claim({
        impactLocation: "undercarriage",
        airbagDeployed: true,
        driveable: false,
        visibleDamagePanels: 20,
      }),
    );
    expect(result.severity).toBe("total_loss");
  });

  it("always returns a severity from the predefined set", () => {
    const result = estimateRepair(claim({ impactLocation: "roof" }));
    expect(SEVERITY_LEVELS).toContain(result.severity);
  });

  it("never returns a negative cost or turnaround at the max vehicle year", () => {
    const result = estimateRepair(
      claim({ vehicleYear: 2026, visibleDamagePanels: 0 }),
    );
    expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.turnaroundDays).toBeGreaterThanOrEqual(0);
  });

  it("adds cost and turnaround for each visible damaged panel", () => {
    const none = estimateRepair(claim({ visibleDamagePanels: 0 }));
    const some = estimateRepair(claim({ visibleDamagePanels: 3 }));
    expect(some.estimatedCostUsd).toBeGreaterThan(none.estimatedCostUsd);
    expect(some.turnaroundDays).toBeGreaterThanOrEqual(none.turnaroundDays);
  });

  it("is deterministic — same input yields identical output", () => {
    const input = claim({ impactLocation: "side", visibleDamagePanels: 5 });
    expect(estimateRepair(input)).toEqual(estimateRepair(input));
  });
});
