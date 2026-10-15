/**
 * Pure, side-effect-free helpers for ClaimClarify teardown reporting
 * (task 19.5, Req 14.4, 14.5).
 *
 * This module holds the logic that, given the output of CloudFormation
 * describe calls, works out which stacks/resources a `cdk destroy` failed to
 * remove and renders a human-readable report. It performs NO AWS I/O and has
 * NO import-time side effects, so it is safe to unit test without live AWS
 * (see `infra/src/teardown-report.test.ts`). The runnable script
 * `infra/scripts/teardown.mjs` wires these helpers to the AWS CLI / cdk.
 */

/**
 * The ClaimClarify stacks this deployment creates (see `infra/src/app.ts`).
 * Teardown targets exactly these; anything still present after `cdk destroy`
 * is reported as not removed (Req 14.5).
 *
 * @type {ReadonlyArray<{ name: string, region: string }>}
 */
export const CLAIMCLARIFY_STACKS = [
  { name: "ClaimClarify-Data", region: "us-east-2" },
  { name: "ClaimClarify-Certificate", region: "us-east-1" },
];

/**
 * CloudFormation stack statuses that mean the stack (or at least one of its
 * resources) was NOT removed by teardown. A stack still sitting in any of
 * these states after `cdk destroy` indicates leftover resources (Req 14.5).
 *
 * @type {ReadonlySet<string>}
 */
export const NOT_REMOVED_STACK_STATUSES = new Set([
  "DELETE_FAILED",
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "ROLLBACK_COMPLETE",
  "DELETE_IN_PROGRESS",
  "UPDATE_IN_PROGRESS",
]);

/**
 * Individual resource statuses that mean a resource failed to delete. Used
 * when inspecting `describe-stack-resources` output for a stack that could not
 * be fully removed (Req 14.5).
 *
 * @type {ReadonlySet<string>}
 */
export const RESOURCE_DELETE_FAILED_STATUSES = new Set(["DELETE_FAILED"]);

/**
 * Parse the JSON text returned by
 * `aws cloudformation describe-stacks --stack-name <name>` and determine
 * whether the stack is still present (i.e. not removed) after teardown.
 *
 * Robust to the two shapes teardown actually encounters:
 * - A describe-stacks success payload: `{ "Stacks": [ { StackName, StackStatus, ... } ] }`.
 *   The stack is considered leftover when its status is in
 *   {@link NOT_REMOVED_STACK_STATUSES}.
 * - A describe-stacks failure where the stack does not exist. When the stack
 *   has been deleted, `describe-stacks` errors with "does not exist"; callers
 *   pass that error text (or an empty `{ "Stacks": [] }`) and this returns
 *   `{ present: false }` — the stack was successfully removed.
 *
 * @param {string} stackName The stack queried.
 * @param {string} describeStacksJsonOrError Raw stdout from a successful
 *   describe-stacks call, or the stderr/error text from a failed one.
 * @returns {{ present: boolean, status: string | null }} `present` is true
 *   when the stack still exists after teardown (a leftover); `status` is the
 *   CloudFormation stack status when known, else null.
 */
