#!/usr/bin/env node
/**
 * ClaimClarify Explorer CDK app — a separate application from ClaimClarify.
 *
 * Deploy-time context inputs (via `cdk deploy -c key=value`):
 *   - hostedZoneId   : the awsteach.com hosted zone id (enables DNS + auto cert)
 *   - domainName     : the Explorer FQDN (default explorer.awsteach.com)
 *   - webAssetPath   : absolute path to the built static site (web/)
 *   - lambdaBundleDir: absolute path to the bundled Lambdas (dist/lambda-bundle)
 *   - allowedLogGroups: comma-separated CloudWatch log group names the logs
 *                       endpoint may read (ClaimClarify core + Explorer own)
 */
import * as path from "node:path";
import { App } from "aws-cdk-lib";

import { ExplorerStack, PRIMARY_REGION } from "./explorer-stack";
import { ExplorerCertStack } from "./explorer-cert-stack";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

const domainName =
  (app.node.tryGetContext("domainName") as string | undefined) ??
  "explorer.awsteach.com";
const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string | undefined;
const webAssetPath =
  (app.node.tryGetContext("webAssetPath") as string | undefined) ??
  path.join(__dirname, "..", "web");
const lambdaBundleDir =
  (app.node.tryGetContext("lambdaBundleDir") as string | undefined) ??
  path.join(__dirname, "..", "dist", "lambda-bundle");

// Default allow-list: the ClaimClarify core log groups + the Explorer's own.
const defaultAllowed = [
  // Explorer's own:
  "/claimclarify/explorer/chat",
  "/claimclarify/explorer/logs",
  // ClaimClarify core (names created by the core stack's observability):
  "/aws/bedrock/agents/ClaimClarify-Agent",
  "/aws/bedrock-agentcore/runtimes/claimclarify_policy_lookup",
  "/aws/bedrock-agentcore/runtimes/claimclarify_repair_estimator",
];
const allowedLogGroupNames = (
  (app.node.tryGetContext("allowedLogGroups") as string | undefined) ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const allowed = allowedLogGroupNames.length > 0 ? allowedLogGroupNames : defaultAllowed;

// us-east-1 viewer certificate (only when we have a zone to validate against).
let certificate;
if (hostedZoneId !== undefined) {
  const certStack = new ExplorerCertStack(app, "ClaimClarify-Explorer-Cert", {
    env: { account, region: "us-east-1" },
    crossRegionReferences: true,
    domainName,
    hostedZoneId,
    description: "ClaimClarify Explorer CloudFront viewer certificate (us-east-1)",
  });
  certificate = certStack.certificate;
}

const explorer = new ExplorerStack(app, "ClaimClarify-Explorer", {
  env: { account, region: PRIMARY_REGION },
  crossRegionReferences: true,
  webAssetPath,
  lambdaBundleDir,
  viewerCertificate: certificate,
  domainName,
  hostedZoneId,
  allowedLogGroupNames: allowed,
  description: "ClaimClarify Explorer — student project-knowledge chatbot (separate app)",
});

void explorer;
app.synth();
