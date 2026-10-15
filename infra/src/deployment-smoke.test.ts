/**
 * Deployment smoke tests (task 23.1).
 *
 * ## What these model and why they live at the synthesis level
 *
 * The real post-deploy smoke suite would run against the LIVE deployment: curl
 * the App_DNS_Record over HTTPS, attempt a plain-HTTP/old-TLS connection and
 * confirm it is refused, and ping both MCP servers on AgentCore Runtime. Live
 * AWS is unavailable in this environment, so each check is modeled against the
 * synthesized CloudFormation template of the two stacks wired exactly as
 * `app.ts` wires them. Every assertion corresponds one-to-one with a live
 * smoke assertion and is named to reflect that smoke intent, so it can be
 * promoted to a live probe later without changing the contract it verifies.
 *
 * The three smoke checks (Req 4.1, 6.1, 11.4):
 *
 * 1. **MCP servers deployed to AgentCore Runtime in us-east-2 and reachable**
 *    (Req 4.1, 6.1). Modeled as: both `AWS::BedrockAgentCore::Runtime`
 *    resources exist in the us-east-2 data stack, each with protocol `MCP` and
 *    `PUBLIC` network mode. PUBLIC + MCP is exactly the wiring that makes a
 *    runtime reachable by the Bedrock_Agent over the MCP protocol; at runtime
 *    the live smoke check would open an MCP session to each runtime endpoint.
 *
 * 2. **A non-TLS request to the API endpoint is rejected** (Req 11.4). The
 *    synthesized config refuses non-TLS two ways: the API Gateway custom domain
 *    pins `SecurityPolicy: TLS_1_2` (min TLS 1.2, so TLS<1.2 is refused) and
 *    CloudFront redirects HTTP→HTTPS for viewers while talking to the API
 *    origin `https-only`. At runtime a plain-HTTP or TLS<1.2 connection to the
 *    API is therefore refused — documented on each assertion.
 *
 * 3. **The deployed stack serves the Chat_UI over HTTPS at the App_DNS_Record
 *    URL**. Modeled as: the App_DNS_Record (`ohio.awsteach.com`) aliases the
 *    CloudFront distribution, and CloudFront serves the S3_Origin default
 *    behavior over HTTPS (`redirect-to-https`). At runtime, GET
 *    https://ohio.awsteach.com/ returns the Chat_UI from the S3_Origin.
 *
 * These stay green alongside the existing synthesis tests; they assert the same
 * synthesized template from the smoke-test point of view.
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClaimClarifyDataStack, PRIMARY_REGION } from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
  APP_DOMAIN_NAME,
} from "./claimclarify-certificate-stack";

/**
 * Build the whole app exactly as `app.ts` does — the us-east-1 certificate
 * stack first, then the us-east-2 data stack consuming its certificate +
 * domain across regions — and synthesize both templates. This mirrors the
 * deployed topology the live smoke tests would probe.
 */
