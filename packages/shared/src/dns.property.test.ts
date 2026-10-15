import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  RESERVED_DNS_RECORD_NAME,
  dnsPrecheck,
  type ZoneSnapshot,
} from "./index";

/**
 * Feature: claimclarify, Property 12: DNS record name precheck
 *
 * For any configured `App_DNS_Record` name and any snapshot of the Hosted_Zone,
 * the deployment precheck proceeds if and only if the name differs from
 * `www.awsteach.com` AND is absent from the zone; otherwise it reports a
 * conflict and signals a halt without changing any record. `dnsPrecheck` is
 * pure and never mutates the zone snapshot.
 *
 * Validates: Requirements 9.2, 9.4
 */
describe("Property 12: DNS record name precheck (Req 9.2, 9.4)", () => {
  // A generator for plausible DNS record names. Sometimes emits the reserved
  // name so that reserved-name conflicts are exercised.
  const recordName = fc.oneof(
    { weight: 1, arbitrary: fc.constant(RESERVED_DNS_RECORD_NAME) },
    {
      weight: 4,
      arbitrary: fc
        .string({ minLength: 1, maxLength: 20 })
        .map((s) => `${s.replace(/\s/g, "")}.awsteach.com`),
    }
  );

  // A pool of record names used to build zone snapshots. Includes the reserved
  // name and arbitrary names so that the generated zones overlap with generated
  // record names often enough to exercise the "already exists" branch.
  const zoneName = fc.oneof(
    { weight: 1, arbitrary: fc.constant(RESERVED_DNS_RECORD_NAME) },
    {
      weight: 4,
      arbitrary: fc
        .string({ minLength: 1, maxLength: 20 })
        .map((s) => `${s.replace(/\s/g, "")}.awsteach.com`),
    }
  );

  const scenario = fc
    .record({
      name: recordName,
      zoneNames: fc.array(zoneName, { minLength: 0, maxLength: 10 }),
      // When true, force the record name into the zone so the collision branch
      // is reliably exercised in addition to random overlaps.
      forcePresent: fc.boolean(),
      // Represent the zone as a list or a Set, since dnsPrecheck accepts both.
      asSet: fc.boolean(),
    })
    .map(({ name, zoneNames, forcePresent, asSet }) => {
      const names = forcePresent ? [...zoneNames, name] : zoneNames;
      const snapshot: ZoneSnapshot = asSet ? new Set(names) : names;
      return { name, snapshot };
    });

  it("proceeds iff the name is not reserved and absent from the zone; otherwise reports a conflict and halts, without mutating the snapshot", () => {
    fc.assert(
      fc.property(scenario, ({ name, snapshot }) => {
        // Deep snapshot of the input to detect any mutation.
        const before =
          snapshot instanceof Set ? new Set(snapshot) : [...snapshot];

        const zoneNamesArr =
          snapshot instanceof Set ? [...snapshot] : [...snapshot];
        const expectedProceed =
          name !== RESERVED_DNS_RECORD_NAME && !zoneNamesArr.includes(name);

        const result = dnsPrecheck(name, snapshot);

        // Core property: proceed iff name is unique and non-reserved.
        expect(result.proceed).toBe(expectedProceed);

        if (expectedProceed) {
          expect(result).toEqual({ proceed: true });
        } else {
          // Conflict reported: halt signalled with a non-empty description that
          // identifies the conflicting name.
          expect(result.proceed).toBe(false);
          if (!result.proceed) {
            expect(typeof result.conflict).toBe("string");
            expect(result.conflict.length).toBeGreaterThan(0);
            expect(result.conflict).toContain(name);
          }
        }

        // Purity: the zone snapshot must never be mutated.
        if (snapshot instanceof Set) {
          expect(snapshot).toEqual(before as Set<string>);
        } else {
          expect(snapshot).toEqual(before as string[]);
        }
      }),
      { numRuns: 100 }
    );
  });
});
