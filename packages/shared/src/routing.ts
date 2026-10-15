/**
 * CloudFront path-routing classifier.
 *
 * Pure, deterministic logic shared between the CDK cache-behavior config and
 * the property tests. Given a request path, it decides whether the request
 * targets the API_Layer or the S3_Origin.
 *
 * See design.md "6. CloudFront_Distribution + S3_Origin" and
 * "Property 11: Path routing" (Req 7.5, 7.6).
 */

/**
 * The path prefix that identifies API requests. A request whose path starts
 * with this prefix is routed to the API_Layer; everything else is served from
 * the S3_Origin.
 */
export const API_PATH_PREFIX = "/api/";

/**
 * The CloudFront behavior a request path resolves to.
 *
 * - `API`: route the request to the API_Layer (`/api/*`).
 * - `S3_ORIGIN`: serve the corresponding Chat_UI asset from the S3_Origin.
 */
export type RouteTarget = "API" | "S3_ORIGIN";

/**
 * Classify a request path to its CloudFront behavior.
 *
 * Returns `"API"` if and only if the path targets the API prefix (`/api/*`),
 * otherwise returns `"S3_ORIGIN"` (Req 7.5, 7.6).
 *
 * A path "targets the API prefix" when it begins with {@link API_PATH_PREFIX}
 * (`/api/`), matching the CloudFront `/api/*` path pattern. The bare `/api`
 * path (with no trailing slash or sub-path) does not match `/api/*` and is
 * therefore served from the S3_Origin.
 *
 * @param path the request path (e.g. `/api/chat`, `/index.html`).
 */
export function classifyPath(path: string): RouteTarget {
  return path.startsWith(API_PATH_PREFIX) ? "API" : "S3_ORIGIN";
}
