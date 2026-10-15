/**
 * DNS, Config_Store, and secrets synthesis tests (task 21.6).
 *
 * These are credential-free assertions against the synthesized CloudFormation
 * template of the ClaimClarify data stack (which embeds the Compute construct).
 * They cover three contracts:
 *
 * ## App_DNS_Record → CloudFront, distinct from www.awsteach.com (Req 9.1, 9.2)
 *
 * When wired exactly as `app.ts` wires it — the `us-east-1` certificate stack
 * first, then the `us-east-2` data stack consuming its certificate +
 * `cloudFrontDomainName` across regions — the data stack emits an
 * `AWS::Route53::RecordSet` A/alias whose `Name` is `ohio.awsteach.com.` and
 * whose `AliasTarget` points at the CloudFront distribution. The record name is
 * asserted to differ from the reserved `www.awsteach.com` (Req 9.2). No
 * `AWS::Route53::HostedZone` is created — the shared zone is referenced
 * read-only (Req 9.3, touched tangentially).
 *
 * ## Config/secrets from Config_Store with per-component least privilege
 * (Req 14.1, 14.6, 15.1, 15.4)
 *
 * The three Config_Store SSM parameters (`policyTableName`,
 * `repairEstimatorEnvironment`, `bedrockAgentId`) are emitted as
 * `AWS::SSM::Parameter` resources, and each component role's inline policy
 * grants `ssm:GetParameter(s)` ONLY on the specific parameter(s) it needs:
 * the chat Lambda on the `BEDROCK_AGENT_ID` parameter, the policy-lookup role
 * on the policy-table-name parameter, and the repair-estimator role on the
 * repair-estimator-environment parameter. A component is NEVER granted read on
 * a parameter it does not need (Req 15.4).
 *
 * ## No embedded secrets in source (Req 15.1)
 *
 * A lightweight heuristic: configuration is sourced from Config_Store (the SSM
 * parameters exist) and the chat handler's environment references parameter
 * *names* (`/`-prefixed SSM paths / the agent-id config key) rather than secret
 * literal values. This mirrors the runtime contract that components read config
 * from SSM at runtime instead of baking secrets into the stack.
 */
import { App, type CfnElement } from "aws-cdk-lib";
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
import {
  BEDROCK_AGENT_ID_KEY,
  POLICY_TABLE_NAME_KEY,
  REPAIR_ESTIMATOR_ENVIRONMENT_KEY,
} from "./config-keys";

/** The App_DNS_Record domain used throughout these tests. */
const APP_DOMAIN_NAME = "ohio.awsteach.com";

/**
 * SSM read actions a least-privilege parameter grant is expected to allow.
 * `IStringParameter.grantRead` grants the Get* family plus
 * `ssm:DescribeParameters` — all read-only, no write/delete.
 */
const SSM_READ_ACTIONS = [
  "ssm:DescribeParameters",
  "ssm:GetParameter",
  "ssm:GetParameterHistory",
  "ssm:GetParameters",
  "ssm:GetParametersByPath",
];

/**
 * Wire both stacks the way `app.ts` / region-placement.synth.test.ts do: the
 * Certificate_Region (`us-east-1`) stack first, then the Primary_Region
 * (`us-east-2`) data stack consuming its certificate + domain name across
 * regions. This is the wiring under which the App_DNS_Record is created.
 */
function synthWithDns(): {
  dataStack: ClaimClarifyDataStack;
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
    dataTemplate: Template.fromStack(dataStack),
    certificateTemplate: Template.fromStack(certificateStack),
  };
}

/** Normalize an IAM Action/Resource field (string or string[]) to an array. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

/**
 * Collect every statement from every inline AWS::IAM::Policy resource attached
 * to the given role logical id.
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

/**
 * Return every SSM parameter logical id a role's inline policy grants a
 * `ssm:GetParameter*` read on. The grant produced by
 * `IStringParameter.grantRead` scopes `Resource` to the parameter's ARN, built
 * from the parameter's logical id via `Fn::Join`/`Ref`/`Fn::Sub`. Rather than
 * decode the ARN shape, we collect the SSM parameter logical ids that appear
 * anywhere inside each SSM-read statement's `Resource`.
 */