export function parseStackPresence(stackName, describeStacksJsonOrError) {
  const text = typeof describeStacksJsonOrError === "string"
    ? describeStacksJsonOrError
    : "";

  // "does not exist" is how CloudFormation reports an already-deleted stack.
  if (/does not exist/i.test(text)) {
    return { present: false, status: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparseable, non-"does not exist" output: treat as unknown-but-present so
    // teardown errs on the side of reporting a possible leftover (Req 14.5).
    return { present: true, status: null };
  }

  const stacks = Array.isArray(parsed?.Stacks) ? parsed.Stacks : [];
  const match = stacks.find((s) => s?.StackName === stackName) ?? stacks[0];

  if (match === undefined) {
    return { present: false, status: null };
  }

  const status = typeof match.StackStatus === "string" ? match.StackStatus : null;
  const present = status === null ? true : NOT_REMOVED_STACK_STATUSES.has(status);
  return { present, status };
}

/**
 * Given the parsed `describe-stack-resources` output for a stack that could
 * not be removed, return the list of resources that failed to delete
 * (Req 14.5). A resource is "not removed" when its `ResourceStatus` is in
 * {@link RESOURCE_DELETE_FAILED_STATUSES}; if the status list is unavailable
 * (empty/garbled), the stack itself is reported as the leftover by the caller.
 *
 * @param {string} stackName The stack the resources belong to.
 * @param {string} describeStackResourcesJson Raw stdout from
 *   `aws cloudformation describe-stack-resources --stack-name <name>`.
 * @returns {Array<{ stackName: string, logicalId: string, resourceType: string, status: string }>}
 *   The resources CloudFormation reports as DELETE_FAILED.
 */
export function parseFailedResources(stackName, describeStackResourcesJson) {
  let parsed;
  try {
    parsed = JSON.parse(describeStackResourcesJson);
  } catch {
    return [];
  }

  const resources = Array.isArray(parsed?.StackResources)
    ? parsed.StackResources
    : [];

  return resources
    .filter((r) => RESOURCE_DELETE_FAILED_STATUSES.has(r?.ResourceStatus))
    .map((r) => ({
      stackName,
      logicalId: typeof r.LogicalResourceId === "string" ? r.LogicalResourceId : "<unknown>",
      resourceType: typeof r.ResourceType === "string" ? r.ResourceType : "<unknown>",
      status: r.ResourceStatus,
    }));
}

/**
 * Combine per-stack presence results (and any per-resource delete failures)
 * into a single teardown report describing what, if anything, was NOT removed
 * (Req 14.4, 14.5).
 *
 * @param {Array<{ stackName: string, region: string, present: boolean, status: string | null, failedResources?: Array<{ logicalId: string, resourceType: string, status: string }> }>} stackResults
 * @returns {{
 *   allRemoved: boolean,
 *   removedStacks: string[],
 *   leftoverStacks: Array<{ stackName: string, region: string, status: string | null, failedResources: Array<{ logicalId: string, resourceType: string, status: string }> }>
 * }} A structured report. `allRemoved` is true iff every targeted stack is
 *   gone.
 */
export function buildTeardownReport(stackResults) {
  const removedStacks = [];
  const leftoverStacks = [];

  for (const result of stackResults) {
    if (result.present) {
      leftoverStacks.push({
        stackName: result.stackName,
        region: result.region,
        status: result.status ?? null,
        failedResources: result.failedResources ?? [],
      });
    } else {
      removedStacks.push(result.stackName);
    }
  }

  return {
    allRemoved: leftoverStacks.length === 0,
    removedStacks,
    leftoverStacks,
  };
}

/**
 * Render a {@link buildTeardownReport} result as human-readable report text
 * suitable for printing to the console at the end of teardown (Req 14.5).
 *
 * @param {ReturnType<typeof buildTeardownReport>} report
 * @returns {string} Multi-line report text.
 */
export function formatTeardownReport(report) {
  const lines = ["", "===== ClaimClarify teardown report ====="];

  if (report.allRemoved) {
    lines.push("All ClaimClarify resources were removed successfully.");
    if (report.removedStacks.length > 0) {
      lines.push(`Removed stacks: ${report.removedStacks.join(", ")}`);
    }
    lines.push("========================================", "");
    return lines.join("\n");
  }

  lines.push(
    `WARNING: ${report.leftoverStacks.length} stack(s) were NOT fully removed (Req 14.5):`
  );

  for (const leftover of report.leftoverStacks) {
    const statusText = leftover.status ? ` [status: ${leftover.status}]` : "";
    lines.push(`  - ${leftover.stackName} (${leftover.region})${statusText}`);
    if (leftover.failedResources.length > 0) {
      for (const res of leftover.failedResources) {
        lines.push(
          `      • ${res.logicalId} (${res.resourceType}) — ${res.status}`
        );
      }
    } else {
      lines.push(
        "      • stack still present; see CloudFormation events for the resource(s) blocking deletion"
      );
    }
  }

  if (report.removedStacks.length > 0) {
    lines.push(`Removed stacks: ${report.removedStacks.join(", ")}`);
  }

  lines.push(
    "Re-run `npm run teardown` after resolving the above, or delete the",
    "listed resources manually, then re-run to confirm removal."
  );
  lines.push("========================================", "");
  return lines.join("\n");
}
