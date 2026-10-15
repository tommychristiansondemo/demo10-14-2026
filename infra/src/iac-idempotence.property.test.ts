/**
 * IaC idempotence property test (task 21.7).
 *
 * Property 16 (design.md): "For any already-provisioned environment, applying
 * the IaC_Template a second time produces an empty change set, leaving all
 * previously provisioned resources unchanged." (Req 14.3)
 *
 * ## How idempotence / an empty change set is modeled credential-free
 *
 * A real `cdk diff` against a provisioned environment needs AWS credentials and
 * a deployed CloudFormation stack, which this credential-free test suite cannot
 * use. We model the requirement at the template level instead: a CloudFormation
 * deployment is idempotent exactly when re-synthesizing the SAME IaC with the
 * SAME inputs yields a byte/structurally IDENTICAL template — CloudFormation
 * then computes an empty change set (no resource is added, removed, or
 * modified) and every provisioned resource is left unchanged.
 *
 * Concretely, for each generated-but-fixed configuration we instantiate two
 * fully independent `App` + stack trees (the first synth stands in for the
 * "already-provisioned environment", the second for the "re-apply"), take
 * `Template.fromStack(...).toJSON()` of each, and assert the two templates are
 * deeply equal. A deep-equal template is the template-level equivalent of an
 * empty `cdk diff`: zero drift.
 *
 * ## fast-check over provisioned-state fixtures
 *
 * fast-check generates the varying-but-fixed inputs that parameterize a
 * deployment — `environmentName`, the CloudFront `appDomainName` drawn from a
 * small set, `hostedZoneId`, and an `existingZoneRecordNames` snapshot that
 * still passes {@link dnsPrecheck} (so synthesis succeeds and actually emits the
 * App_DNS_Record). For each generated config, the property asserts that two
 * independent synths of that same config are template-identical. Runs 100
 * iterations.
 *
 * ## Determinism note (asset hashes)
 *
 * CDK embeds Lambda/custom-resource asset hashes in the template. Those hashes
 * are content-addressed, so for IDENTICAL inputs two synths produce IDENTICAL
 * hashes — they do not introduce nondeterminism here and need no normalization.
 * The assertion is a straight deep-equality of the raw `toJSON()` output; no
 * field is stripped. (If any field ever differed for identical input it would
 * signal real nondeterminism — a genuine idempotence violation — and the test
 * should fail rather than mask it.)
 */
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  RESERVED_DNS_RECORD_NAME,
  dnsPrecheck,
  type ZoneSnapshot,
} from "@claimclarify/shared";

import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
  type ClaimClarifyDataStackProps,
} from "./claimclarify-stack";
import {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
} from "./claimclarify-certificate-stack";

/**
 * A deployment configuration — the varying-but-fixed inputs that parameterize a
 * single provisioning of the ClaimClarify IaC. All fields are chosen so that
 * synthesis succeeds (the App_DNS_Record name passes {@link dnsPrecheck}).
 */
interface DeploymentConfig {
  readonly environmentName: string;
  readonly appDomainName: string;
  readonly hostedZoneId: string;
  readonly existingZoneRecordNames: readonly string[];
}

/**
 * The 12-char account id CDK requires for an `env`-pinned stack. Fixed so it is
 * not a source of variation — the config under test is what varies.
 */
const ACCOUNT = "111111111111";

/**
 * Synthesize the full ClaimClarify IaC (the `us-east-1` certificate stack + the
 * `us-east-2` data stack, wired exactly as `app.ts`/`region-placement.synth.test`
 * wire them) for a given {@link DeploymentConfig}, and return the data stack's
 * synthesized CloudFormation template as plain JSON.
 *
 * Each call builds a brand-new, independent `App`, so two calls with the same
 * config stand in for "provision" then "re-apply against the already-provisioned
 * environment".
 */
