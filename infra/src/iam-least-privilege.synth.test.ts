/**
 * IAM least-privilege synthesis tests (task 21.4).
 *
 * These assert the Req 10 least-privilege contract on the synthesized
 * CloudFormation template of the ClaimClarify data stack (which embeds the
 * ClaimClarifyCompute construct):
 *
 * - Req 10.1: a dedicated, NON-SHARED IAM role per component — four distinct
 *   AWS::IAM::Role resources (Bedrock_Agent, API_Layer Lambda, Policy_Lookup,
 *   Repair_Estimator), each a distinct construct with a distinct logical id,
 *   never reused across components.
 * - Req 10.2: the Policy_Lookup role is READ-ONLY on the Policy_Table — its
 *   inline policy includes DynamoDB read actions (GetItem/Query/BatchGetItem/
 *   …) and does NOT include PutItem/UpdateItem/DeleteItem/BatchWriteItem.
 * - Req 10.4: CloudFront reaches the S3_Origin via OAC READ-ONLY — the origin
 *   bucket policy grants `s3:GetObject` to the `cloudfront.amazonaws.com`
 *   service principal and never grants `s3:PutObject`/`s3:DeleteObject` to it.
 * - Req 10.3: no component role grants a wildcard permission — none of the four
 *   component roles' inline policy statements use Action `"*"` or Resource
 *   `"*"`. (The AWS-managed basic Lambda logging policy is attached by managed
 *   ARN, not an inline `"*"` statement, so it does not violate this.)
 *
 * The assertions walk the synthesized template (Template.fromStack +
 * findResources) rather than CDK construct internals, mirroring the existing
 * synth-test pattern in claimclarify-stack.test.ts.
 */
import { App, type CfnElement } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClaimClarifyDataStack, PRIMARY_REGION } from "./claimclarify-stack";

/** DynamoDB write/delete actions that a READ-ONLY role must never grant. */
const DDB_WRITE_ACTIONS = [
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:BatchWriteItem",
];

/** DynamoDB read actions a read-only policy-lookup role is expected to grant. */
const DDB_READ_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:BatchGetItem",
  "dynamodb:Query",
];

/** S3 write/delete actions CloudFront OAC must never be granted. */
const S3_WRITE_ACTIONS = ["s3:PutObject", "s3:DeleteObject"];

/**
 * Synthesize the data stack (which includes the Compute construct with all
 * four component roles and the CloudFront OAC bucket policy) and return the
 * template together with the construct references needed to resolve logical
 * ids.
 */
function synth(): {
  stack: ClaimClarifyDataStack;
  template: Template;
} {
  const app = new App();
  const stack = new ClaimClarifyDataStack(app, "TestIamData", {
    env: { account: "111111111111", region: PRIMARY_REGION },
  });
  return { stack, template: Template.fromStack(stack) };
}

/** Normalize an IAM Action/Resource field (string or string[]) to an array. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

/**
 * Collect every statement from every inline AWS::IAM::Policy resource that is
 * attached to the given role logical id.
 */
function statementsForRole(
  template: Template,
  roleLogicalId: string
): Record<string, unknown>[] {
  const policies = template.findResources("AWS::IAM::Policy");
  const statements: Record<string, unknown>[] = [];
  for (const policy of Object.values(policies)) {
    const props = (policy as { Properties?: Record<string, unknown> })
      .Properties;
    const roles = toArray(props?.Roles);
    const attachedToRole = roles.some(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        (r as { Ref?: string }).Ref === roleLogicalId
    );
    if (!attachedToRole) {
      continue;
    }
    const doc = props?.PolicyDocument as
      | { Statement?: Record<string, unknown>[] }
      | undefined;
    for (const stmt of doc?.Statement ?? []) {
      statements.push(stmt);
    }
  }
  return statements;
}

