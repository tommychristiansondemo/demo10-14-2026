/**
 * Certificate & DNS integration tests (task 22.3).
 *
 * Live AWS is unavailable in this environment, so these "integration" tests run
 * at the CDK synthesis / cross-stack wiring level: they build an App that
 * mirrors `app.ts` (both the `us-east-1` {@link ClaimClarifyCertificateStack}
 * and the `us-east-2` {@link ClaimClarifyDataStack}, wired with
 * `dataStack.addDependency(certificateStack)` and `crossRegionReferences`) and
 * assert the deploy-ordering and DNS contracts across the two stacks together,
 * rather than any single stack in isolation. 1–3 representative examples per
 * contract (per the design's integration-test guidance).
 *
 * Contracts covered:
 *
 * ## ACM certificate in us-east-1, issued/validated BEFORE CloudFront (Req 8.2, 8.3)
 *
 * - The certificate stack is pinned to `us-east-1` and emits a DNS-validated
 *   ACM certificate (the inherent issued+validated gate — Req 8.2).
 * - The app wires `dataStack.addDependency(certificateStack)` so CloudFormation
 *   deploys the certificate stack (and the cert reaches ISSUED) before the
 *   data stack provisions CloudFront (Req 8.2). We assert the dependency is
 *   present and directional, and that CloudFront in the data stack references
 *   the cross-region certificate ARN — the reference that makes the gate
 *   binding (document the inherent DNS-validation block in Req 8.3).
 * - SIMULATED-FAILURE halt case (Req 8.3 analog via dnsPrecheck / Req 9.4):
 *   the cert's DNS-validation record and the App_DNS_Record share the
 *   `awsteach.com` zone; the deploy halts if the configured name conflicts.
 *   We assert that synthesizing the data stack with a conflicting
 *   `cloudFrontDomainName` (equal to `www.awsteach.com`, or already present in
 *   `existingZoneRecordNames`) THROWS — mirroring the halt-on-failure behavior
 *   that gates CloudFront/DNS provisioning.
 *
 * ## www.awsteach.com unchanged across apply (Req 9.3)
 *
 * - Neither stack emits an `AWS::Route53::HostedZone` (the shared zone is
 *   imported read-only) and no `AWS::Route53::RecordSet` named
 *   `www.awsteach.com` is created. The deployment only creates its own
 *   `ohio.awsteach.com` record.
 */
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RESERVED_DNS_RECORD_NAME } from "@claimclarify/shared";
import { describe, expect, it } from "vitest";

import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
} from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
} from "./claimclarify-certificate-stack";

/** The App_DNS_Record domain the deployment creates (distinct from www). */
const APP_DOMAIN_NAME = "ohio.awsteach.com";

/**
 * Build an App that mirrors `app.ts`: the Certificate_Region (`us-east-1`)
 * stack first, then the Primary_Region (`us-east-2`) data stack consuming its
 * certificate + domain across regions, with `dataStack.addDependency(
 * certificateStack)` and `crossRegionReferences` on both. Returns the stacks
 * and their synthesized templates.
 */
function synthApp(): {
  app: App;
  certificateStack: ClaimClarifyCertificateStack;
  dataStack: ClaimClarifyDataStack;
  certificateTemplate: Template;
  dataTemplate: Template;
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
    app,
    certificateStack,
    dataStack,
    certificateTemplate: Template.fromStack(certificateStack),
    dataTemplate: Template.fromStack(dataStack),
  };
}

