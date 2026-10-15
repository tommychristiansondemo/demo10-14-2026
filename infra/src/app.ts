#!/usr/bin/env node
/**
 * ClaimClarify CDK application entry point.
 *
 * Instantiates the stacks that make up the ClaimClarify infrastructure. Task
 * 17.1 establishes this scaffold plus the data/storage/config stack; tasks
 * 18/19 add compute, API, agent, CloudFront, ACM, and DNS to it.
 *
 * ClaimClarify spans two regions (Req 8): all compute/data/config lives in the
 * Primary_Region `us-east-2` ({@link ClaimClarifyDataStack}), while the
 * CloudFront viewer ACM certificate must live in the Certificate_Region
 * `us-east-1` ({@link ClaimClarifyCertificateStack}, task 19.1). The CloudFront
 * distribution (task 19.2, defined in the primary stack) consumes the
 * `us-east-1` certificate across regions, so both stacks enable
 * `crossRegionReferences`.
 */
import { App } from "aws-cdk-lib";

import { ClaimClarifyCertificateStack } from "./claimclarify-certificate-stack";
import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
} from "./claimclarify-stack";

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;

/**
 * Deploy-time inputs supplied via `cdk ... -c <key>=<value>` (CDK context).
 * These are omitted during `cdk synth`/tests, where the stacks fall back to
 * synth-safe placeholders. For a real deploy they carry the account-specific
 * hosted zone id, the pushed MCP container image URIs, the region-available
 * Bedrock foundation model, the App_DNS_Record name, and the built Chat_UI
 * asset path.
 */
const ctx = {
  hostedZoneId: app.node.tryGetContext("hostedZoneId") as string | undefined,
  appDomainName: app.node.tryGetContext("appDomainName") as string | undefined,
  policyLookupImageUri: app.node.tryGetContext("policyLookupImageUri") as
    | string
    | undefined,
  repairEstimatorImageUri: app.node.tryGetContext("repairEstimatorImageUri") as
    | string
    | undefined,
  foundationModel: app.node.tryGetContext("foundationModel") as
    | string
    | undefined,
  uiAssetPath: app.node.tryGetContext("uiAssetPath") as string | undefined,
  // Context arrives as strings; treat only the explicit string "false" as
  // disabling AgentCore. Undefined (synth/tests/full deploy) → true.
  deployAgentCore:
    String(app.node.tryGetContext("deployAgentCore") ?? "true") !== "false",
};

// Certificate_Region (us-east-1) stack: owns the DNS-validated ACM certificate
// CloudFront uses as its viewer certificate (task 19.1, Req 8.2, 8.3, 8.4). It
// must be instantiated before the data stack so the CloudFront distribution in
// the primary stack can reference `certificateStack.certificate` cross-region.
const certificateStack = new ClaimClarifyCertificateStack(
  app,
  "ClaimClarify-Certificate",
  {
    env: { account, region: "us-east-1" },
    crossRegionReferences: true,
    appDomainName: ctx.appDomainName,
    hostedZoneId: ctx.hostedZoneId,
    description:
      "ClaimClarify CloudFront viewer ACM certificate in us-east-1 " +
      "(Certificate_Region) with DNS validation gate (Req 8.2, 8.3, 8.4)",
  }
);

const dataStack = new ClaimClarifyDataStack(app, "ClaimClarify-Data", {
  env: {
    account,
    region: PRIMARY_REGION,
  },
  // The CloudFront distribution (task 19.2) lives in this us-east-2 stack and
  // references the us-east-1 certificate above, so cross-region references must
  // be enabled on the consumer stack too.
  crossRegionReferences: true,
  // The CloudFront viewer certificate from the Certificate_Region. Exposed to
  // the stack so task 19.2 attaches it to the distribution; CloudFront's
  // reference to it is what gates provisioning on the certificate reaching an
  // issued+validated state (Req 8.2, 8.4).
  cloudFrontCertificate: certificateStack.certificate,
  cloudFrontDomainName: certificateStack.appDomainName,
  // Deploy-time inputs (undefined during synth/tests → synth-safe fallbacks).
  hostedZoneId: ctx.hostedZoneId,
  policyLookupImageUri: ctx.policyLookupImageUri,
  repairEstimatorImageUri: ctx.repairEstimatorImageUri,
  foundationModel: ctx.foundationModel,
  uiAssetPath: ctx.uiAssetPath,
  deployAgentCore: ctx.deployAgentCore,
  description:
    "ClaimClarify data, storage, and configuration (Policy_Table, S3_Origin, Config_Store)",
});

// Make the explicit cross-region dependency visible to CDK/CloudFormation so
// the certificate stack is deployed (and its certificate issued+validated)
// before the primary stack provisions CloudFront (Req 8.2).
dataStack.addDependency(certificateStack);

app.synth();
