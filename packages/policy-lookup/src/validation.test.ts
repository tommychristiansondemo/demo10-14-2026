import { describe, it, expect } from "vitest";
import { POLICY_ID_MAX_LENGTH } from "@claimclarify/shared";
import { validatePolicyId, POLICY_ID_FIELD } from "./validation";

describe("validatePolicyId", () => {
  it("accepts a non-empty id within the length limit", () => {
    const result = validatePolicyId("POL-100001");
    expect(result).toEqual({ ok: true, policyId: "POL-100001" });
  });

  it("accepts an id exactly at the max length", () => {
    const id = "a".repeat(POLICY_ID_MAX_LENGTH);
    const result = validatePolicyId(id);
    expect(result).toEqual({ ok: true, policyId: id });
  });

  it("rejects an absent (undefined) id with VALIDATION_ERROR naming policyId", () => {
    const result = validatePolicyId(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe(POLICY_ID_FIELD);
    }
  });

  it("rejects a null id with VALIDATION_ERROR", () => {
    const result = validatePolicyId(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe(POLICY_ID_FIELD);
    }
  });

  it("rejects a non-string id", () => {
    const result = validatePolicyId(12345);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe(POLICY_ID_FIELD);
    }
  });

  it("rejects an empty string id", () => {
    const result = validatePolicyId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe(POLICY_ID_FIELD);
    }
  });

  it("rejects an id longer than the max length", () => {
    const id = "a".repeat(POLICY_ID_MAX_LENGTH + 1);
    const result = validatePolicyId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe(POLICY_ID_FIELD);
      expect(result.error.message).toContain(String(POLICY_ID_MAX_LENGTH));
    }
  });
});