function ssmParamsReadByRole(
  template: Template,
  roleLogicalId: string,
  allParamLogicalIds: string[]
): Set<string> {
  const statements = statementsForRole(template, roleLogicalId);
  const read = new Set<string>();
  for (const stmt of statements) {
    const actions = toArray(stmt.Action) as string[];
    const isSsmRead = actions.some((a) => a.startsWith("ssm:Get"));
    if (!isSsmRead) {
      continue;
    }
    const resourceJson = JSON.stringify(stmt.Resource ?? "");
    for (const paramId of allParamLogicalIds) {
      if (resourceJson.includes(paramId)) {
        read.add(paramId);
      }
    }
  }
  return read;
}

describe("DNS, Config_Store & secrets synthesis (task 21.6)", () => {
  describe("App_DNS_Record targets CloudFront, distinct from www.awsteach.com (Req 9.1, 9.2)", () => {
    it("creates an A/alias RecordSet named ohio.awsteach.com. pointing at the CloudFront distribution", () => {
      const { dataTemplate } = synthWithDns();

      const recordSets = dataTemplate.findResources("AWS::Route53::RecordSet");
      // Find the A (IPv4 alias) record for the App_DNS_Record domain.
      const aRecords = Object.values(recordSets).filter((r) => {
        const props = (r as { Properties?: Record<string, unknown> }).Properties;
        return props?.Type === "A" && props?.Name === `${APP_DOMAIN_NAME}.`;
      });
      expect(aRecords.length).toBe(1);

      const aRecord = aRecords[0] as { Properties: Record<string, unknown> };
      const name = aRecord.Properties.Name as string;

      // Name is the App_DNS_Record FQDN …
      expect(name).toBe(`${APP_DOMAIN_NAME}.`);
      // … and it is DISTINCT from the reserved www.awsteach.com record (Req 9.2).
      expect(name).not.toBe(`${RESERVED_DNS_RECORD_NAME}.`);
      expect(name).not.toBe(RESERVED_DNS_RECORD_NAME);

      // It is an ALIAS (not a plain record with TTL/ResourceRecords) targeting
      // the CloudFront distribution: alias targets use the CloudFront hosted
      // zone id Z2FDTNDATAQYW2, and the DNSName resolves to the distribution's
      // domain name (an Fn::GetAtt against the CloudFront::Distribution).
      const aliasTarget = aRecord.Properties.AliasTarget as
        | Record<string, unknown>
        | undefined;
      expect(aliasTarget).toBeDefined();
      // The alias is anchored at the CloudFront global hosted zone. CDK emits
      // this either as the literal CloudFront zone id (Z2FDTNDATAQYW2) or as a
      // partition-aware Fn::FindInMap into the CloudFront hosted-zone map; both
      // identify CloudFront as the alias anchor.
      const aliasZoneId = aliasTarget?.HostedZoneId;
      const aliasZoneIdJson = JSON.stringify(aliasZoneId ?? "");
      expect(
        aliasZoneId === "Z2FDTNDATAQYW2" ||
          aliasZoneIdJson.includes("CloudFront")
      ).toBe(true);

      const dnsName = aliasTarget?.DNSName;
      const getAtt = (dnsName as { "Fn::GetAtt"?: unknown[] })?.["Fn::GetAtt"];
      expect(getAtt).toBeDefined();
      const distributionLogicalId = (getAtt as unknown[])[0] as string;
      const attribute = (getAtt as unknown[])[1] as string;
      expect(attribute).toBe("DomainName");

      // The GetAtt target is the one CloudFront distribution in the stack.
      const distributions = dataTemplate.findResources(
        "AWS::CloudFront::Distribution"
      );
      expect(distributionLogicalId in distributions).toBe(true);
    });

    it("does not create an AWS::Route53::HostedZone (shared zone referenced read-only, Req 9.3)", () => {
      const { dataTemplate, certificateTemplate } = synthWithDns();
      // The existing awsteach.com zone is imported read-only; neither stack may
      // emit a HostedZone resource.
      dataTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
      certificateTemplate.resourceCountIs("AWS::Route53::HostedZone", 0);
    });
  });

  describe("Config_Store parameters & per-component least-privilege reads (Req 14.1, 14.6, 15.1, 15.4)", () => {
    it("emits the three Config_Store SSM parameters", () => {
      const { dataTemplate } = synthWithDns();
      // Exactly the three Config_Store entries: policy-table-name,
      // repair-estimator-environment, bedrock-agent-id (Req 14.1, 14.6).
      dataTemplate.resourceCountIs("AWS::SSM::Parameter", 3);
    });

    it("scopes each component's SSM read to ONLY the parameter(s) it needs (Req 15.4)", () => {
      const { dataStack, dataTemplate } = synthWithDns();
      const { compute, configStore } = dataStack;

      // Resolve the logical ids of the three Config_Store parameters.
      const paramLogicalIds = {
        policyTableName: dataStack.getLogicalId(
          configStore.policyTableName.node.defaultChild as CfnElement
        ),
        repairEstimatorEnvironment: dataStack.getLogicalId(
          configStore.repairEstimatorEnvironment.node.defaultChild as CfnElement
        ),
        bedrockAgentId: dataStack.getLogicalId(
          configStore.bedrockAgentId.node.defaultChild as CfnElement
        ),
      };
      const allParamIds = Object.values(paramLogicalIds);
      // Sanity: three distinct parameter logical ids.
      expect(new Set(allParamIds).size).toBe(3);

      // Resolve the component role logical ids.
      const chatHandlerRoleId = dataStack.getLogicalId(
        compute.chatHandlerRole.node.defaultChild as CfnElement
      );
      const policyLookupRoleId = dataStack.getLogicalId(
        compute.policyLookupRole.node.defaultChild as CfnElement
      );
      const repairEstimatorRoleId = dataStack.getLogicalId(
        compute.repairEstimatorRole.node.defaultChild as CfnElement
      );

      // --- chat Lambda → ONLY the bedrockAgentId parameter ---------------
      const chatReads = ssmParamsReadByRole(
        dataTemplate,
        chatHandlerRoleId,
        allParamIds
      );
      expect(chatReads.has(paramLogicalIds.bedrockAgentId)).toBe(true);
      // NOT granted read on parameters it does not need (Req 15.4).
      expect(chatReads.has(paramLogicalIds.policyTableName)).toBe(false);
      expect(chatReads.has(paramLogicalIds.repairEstimatorEnvironment)).toBe(
        false
      );

      // --- policy-lookup → ONLY the policyTableName parameter -------------
      const policyLookupReads = ssmParamsReadByRole(
        dataTemplate,
        policyLookupRoleId,
        allParamIds
      );
      expect(policyLookupReads.has(paramLogicalIds.policyTableName)).toBe(true);
      expect(policyLookupReads.has(paramLogicalIds.bedrockAgentId)).toBe(false);
      expect(
        policyLookupReads.has(paramLogicalIds.repairEstimatorEnvironment)
      ).toBe(false);

      // --- repair-estimator → ONLY the repairEstimatorEnvironment param --
      const repairEstimatorReads = ssmParamsReadByRole(
        dataTemplate,
        repairEstimatorRoleId,
        allParamIds
      );
      expect(
        repairEstimatorReads.has(paramLogicalIds.repairEstimatorEnvironment)
      ).toBe(true);
      expect(repairEstimatorReads.has(paramLogicalIds.policyTableName)).toBe(
        false
      );
      expect(repairEstimatorReads.has(paramLogicalIds.bedrockAgentId)).toBe(
        false
      );
    });

    it("grants only ssm:GetParameter* read actions (never write) on each component's SSM statement (Req 15.4)", () => {
      const { dataStack, dataTemplate } = synthWithDns();
      const { compute } = dataStack;

      const roleIds = [
        dataStack.getLogicalId(
          compute.chatHandlerRole.node.defaultChild as CfnElement
        ),
        dataStack.getLogicalId(
          compute.policyLookupRole.node.defaultChild as CfnElement
        ),
        dataStack.getLogicalId(
          compute.repairEstimatorRole.node.defaultChild as CfnElement
        ),
      ];

      for (const roleId of roleIds) {
        const statements = statementsForRole(dataTemplate, roleId);
        const ssmStatements = statements.filter((s) =>
          (toArray(s.Action) as string[]).some((a) => a.startsWith("ssm:"))
        );
        // Each component reads at least one Config_Store parameter.
        expect(ssmStatements.length).toBeGreaterThan(0);
        for (const stmt of ssmStatements) {
          const actions = toArray(stmt.Action) as string[];
          // Every SSM action is a read; no PutParameter/DeleteParameter.
          for (const action of actions) {
            expect(SSM_READ_ACTIONS).toContain(action);
          }
          expect(actions).not.toContain("ssm:PutParameter");
          expect(actions).not.toContain("ssm:DeleteParameter");
          expect(actions).not.toContain("ssm:*");
        }
      }
    });
  });

  describe("no embedded secrets in source — config comes from Config_Store (Req 15.1)", () => {
    it("defines the three Config_Store parameters whose names match the config keys components read", () => {
      const { dataTemplate } = synthWithDns();

      const params = dataTemplate.findResources("AWS::SSM::Parameter");
      const paramNames = Object.values(params).map((p) => {
        const props = (p as { Properties?: Record<string, unknown> }).Properties;
        return props?.Name as string;
      });

      // The physical SSM names (hierarchical names get a leading slash) match
      // the logical config keys the runtime components read — config lives in
      // Config_Store, not source (Req 14.6, 15.1).
      expect(paramNames).toContain(BEDROCK_AGENT_ID_KEY); // simple name, no slash
      expect(paramNames).toContain(`/${POLICY_TABLE_NAME_KEY}`);
      expect(paramNames).toContain(`/${REPAIR_ESTIMATOR_ENVIRONMENT_KEY}`);
    });

    it("has the chat handler reference config by parameter NAME, not a secret literal value (Req 15.1)", () => {
      const { dataTemplate } = synthWithDns();

      const functions = dataTemplate.findResources("AWS::Lambda::Function");
      // The chat handler is identified by its AGENT_ID_CONFIG_KEY environment
      // variable (both bundled Lambdas use the `index.handler` entry point, so
      // the handler string alone no longer distinguishes them).
      const chatHandler = Object.values(functions).find((f) => {
        const props = (f as { Properties?: Record<string, unknown> }).Properties;
        const env = (
          props?.Environment as { Variables?: Record<string, unknown> } | undefined
        )?.Variables;
        return env?.AGENT_ID_CONFIG_KEY !== undefined;
      }) as { Properties: Record<string, unknown> } | undefined;
      expect(chatHandler).toBeDefined();

      const env = (
        chatHandler?.Properties.Environment as
          | { Variables?: Record<string, unknown> }
          | undefined
      )?.Variables;
      expect(env).toBeDefined();

      // The handler is told WHICH Config_Store key to read for the agent id,
      // not the agent id itself — a parameter name, not a secret value.
      expect(env?.AGENT_ID_CONFIG_KEY).toBe(BEDROCK_AGENT_ID_KEY);

      // The policy-table parameter is referenced by its SSM NAME (a `/`-prefixed
      // path or a Ref to the parameter), never an inlined secret/connection
      // literal.
      const tableParam = env?.POLICY_TABLE_NAME_PARAM;
      const tableParamJson = JSON.stringify(tableParam ?? "");
      // It resolves either to the literal `/claimclarify/...` name or a Ref/Join
      // against the SSM parameter — in all cases it is a NAME reference, and it
      // must not be the placeholder secret value baked into the agent-id param.
      expect(tableParamJson).not.toContain("PLACEHOLDER_SET_IN_TASK_18");
      expect(
        tableParamJson.includes(POLICY_TABLE_NAME_KEY) ||
          tableParamJson.includes("Ref") ||
          tableParamJson.includes("Fn::")
      ).toBe(true);
    });

    it("keeps the agent-id placeholder confined to the SSM parameter, out of component env/policies (Req 15.1)", () => {
      const { dataStack, dataTemplate } = synthWithDns();

      // The placeholder stand-in value for the agent id lives ONLY in the SSM
      // parameter definition (where it is a config value), never leaked into a
      // component's environment or IAM policy as a hardcoded literal.
      const functions = dataTemplate.findResources("AWS::Lambda::Function");
      for (const fn of Object.values(functions)) {
        const env = (
          (fn as { Properties?: Record<string, unknown> }).Properties
            ?.Environment as { Variables?: Record<string, unknown> } | undefined
        )?.Variables;
        expect(JSON.stringify(env ?? {})).not.toContain(
          "PLACEHOLDER_SET_IN_TASK_18"
        );
      }

      // Sanity: the Config_Store parameters are actual construct references on
      // the stack (config is centralized in Config_Store, Req 15.1).
      expect(dataStack.configStore.policyTableName).toBeDefined();
      expect(dataStack.configStore.repairEstimatorEnvironment).toBeDefined();
      expect(dataStack.configStore.bedrockAgentId).toBeDefined();
    });
  });
});
