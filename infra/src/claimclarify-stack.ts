/**
 * ClaimClarify data/storage/config stack (task 17.1).
 *
 * Defines the foundational constructs that later infrastructure tasks attach
 * to:
 *
 * - {@link ClaimClarifyDataStack.policyTable} — the DynamoDB `Policy_Table`:
 *   on-demand billing, encryption at rest, `policyId` partition key, in the
 *   Primary_Region `us-east-2` (Req 5.1, 5.5, 11.1).
 * - {@link ClaimClarifyDataStack.originBucket} — the `S3_Origin` bucket for the
 *   static Chat_UI: encryption at rest, fully private (OAC-only; the CloudFront
 *   OAC read policy is attached in task 19.2) (Req 7.2, 11.2).
 * - {@link ClaimClarifyDataStack.configStore} — the `Config_Store` SSM
 *   parameters each runtime component reads at runtime, so configuration lives
 *   outside source (Req 14.6, 15.1).
 * - A seeding custom resource that applies the shared seed data set to the
 *   Policy_Table using the duplicate-aware seed-apply helper (Req 5.2, 5.4).
 *
 * Compute/API/agent/CloudFront/ACM/DNS constructs are defined in tasks 18/19,
 * which consume the references exported from this stack.
 */
import {
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Provider } from "aws-cdk-lib/custom-resources";
import {
  API_PATH_PREFIX,
  RESERVED_DNS_RECORD_NAME,
  dnsPrecheck,
  type ZoneSnapshot,
} from "@claimclarify/shared";
import { Construct } from "constructs";

import type * as acm from "aws-cdk-lib/aws-certificatemanager";

import { ClaimClarifyCompute } from "./claimclarify-compute-stack";
import { lambdaBundleDir } from "./lambda-assets";
import {
  BEDROCK_AGENT_ID_KEY,
  POLICY_TABLE_NAME_KEY,
  REPAIR_ESTIMATOR_ENVIRONMENT_KEY,
} from "./config-keys";

/** The Primary_Region for all compute/data/config (Req 8.1). */
export const PRIMARY_REGION = "us-east-2";

/**
 * The existing public Hosted_Zone the App_DNS_Record is published into. The
 * `awsteach.com` zone is shared with an unrelated application, so this
 * deployment references it read-only and never creates or mutates the zone
 * itself (Req 9.3).
 */
export const HOSTED_ZONE_NAME = "awsteach.com";

/**
 * A synth-time placeholder Hosted_Zone id. `route53.HostedZone.fromHostedZoneAttributes`
 * needs a zone id, but a real id requires account context (which would break
 * credential-free `cdk synth`). The real id is injected via
 * {@link ClaimClarifyDataStackProps.hostedZoneId} at deploy time; this
 * placeholder keeps synth/tests credential-free. Importing an existing zone by
 * attributes is read-only — CDK emits no resource that creates or mutates the
 * zone (Req 9.3).
 */
export const PLACEHOLDER_HOSTED_ZONE_ID = "Z0000000000000000PLACE";

/**
 * The default snapshot of record names already present in the shared
 * Hosted_Zone. The pre-existing `www.awsteach.com` record is always present and
 * must stay untouched (Req 9.3); it is listed here so the {@link dnsPrecheck}
 * halt (Req 9.4) is meaningfully exercised at synth time. Callers may inject a
 * fuller snapshot via {@link ClaimClarifyDataStackProps.existingZoneRecordNames}.
 */
export const DEFAULT_ZONE_SNAPSHOT: readonly string[] = [
  RESERVED_DNS_RECORD_NAME,
];

/**
 * Map a logical Config_Store key to a valid SSM parameter name. SSM requires
 * hierarchical names (those containing "/") to begin with a leading "/", while
 * simple names must not. The runtime components read by the same logical key;
 * the leading slash is a physical-naming detail of SSM.
 */
function toParameterName(key: string): string {
  return key.includes("/") && !key.startsWith("/") ? `/${key}` : key;
}

/** Props for {@link ClaimClarifyDataStack}. */
export interface ClaimClarifyDataStackProps extends StackProps {
  /**
   * Logical environment name seeded into the repair-estimator Config_Store
   * entry (e.g. "demo"). Defaults to "demo".
   */
  readonly environmentName?: string;