function synthDataTemplate(config: DeploymentConfig): object {
  const app = new App();

  const certificateStack = new ClaimClarifyCertificateStack(
    app,
    "ClaimClarify-Certificate",
    {
      env: { account: ACCOUNT, region: CERTIFICATE_REGION },
      crossRegionReferences: true,
      appDomainName: config.appDomainName,
    }
  );

  const dataProps: ClaimClarifyDataStackProps = {
    env: { account: ACCOUNT, region: PRIMARY_REGION },
    crossRegionReferences: true,
    cloudFrontCertificate: certificateStack.certificate,
    cloudFrontDomainName: config.appDomainName,
    environmentName: config.environmentName,
    hostedZoneId: config.hostedZoneId,
    existingZoneRecordNames: config.existingZoneRecordNames as ZoneSnapshot,
  };

  const dataStack = new ClaimClarifyDataStack(app, "ClaimClarify-Data", dataProps);
  dataStack.addDependency(certificateStack);

  return Template.fromStack(dataStack).toJSON();
}

/**
 * A fast-check arbitrary producing deployment configs whose App_DNS_Record name
 * is guaranteed to pass {@link dnsPrecheck}: it is never the reserved
 * `www.awsteach.com` and is never present in the generated zone snapshot. This
 * keeps synthesis successful so the DNS record is actually emitted and compared.
 */
const deploymentConfig: fc.Arbitrary<DeploymentConfig> = fc
  .record({
    environmentName: fc.constantFrom("demo", "dev", "staging", "prod", "sandbox"),
    // A small set of plausible App_DNS_Record names, none of which is the
    // reserved www.awsteach.com.
    appDomainName: fc.constantFrom(
      "ohio.awsteach.com",
      "claims.awsteach.com",
      "triage.awsteach.com",
      "app.awsteach.com",
      "demo.awsteach.com"
    ),
    // A deploy-time hosted-zone id (varying, uppercase alphanumerics like a
    // real Route 53 zone id).
    hostedZoneId: fc
      .array(
        fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")),
        { minLength: 1, maxLength: 14 }
      )
      .map((chars) => `Z${chars.join("")}`),
    // A snapshot of records already in the zone. Always includes the reserved
    // record (mirroring DEFAULT_ZONE_SNAPSHOT) plus some arbitrary others.
    otherZoneRecords: fc.array(
      fc
        .string({ minLength: 1, maxLength: 12 })
        .map((s) => `${s.replace(/[^a-zA-Z0-9]/g, "")}.awsteach.com`)
        .filter((n) => n !== "." && n.length > ".awsteach.com".length),
      { minLength: 0, maxLength: 5 }
    ),
  })
  .map(({ environmentName, appDomainName, hostedZoneId, otherZoneRecords }) => {
    // Build the zone snapshot, then strip any entry equal to the chosen
    // App_DNS_Record name so the precheck proceeds (name absent from zone).
    const existingZoneRecordNames = [
      RESERVED_DNS_RECORD_NAME,
      ...otherZoneRecords,
    ].filter((n) => n !== appDomainName);
    return { environmentName, appDomainName, hostedZoneId, existingZoneRecordNames };
  })
  // Belt-and-suspenders: only keep configs the precheck actually accepts, so a
  // generated collision can never make synthesis throw and mask the property.
  .filter(
    (c) => dnsPrecheck(c.appDomainName, c.existingZoneRecordNames).proceed === true
  );

/**
 * Feature: claimclarify, Property 16: IaC idempotence
 *
 * For any already-provisioned environment, applying the IaC_Template a second
 * time produces an empty change set, leaving all previously provisioned
 * resources unchanged. Modeled as: two independent synths of the SAME
 * configuration produce structurally-identical CloudFormation templates (an
 * empty diff / no drift).
 *
 * Validates: Requirements 14.3
 */
describe("Property 16: IaC idempotence (Req 14.3)", () => {
  it("re-synthesizing the same configuration yields an identical template (empty change set / no drift)", () => {
    fc.assert(
      fc.property(deploymentConfig, (config) => {
        // First synth: stands in for the already-provisioned environment.
        const firstTemplate = synthDataTemplate(config);
        // Second synth: stands in for re-applying the SAME IaC against it.
        const secondTemplate = synthDataTemplate(config);

        // Deep equality of the two templates is the template-level equivalent of
        // an empty `cdk diff`: no resource added, removed, or modified. Any
        // difference would be drift and a genuine idempotence violation.
        expect(secondTemplate).toEqual(firstTemplate);
      }),
      { numRuns: 100 }
    );
  });
});
