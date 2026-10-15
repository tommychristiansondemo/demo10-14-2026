/**
 * Encryption-at-rest synthesis tests (task 21.2).
 *
 * These assert the encryption-at-rest contract on the synthesized
 * CloudFormation template for the ClaimClarifyDataStack (Primary_Region
 * us-east-2):
 *
 * - Policy_Table (DynamoDB) is created with AWS_MANAGED encryption, which
 *   synthesizes to an `SSESpecification` with `SSEEnabled: true`
 *   (Req 5.5, 11.1).
 * - S3_Origin (S3 bucket) is created with S3_MANAGED encryption, which
 *   synthesizes to a `BucketEncryption` block whose
 *   `ServerSideEncryptionByDefault` uses the `AES256` algorithm (or an
 *   `aws:kms` algorithm if a managed key were ever used) (Req 7.2, 11.2).
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClaimClarifyDataStack, PRIMARY_REGION } from "./claimclarify-stack";

function synth(): Template {
  const app = new App();
  const stack = new ClaimClarifyDataStack(app, "TestEncryptionAtRest", {
    env: { account: "111111111111", region: PRIMARY_REGION },
  });
  return Template.fromStack(stack);
}

describe("ClaimClarify encryption at rest (task 21.2)", () => {
  it("enables encryption at rest on the Policy_Table (SSESpecification.SSEEnabled true)", () => {
    const template = synth();

    // AWS_MANAGED DynamoDB encryption synthesizes to SSESpecification with
    // SSEEnabled: true (Req 5.5, 11.1).
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
    });

    // Every DynamoDB table in the stack must have encryption at rest enabled;
    // none may be left unencrypted.
    const tables = template.findResources("AWS::DynamoDB::Table");
    expect(Object.keys(tables).length).toBeGreaterThan(0);
    for (const table of Object.values(tables)) {
      expect(table.Properties?.SSESpecification?.SSEEnabled).toBe(true);
    }
  });

  it("enables encryption at rest on the S3_Origin (BucketEncryption with ServerSideEncryptionByDefault)", () => {
    const template = synth();

    // S3_MANAGED bucket encryption synthesizes to a BucketEncryption block with
    // a default SSE algorithm of AES256 (aws:kms is also accepted for the
    // encryption-at-rest contract) (Req 7.2, 11.2).
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: Match.stringLikeRegexp("^(AES256|aws:kms)$"),
            }),
          }),
        ]),
      },
    });

    // Every S3 bucket in the stack must have encryption at rest enabled.
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThan(0);
    for (const bucket of Object.values(buckets)) {
      const rules =
        bucket.Properties?.BucketEncryption
          ?.ServerSideEncryptionConfiguration ?? [];
      expect(rules.length).toBeGreaterThan(0);
      const algorithms = rules.map(
        (rule: {
          ServerSideEncryptionByDefault?: { SSEAlgorithm?: string };
        }) => rule.ServerSideEncryptionByDefault?.SSEAlgorithm
      );
      expect(
        algorithms.some(
          (algorithm: string | undefined) =>
            algorithm === "AES256" || algorithm === "aws:kms"
        )
      ).toBe(true);
    }
  });
});
