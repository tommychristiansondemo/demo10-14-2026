/**
 * Unit tests for loading the Policy_Table name from the Config_Store.
 *
 * Verifies the table name is read from the Config_Store at runtime (Req 15.2)
 * and that a missing key yields CONFIG_ERROR with no embedded fallback
 * (Req 15.3).
 */
import { describe, expect, it } from "vitest";

import { InMemoryConfigSource } from "@claimclarify/shared";

import { POLICY_TABLE_NAME_KEY, loadPolicyTableName } from "./server-config";

describe("loadPolicyTableName", () => {
  it("reads the table name from the Config_Store", () => {
    const source = new InMemoryConfigSource({
      [POLICY_TABLE_NAME_KEY]: "ClaimClarify-Policy_Table",
    });
    const result = loadPolicyTableName(source);
    expect(result).toEqual({ ok: true, value: "ClaimClarify-Policy_Table" });
  });

  it("returns CONFIG_ERROR when the key is absent (no code fallback)", () => {
    const source = new InMemoryConfigSource({});
    const result = loadPolicyTableName(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("CONFIG_ERROR");
      expect(result.error.message).toContain(POLICY_TABLE_NAME_KEY);
    }
  });
});
