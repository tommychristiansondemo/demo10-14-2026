import { describe, it, expect } from "vitest";
import {
  RESERVED_DNS_RECORD_NAME,
  dnsPrecheck,
  type ZoneSnapshot,
} from "./index";

describe("dnsPrecheck (Req 9.2, 9.4)", () => {
  it("proceeds when the name is unique and absent from the zone", () => {
    const result = dnsPrecheck("ohio.awsteach.com", ["www.awsteach.com"]);
    expect(result).toEqual({ proceed: true });
  });

  it("reports a conflict for the reserved www.awsteach.com name", () => {
    const result = dnsPrecheck(RESERVED_DNS_RECORD_NAME, []);
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.conflict).toContain(RESERVED_DNS_RECORD_NAME);
    }
  });

  it("reports a conflict for the reserved name even when the zone is empty", () => {
    const result = dnsPrecheck(RESERVED_DNS_RECORD_NAME, new Set<string>());
    expect(result.proceed).toBe(false);
  });

  it("reports a conflict when the name already exists in the zone (list)", () => {
    const result = dnsPrecheck("ohio.awsteach.com", [
      "www.awsteach.com",
      "ohio.awsteach.com",
    ]);
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.conflict).toContain("ohio.awsteach.com");
    }
  });

  it("reports a conflict when the name already exists in the zone (set)", () => {
    const zone = new Set<string>(["ohio.awsteach.com"]);
    const result = dnsPrecheck("ohio.awsteach.com", zone);
    expect(result.proceed).toBe(false);
  });

  it("never mutates the zone snapshot", () => {
    const listZone: ZoneSnapshot = ["www.awsteach.com", "api.awsteach.com"];
    const listCopy = [...listZone];
    dnsPrecheck("ohio.awsteach.com", listZone);
    expect(listZone).toEqual(listCopy);

    const setZone = new Set<string>(["www.awsteach.com"]);
    const setBefore = new Set(setZone);
    dnsPrecheck("ohio.awsteach.com", setZone);
    expect(setZone).toEqual(setBefore);
  });
});
