import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { classifyPath, API_PATH_PREFIX } from "./routing";

/**
 * Feature: claimclarify, Property 11: Path routing
 *
 * For any request path, the CloudFront routing classifier selects the
 * API_Layer behavior (`"API"`) if and only if the path matches the API prefix
 * (`/api/*`, i.e. starts with `/api/`), and otherwise selects the S3_Origin
 * behavior (`"S3_ORIGIN"`).
 *
 * Validates: Requirements 7.5, 7.6
 */
describe("Property 11: Path routing (Req 7.5, 7.6)", () => {
  // Arbitrary suffix appended after the API prefix. May itself contain further
  // slashes, dots, query-like characters, or be empty (the bare `/api/`).
  const suffix = fc.string({ maxLength: 64 });

  // Paths that genuinely begin with the API prefix (`/api/<suffix>`), spanning
  // the bare `/api/` and arbitrary sub-paths.
  const apiPrefixedPath = suffix.map((s) => API_PATH_PREFIX + s);

  // Explicit non-prefixed edge cases that are tempting to misclassify:
  //  - "/" root, "/index.html" static asset
  //  - "/api" with no trailing slash (does NOT match `/api/*`)
  //  - a path that contains "/api/" somewhere later but not as a prefix
  const nonPrefixedEdgeCases = fc.constantFrom(
    "",
    "/",
    "/index.html",
    "/assets/app.js",
    "/api",
    "/apiary",
    "/static/api/thing",
    "/v1/api/chat",
    "api/chat"
  );

  // Random strings that are not guaranteed to avoid the prefix; we filter out
  // any that happen to start with it so this generator only yields genuine
  // non-API paths. This widens coverage of the S3_ORIGIN branch.
  const randomNonPrefixed = fc
    .string({ maxLength: 64 })
    .filter((s) => !s.startsWith(API_PATH_PREFIX));

  // The full path space: API-prefixed paths plus a variety of non-prefixed
  // paths (explicit edge cases and filtered random strings).
  const path = fc.oneof(apiPrefixedPath, nonPrefixedEdgeCases, randomNonPrefixed);

  it("returns API iff the path starts with the API prefix, else S3_ORIGIN", () => {
    fc.assert(
      fc.property(path, (p) => {
        const expected = p.startsWith(API_PATH_PREFIX) ? "API" : "S3_ORIGIN";
        expect(classifyPath(p)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});