  /**
   * The CloudFront viewer ACM certificate from the Certificate_Region
   * (`us-east-1`), produced by {@link ClaimClarifyCertificateStack} (task
   * 19.1). CloudFront requires its viewer certificate in `us-east-1`, so it is
   * created in a separate region-pinned stack and passed in here across regions
   * (the stacks enable `crossRegionReferences`). Task 19.2 attaches this
   * certificate to the CloudFront distribution; CloudFront's dependency on it
   * is what gates provisioning on the certificate reaching an issued+validated
   * state (Req 8.2, 8.4). Optional so earlier tasks/tests can synthesize the
   * data stack on its own.
   */
  readonly cloudFrontCertificate?: acm.ICertificate;

  /**
   * The App_DNS_Record domain the {@link cloudFrontCertificate} is issued for
   * (e.g. `ohio.awsteach.com`). Task 19.2 sets this as the CloudFront
   * distribution's alias (Req 8.4) and task 19.3 publishes the matching DNS
   * record.
   */
  readonly cloudFrontDomainName?: string;

  /**
   * The name of the existing public Hosted_Zone the App_DNS_Record is published
   * into. Defaults to {@link HOSTED_ZONE_NAME} (`awsteach.com`). The zone is
   * referenced read-only via `HostedZone.fromHostedZoneAttributes`; this
   * deployment never creates or mutates it (Req 9.3).
   */
  readonly hostedZoneName?: string;

  /**
   * The id of the existing Hosted_Zone. Injected at deploy time (e.g. from a
   * context value or pipeline parameter) so the real zone is targeted; defaults
   * to {@link PLACEHOLDER_HOSTED_ZONE_ID} to keep credential-free `cdk synth`
   * and the synthesis tests working. Importing by id/attributes is read-only
   * and emits no zone-mutating resource (Req 9.3).
   */
  readonly hostedZoneId?: string;

  /**
   * A snapshot of the record names already present in the Hosted_Zone, used by
   * the pure {@link dnsPrecheck} helper (task 9.3) to detect a naming conflict
   * before any record is defined. Defaults to {@link DEFAULT_ZONE_SNAPSHOT}
   * (`['www.awsteach.com']`) so the precheck is exercised against the reserved
   * record. If the configured App_DNS_Record name collides with the reserved
   * `www.awsteach.com` name or an entry in this snapshot, the constructor
   * throws, halting the entire synthesis and leaving every existing record
   * unchanged (Req 9.2, 9.4).
   */
  readonly existingZoneRecordNames?: ZoneSnapshot;

  /**
   * ECR image URI for the Policy_Lookup_Server MCP container (injected at
   * deploy time after the image is built and pushed).
   */
  readonly policyLookupImageUri?: string;

  /**
   * ECR image URI for the Repair_Estimator_Server MCP container (injected at
   * deploy time after the image is built and pushed).
   */
  readonly repairEstimatorImageUri?: string;

  /**
   * The Bedrock foundation model id the agent uses. Injected at deploy time to
   * pin a model available in the target region.
   */
  readonly foundationModel?: string;

  /**
   * Absolute path to the built Chat_UI web bundle directory. When provided, the
   * stack deploys its contents into the S3_Origin bucket via a
   * {@link s3deploy.BucketDeployment} so CloudFront serves the Chat_UI
   * (Req 7.1). Omitted in synth/tests so no asset bundling is required.
   */
  readonly uiAssetPath?: string;

  /**
   * Whether to provision the Bedrock_Agent + AgentCore Runtime MCP servers.
   * Defaults to `true`. Set `false` for a phased/core-only deploy that stands
   * up the deterministic app without the container runtimes (which require
   * pushed ECR images). Passed through to {@link ClaimClarifyCompute}.
   */
  readonly deployAgentCore?: boolean;
}

/**
 * Config_Store SSM parameters exposed for per-component least-privilege
 * read-grants wired up in later tasks.
 */
export interface ConfigStore {
  /** Policy_Table name parameter (read by the policy-lookup server). */
  readonly policyTableName: ssm.IStringParameter;
  /** Repair-estimator environment parameter. */
  readonly repairEstimatorEnvironment: ssm.IStringParameter;
  /** Bedrock agent id parameter (read by the API Lambda). */
  readonly bedrockAgentId: ssm.IStringParameter;
}

/**
 * Foundational data, storage, and configuration stack. Later stacks reference
 * the public construct properties to attach compute, routing, and IAM.
 */
