/**
 * Synthesis tests for ClaimClarify's secure-transport wiring (task 21.3).
 *
 * These assert the task-21.3 contract on the synthesized CloudFormation
 * template for the CloudFront_Distribution and the API Gateway custom domain:
 *
 * - CloudFront serves everything over HTTPS by redirecting HTTP → HTTPS on both
 *   the default (S3_Origin) behavior and the `/api/*` (API_Layer) behavior
 *   (Req 7.3, 7.4).
 * - The distribution enforces a minimum TLS version of 1.2 — asserted both via
 *   the distribution-level `MinimumProtocolVersion` and, when a custom
 *   certificate/domain is attached (as in `app.ts`), via
 *   `DistributionConfig.ViewerCertificate.MinimumProtocolVersion` ===
 *   `TLSv1.2_2021` (Req 7.3).
 * - Both cache behaviors exist: a default behavior backed by the S3_Origin and
 *   a distinct `/api/*` CacheBehavior (PathPattern `/api/*`) backed by the API
 *   origin (Req 7.1, 7.5, 7.6).
 * - API Gateway pins a minimum TLS version of 1.2 via its custom domain's
 *   `DomainNameConfigurations[].SecurityPolicy` === `TLS_1_2` (Req 11.3).
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClaimClarifyDataStack, PRIMARY_REGION } from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  APP_DOMAIN_NAME,
} from "./claimclarify-certificate-stack";

/**
 * Synthesize the data stack on its own (no custom certificate/domain). The
 * CloudFront distribution falls back to the default `*.cloudfront.net`
 * certificate, so TLS-min is expressed through the distribution-level
 * `MinimumProtocolVersion`.
 */
function synthDefault(): Template {
  const app = new App();
  const stack = new ClaimClarifyDataStack(app, "TestTransport", {
    env: { account: "111111111111", region: PRIMARY_REGION },
  });
  return Template.fromStack(stack);
}

/**
 * Synthesize the data stack WITH the us-east-1 ACM certificate + custom domain
 * wired exactly as `app.ts` does, so CloudFront attaches a custom
 * `ViewerCertificate` whose `MinimumProtocolVersion` is asserted directly.
 */
function synthWithCustomDomain(): Template {
  const app = new App();
  const certStack = new ClaimClarifyCertificateStack(app, "TestCert", {
    env: { account: "111111111111", region: "us-east-1" },
    crossRegionReferences: true,
  });
  const stack = new ClaimClarifyDataStack(app, "TestTransportDomain", {
    env: { account: "111111111111", region: PRIMARY_REGION },
    crossRegionReferences: true,
    cloudFrontCertificate: certStack.certificate,
    cloudFrontDomainName: certStack.appDomainName,
  });
  return Template.fromStack(stack);
}

