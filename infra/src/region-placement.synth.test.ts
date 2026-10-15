/**
 * Region & certificate placement synthesis tests (task 21.1).
 *
 * These are credential-free assertions against the synthesized CloudFormation
 * template(s). They verify the two-region split ClaimClarify requires (Req 8):
 *
 * - Every core resource — the DynamoDB Policy_Table, the S3_Origin bucket, the
 *   API_Layer Lambda + API Gateway, the two AgentCore Runtime MCP servers, the
 *   Bedrock_Agent — plus every CloudWatch resource (log groups + alarms) is
 *   emitted into the ClaimClarifyDataStack, which is pinned to the
 *   Primary_Region `us-east-2` (Req 8.1, 8.5).
 * - The ACM certificate CloudFront uses lives in the ClaimClarifyCertificate
 *   Stack, pinned to the Certificate_Region `us-east-1` (Req 8.4).
 * - The CloudFront Distribution's ViewerCertificate references an ACM
 *   certificate ARN that is resolved cross-region (via a CDK cross-region
 *   export reader), i.e. CloudFront uses the `us-east-1` certificate (Req 8.4).
 *
 * The stacks are wired exactly as `app.ts` wires them: the `us-east-1`
 * certificate stack is instantiated first, its certificate is passed into the
 * `us-east-2` data stack, and both enable `crossRegionReferences`.
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
} from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
} from "./claimclarify-certificate-stack";

/**
 * Wire both stacks the way `app.ts` does: the Certificate_Region (`us-east-1`)
 * stack first, then the Primary_Region (`us-east-2`) data stack consuming its
 * certificate across regions. Returns both stacks and their synthesized
 * templates.
 */
function synthApp(): {
  dataStack: ClaimClarifyDataStack;
  certificateStack: ClaimClarifyCertificateStack;
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
    dataStack,
    certificateStack,
    dataTemplate: Template.fromStack(dataStack),
    certificateTemplate: Template.fromStack(certificateStack),
  };
}

describe("Region & certificate placement (task 21.1)", () => {
  describe("core resources in the Primary_Region us-east-2 (Req 8.1)", () => {
    it("pins the data stack to us-east-2", () => {
      const { dataStack } = synthApp();
      expect(dataStack.region).toBe("us-east-2");
    });

    it.each([
      ["DynamoDB Policy_Table", "AWS::DynamoDB::Table"],
      ["S3_Origin bucket", "AWS::S3::Bucket"],
      ["API_Layer Lambda", "AWS::Lambda::Function"],
      ["API Gateway HTTP API", "AWS::ApiGatewayV2::Api"],
      ["AgentCore Runtime MCP servers", "AWS::BedrockAgentCore::Runtime"],
      ["Bedrock_Agent", "AWS::Bedrock::Agent"],
    ] as const)(
      "emits the %s into the us-east-2 data stack",
      (_label, resourceType) => {
        const { dataTemplate } = synthApp();
        expect(
          Object.keys(dataTemplate.findResources(resourceType)).length
        ).toBeGreaterThan(0);
      }
    );

    it("deploys the DynamoDB Policy_Table with the policyId partition key in us-east-2", () => {
      const { dataTemplate } = synthApp();
      dataTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [{ AttributeName: "policyId", KeyType: "HASH" }],
      });
    });

    it("deploys BOTH AgentCore Runtime MCP servers in us-east-2", () => {
      const { dataTemplate } = synthApp();
      dataTemplate.resourceCountIs("AWS::BedrockAgentCore::Runtime", 2);
    });
  });

  describe("CloudWatch observability in the Primary_Region us-east-2 (Req 8.5)", () => {
    it("emits CloudWatch log groups for the monitored components into us-east-2", () => {
      const { dataTemplate } = synthApp();
      // Four explicit log groups (Bedrock_Agent, chat Lambda, both MCP servers)
      // are defined in-stack, so they live in us-east-2 (Req 12.1, 8.5).
      expect(
        Object.keys(dataTemplate.findResources("AWS::Logs::LogGroup")).length
      ).toBeGreaterThanOrEqual(4);
    });

    it("emits the error-rate CloudWatch alarms into us-east-2", () => {
      const { dataTemplate } = synthApp();
      // One alarm per monitored component (chat Lambda + two MCP servers).
      dataTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    });
  });

  describe("ACM certificate in the Certificate_Region us-east-1 (Req 8.4)", () => {
    it("pins the certificate stack to us-east-1", () => {
      const { certificateStack } = synthApp();
      expect(certificateStack.region).toBe("us-east-1");
    });

    it("emits the CloudFront viewer ACM certificate (DNS-validated) into us-east-1", () => {
      const { certificateTemplate } = synthApp();
      certificateTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
        ValidationMethod: "DNS",
      });
    });
  });

  describe("CloudFront uses the us-east-1 certificate (Req 8.4)", () => {
    it("defines exactly one CloudFront Distribution in the us-east-2 data stack", () => {
      const { dataTemplate } = synthApp();
      dataTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });

    it("references the us-east-1 ACM certificate as its viewer certificate across regions", () => {
      const { dataTemplate } = synthApp();

      const distributions = dataTemplate.findResources(
        "AWS::CloudFront::Distribution"
      );
      const distribution = Object.values(distributions)[0];
      const viewerCertificate =
        distribution.Properties.DistributionConfig.ViewerCertificate;

      // CloudFront must use the cross-region ACM certificate, so the viewer
      // certificate carries an AcmCertificateArn (not the default
      // *.cloudfront.net cert) and pins min TLS 1.2 with SNI (Req 8.4).
      expect(viewerCertificate).toMatchObject({
        MinimumProtocolVersion: "TLSv1.2_2021",
        SslSupportMethod: "sni-only",
      });
      expect(viewerCertificate.AcmCertificateArn).toBeDefined();
      // The default CloudFront certificate flag must NOT be set — a real ACM
      // cert is in use.
      expect(viewerCertificate.CloudFrontDefaultCertificate).toBeUndefined();

      // The ARN is resolved cross-region: CDK wires the us-east-1 cert into the
      // us-east-2 distribution via a cross-region export reader custom
      // resource, so the ARN is an Fn::GetAtt against that reader rather than a
      // same-stack ref. This proves the certificate comes from another region.
      const arn = viewerCertificate.AcmCertificateArn;
      const getAttTarget = arn?.["Fn::GetAtt"]?.[0];
      expect(typeof getAttTarget).toBe("string");
      expect(getAttTarget).toMatch(/ExportsReader/);

      // The cross-region export the reader resolves points at the certificate
      // stack's exported CloudFront certificate reference.
      const exportPath = arn?.["Fn::GetAtt"]?.[1] as string;
      expect(exportPath).toContain("CloudFrontCertificate");
    });

    it("provisions the cross-region export reader custom resource in the data stack", () => {
      const { dataTemplate } = synthApp();
      // The cross-region reference reader is what lets the us-east-2 stack read
      // the us-east-1 certificate ARN; assert it exists.
      const readers = dataTemplate.findResources(
        "Custom::CrossRegionExportReader"
      );
      expect(Object.keys(readers).length).toBeGreaterThan(0);
    });
  });

  it("does not create or mutate the shared Hosted_Zone in either stack (Req 9.3) — sanity for region tests", () => {
    const { dataTemplate, certificateTemplate } = synthApp();
    // Neither region-pinned stack should emit an AWS::Route53::HostedZone;
    // the zone is referenced read-only. This keeps the placement tests honest.
    dataTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
    certificateTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
  });
});
