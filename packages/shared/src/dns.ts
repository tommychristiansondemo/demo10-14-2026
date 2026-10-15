/**
 * DNS record-name precheck helper.
 *
 * Pure, deterministic logic shared between the CDK DNS construct and the
 * property tests. Before the deployment creates `App_DNS_Record` in the shared
 * `awsteach.com` hosted zone, it must confirm that the chosen record name does
 * not collide with the reserved `www.awsteach.com` record and does not already
 * exist in the zone. On any conflict the deployment must halt without changing
 * a single record.
 *
 * See design.md "7. IaC_Template", the error-handling "DNS name conflict" row,
 * and "Property 12: DNS record name precheck" (Req 9.2, 9.4).
 */

/**
 * The reserved record name owned by an unrelated application. The deployment
 * must never create or mutate this record (Req 9.2, 9.3).
 */
export const RESERVED_DNS_RECORD_NAME = "www.awsteach.com";

/**
 * A read-only snapshot of the record names already present in the Hosted_Zone.
 * Accepts either a list or a set of names; the helper never mutates it.
 */
export type ZoneSnapshot = readonly string[] | ReadonlySet<string>;

/**
 * The result of a DNS precheck.
 *
 * - `{ proceed: true }`: the name is safe; the deployment may create the record.
 * - `{ proceed: false, conflict }`: a conflict was detected; the deployment
 *   must halt and leave every record unchanged. `conflict` is a human-readable
 *   description identifying the conflicting name.
 */
export type DnsPrecheckResult =
  | { proceed: true }
  | { proceed: false; conflict: string };

/**
 * Decide whether the deployment may create a DNS record named `recordName`.
 *
 * The precheck proceeds if and only if the name differs from the reserved
 * `www.awsteach.com` record AND is absent from the zone snapshot; otherwise it
 * reports a conflict and signals a halt. This function is pure and never
 * mutates `zoneSnapshot` (Req 9.2, 9.4).
 *
 * @param recordName the configured `App_DNS_Record` name.
 * @param zoneSnapshot the set/list of record names already in the Hosted_Zone.
 */
export function dnsPrecheck(
  recordName: string,
  zoneSnapshot: ZoneSnapshot
): DnsPrecheckResult {
  if (recordName === RESERVED_DNS_RECORD_NAME) {
    return {
      proceed: false,
      conflict: `Record name "${recordName}" is reserved and must not be modified; halting without changing any record.`,
    };
  }

  const existing =
    zoneSnapshot instanceof Set
      ? zoneSnapshot
      : new Set<string>(zoneSnapshot as readonly string[]);

  if (existing.has(recordName)) {
    return {
      proceed: false,
      conflict: `Record name "${recordName}" already exists in the hosted zone; halting without changing any record.`,
    };
  }

  return { proceed: true };
}
