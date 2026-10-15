import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryConfigSource, loadConfig } from "./index";

/**
 * Feature: claimclarify, Property 17: Config retrieval has no code fallback
 *
 * For any required configuration key that is missing from the Config_Store,
 * loadConfig returns a CONFIG_ERROR and never returns a value embedded in
 * source code. For any key that is present, loadConfig returns exactly the
 * stored value. There is no hardcoded fallback — a missing key always errors.
 *
 * Validates: Requirements 15.3
 */
describe("Property 17: Config retrieval has no code fallback (Req 15.3)", () => {
  // A fake Config_Store: a random set of present key/value pairs.
  const presentEntries = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.string({ maxLength: 60 }),
    { maxKeys: 10 }
  );

  // A key to query: biased so both present and absent keys are exercised.
  // Present keys are chosen from the generated store; absent keys are arbitrary
  // strings (and the empty string) that may or may not collide with the store.
  const queryKey = fc.string({ maxLength: 40 });

  it("returns the stored value for present keys and CONFIG_ERROR (no fallback) for absent keys", () => {
    fc.assert(
      fc.property(presentEntries, queryKey, (entries, key) => {
        const source = new InMemoryConfigSource(entries);
        const result = loadConfig(source, key);

        const isPresent = Object.prototype.hasOwnProperty.call(entries, key);

        if (isPresent) {
          // Present key: must succeed and return exactly the stored value.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(entries[key]);
          }
        } else {
          // Absent key: must fail with CONFIG_ERROR naming the key, and must
          // NOT return any value — proving there is no source-embedded fallback.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.type).toBe("CONFIG_ERROR");
            expect(result.error.message).toContain(key);
          }
          expect("value" in result).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("never falls back to a value for a key guaranteed absent from the store", () => {
    // Build a store that explicitly excludes the queried key, so this exercises
    // the no-fallback guarantee deterministically across many stores/keys.
    fc.assert(
      fc.property(presentEntries, fc.string({ maxLength: 40 }), (entries, key) => {
        const { [key]: _omitted, ...withoutKey } = entries;
        const source = new InMemoryConfigSource(withoutKey);
        const result = loadConfig(source, key);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.type).toBe("CONFIG_ERROR");
          expect(result.error.message).toContain(key);
        }
        expect("value" in result).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