export class ClaimClarifyDataStack extends Stack {
  /** DynamoDB `Policy_Table` (Req 5.1, 5.5, 11.1). */
  public readonly policyTable: dynamodb.Table;

  /** `S3_Origin` bucket for the static Chat_UI (Req 7.2, 11.2). */
  public readonly originBucket: s3.Bucket;

  /** `Config_Store` SSM parameters (Req 14.6, 15.1). */
  public readonly configStore: ConfigStore;

  /**
   * The CloudFront viewer ACM certificate from the Certificate_Region
   * (`us-east-1`), if provided to the stack (task 19.1). Exposed so the
   * CloudFront distribution defined in task 19.2 attaches it as its viewer
   * certificate (Req 8.4); the distribution's reference to it enforces the
   * issued+validated ordering gate (Req 8.2, 8.3). `undefined` when the stack
   * is synthesized without the certificate stack (e.g. in isolated tests).
   */
  public readonly cloudFrontCertificate?: acm.ICertificate;

  /** The App_DNS_Record domain the {@link cloudFrontCertificate} covers. */
  public readonly cloudFrontDomainName?: string;

  /**
   * The CloudFront_Distribution fronting the Chat_UI (task 19.2). Serves
   * {@link originBucket} assets over OAC-read-only, enforces HTTPS with a
   * minimum of TLS 1.2 and HTTP→HTTPS redirect, and routes `/api/*` to the
   * API_Layer while serving everything else from the S3_Origin (Req 7.1, 7.3,
   * 7.4, 7.5, 7.6, 10.4). When {@link cloudFrontCertificate} is supplied it is
   * attached as the viewer certificate with {@link cloudFrontDomainName} as the
   * alias (Req 8.4). Exposed for the DNS record (task 19.3) and the synthesis
   * tests (tasks 21.3/21.4).
   */
  public readonly distribution: cloudfront.Distribution;

  /**
   * The App_DNS_Record (task 19.3): a new, unique A/AAAA alias in the existing
   * `awsteach.com` Hosted_Zone pointing at the CloudFront_Distribution
   * (Req 9.1). Its name is the {@link cloudFrontDomainName} (e.g.
   * `ohio.awsteach.com`), distinct from the reserved `www.awsteach.com`
   * (Req 9.2) — enforced at construct time by the {@link dnsPrecheck} halt
   * (Req 9.4). `undefined` when the stack is synthesized without a
   * {@link cloudFrontDomainName} (e.g. isolated tests), in which case no record
   * is defined and the shared zone is never touched. The matching IPv6 alias is
   * exposed as {@link appDnsRecordAaaa}. Exposed for the DNS synthesis test
   * (task 21.6).
   */
  public readonly appDnsRecord?: route53.ARecord;

  /** The IPv6 (AAAA) companion alias of {@link appDnsRecord} (task 19.3). */
  public readonly appDnsRecordAaaa?: route53.AaaaRecord;

  /**
   * Compute/API/agent/AgentCore-runtime constructs (task 18.1). Exposes the
   * chat handler Lambda, HTTP API, min-TLS custom domain, Bedrock_Agent, and
   * the two MCP-server AgentCore runtimes for tasks 18.2/19/21 to attach to.
   */
  public readonly compute: ClaimClarifyCompute;

