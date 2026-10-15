/**
 * Apply / teardown integration tests (task 22.4, Req 14.2, 14.4, 14.5).
 *
 * ClaimClarify's "apply" and "teardown" loop normally runs against live AWS
 * (`cdk deploy` then `cdk destroy` + the teardown report script). Live AWS is
 * unavailable in CI, so these integration tests exercise the same loop at the
 * synthesis level with simulated CloudFormation describe output:
 *
 * - APPLY (Req 14.2): synthesize the full ClaimClarify app — both stacks wired
 *   exactly as `app.ts` wires them — and assert the resulting CloudFormation
 *   template(s) contain the complete set of resources required for the
 *   application to operate (DynamoDB table, S3 bucket, Lambda(s), API Gateway,
 *   two AgentCore runtimes, Bedrock agent, CloudFront distribution, SSM
 *   Config_Store parameters, log groups, alarms, the seeding custom resource,
 *   and the App_DNS_Record). "Apply provisions all resources" is validated by
 *   proving every such resource type is present in the synthesized stacks.
 *
 * - TEARDOWN (Req 14.4, 14.5): drive the pure teardown-report helpers
 *   end-to-end over simulated `aws cloudformation describe-*` output for the
 *   two ClaimClarify stacks, covering both outcomes: (a) every stack removed →
 *   `buildTeardownReport.allRemoved` true and a success message; and (b) a
 *   stack still present with a DELETE_FAILED resource → the report names the
 *   leftover stack and the specific resource that was not removed (Req 14.5).
 *   This closes the apply→teardown loop (resources present, then removed, with
 *   leftovers reported) without any live AWS access.
 */
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
} from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
} from "./claimclarify-certificate-stack";

import {
  CLAIMCLARIFY_STACKS,
  parseStackPresence,
  parseFailedResources,
  buildTeardownReport,
  formatTeardownReport,
  // Pure ESM helpers co-located with the runnable teardown script.
} from "../scripts/teardown-report.mjs";

/**
 * Synthesize the whole ClaimClarify app the way `app.ts` does: the
 * Certificate_Region (`us-east-1`) stack first, then the Primary_Region
 * (`us-east-2`) data stack consuming its certificate + domain across regions,
 * with the explicit cross-region dependency. Returns both synthesized
 * templates — together they are what an "apply" would provision.
 */
function synthApp(): {
  dataTemplate: Template;
  certificateTemplate: Template;
} {
  const app = new App();

  const certificateStack = new ClaimClarifyCertificateStack(
    app,
    "ClaimClarify-Certificate",
    {
      env: { account: "111111111111", region: CERTIFICATE_REGION },
      crossRegionReferences: true,
    }
  );

  const dataStack = new ClaimClarifyDataStack(app, "ClaimClarify-Data", {
    env: { account: "111111111111", region: PRIMARY_REGION },
    crossRegionReferences: true,
    cloudFrontCertificate: certificateStack.certificate,
    cloudFrontDomainName: certificateStack.appDomainName,
  });
  dataStack.addDependency(certificateStack);

  return {
    dataTemplate: Template.fromStack(dataStack),
    certificateTemplate: Template.fromStack(certificateStack),
  };
}