function synthDeployedApp(): {
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

describe("ClaimClarify deployment smoke tests (task 23.1)", () => {
  // ---------------------------------------------------------------------------
  // Smoke check 1: MCP servers deployed to AgentCore Runtime and reachable
  // (Req 4.1, 6.1). Live equivalent: open an MCP session to each runtime
  // endpoint in us-east-2 and confirm it answers. Modeled here as: both
  // runtimes exist with protocol MCP + PUBLIC network mode (the reachable
  // wiring).
  // ---------------------------------------------------------------------------
  describe("smoke: MCP servers are deployed to AgentCore Runtime in us-east-2 and reachable (Req 4.1, 6.1)", () => {
    it("the data stack that hosts the AgentCore runtimes is deployed to us-east-2", () => {
      const { dataStack } = synthDeployedApp();
      expect(dataStack.region).toBe(PRIMARY_REGION);
    });

    it("deploys exactly the two MCP-server AgentCore runtimes (policy-lookup + repair-estimator)", () => {
      const { dataTemplate } = synthDeployedApp();
      dataTemplate.resourceCountIs("AWS::BedrockAgentCore::Runtime", 2);
    });

    it("the Policy_Lookup_Server runtime is reachable: MCP protocol + PUBLIC network mode (Req 4.1)", () => {
      const { dataTemplate } = synthDeployedApp();
      // PUBLIC network mode + MCP protocol is what makes the runtime reachable
      // by the Bedrock_Agent over the MCP protocol; a live smoke probe would
      // open an MCP session against this runtime's endpoint.
      dataTemplate.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
        AgentRuntimeName: "claimclarify_policy_lookup",
        ProtocolConfiguration: "MCP",
        NetworkConfiguration: Match.objectLike({ NetworkMode: "PUBLIC" }),
      });
    });

    it("the Repair_Estimator_Server runtime is reachable: MCP protocol + PUBLIC network mode (Req 6.1)", () => {
      const { dataTemplate } = synthDeployedApp();
      dataTemplate.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
        AgentRuntimeName: "claimclarify_repair_estimator",
        ProtocolConfiguration: "MCP",
        NetworkConfiguration: Match.objectLike({ NetworkMode: "PUBLIC" }),
      });
    });

    it("BOTH AgentCore runtimes expose the MCP protocol (every runtime is MCP-reachable)", () => {
      const { dataTemplate } = synthDeployedApp();
      const runtimes = dataTemplate.findResources(
        "AWS::BedrockAgentCore::Runtime"
      );
      const configs = Object.values(runtimes);
      expect(configs).toHaveLength(2);
      for (const runtime of configs) {
        expect(runtime.Properties.ProtocolConfiguration).toBe("MCP");
        expect(runtime.Properties.NetworkConfiguration).toMatchObject({
          NetworkMode: "PUBLIC",
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Smoke check 2: a non-TLS request to the API endpoint is rejected
  // (Req 11.4). Live equivalent: attempt `http://.../api/chat` (or a TLS<1.2
  // handshake) and confirm the connection is refused / redirected to HTTPS.
  // Modeled here as: API custom domain pins min TLS 1.2 and CloudFront
  // redirects HTTP→HTTPS for viewers and speaks https-only to the API origin.
  // ---------------------------------------------------------------------------
  describe("smoke: a non-TLS request to the API endpoint is rejected (Req 11.4)", () => {
    it("the API Gateway custom domain pins SecurityPolicy TLS_1_2, so a TLS<1.2 handshake is refused", () => {
      const { dataTemplate } = synthDeployedApp();
      // At runtime, API Gateway refuses any client connection negotiating below
      // TLS 1.2 (and plain HTTP) because the domain's security policy is pinned
      // to TLS_1_2 — this is the API endpoint rejecting a non-TLS request.
      dataTemplate.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
        DomainNameConfigurations: Match.arrayWith([
          Match.objectLike({ SecurityPolicy: "TLS_1_2" }),
        ]),
      });
    });

    it("every API custom-domain config enforces min TLS 1.2 (no non-TLS/weak-TLS listener exists)", () => {
      const { dataTemplate } = synthDeployedApp();
      const domains = dataTemplate.findResources(
        "AWS::ApiGatewayV2::DomainName"
      );
      const configs = Object.values(domains).flatMap(
        (d) =>
          (d.Properties?.DomainNameConfigurations ?? []) as Array<
            Record<string, unknown>
          >
      );
      expect(configs.length).toBeGreaterThanOrEqual(1);
      for (const c of configs) {
        // No config may leave TLS unpinned or set below 1.2; a non-TLS or
        // weak-TLS connection has no listener to terminate on and is refused.
        expect(c.SecurityPolicy).toBe("TLS_1_2");
      }
    });

    it("CloudFront redirects a plain-HTTP request to the /api/* behavior to HTTPS (viewer non-TLS rejected at the edge)", () => {
      const { dataTemplate } = synthDeployedApp();
      // A viewer that hits http://.../api/... is sent a redirect to the HTTPS
      // URL rather than being served over plain HTTP — the edge refuses to
      // carry API traffic without TLS.
      dataTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
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

    it("CloudFront talks to the API origin https-only with TLS 1.2 (no non-TLS hop to the API)", () => {
      const { dataTemplate } = synthDeployedApp();
      // The CloudFront→API origin hop is HTTPS-only at TLS 1.2+, so the API is
      // never reached over a non-TLS connection from the edge either.
      dataTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
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

  // ---------------------------------------------------------------------------
  // Smoke check 3: the deployed stack serves the Chat_UI over HTTPS at the
  // App_DNS_Record URL. Live equivalent: GET https://ohio.awsteach.com/ and
  // confirm a 200 serving the Chat_UI over HTTPS. Modeled here as: the
  // App_DNS_Record aliases the CloudFront distribution and CloudFront serves
  // the S3_Origin default behavior over HTTPS (redirect-to-https).
  // ---------------------------------------------------------------------------
  describe("smoke: the deployed stack serves the Chat_UI over HTTPS at the App_DNS_Record URL", () => {
    it("the App_DNS_Record is published for ohio.awsteach.com (the Chat_UI URL host)", () => {
      const { dataTemplate } = synthDeployedApp();
      // Both an A and AAAA alias are published; assert the A record carries the
      // App_DNS_Record host. CDK renders the absolute record name with a
      // trailing dot.
      dataTemplate.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: "A",
        Name: `${APP_DOMAIN_NAME}.`,
      });
    });

    it("the App_DNS_Record aliases the CloudFront distribution (resolves straight to the edge)", () => {
      const { dataTemplate } = synthDeployedApp();
      const records = dataTemplate.findResources("AWS::Route53::RecordSet");
      const aRecord = Object.values(records).find(
        (r) =>
          r.Properties?.Type === "A" &&
          r.Properties?.Name === `${APP_DOMAIN_NAME}.`
      );
      expect(aRecord).toBeDefined();
      // An alias record targets the CloudFront distribution via AliasTarget.
      const aliasTarget = aRecord?.Properties?.AliasTarget as
        | Record<string, unknown>
        | undefined;
      expect(aliasTarget).toBeDefined();
      // CDK renders the CloudFront alias hosted-zone id through the global
      // CloudFront partition map (which resolves to the well-known
      // Z2FDTNDATAQYW2), so assert the AliasTarget references that CloudFront
      // zone-id mapping rather than a literal — this is what makes the record a
      // CloudFront alias.
      const hostedZoneId = aliasTarget?.HostedZoneId as
        | Record<string, unknown>
        | undefined;
      const findInMap = hostedZoneId?.["Fn::FindInMap"] as unknown[] | undefined;
      expect(findInMap).toBeDefined();
      expect(findInMap?.[0]).toBe("AWSCloudFrontPartitionHostedZoneIdMap");
      // The alias DNS name resolves to the distribution's domain name.
      expect(aliasTarget?.DNSName).toBeDefined();
    });

    it("the App_DNS_Record domain is distinct from the reserved www.awsteach.com (does not disturb the other app)", () => {
      const { dataTemplate } = synthDeployedApp();
      const records = dataTemplate.findResources("AWS::Route53::RecordSet");
      for (const r of Object.values(records)) {
        expect(r.Properties?.Name).not.toBe("www.awsteach.com.");
      }
    });

    it("CloudFront serves the default (S3_Origin) behavior over HTTPS via redirect-to-https (Chat_UI over HTTPS)", () => {
      const { dataTemplate } = synthDeployedApp();
      // A viewer hitting http://ohio.awsteach.com/ is redirected to HTTPS, so
      // the Chat_UI is only ever served over HTTPS.
      dataTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: "redirect-to-https",
          }),
        }),
      });
    });

    it("CloudFront answers on the ohio.awsteach.com alias with a TLS 1.2+ viewer certificate (HTTPS at the App_DNS_Record URL)", () => {
      const { dataTemplate } = synthDeployedApp();
      // The distribution must list the App_DNS_Record host as an alias and
      // terminate TLS for it at min TLS 1.2 — so HTTPS at the App_DNS_Record
      // URL is actually served by this distribution.
      dataTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Aliases: Match.arrayWith([APP_DOMAIN_NAME]),
          ViewerCertificate: Match.objectLike({
            MinimumProtocolVersion: "TLSv1.2_2021",
            SslSupportMethod: "sni-only",
          }),
        }),
      });
    });

    it("the default behavior is backed by the S3_Origin (the Chat_UI assets), not the API origin", () => {
      const { dataTemplate } = synthDeployedApp();
      const distributions = dataTemplate.findResources(
        "AWS::CloudFront::Distribution"
      );
      const [distribution] = Object.values(distributions);
      const config = distribution.Properties.DistributionConfig;

      const defaultTargetId = config.DefaultCacheBehavior.TargetOriginId;
      const origins = config.Origins as Array<Record<string, unknown>>;
      const defaultOrigin = origins.find((o) => o.Id === defaultTargetId) as
        | Record<string, unknown>
        | undefined;
      expect(defaultOrigin).toBeDefined();
      // The S3_Origin uses OAC (OriginAccessControlId) and has no
      // CustomOriginConfig; the API origin is the opposite.
      expect(defaultOrigin).toHaveProperty("OriginAccessControlId");
      expect(defaultOrigin).not.toHaveProperty("CustomOriginConfig");
    });
  });
});
