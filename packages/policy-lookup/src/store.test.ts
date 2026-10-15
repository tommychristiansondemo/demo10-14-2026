import { describe, it, expect } from "vitest";
import type { PolicyRecord } from "@claimclarify/shared";
import { InMemoryPolicyStore } from "./store";

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

describe("InMemoryPolicyStore", () => {
  it("returns the full record for an existing policyId", () => {
    const store = new InMemoryPolicyStore([sampleRecord]);
    expect(store.getByPolicyId("POL-100001")).toEqual(sampleRecord);
  });

  it("returns per-section data for an existing policyId", () => {
    const store = new InMemoryPolicyStore([sampleRecord]);
    expect(store.getCoverage("POL-100001")).toEqual(sampleRecord.coverage);
    expect(store.getDeductibles("POL-100001")).toEqual(sampleRecord.deductibles);
    expect(store.getPriorClaims("POL-100001")).toEqual(sampleRecord.priorClaims);
  });

  it("returns undefined for an absent policyId across all getters", () => {
    const store = new InMemoryPolicyStore([sampleRecord]);
    expect(store.getByPolicyId("MISSING")).toBeUndefined();
    expect(store.getCoverage("MISSING")).toBeUndefined();
    expect(store.getDeductibles("MISSING")).toBeUndefined();
    expect(store.getPriorClaims("MISSING")).toBeUndefined();
  });

  it("is read-only: mutating a returned record does not affect the store", () => {
    const store = new InMemoryPolicyStore([sampleRecord]);
    const first = store.getByPolicyId("POL-100001");
    expect(first).toBeDefined();
    first!.coverage.collision = false;
    first!.priorClaims.push({
      claimId: "CLM-9999",
      date: "2024-01-01",
      amountUsd: 1,
      atFault: false,
    });

    const second = store.getByPolicyId("POL-100001");
    expect(second).toEqual(sampleRecord);
  });

  it("is read-only: mutating the seed input does not affect the store", () => {
    const seed: PolicyRecord = structuredClone(sampleRecord);
    const store = new InMemoryPolicyStore([seed]);
    seed.coverage.liabilityLimitUsd = 1;

    expect(store.getCoverage("POL-100001")?.liabilityLimitUsd).toBe(100000);
  });

  it("reports its size", () => {
    const store = new InMemoryPolicyStore([sampleRecord]);
    expect(store.size).toBe(1);
    expect(new InMemoryPolicyStore().size).toBe(0);
  });
});