describe("Apply/teardown integration (task 22.4)", () => {
  describe("apply provisions all ClaimClarify resources (Req 14.2)", () => {
    // The resource types the application needs to operate, each expected to be
    // present (count > 0) in the Primary_Region data stack after synthesis.
    // Presence of each type is a representative check that "apply" provisions
    // every category of resource the app requires (Req 14.1, 14.2).
    const requiredDataStackResourceTypes: ReadonlyArray<[string, string]> = [
      ["DynamoDB Policy_Table", "AWS::DynamoDB::Table"],
      ["S3_Origin bucket", "AWS::S3::Bucket"],
      ["API_Layer / seeding Lambda(s)", "AWS::Lambda::Function"],
      ["API Gateway HTTP API", "AWS::ApiGatewayV2::Api"],
      ["Bedrock_Agent", "AWS::Bedrock::Agent"],
      ["AgentCore Runtime MCP servers", "AWS::BedrockAgentCore::Runtime"],
      ["CloudFront_Distribution", "AWS::CloudFront::Distribution"],
      ["Config_Store SSM parameters", "AWS::SSM::Parameter"],
      ["CloudWatch log groups", "AWS::Logs::LogGroup"],
      ["CloudWatch error-rate alarms", "AWS::CloudWatch::Alarm"],
      ["App_DNS_Record (Route53)", "AWS::Route53::RecordSet"],
    ];

    it.each(requiredDataStackResourceTypes)(
      "provisions the %s in the us-east-2 data stack",
      (_label, resourceType) => {
        const { dataTemplate } = synthApp();
        expect(
          Object.keys(dataTemplate.findResources(resourceType)).length
        ).toBeGreaterThan(0);
      }
    );

    it("provisions the Policy_Table seeding custom resource (Req 5.2, 14.2)", () => {
      const { dataTemplate } = synthApp();
      // The duplicate-aware seeding runs via a CloudFormation custom resource;
      // its presence is what makes the applied table operational.
      const seedResources = dataTemplate.findResources(
        "AWS::CloudFormation::CustomResource"
      );
      expect(Object.keys(seedResources).length).toBeGreaterThan(0);
    });

    it("provisions BOTH AgentCore Runtime MCP servers (policy-lookup + repair-estimator)", () => {
      const { dataTemplate } = synthApp();
      dataTemplate.resourceCountIs("AWS::BedrockAgentCore::Runtime", 2);
    });

    it("provisions the DNS-validated ACM certificate in the us-east-1 stack (Req 14.2)", () => {
      const { certificateTemplate } = synthApp();
      // The certificate the whole apply gates on lives in the Certificate_Region
      // stack; without it CloudFront cannot be provisioned (Req 14.2).
      expect(
        Object.keys(
          certificateTemplate.findResources(
            "AWS::CertificateManager::Certificate"
          )
        ).length
      ).toBeGreaterThan(0);
    });

    it("provisions the complete required resource set across both stacks (Req 14.2)", () => {
      const { dataTemplate, certificateTemplate } = synthApp();

      // A single end-to-end assertion that an "apply" of the two wired stacks
      // yields at least one of every required resource type — the application
      // can operate only when all of these are present.
      for (const [, resourceType] of requiredDataStackResourceTypes) {
        expect(
          Object.keys(dataTemplate.findResources(resourceType)).length,
          `expected at least one ${resourceType} in the data stack`
        ).toBeGreaterThan(0);
      }
      expect(
        Object.keys(
          certificateTemplate.findResources(
            "AWS::CertificateManager::Certificate"
          )
        ).length
      ).toBeGreaterThan(0);
    });
  });

  describe("teardown removes resources and reports failures (Req 14.4, 14.5)", () => {
    it("reports all resources removed when both stacks are gone (Req 14.4)", () => {
      // Simulate `aws cloudformation describe-stacks` after a successful
      // `cdk destroy`: CloudFormation errors with "does not exist" for each
      // teardown-targeted stack.
      const stackResults = CLAIMCLARIFY_STACKS.map(({ name, region }) => {
        const describeOutput = `An error occurred (ValidationError): Stack with id ${name} does not exist`;
        const presence = parseStackPresence(name, describeOutput);
        return {
          stackName: name,
          region,
          present: presence.present,
          status: presence.status,
        };
      });

      const report = buildTeardownReport(stackResults);

      expect(report.allRemoved).toBe(true);
      expect(report.leftoverStacks).toEqual([]);
      expect(report.removedStacks).toEqual([
        "ClaimClarify-Data",
        "ClaimClarify-Certificate",
      ]);

      const text = formatTeardownReport(report);
      expect(text).toContain(
        "All ClaimClarify resources were removed successfully."
      );
    });

    it("names the leftover stack and the resource that was NOT removed on a DELETE_FAILED (Req 14.5)", () => {
      // Simulate teardown where the Certificate stack is gone but the Data
      // stack is stuck in DELETE_FAILED because its S3_Origin bucket could not
      // be deleted — the exact leftover scenario Req 14.5 covers.
      const dataDescribeStacks = JSON.stringify({
        Stacks: [
          {
            StackName: "ClaimClarify-Data",
            StackStatus: "DELETE_FAILED",
          },
        ],
      });
      const dataDescribeResources = JSON.stringify({
        StackResources: [
          {
            LogicalResourceId: "OriginBucketCA772B8F",
            ResourceType: "AWS::S3::Bucket",
            ResourceStatus: "DELETE_FAILED",
          },
          {
            LogicalResourceId: "PolicyTableE50BDB2B",
            ResourceType: "AWS::DynamoDB::Table",
            ResourceStatus: "DELETE_COMPLETE",
          },
        ],
      });
      const certDescribeStacks =
        "An error occurred (ValidationError): Stack with id ClaimClarify-Certificate does not exist";

      // Data stack: still present, with one DELETE_FAILED resource.
      const dataPresence = parseStackPresence(
        "ClaimClarify-Data",
        dataDescribeStacks
      );
      const dataFailedResources = parseFailedResources(
        "ClaimClarify-Data",
        dataDescribeResources
      );

      // Certificate stack: successfully removed.
      const certPresence = parseStackPresence(
        "ClaimClarify-Certificate",
        certDescribeStacks
      );

      const report = buildTeardownReport([
        {
          stackName: "ClaimClarify-Data",
          region: "us-east-2",
          present: dataPresence.present,
          status: dataPresence.status,
          failedResources: dataFailedResources.map((r) => ({
            logicalId: r.logicalId,
            resourceType: r.resourceType,
            status: r.status,
          })),
        },
        {
          stackName: "ClaimClarify-Certificate",
          region: "us-east-1",
          present: certPresence.present,
          status: certPresence.status,
        },
      ]);

      // Teardown removed the certificate stack but left the data stack behind.
      expect(report.allRemoved).toBe(false);
      expect(report.removedStacks).toEqual(["ClaimClarify-Certificate"]);
      expect(report.leftoverStacks).toHaveLength(1);
      expect(report.leftoverStacks[0].stackName).toBe("ClaimClarify-Data");
      expect(report.leftoverStacks[0].status).toBe("DELETE_FAILED");

      // Only the DELETE_FAILED resource is reported as a leftover (the
      // DELETE_COMPLETE one is filtered out).
      expect(report.leftoverStacks[0].failedResources).toEqual([
        {
          logicalId: "OriginBucketCA772B8F",
          resourceType: "AWS::S3::Bucket",
          status: "DELETE_FAILED",
        },
      ]);

      // The rendered report must name BOTH the leftover stack and the specific
      // resource that was not removed (Req 14.5).
      const text = formatTeardownReport(report);
      expect(text).toContain("were NOT fully removed");
      expect(text).toContain("ClaimClarify-Data");
      expect(text).toContain("OriginBucketCA772B8F");
      expect(text).toContain("AWS::S3::Bucket");
      // The successfully-removed stack is still acknowledged.
      expect(text).toContain("Removed stacks: ClaimClarify-Certificate");
    });
  });
});