  constructor(
    scope: Construct,
    id: string,
    props: ClaimClarifyDataStackProps = {}
  ) {
    super(scope, id, {
      ...props,
      env: { ...props.env, region: PRIMARY_REGION },
    });

    const environmentName = props.environmentName ?? "demo";

    // Hold the us-east-1 CloudFront certificate reference (task 19.1) for the
    // CloudFront distribution added in task 19.2 to consume (Req 8.4).
    this.cloudFrontCertificate = props.cloudFrontCertificate;
    this.cloudFrontDomainName = props.cloudFrontDomainName;

    // --- Policy_Table: on-demand, encrypted at rest, policyId PK -----------
    this.policyTable = new dynamodb.Table(this, "PolicyTable", {
      partitionKey: {
        name: "policyId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- S3_Origin: encrypted at rest, fully private (OAC-only) ------------
    this.originBucket = new s3.Bucket(this, "OriginBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Config_Store: SSM parameters read by components at runtime --------
    const policyTableNameParam = new ssm.StringParameter(
      this,
      "PolicyTableNameParam",
      {
        parameterName: toParameterName(POLICY_TABLE_NAME_KEY),
        stringValue: this.policyTable.tableName,
      }
    );

    const repairEstimatorEnvParam = new ssm.StringParameter(
      this,
      "RepairEstimatorEnvParam",
      {
        parameterName: toParameterName(REPAIR_ESTIMATOR_ENVIRONMENT_KEY),
        stringValue: environmentName,
      }
    );

    // The real agent id is produced in task 18; seed a placeholder parameter
    // now so the Config_Store entry exists and components can be granted
    // least-privilege read access. The value is updated when the agent is
    // defined (configuration lives in Config_Store, not source — Req 15.1).
    const bedrockAgentIdParam = new ssm.StringParameter(
      this,
      "BedrockAgentIdParam",
      {
        parameterName: toParameterName(BEDROCK_AGENT_ID_KEY),
        stringValue: "PLACEHOLDER_SET_IN_TASK_18",
      }
    );

    this.configStore = {
      policyTableName: policyTableNameParam,
      repairEstimatorEnvironment: repairEstimatorEnvParam,
      bedrockAgentId: bedrockAgentIdParam,
    };

    // --- Seeding custom resource (duplicate-aware applySeed) ----------------
    this.createSeedResource();

    // --- Compute/API/agent/runtime constructs (task 18.1) ------------------
    // Added as an in-stack construct so every resource stays in the single
    // Primary_Region stack and the agent-id write-back into the Config_Store
    // parameter is in-stack (no cross-stack dependency cycle).
    this.compute = new ClaimClarifyCompute(this, "Compute", {
      configStore: this.configStore,
      policyTable: this.policyTable,
      policyLookupImageUri: props.policyLookupImageUri,
      repairEstimatorImageUri: props.repairEstimatorImageUri,
      foundationModel: props.foundationModel,
      deployAgentCore: props.deployAgentCore,
      hostedZoneId: props.hostedZoneId,
      hostedZoneName: props.hostedZoneName ?? HOSTED_ZONE_NAME,
    });

    // --- CloudFront_Distribution + cache behaviors (task 19.2) -------------
    this.distribution = this.createDistribution();

    // --- Chat_UI asset upload to S3_Origin ---------------------------------
    // When a built UI bundle path is supplied at deploy time, upload its
    // contents into the S3_Origin and invalidate the distribution so CloudFront
    // serves the Chat_UI (Req 7.1). Skipped in synth/tests (no uiAssetPath).
    if (props.uiAssetPath !== undefined) {
      new s3deploy.BucketDeployment(this, "ChatUiDeployment", {
        sources: [s3deploy.Source.asset(props.uiAssetPath)],
        destinationBucket: this.originBucket,
        distribution: this.distribution,
        distributionPaths: ["/*"],
        prune: true,
      });
    }

    // --- App_DNS_Record in the existing awsteach.com zone (task 19.3) ------
    const dnsRecords = this.createAppDnsRecord(props);
    this.appDnsRecord = dnsRecords?.aRecord;
    this.appDnsRecordAaaa = dnsRecords?.aaaaRecord;
  }

  /**
   * Define the App_DNS_Record pointing at the CloudFront_Distribution (task
   * 19.3, Req 9.1–9.4).
   *
   * ## Referencing the existing zone WITHOUT mutating it (Req 9.3)
   *
   * The `awsteach.com` Hosted_Zone is shared with an unrelated application, so
   * this deployment must never create or change the zone. The zone is imported
   * read-only with {@link route53.HostedZone.fromHostedZoneAttributes}, which
   * produces an `IHostedZone` reference only — CDK emits NO
   * `AWS::Route53::HostedZone` resource and nothing that alters the zone's own
   * configuration. (`fromLookup` is deliberately avoided because it needs
   * concrete account/region context and would break credential-free
   * `cdk synth`; the zone id is injected via {@link
   * ClaimClarifyDataStackProps.hostedZoneId}, defaulting to a synth-time
   * placeholder.) Because we only ever add our own new record and never define
   * `www.awsteach.com`, that pre-existing record stays untouched (Req 9.3).
   *
   * ## Naming-conflict halt (Req 9.2, 9.4)
   *
   * Before any record is defined, the configured App_DNS_Record name is run
   * through the pure {@link dnsPrecheck} helper (task 9.3) against the zone
   * snapshot (defaulting to the reserved `www.awsteach.com`). If the name
   * equals the reserved record or already exists in the snapshot, `dnsPrecheck`
   * returns `proceed: false` and this method throws, halting the ENTIRE
   * synthesis before CloudFormation emits any Route 53 resource — so no
   * existing record is changed (Req 9.4). The thrown error carries the helper's
   * conflict description, identifying the offending name.
   *
   * ## Record target (Req 9.1)
   *
   * On success it creates an A record (and a companion AAAA record for IPv6)
   * whose name is {@link cloudFrontDomainName} and whose target is a
   * {@link targets.CloudFrontTarget} alias to {@link distribution} — i.e. the
   * record resolves straight to the CloudFront distribution.
   *
   * Returns `undefined` (and defines no record) when no
   * {@link cloudFrontDomainName} is configured, keeping isolated synth working
   * without ever referencing the shared zone.
   */
  private createAppDnsRecord(
    props: ClaimClarifyDataStackProps
  ):
    | { aRecord: route53.ARecord; aaaaRecord: route53.AaaaRecord }
    | undefined {
    const appDomainName = this.cloudFrontDomainName;

    // No configured domain → no record, and the shared zone is never touched.
    if (appDomainName === undefined) {
      return undefined;
    }

    const hostedZoneName = props.hostedZoneName ?? HOSTED_ZONE_NAME;
    const zoneSnapshot: ZoneSnapshot =
      props.existingZoneRecordNames ?? DEFAULT_ZONE_SNAPSHOT;

    // Precheck halt (task 9.3): refuse to proceed if the App_DNS_Record name
    // collides with the reserved `www.awsteach.com` record or an existing
    // record in the zone snapshot. Throwing here aborts the whole `cdk synth`
    // before any Route 53 resource is emitted, so every existing record is left
    // unchanged (Req 9.2, 9.4).
    const precheck = dnsPrecheck(appDomainName, zoneSnapshot);
    if (!precheck.proceed) {
      throw new Error(
        `App_DNS_Record naming conflict for "${appDomainName}" in hosted zone ` +
          `"${hostedZoneName}": ${precheck.conflict} ` +
          "Halting deployment; no existing records were changed (Req 9.4)."
      );
    }

    // Reference the EXISTING zone read-only (Req 9.3). fromHostedZoneAttributes
    // imports the zone by id + name and emits no zone-creating/mutating
    // resource; the id is injected at deploy time and defaults to a synth-time
    // placeholder to keep credential-free synth working.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "AppHostedZone",
      {
        hostedZoneId: props.hostedZoneId ?? PLACEHOLDER_HOSTED_ZONE_ID,
        zoneName: hostedZoneName,
      }
    );

    // Alias A/AAAA records pointing straight at the CloudFront distribution
    // (Req 9.1). `recordName` is the full App_DNS_Record FQDN; `.` suffix makes
    // it absolute so CDK does not re-append the zone name.
    const recordName = `${appDomainName}.`;
    const target = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution)
    );

    const aRecord = new route53.ARecord(this, "AppDnsRecord", {
      zone: hostedZone,
      recordName,
      target,
      comment:
        "ClaimClarify App_DNS_Record → CloudFront_Distribution; " +
        "distinct from reserved www.awsteach.com (Req 9.1, 9.2)",
    });

    const aaaaRecord = new route53.AaaaRecord(this, "AppDnsRecordAaaa", {
      zone: hostedZone,
      recordName,
      target,
      comment:
        "ClaimClarify App_DNS_Record (IPv6) → CloudFront_Distribution " +
        "(Req 9.1)",
    });

    return { aRecord, aaaaRecord };
  }

  /**
   * Define the CloudFront_Distribution that fronts the Chat_UI (task 19.2).
   *
   * Routing mirrors the shared {@link classifyPath} classifier (task 7.1):
   * paths under {@link API_PATH_PREFIX} (`/api/*`) are served by the API_Layer
   * behavior; every other path falls through to the default behavior backed by
   * the S3_Origin (Req 7.5, 7.6).
   *
   * - **S3_Origin via OAC (read-only).** The origin is created with
   *   {@link origins.S3BucketOrigin.withOriginAccessControl}, which provisions
   *   an Origin Access Control and attaches a bucket policy granting CloudFront
   *   `s3:GetObject` ONLY — never Put/Delete — so the Chat_UI delivery path has
   *   read-only access to the bucket (Req 7.1, 10.4).
   * - **HTTPS / TLS 1.2 / redirect.** The default and API behaviors set
   *   `viewerProtocolPolicy` to `REDIRECT_TO_HTTPS` so HTTP requests are
   *   redirected to the equivalent HTTPS URL (Req 7.4), and the distribution's
   *   `minimumProtocolVersion` is pinned to `TLSv1.2_2021` (Req 7.3).
   * - **Viewer certificate / alias.** When {@link cloudFrontCertificate} is
   *   provided, it is attached as the viewer certificate (the `us-east-1` ACM
   *   cert — Req 8.4) and {@link cloudFrontDomainName} is set as the domain
   *   alias. Both are omitted when the prop is absent so the stack still
   *   synthesizes in isolation (the default `*.cloudfront.net` cert is used).
   */
  private createDistribution(): cloudfront.Distribution {
    // S3_Origin served through an Origin Access Control that grants CloudFront
    // read-only (s3:GetObject) access via an auto-generated bucket policy; no
    // write/delete is ever granted (Req 7.1, 10.4).
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      this.originBucket,
      {
        originAccessLevels: [cloudfront.AccessLevel.READ],
      }
    );

    // API_Layer origin: forward `/api/*` to the API Gateway HTTP API. The
    // custom domain (task 18.1) pins min TLS 1.2 for the CloudFront→origin hop;
    // CloudFront must talk to it over HTTPS only.
    const apiOrigin = new origins.HttpOrigin(this.compute.apiDomain.ref, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    // Attach the us-east-1 viewer certificate + alias only when provided, so
    // isolated synth (no certificate stack) keeps working with the default
    // CloudFront certificate (Req 8.4).
    const useCustomDomain =
      this.cloudFrontCertificate !== undefined &&
      this.cloudFrontDomainName !== undefined;

    return new cloudfront.Distribution(this, "Distribution", {
      comment:
        "ClaimClarify Chat_UI distribution: OAC read-only S3_Origin, " +
        "/api/* → API_Layer, TLS 1.2+ HTTPS-only (Req 7.1,7.3-7.6,8.4,10.4)",
      // Default behavior → S3_Origin for every non-API path (Req 7.6).
      defaultBehavior: {
        origin: s3Origin,
        // Redirect HTTP → HTTPS (Req 7.4).
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        // `/api/*` behavior → API_Layer, mirroring classifyPath semantics
        // (API_PATH_PREFIX = "/api/") (Req 7.5). API responses are dynamic and
        // may carry a body/headers, so caching is disabled and all methods are
        // forwarded.
        [`${API_PATH_PREFIX}*`]: {
          origin: apiOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      defaultRootObject: "index.html",
      // Serve all content over HTTPS with a minimum of TLS 1.2 (Req 7.3).
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // Viewer certificate + alias from the us-east-1 ACM cert (Req 8.4), only
      // when supplied so isolated synth still works.
      ...(useCustomDomain
        ? {
            certificate: this.cloudFrontCertificate,
            domainNames: [this.cloudFrontDomainName as string],
          }
        : {}),
    });
  }

  /**
   * Provision the Lambda-backed custom resource that seeds the Policy_Table
   * with the shared seed data via the duplicate-aware {@link applySeed} helper
   * (Req 5.2, 5.4). The handler reads existing rows and only writes records the
   * helper reports as new, never overwriting an existing policyId.
   */
  private createSeedResource(): void {
    const seedLogGroup = new logs.LogGroup(this, "SeedPolicyTableLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const seedFn = new lambda.Function(this, "SeedPolicyTableFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      // Self-contained esbuild bundle (workspace deps inlined). Produced by
      // `scripts/bundle-lambdas.mjs` before deploy.
      code: lambda.Code.fromAsset(lambdaBundleDir("seed-policy-table")),
      timeout: Duration.minutes(2),
      memorySize: 256,
      logGroup: seedLogGroup,
      description: "Seeds Policy_Table with the ClaimClarify seed data set",
    });

    // Seeding needs to read existing rows (duplicate detection) and
    // conditionally put new ones.
    this.policyTable.grantReadWriteData(seedFn);

    const provider = new Provider(this, "SeedPolicyTableProvider", {
      onEventHandler: seedFn,
    });

    new CustomResource(this, "SeedPolicyTable", {
      serviceToken: provider.serviceToken,
      properties: {
        TableName: this.policyTable.tableName,
        // Change this to force re-seeding when the seed set changes.
        SeedVersion: "1",
      },
    });
  }
}
