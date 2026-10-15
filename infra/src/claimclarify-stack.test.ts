/**
 * Synthesis tests for the ClaimClarify data/storage/config stack (task 17.1).
 *
 * These assert the task-17.1 contract on the synthesized CloudFormation
 * template: Policy_Table (on-demand + encrypted + policyId PK), S3_Origin
 * (encrypted + fully private), the Config_Store SSM parameters, the seeding
 * custom resource, and that the stack targets the Primary_Region us-east-2.
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
} from "./claimclarify-stack";
import {
  BEDROCK_AGENT_ID_KEY,
  POLICY_TABLE_NAME_KEY,
  REPAIR_ESTIMATOR_ENVIRONMENT_KEY,
} from "./config-keys";

function synth(): { template: Template; region: string } {
  const app = new App();
  const stack = new ClaimClarifyDataStack(app, "TestData", {
    env: { account: "111111111111", region: PRIMARY_REGION },
  });
  return { template: Template.fromStack(stack), region: stack.region };
}

describe("ClaimClarifyDataStack", () => {
  it("places the stack in the Primary_Region us-east-2", () => {
    const { region } = synth();
    expect(region).toBe("us-east-2");
  });

  it("defines Policy_Table on-demand, encrypted, with policyId partition key", () => {
    const { template } = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "policyId", KeyType: "HASH" }],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "policyId", AttributeType: "S" },
      ]),
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
    });
  });

  it("defines S3_Origin encrypted at rest and fully private (OAC-only)", () => {
    const { template } = synth();
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "AES256",
            }),
          }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("provisions the three Config_Store SSM parameters", () => {
    const { template } = synth();
    for (const key of [
      POLICY_TABLE_NAME_KEY,
      REPAIR_ESTIMATOR_ENVIRONMENT_KEY,
      BEDROCK_AGENT_ID_KEY,
    ]) {
      const name = key.includes("/") && !key.startsWith("/") ? `/${key}` : key;
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: name,
      });
    }
  });

  it("creates a seeding custom resource targeting the Policy_Table", () => {
    const { template } = synth();
    // The custom resource is backed by the Provider framework; assert the
    // custom resource exists and carries the table-name property.
    const customResources = template.findResources(
      "AWS::CloudFormation::CustomResource"
    );
    const found = Object.values(customResources).some((r) =>
      Object.prototype.hasOwnProperty.call(r.Properties ?? {}, "TableName")
    );
    expect(found).toBe(true);
  });

  it("exposes construct references for later tasks", () => {
    const app = new App();
    const stack = new ClaimClarifyDataStack(app, "RefData", {
      env: { account: "111111111111", region: PRIMARY_REGION },
    });
    expect(stack.policyTable).toBeDefined();
    expect(stack.originBucket).toBeDefined();
    expect(stack.configStore.policyTableName).toBeDefined();
    expect(stack.configStore.repairEstimatorEnvironment).toBeDefined();
    expect(stack.configStore.bedrockAgentId).toBeDefined();
  });
});