describe("Certificate & DNS integration (task 22.3)", () => {
  describe("ACM cert in us-east-1, issued/validated before CloudFront (Req 8.2, 8.3)", () => {
    it("places the DNS-validated ACM certificate in the us-east-1 certificate stack", () => {
      const { certificateStack, certificateTemplate } = synthApp();

      // The certificate stack is pinned to the Certificate_Region.
      expect(certificateStack.region).toBe("us-east-1");

      // It emits exactly one ACM certificate, DNS-validated. A DNS-validated
      // ACM certificate does not reach CREATE_COMPLETE until ACM observes the
      // validation CNAME and the cert transitions to ISSUED — this is the
      // inherent issued+validated gate (Req 8.2) whose failure halts the
      // deployment and surfaces the certificate (Req 8.3).
      certificateTemplate.resourceCountIs(
        "AWS::CertificateManager::Certificate",
        1
      );
      certificateTemplate.hasResourceProperties(
        "AWS::CertificateManager::Certificate",
        {
          DomainName: APP_DOMAIN_NAME,
          ValidationMethod: "DNS",
        }
      );
    });

    it("wires dataStack.addDependency(certificateStack) so the cert deploys (and validates) first", () => {
      const { certificateStack, dataStack } = synthApp();

      // The data stack (which owns CloudFront) declares a deploy-time
      // dependency on the certificate stack. CloudFormation therefore deploys
      // the certificate stack to completion — i.e. the DNS-validated cert
      // reaches ISSUED — before provisioning anything in the data stack,
      // including CloudFront (Req 8.2).
      const deps = dataStack.dependencies;
      expect(deps).toContain(certificateStack);

      // Directional: the certificate stack must NOT depend back on the data
      // stack, otherwise the ordering gate would be a cycle rather than
      // "certificate first".
      expect(certificateStack.dependencies).not.toContain(dataStack);
    });

    it("has CloudFront reference the cross-region cert ARN — the reference that binds the ordering gate", () => {
      const { dataTemplate } = synthApp();

      // Exactly one CloudFront distribution lives in the data stack.
      dataTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);

      const distributions = dataTemplate.findResources(
        "AWS::CloudFront::Distribution"
      );
      const viewerCertificate = (
        Object.values(distributions)[0] as {
          Properties: {
            DistributionConfig: { ViewerCertificate: Record<string, unknown> };
          };
        }
      ).Properties.DistributionConfig.ViewerCertificate;

      // CloudFront uses a real ACM cert (not the default *.cloudfront.net one),
      // resolved cross-region via a CDK ExportsReader custom resource — proving
      // the cert comes from the us-east-1 stack. Because CloudFront references
      // this ARN, it cannot provision until that cert exists/ISSUED (Req 8.2).
      const arn = viewerCertificate.AcmCertificateArn as
        | { "Fn::GetAtt"?: unknown[] }
        | undefined;
      expect(arn).toBeDefined();
      expect(
        viewerCertificate.CloudFrontDefaultCertificate
      ).toBeUndefined();

      const getAttTarget = arn?.["Fn::GetAtt"]?.[0] as string | undefined;
      expect(getAttTarget).toMatch(/ExportsReader/);
      const exportPath = arn?.["Fn::GetAtt"]?.[1] as string | undefined;
      expect(exportPath).toContain("CloudFrontCertificate");
    });

    // SIMULATED-FAILURE halt case (Req 8.3 analog via dnsPrecheck; Req 9.4).
    // The cert's DNS-validation record and the App_DNS_Record are published
    // into the same shared zone; a naming conflict halts the whole deployment
    // before any CloudFront/DNS/validation resource is emitted. We simulate the
    // halt by configuring a conflicting App_DNS_Record name and asserting synth
    // THROWS — mirroring the cert/DNS halt-on-failure behavior.
    it("HALTS synthesis when the configured domain equals the reserved www.awsteach.com (simulated failure)", () => {
      const app = new App();
      const certificateStack = new ClaimClarifyCertificateStack(
        app,
        "ClaimClarify-Certificate",
        {
          env: { account: "111111111111", region: CERTIFICATE_REGION },
          crossRegionReferences: true,
        }
      );

      expect(() => {
        new ClaimClarifyDataStack(app, "ClaimClarify-Data", {
          env: { account: "111111111111", region: PRIMARY_REGION },
          crossRegionReferences: true,
          cloudFrontCertificate: certificateStack.certificate,
          // Conflicts with the reserved record → precheck halt.
          cloudFrontDomainName: RESERVED_DNS_RECORD_NAME,
        });
      }).toThrow(/conflict|www\.awsteach\.com|Halting/i);
    });

    it("HALTS synthesis when the configured domain already exists in the zone snapshot (simulated failure)", () => {
      const app = new App();
      const certificateStack = new ClaimClarifyCertificateStack(
        app,
        "ClaimClarify-Certificate",
        {
          env: { account: "111111111111", region: CERTIFICATE_REGION },
          crossRegionReferences: true,
        }
      );

      expect(() => {
        new ClaimClarifyDataStack(app, "ClaimClarify-Data", {
          env: { account: "111111111111", region: PRIMARY_REGION },
          crossRegionReferences: true,
          cloudFrontCertificate: certificateStack.certificate,
          cloudFrontDomainName: APP_DOMAIN_NAME,
          // The App_DNS_Record name already exists in the zone → precheck halt,
          // mirroring the halt-on-failure gate (Req 9.4).
          existingZoneRecordNames: [
            RESERVED_DNS_RECORD_NAME,
            APP_DOMAIN_NAME,
          ],
        });
      }).toThrow(/conflict|ohio\.awsteach\.com|Halting/i);
    });
  });

  describe("www.awsteach.com unchanged across apply (Req 9.3)", () => {
    it("creates no AWS::Route53::HostedZone in either stack (shared zone imported read-only)", () => {
      const { certificateTemplate, dataTemplate } = synthApp();
      // Neither stack may create or mutate the shared zone.
      certificateTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
      dataTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
    });

    it("creates no RecordSet named www.awsteach.com — only its own ohio.awsteach.com record", () => {
      const { dataTemplate } = synthApp();

      const recordSets = dataTemplate.findResources("AWS::Route53::RecordSet");
      const names = Object.values(recordSets).map((r) => {
        const props = (r as { Properties?: Record<string, unknown> })
          .Properties;
        return props?.Name as string;
      });

      // The deployment only ever defines its own App_DNS_Record (A + AAAA for
      // ohio.awsteach.com); the pre-existing www.awsteach.com is never defined,
      // so it stays untouched across apply (Req 9.3).
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).toBe(`${APP_DOMAIN_NAME}.`);
        expect(name).not.toBe(`${RESERVED_DNS_RECORD_NAME}.`);
        expect(name).not.toBe(RESERVED_DNS_RECORD_NAME);
      }

      // And at least one of them is our own record, so the assertion is not
      // vacuously true on an empty set.
      expect(names).toContain(`${APP_DOMAIN_NAME}.`);
    });
  });
});