describe("IAM least-privilege synthesis (Req 10)", () => {
  it("assigns a dedicated, non-shared IAM role to each of the four components (Req 10.1)", () => {
    const { stack, template } = synth();

    // The four dedicated component roles exposed by the Compute construct.
    const componentRoles = {
      bedrockAgent: stack.compute.bedrockAgentRole,
      chatHandler: stack.compute.chatHandlerRole,
      policyLookup: stack.compute.policyLookupRole,
      repairEstimator: stack.compute.repairEstimatorRole,
    };

    const logicalIds = Object.values(componentRoles).map((role) =>
      stack.getLogicalId(role.node.defaultChild as CfnElement)
    );

    // Four distinct constructs → four distinct logical ids (no reuse).
    const uniqueIds = new Set(logicalIds);
    expect(uniqueIds.size).toBe(4);

    // Each logical id resolves to an actual AWS::IAM::Role in the template.
    const roles = template.findResources("AWS::IAM::Role");
    for (const id of logicalIds) {
      expect(roles).toHaveProperty(id);
    }

    // The public role props are four distinct construct instances (Req 10.1):
    // no single role object is reused across components.
    const roleInstances = new Set(Object.values(componentRoles));
    expect(roleInstances.size).toBe(4);
  });

  it("grants the Policy_Lookup role READ-ONLY access to the Policy_Table (Req 10.2)", () => {
    const { stack, template } = synth();

    const policyLookupLogicalId = stack.getLogicalId(
      stack.compute.policyLookupRole.node
        .defaultChild as CfnElement
    );
    const statements = statementsForRole(template, policyLookupLogicalId);
    expect(statements.length).toBeGreaterThan(0);

    const allActions = statements.flatMap((s) => toArray(s.Action) as string[]);

    // Read actions are present …
    for (const read of DDB_READ_ACTIONS) {
      expect(allActions).toContain(read);
    }

    // … and NO write/delete action is granted anywhere on this role.
    for (const write of DDB_WRITE_ACTIONS) {
      expect(allActions).not.toContain(write);
    }
  });

  it("grants CloudFront OAC READ-ONLY (s3:GetObject) on the S3_Origin (Req 10.4)", () => {
    const { template } = synth();

    const bucketPolicies = template.findResources("AWS::S3::BucketPolicy");
    expect(Object.keys(bucketPolicies).length).toBeGreaterThan(0);

    // Collect every statement whose principal is the CloudFront service.
    const cloudFrontStatements: Record<string, unknown>[] = [];
    for (const policy of Object.values(bucketPolicies)) {
      const props = (policy as { Properties?: Record<string, unknown> })
        .Properties;
      const doc = props?.PolicyDocument as
        | { Statement?: Record<string, unknown>[] }
        | undefined;
      for (const stmt of doc?.Statement ?? []) {
        const principal = stmt.Principal as
          | { Service?: unknown }
          | undefined;
        if (principal?.Service === "cloudfront.amazonaws.com") {
          cloudFrontStatements.push(stmt);
        }
      }
    }

    // CloudFront must be granted at least one statement, and it must be an
    // Allow of s3:GetObject.
    expect(cloudFrontStatements.length).toBeGreaterThan(0);

    const cloudFrontActions = cloudFrontStatements.flatMap(
      (s) => toArray(s.Action) as string[]
    );
    expect(cloudFrontActions).toContain("s3:GetObject");
    for (const stmt of cloudFrontStatements) {
      expect(stmt.Effect).toBe("Allow");
    }

    // CloudFront must NEVER be granted write/delete (or a wildcard) on S3.
    for (const write of S3_WRITE_ACTIONS) {
      expect(cloudFrontActions).not.toContain(write);
    }
    expect(cloudFrontActions).not.toContain("s3:*");
    expect(cloudFrontActions).not.toContain("*");
  });

  it("grants no wildcard Action or Resource on any component role (Req 10.3)", () => {
    const { stack, template } = synth();

    const componentRoles = [
      stack.compute.bedrockAgentRole,
      stack.compute.chatHandlerRole,
      stack.compute.policyLookupRole,
      stack.compute.repairEstimatorRole,
    ];

    for (const role of componentRoles) {
      const logicalId = stack.getLogicalId(
        role.node.defaultChild as CfnElement
      );
      const statements = statementsForRole(template, logicalId);

      for (const stmt of statements) {
        const actions = toArray(stmt.Action) as unknown[];
        const resources = toArray(stmt.Resource) as unknown[];

        // No custom inline statement may grant Action "*" …
        expect(actions).not.toContain("*");
        // … and none may grant Resource "*".
        expect(resources).not.toContain("*");
      }
    }
  });
});
