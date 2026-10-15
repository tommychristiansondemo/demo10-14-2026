import { describe, it, expect } from "vitest";
import type { PolicyRecord } from "@claimclarify/shared";
import { InMemoryPolicyStore } from "./store";
import { getCoverage, getDeductibles, getPriorClaims } from "./lookup-tools";

const sampleRecord: PolicyRecord = {
  policyId: "POL-100001",
  holderName: "Jordan Rivera",
  coverage: {
    collision: true,
    comprehensive: true,
    liabilityLimitUsd: 100000,
    rentalReimbursement: false,
  },
  deductibles: {
    collisionUsd: 500,
    comprehensiveUsd: 250,
  },
  priorClaims: [
    { claimId: "CLM-0001", date: "2023-04-12", amountUsd: 3200, atFault: true },
  ],
};

function newStore(): InMemoryPolicyStore {
  return new InMemoryPolicyStore([sampleRecord]);
}

describe("policy lookup tools", () => {
  describe("existing policyId returns exactly the stored data (Req 4.2, 4.3, 4.4)", () => {
    it("get_coverage returns the stored coverage", () => {
      const result = getCoverage(newStore(), { policyId: "POL-100001" });
      expect(result).toEqual({ ok: true, data: sampleRecord.coverage });
    });

    it("get_deductibles returns the stored deductibles", () => {
      const result = getDeductibles(newStore(), { policyId: "POL-100001" });
      expect(result).toEqual({ ok: true, data: sampleRecord.deductibles });
    });

    it("get_prior_claims returns the stored prior claims", () => {
      const result = getPriorClaims(newStore(), { policyId: "POL-100001" });
      expect(result).toEqual({ ok: true, data: sampleRecord.priorClaims });
    });
  });

  describe("missing policyId returns NOT_FOUND naming the id, store unchanged (Req 4.5)", () => {
    it.each([
      ["get_coverage", getCoverage],
      ["get_deductibles", getDeductibles],
      ["get_prior_claims", getPriorClaims],
    ] as const)("%s returns NOT_FOUND for an absent id", (_name, tool) => {
      const store = newStore();
      const result = tool(store, { policyId: "MISSING-999" });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.type).toBe("NOT_FOUND");
      expect(result.error.message).toContain("MISSING-999");
      // Store unchanged: the existing record is still present and intact.
      expect(store.getByPolicyId("POL-100001")).toEqual(sampleRecord);
      expect(store.size).toBe(1);
    });
  });

  describe("invalid policyId returns the VALIDATION_ERROR from validatePolicyId (Req 4.6, 13.2)", () => {
    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["over-length", "x".repeat(65)],
      ["non-string", 12345],
    ] as const)("get_coverage rejects an %s policyId", (_name, policyId) => {
      const result = getCoverage(newStore(), {
        policyId: policyId as unknown,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("policyId");
    });

    it("validation short-circuits before any store read", () => {
      // A store whose reads throw proves validation happens first.
      const throwingStore = {
        getByPolicyId() {
          throw new Error("should not be read");
        },
        getCoverage() {
          throw new Error("should not be read");
        },
        getDeductibles() {
          throw new Error("should not be read");
        },
        getPriorClaims() {
          throw new Error("should not be read");
        },
      };
      const result = getCoverage(throwingStore, { policyId: "" });
      expect(result.ok).toBe(false);
    });
  });
});