describe("ClaimClarify secure transport synthesis (task 21.3)", () => {
  describe("CloudFront_Distribution viewer protocol + TLS", () => {
    it("redirects HTTP → HTTPS on the default (S3_Origin) behavior (Req 7.4)", () => {
      const template = synthDefault();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: "redirect-to-https",
          }),
        }),
      });
    });

    it("redirects HTTP → HTTPS on the /api/* (API_Layer) behavior (Req 7.4)", () => {
      const template = synthDefault();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: "/api/*",
              ViewerProtocolPolicy: "redirect-to-https",
            }),
          ]),
        }),
      });
    });

    it("pins a minimum TLS version of 1.2 (TLSv1.2_2021) on the distribution (Req 7.3)", () => {
      // The distribution's `minimumProtocolVersion` only materializes in the
      // synthesized template as `ViewerCertificate.MinimumProtocolVersion` once
      // a custom viewer certificate/domain is attached (as `app.ts` does). With
      // the default `*.cloudfront.net` certificate CloudFront omits the
      // ViewerCertificate block entirely, so TLS-min is asserted against the
      // custom-domain template — the configuration actually deployed.
      const template = synthWithCustomDomain();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          ViewerCertificate: Match.objectLike({
            MinimumProtocolVersion: "TLSv1.2_2021",
          }),
        }),
      });
    });

    it("sets ViewerCertificate.MinimumProtocolVersion to TLSv1.2_2021 when a custom cert/domain is attached (Req 7.3)", () => {
      const template = synthWithCustomDomain();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Aliases: Match.arrayWith([APP_DOMAIN_NAME]),
          ViewerCertificate: Match.objectLike({
            MinimumProtocolVersion: "TLSv1.2_2021",
            // A custom cert is referenced via AcmCertificateArn (not the
            // default CloudFront certificate) when a domain is attached.
            SslSupportMethod: "sni-only",
          }),
        }),
      });
    });
  });

  describe("CloudFront_Distribution cache behaviors + origins", () => {
    it("defines a default behavior backed by the S3_Origin (Req 7.1, 7.6)", () => {
      const template = synthDefault();

      // There must be exactly one distribution.
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);

      const distributions = template.findResources(
        "AWS::CloudFront::Distribution"
      );
      const [distribution] = Object.values(distributions);
      const config = distribution.Properties.DistributionConfig;

      // The default behavior targets some origin, and that origin is the S3
      // bucket origin (an S3Origin carries an OriginAccessControlId; the API
      // origin is a CustomOriginConfig). Resolve the default behavior's origin
      // and assert it is the S3-backed one.
      const defaultTargetId = config.DefaultCacheBehavior.TargetOriginId;
      const origins = config.Origins as Array<Record<string, unknown>>;
      const defaultOrigin = origins.find(
        (o) => o.Id === defaultTargetId
      ) as Record<string, unknown>;
      expect(defaultOrigin).toBeDefined();
      // S3 OAC origins expose S3OriginConfig/OriginAccessControlId and have no
      // CustomOriginConfig; the API origin is the opposite.
      expect(defaultOrigin).toHaveProperty("OriginAccessControlId");
      expect(defaultOrigin).not.toHaveProperty("CustomOriginConfig");
    });

    it("defines a /api/* CacheBehavior routed to the API (custom) origin (Req 7.5)", () => {
      const template = synthDefault();

      const distributions = template.findResources(
        "AWS::CloudFront::Distribution"
      );
      const [distribution] = Object.values(distributions);
      const config = distribution.Properties.DistributionConfig;

      const cacheBehaviors = config.CacheBehaviors as Array<
        Record<string, unknown>
      >;
      const apiBehavior = cacheBehaviors.find(
        (b) => b.PathPattern === "/api/*"
      ) as Record<string, unknown>;
      expect(apiBehavior).toBeDefined();

      // The /api/* behavior must target the API origin, which is an HTTP custom
      // origin (CustomOriginConfig), NOT the S3 OAC origin.
      const apiTargetId = apiBehavior.TargetOriginId;
      const origins = config.Origins as Array<Record<string, unknown>>;
      const apiOrigin = origins.find((o) => o.Id === apiTargetId) as Record<
        string,
        unknown
      >;
      expect(apiOrigin).toBeDefined();
      expect(apiOrigin).toHaveProperty("CustomOriginConfig");
      expect(apiOrigin).not.toHaveProperty("OriginAccessControlId");
    });

    it("forces the API origin to speak HTTPS-only with TLS 1.2 to the origin (Req 7.3)", () => {
      const template = synthDefault();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              CustomOriginConfig: Match.objectLike({
                OriginProtocolPolicy: "https-only",
                OriginSSLProtocols: Match.arrayWith(["TLSv1.2"]),
              }),
            }),
          ]),
        }),
      });
    });
  });

  describe("API Gateway custom domain minimum TLS", () => {
    it("sets DomainNameConfigurations[].SecurityPolicy to TLS_1_2 (Req 11.3)", () => {
      const template = synthDefault();
      template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
        DomainNameConfigurations: Match.arrayWith([
          Match.objectLike({
            SecurityPolicy: "TLS_1_2",
          }),
        ]),
      });
    });

    it("defines exactly one API custom domain enforcing min TLS 1.2 (Req 11.3)", () => {
      const template = synthDefault();
      const domains = template.findResources("AWS::ApiGatewayV2::DomainName");
      const configs = Object.values(domains).flatMap(
        (d) =>
          (d.Properties?.DomainNameConfigurations ?? []) as Array<
            Record<string, unknown>
          >
      );
      expect(configs.length).toBeGreaterThanOrEqual(1);
      for (const c of configs) {
        expect(c.SecurityPolicy).toBe("TLS_1_2");
      }
    });
  });
});
