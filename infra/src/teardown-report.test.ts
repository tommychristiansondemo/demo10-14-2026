/**
 * Unit tests for the pure teardown reporting helpers (task 19.5, Req 14.5).
 *
 * These cover the logic that turns CloudFormation describe output into a
 * "what was NOT removed" report, without any live AWS access. The runnable
 * script `infra/scripts/teardown.mjs` wires these helpers to the AWS CLI; only
 * the pure logic is exercised here.
 */
import { describe, expect, it } from "vitest";

import {
  CLAIMCLARIFY_STACKS,
  parseStackPresence,
  parseFailedResources,
  buildTeardownReport,
  formatTeardownReport,
  // The helper module is plain ESM JS co-located with the teardown script.
} from "../scripts/teardown-report.mjs";

describe("parseStackPresence", () => {
  it("treats a 'does not exist' error as a removed stack", () => {
    const result = parseStackPresence(
      "ClaimClarify-Data",
      "An error occurred (ValidationError): Stack with id ClaimClarify-Data does not exist"
    );
    expect(result).toEqual({ present: false, status: null });
  });

  it("treats an empty Stacks array as removed", () => {
    const result = parseStackPresence(
      "ClaimClarify-Data",
      JSON.stringify({ Stacks: [] })
    );
    expect(result.present).toBe(false);
  });

  it("reports a stack still in a live/complete status as present", () => {
    const result = parseStackPresence(
      "ClaimClarify-Data",
      JSON.stringify({
        Stacks: [
          { StackName: "ClaimClarify-Data", StackStatus: "CREATE_COMPLETE" },
        ],
      })
    );
    expect(result).toEqual({ present: true, status: "CREATE_COMPLETE" });
  });

  it("reports a DELETE_FAILED stack as present (a leftover)", () => {
    const result = parseStackPresence(
      "ClaimClarify-Data",
      JSON.stringify({
        Stacks: [
          { StackName: "ClaimClarify-Data", StackStatus: "DELETE_FAILED" },
        ],
      })
    );
    expect(result).toEqual({ present: true, status: "DELETE_FAILED" });
  });

  it("errs on the side of present when output is unparseable", () => {
    const result = parseStackPresence("ClaimClarify-Data", "<garbage not json>");
    expect(result.present).toBe(true);
    expect(result.status).toBeNull();
  });
});

describe("parseFailedResources", () => {
  it("extracts only DELETE_FAILED resources with their type and status", () => {
    const json = JSON.stringify({
      StackResources: [
        {
          LogicalResourceId: "OriginBucket",
          ResourceType: "AWS::S3::Bucket",
          ResourceStatus: "DELETE_FAILED",
        },
        {
          LogicalResourceId: "PolicyTable",
          ResourceType: "AWS::DynamoDB::Table",
          ResourceStatus: "DELETE_COMPLETE",
        },
      ],
    });

    expect(parseFailedResources("ClaimClarify-Data", json)).toEqual([
      {
        stackName: "ClaimClarify-Data",
        logicalId: "OriginBucket",
        resourceType: "AWS::S3::Bucket",
        status: "DELETE_FAILED",
      },
    ]);
  });

  it("returns an empty list for unparseable input", () => {
    expect(parseFailedResources("ClaimClarify-Data", "not json")).toEqual([]);
  });
});

describe("buildTeardownReport", () => {
  it("reports allRemoved when every stack is gone", () => {
    const report = buildTeardownReport([
      { stackName: "ClaimClarify-Data", region: "us-east-2", present: false, status: null },
      { stackName: "ClaimClarify-Certificate", region: "us-east-1", present: false, status: null },
    ]);
    expect(report.allRemoved).toBe(true);
    expect(report.removedStacks).toEqual([
      "ClaimClarify-Data",
      "ClaimClarify-Certificate",
    ]);
    expect(report.leftoverStacks).toEqual([]);
  });

  it("collects leftover stacks and their failed resources", () => {
    const report = buildTeardownReport([
      {
        stackName: "ClaimClarify-Data",
        region: "us-east-2",
        present: true,
        status: "DELETE_FAILED",
        failedResources: [
          {
            logicalId: "OriginBucket",
            resourceType: "AWS::S3::Bucket",
            status: "DELETE_FAILED",
          },
        ],
      },
      {
        stackName: "ClaimClarify-Certificate",
        region: "us-east-1",
        present: false,
        status: null,
      },
    ]);

    expect(report.allRemoved).toBe(false);
    expect(report.removedStacks).toEqual(["ClaimClarify-Certificate"]);
    expect(report.leftoverStacks).toHaveLength(1);
    expect(report.leftoverStacks[0].stackName).toBe("ClaimClarify-Data");
    expect(report.leftoverStacks[0].failedResources).toHaveLength(1);
  });
});

describe("formatTeardownReport", () => {
  it("renders a success message when everything was removed", () => {
    const text = formatTeardownReport(
      buildTeardownReport([
        { stackName: "ClaimClarify-Data", region: "us-east-2", present: false, status: null },
      ])
    );
    expect(text).toContain("All ClaimClarify resources were removed successfully.");
  });

  it("names the stacks and resources that were NOT removed (Req 14.5)", () => {
    const text = formatTeardownReport(
      buildTeardownReport([
        {
          stackName: "ClaimClarify-Data",
          region: "us-east-2",
          present: true,
          status: "DELETE_FAILED",
          failedResources: [
            {
              logicalId: "OriginBucket",
              resourceType: "AWS::S3::Bucket",
              status: "DELETE_FAILED",
            },
          ],
        },
      ])
    );
    expect(text).toContain("were NOT fully removed");
    expect(text).toContain("ClaimClarify-Data");
    expect(text).toContain("OriginBucket");
    expect(text).toContain("AWS::S3::Bucket");
  });

  it("notes a leftover stack even when per-resource detail is unavailable", () => {
    const text = formatTeardownReport(
      buildTeardownReport([
        {
          stackName: "ClaimClarify-Certificate",
          region: "us-east-1",
          present: true,
          status: null,
        },
      ])
    );
    expect(text).toContain("ClaimClarify-Certificate");
    expect(text).toContain("see CloudFormation events");
  });
});

describe("CLAIMCLARIFY_STACKS", () => {
  it("targets the two ClaimClarify stacks in their regions", () => {
    expect(CLAIMCLARIFY_STACKS).toEqual([
      { name: "ClaimClarify-Data", region: "us-east-2" },
      { name: "ClaimClarify-Certificate", region: "us-east-1" },
    ]);
  });
});
