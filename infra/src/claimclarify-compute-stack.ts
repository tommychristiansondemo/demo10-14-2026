/**
 * ClaimClarify compute/API/agent/runtime constructs (task 18.1).
 *
 * This module defines {@link ClaimClarifyCompute}, a reusable construct that
 * adds the runtime pieces that serve and orchestrate adjuster chat requests on
 * top of the data/storage/config constructs from task 17.1. It is instantiated
 * inside {@link ClaimClarifyDataStack} so every construct lives in the single
 * Primary_Region (`us-east-2`) stack (Req 8.1) and the Config_Store agent-id
 * write-back stays in-stack (no cross-stack dependency cycle).
 *
 * Constructs defined here:
 *
 * - {@link ClaimClarifyCompute.chatHandler} — the API_Layer Chat Handler Lambda
 *   (Node.js), packaged from the compiled `@claimclarify/api` handler
 *   (Req 2.1, 2.2). Its code asset points at the infra `dist/lambda` output so
 *   `cdk synth` stays credential-/bundler-free, mirroring the task-17.1 seed
 *   Lambda.
 * - {@link ClaimClarifyCompute.httpApi} — an API Gateway v2 HTTP API with the
 *   `POST /api/chat` route proxying to the chat handler.
 * - {@link ClaimClarifyCompute.apiDomain} — an API Gateway custom domain whose
 *   security policy pins a MINIMUM TLS version of 1.2 (Req 11.3). HTTP APIs
 *   express a minimum TLS policy only via a domain name, so one is modeled
 *   here; task 19 wires DNS/CloudFront in front of it.
 * - {@link ClaimClarifyCompute.policyLookupRuntime} and
 *   {@link ClaimClarifyCompute.repairEstimatorRuntime} — the two MCP servers
 *   deployed to Bedrock AgentCore Runtime (Req 4.1, 6.1).
 * - {@link ClaimClarifyCompute.bedrockAgent} — the Bedrock_Agent orchestrating
 *   the two MCP servers; its id is written back into the Config_Store
 *   `BEDROCK_AGENT_ID` parameter the API reads (Req 15.1).
 *
 * IAM least-privilege (task 18.2) and CloudFront/ACM/DNS/observability
 * (task 19) refine and consume the public references exposed here. Default
 * roles created by CDK/Cfn constructs are intentionally left in place for
 * task 18.2 to tighten.
 */
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { CfnParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";

import { BEDROCK_AGENT_ID_KEY } from "./config-keys";
import { lambdaBundleDir } from "./lambda-assets";
import type { ConfigStore } from "./claimclarify-stack";

/**
 * The default foundational model the Bedrock_Agent uses to compose triage
 * responses. Overridable via {@link ClaimClarifyComputeProps.foundationModel}
 * so a deploy can pin a model actually available in the target region. The
 * default is a current Anthropic Sonnet model available in `us-east-2`.
 */
const DEFAULT_AGENT_FOUNDATION_MODEL =
  "anthropic.claude-sonnet-4-5-20250929-v1:0";

/**
 * Default (synth/test) container image URIs the AgentCore Runtime constructs
 * reference. AgentCore Runtime hosts each MCP server as a container exposing
 * the MCP protocol. These placeholders keep `cdk synth` self-contained; a real
 * deploy injects the pushed ECR image URIs via
 * {@link ClaimClarifyComputeProps.policyLookupImageUri} /
 * {@link ClaimClarifyComputeProps.repairEstimatorImageUri}.
 */
const DEFAULT_POLICY_LOOKUP_IMAGE_URI =
  "ACCOUNT.dkr.ecr.us-east-2.amazonaws.com/claimclarify-policy-lookup:latest";
const DEFAULT_REPAIR_ESTIMATOR_IMAGE_URI =
  "ACCOUNT.dkr.ecr.us-east-2.amazonaws.com/claimclarify-repair-estimator:latest";

/**
 * The custom CloudWatch namespace the two MCP servers emit their application
 * metrics under (Req 12.2). AgentCore-hosted MCP servers do not expose a
 * first-class Lambda-style metric set, so each server publishes an
 * invocation-count / error-count / latency metric under this namespace,
 * distinguished by a `Server` dimension. The alarm error-rate math and the
 * task-21.5 synthesis test reference these metric names/dimensions.
 */
export const MCP_METRIC_NAMESPACE = "ClaimClarify/MCP";

/** MCP invocation-count metric name (Req 12.2). */
export const MCP_INVOCATION_METRIC = "Invocations";
/** MCP error-count metric name (Req 12.2). */
export const MCP_ERROR_METRIC = "Errors";
/** MCP latency metric name, in milliseconds (Req 12.2). */
export const MCP_LATENCY_METRIC = "Latency";

/** The `Server` dimension value for the Policy_Lookup_Server MCP metrics. */
export const POLICY_LOOKUP_SERVER_DIMENSION = "claimclarify_policy_lookup";
/** The `Server` dimension value for the Repair_Estimator_Server MCP metrics. */
export const REPAIR_ESTIMATOR_SERVER_DIMENSION = "claimclarify_repair_estimator";

/**
 * The error-rate alarm threshold, in percent (Req 12.3, 12.4). The alarm
 * enters ALARM when error rate (errors / invocations * 100) exceeds this value
 * and returns to OK at/below it.
 */
export const ERROR_RATE_ALARM_THRESHOLD_PERCENT = 5;

/** The alarm evaluation window, in minutes (Req 12.3, 12.4). */
export const ERROR_RATE_ALARM_PERIOD_MINUTES = 5;

/**
 * Invocation/error/latency metric references for a single monitored component
 * (Req 12.2). For the API_Layer Lambda these are the function's built-in
 * `AWS/Lambda` metrics; for the MCP servers they are references to the
 * {@link MCP_METRIC_NAMESPACE} metrics the servers emit.
 */
export interface ComponentMetrics {
  /** Invocation-count metric. */
  readonly invocations: cloudwatch.IMetric;
  /** Error-count metric. */
  readonly errors: cloudwatch.IMetric;
  /** Latency/duration metric. */
  readonly latency: cloudwatch.IMetric;
}

/**
 * The CloudWatch Log_Group references for the four monitored components
 * (Req 12.1), exposed for the task-21.5 synthesis test.
 */
export interface ComponentLogGroups {
  /** Bedrock_Agent log group. */
  readonly bedrockAgent: logs.ILogGroup;
  /** API_Layer chat Lambda log group. */
  readonly chatHandler: logs.ILogGroup;
  /** Policy_Lookup_Server log group. */
  readonly policyLookup: logs.ILogGroup;
  /** Repair_Estimator_Server log group. */
  readonly repairEstimator: logs.ILogGroup;
}

/**
 * The error-rate CloudWatch Alarms for the monitored components (Req 12.3,
 * 12.4), exposed for the task-21.5 synthesis test.
 */
export interface ComponentAlarms {
  /** API_Layer chat Lambda error-rate alarm. */
  readonly chatHandler: cloudwatch.Alarm;
  /** Policy_Lookup_Server error-rate alarm. */
  readonly policyLookup: cloudwatch.Alarm;
  /** Repair_Estimator_Server error-rate alarm. */
  readonly repairEstimator: cloudwatch.Alarm;
}

/** Props for {@link ClaimClarifyCompute}. */
export interface ClaimClarifyComputeProps {
  /** The Config_Store SSM parameters each component reads at runtime. */
  readonly configStore: ConfigStore;
  /**
   * The Policy_Table the policy-lookup server reads. Used to grant the
   * policy-lookup runtime role READ-ONLY data access (Req 10.2).
   */
  readonly policyTable: dynamodb.ITable;
  /**
   * Fully-qualified domain name for the API custom domain whose security policy
   * enforces min TLS 1.2 (Req 11.3). Defaults to `api.ohio.awsteach.com`; the
   * DNS record for it is published in task 19.3.
   */
  readonly apiDomainName?: string;
  /**
   * The ECR image URI for the Policy_Lookup_Server MCP container. A real deploy
   * injects the pushed image URI; defaults to a synth/test placeholder.
   */
  readonly policyLookupImageUri?: string;
  /**
   * The ECR image URI for the Repair_Estimator_Server MCP container. A real
   * deploy injects the pushed image URI; defaults to a synth/test placeholder.
   */
  readonly repairEstimatorImageUri?: string;
  /**
   * The Bedrock foundation model id the agent uses. A real deploy pins a model
   * available in the target region; defaults to
   * {@link DEFAULT_AGENT_FOUNDATION_MODEL}.
   */
  readonly foundationModel?: string;
  /**
   * Whether to provision the Bedrock_Agent and the two AgentCore Runtime MCP
   * servers. Defaults to `true` (full stack). A phased/core-only deploy sets
   * this to `false` to stand up the deterministic app (API, data, CloudFront,
   * DNS, observability for the Lambda) without the AgentCore container runtimes
   * — which require pushed ECR images. When `false` the chat Lambda serves a
   * deterministic response and the `BEDROCK_AGENT_ID` Config_Store entry is
   * left as its not-yet-deployed marker.
   */
  readonly deployAgentCore?: boolean;

  /**
   * The id and name of the existing Hosted_Zone. When provided, the API custom
   * domain's ACM certificate binds the imported zone so its DNS-validation
   * record is created automatically (hands-off issuance). Omitted in
   * synth/tests to keep `cdk synth` credential-free.
   */
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

/**
 * Compute, API, agent, and AgentCore runtime constructs for ClaimClarify. All
 * resources are created in the scope of the enclosing Primary_Region stack
 * (Req 8.1).
 */
export class ClaimClarifyCompute extends Construct {
  /** Whether the Bedrock_Agent + AgentCore runtimes are provisioned. */
  private readonly deployAgentCore: boolean;
  /** Resolved ECR image URI for the Policy_Lookup_Server MCP container. */
  private readonly policyLookupImageUri: string;
  /** Resolved ECR image URI for the Repair_Estimator_Server MCP container. */
  private readonly repairEstimatorImageUri: string;
  /** Resolved Bedrock foundation model id for the agent. */
  private readonly foundationModel: string;
  /** Hosted zone id for automatic ACM DNS validation (undefined in synth/tests). */
  private readonly hostedZoneId?: string;
  /** Hosted zone name for automatic ACM DNS validation. */
  private readonly hostedZoneName: string;
  /** API_Layer Chat Handler Lambda (Req 2.1, 2.2). */
  public readonly chatHandler: lambda.Function;

  /**
   * The explicit CloudWatch Log_Group attached to the chat handler Lambda
   * (Req 12.1). Created with the function so it replaces the implicit group
   * CDK would otherwise synthesize and is guaranteed present in `us-east-2`.
   */
  private readonly chatHandlerLogGroup: logs.LogGroup;

  /** HTTP API fronting `POST /api/chat`. */
  public readonly httpApi: apigwv2.CfnApi;

  /** `POST /api/chat` route. */
  public readonly chatRoute: apigwv2.CfnRoute;

  /** Custom domain name pinning min TLS 1.2 (Req 11.3). */
  public readonly apiDomain: apigwv2.CfnDomainName;

  /**
   * Policy_Lookup_Server on AgentCore Runtime (Req 4.1). Present only when
   * {@link ClaimClarifyComputeProps.deployAgentCore} is enabled.
   */
  public readonly policyLookupRuntime?: agentcore.CfnRuntime;

  /**
   * Repair_Estimator_Server on AgentCore Runtime (Req 6.1). Present only when
   * {@link ClaimClarifyComputeProps.deployAgentCore} is enabled.
   */
  public readonly repairEstimatorRuntime?: agentcore.CfnRuntime;

  /**
   * The Bedrock_Agent orchestrating the two MCP servers. Present only when
   * {@link ClaimClarifyComputeProps.deployAgentCore} is enabled.
   */
  public readonly bedrockAgent?: bedrock.CfnAgent;

  /**
   * Dedicated, non-shared least-privilege IAM roles — one per component
   * (Req 10.1, 10.3). Exposed so task 21.4's synthesis tests can assert each
   * component has its own role and its policies are correctly scoped.
   */
  public readonly chatHandlerRole: iam.Role;
  public readonly policyLookupRole: iam.Role;
  public readonly repairEstimatorRole: iam.Role;
  public readonly bedrockAgentRole: iam.Role;

  /**
   * Explicit CloudWatch Log_Groups for ALL FOUR components — the Bedrock_Agent,
   * the API_Layer chat Lambda, the Policy_Lookup_Server, and the
   * Repair_Estimator_Server (Req 12.1). An explicit group is defined per
   * component (the chat Lambda's implicit group is replaced by the explicit one
   * attached to it) so all four are present in the Primary_Region `us-east-2`
   * (Req 8.5). Exposed for the task-21.5 synthesis test.
   */
  public readonly logGroups: ComponentLogGroups;

  /**
   * Invocation/error/latency metric references for the API_Layer Lambda and the
   * two MCP servers (Req 12.2). The Lambda metrics are its built-in
   * `AWS/Lambda` Invocations/Errors/Duration; the MCP metrics reference the
   * {@link MCP_METRIC_NAMESPACE} metrics the servers emit. Exposed for the
   * task-21.5 synthesis test.
   */
  public readonly metrics: {
    readonly chatHandler: ComponentMetrics;
    readonly policyLookup: ComponentMetrics;
    readonly repairEstimator: ComponentMetrics;
  };

  /**
   * Error-rate CloudWatch Alarms for each monitored component: ALARM when the
   * error rate exceeds 5% over a 5-minute window and OK at/below it (Req 12.3,
   * 12.4). All CloudWatch resources live in the Primary_Region `us-east-2`
   * (Req 8.5). Exposed for the task-21.5 synthesis test.
   */
  public readonly alarms: ComponentAlarms;

  constructor(scope: Construct, id: string, props: ClaimClarifyComputeProps) {
    super(scope, id);

    const { configStore, policyTable } = props;
    const apiDomainName = props.apiDomainName ?? "api.ohio.awsteach.com";
    this.policyLookupImageUri =
      props.policyLookupImageUri ?? DEFAULT_POLICY_LOOKUP_IMAGE_URI;
    this.repairEstimatorImageUri =
      props.repairEstimatorImageUri ?? DEFAULT_REPAIR_ESTIMATOR_IMAGE_URI;
    this.foundationModel =
      props.foundationModel ?? DEFAULT_AGENT_FOUNDATION_MODEL;
    this.deployAgentCore = props.deployAgentCore ?? true;
    this.hostedZoneId = props.hostedZoneId;
    this.hostedZoneName = props.hostedZoneName ?? "awsteach.com";

    const chatHandlerBundle = this.createChatHandler(configStore);
    this.chatHandler = chatHandlerBundle.fn;
    this.chatHandlerLogGroup = chatHandlerBundle.logGroup;
    this.chatHandlerRole = this.chatHandler.role as iam.Role;
    const { httpApi, chatRoute, domain } = this.createApi(apiDomainName);
    this.httpApi = httpApi;
    this.chatRoute = chatRoute;
    this.apiDomain = domain;

    // The dedicated component roles are always created (cheap, and keep the
    // least-privilege grants resolvable). The AgentCore runtime + Bedrock agent
    // RESOURCES are gated behind `deployAgentCore` so a core-only deploy does
    // not reference ECR images that have not been built/pushed yet.
    const {
      policyLookupRuntime,
      repairEstimatorRuntime,
      policyLookupRole,
      repairEstimatorRole,
    } = this.createAgentCoreRuntimes(configStore, policyTable);
    this.policyLookupRuntime = policyLookupRuntime;
    this.repairEstimatorRuntime = repairEstimatorRuntime;
    this.policyLookupRole = policyLookupRole;
    this.repairEstimatorRole = repairEstimatorRole;

    const { agent, agentRole } = this.createBedrockAgent();
    this.bedrockAgent = agent;
    this.bedrockAgentRole = agentRole;

    // --- Least-privilege Config_Store + resource grants (task 18.2) --------
    this.grantLeastPrivilege(configStore);

    // --- Observability: logs, metrics, alarms (task 19.4) ------------------
    // Defined last so the chat handler / runtimes exist; all CloudWatch
    // resources are created in the scope of this Primary_Region stack so they
    // live in us-east-2 (Req 8.5, 12.1, 12.2, 12.3, 12.4).
    const observability = this.createObservability();
    this.logGroups = observability.logGroups;
    this.metrics = observability.metrics;
    this.alarms = observability.alarms;

    // Wire the real agent id into the Config_Store BEDROCK_AGENT_ID parameter
    // (replacing the task-17.1 placeholder) so the API reads a real reference
    // from the Config_Store at runtime (Req 15.1). This is an in-stack
    // reference, so there is no cross-stack dependency cycle. In a core-only
    // deploy there is no agent yet, so the marker value is left in place and
    // the chat Lambda serves a deterministic response.
    if (this.deployAgentCore && this.bedrockAgent) {
      const agentIdParam = configStore.bedrockAgentId.node
        .defaultChild as CfnParameter;
      agentIdParam.value = this.bedrockAgent.attrAgentId;
    }
  }

  /**
   * The API_Layer Chat Handler Lambda. The code asset points at the compiled
   * `dist/lambda` directory (the same credential-free pattern the task-17.1
   * seed Lambda uses). The Config_Store key/param names are passed as
   * environment variables so the handler reads the agent id at runtime
   * (Req 2.1, 2.2, 15.2).
   */
  private createChatHandler(configStore: ConfigStore): {
    fn: lambda.Function;
    logGroup: logs.LogGroup;
  } {
    // A dedicated, non-shared execution role for the API_Layer Lambda
    // (Req 10.1). CDK would otherwise synthesize an anonymous default role;
    // modeling it explicitly lets task 18.2 attach exactly the scoped
    // permissions the handler needs (Config_Store read + agent invoke) and
    // lets task 21.4 assert the role is dedicated. The AWS-managed basic
    // execution policy only grants CloudWatch Logs write for this function's
    // own log group, which is the minimum a Lambda needs to run (Req 10.3).
    const chatHandlerRole = new iam.Role(this, "ChatHandlerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Dedicated least-privilege execution role for the API_Layer chat " +
        "handler Lambda (Req 10.1, 10.3)",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Explicit CloudWatch Log_Group for the API_Layer Lambda (Req 12.1).
    // Attaching it to the function (via `logGroup`) replaces the implicit group
    // CDK would otherwise create, so there is exactly one Lambda-owned log
    // group under our control, present in the Primary_Region us-east-2
    // (Req 8.5). The AWS-managed basic execution policy already grants the
    // function write access to its own log group.
    const logGroup = new logs.LogGroup(this, "ChatHandlerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, "ChatHandlerFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      // Self-contained esbuild bundle (workspace deps inlined). Produced by
      // `scripts/bundle-lambdas.mjs` before deploy.
      code: lambda.Code.fromAsset(lambdaBundleDir("chat-handler")),
      role: chatHandlerRole,
      timeout: Duration.seconds(29),
      memorySize: 256,
      logGroup,
      environment: {
        // The handler reads the agent id from the Config_Store by this key.
        AGENT_ID_CONFIG_KEY: BEDROCK_AGENT_ID_KEY,
        POLICY_TABLE_NAME_PARAM: configStore.policyTableName.parameterName,
      },
      description:
        "ClaimClarify API_Layer chat handler: validates requests and " +
        "invokes the Bedrock_Agent (Req 2.1, 2.2)",
    });

    return { fn, logGroup };
  }

  /**
   * API Gateway v2 HTTP API exposing `POST /api/chat`, plus a custom domain
   * whose security policy pins a MINIMUM TLS version of 1.2 (Req 11.3).
   *
   * HTTP APIs express a minimum TLS policy only through a domain name's
   * `securityPolicy`, so a domain name construct is created and set to
   * `TLS_1_2`. The ACM certificate the domain references is provisioned in
   * `us-east-2` here (CloudFront's cert is the separate `us-east-1` cert from
   * task 19.1); DNS for the domain is published in task 19.3.
   */
  private createApi(apiDomainName: string): {
    httpApi: apigwv2.CfnApi;
    chatRoute: apigwv2.CfnRoute;
    domain: apigwv2.CfnDomainName;
  } {
    const httpApi = new apigwv2.CfnApi(this, "ChatHttpApi", {
      name: "ClaimClarify-ChatApi",
      protocolType: "HTTP",
      description: "ClaimClarify API_Layer HTTP API (POST /api/chat)",
    });

    // Grant API Gateway permission to invoke the handler.
    this.chatHandler.addPermission("ApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: Stack.of(this).formatArn({
        service: "execute-api",
        resource: httpApi.ref,
        resourceName: "*/*/*",
      }),
    });

    const integration = new apigwv2.CfnIntegration(this, "ChatIntegration", {
      apiId: httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: this.chatHandler.functionArn,
      payloadFormatVersion: "2.0",
      integrationMethod: "POST",
    });

    const chatRoute = new apigwv2.CfnRoute(this, "ChatRoute", {
      apiId: httpApi.ref,
      routeKey: "POST /api/chat",
      target: `integrations/${integration.ref}`,
    });

    new apigwv2.CfnStage(this, "ChatApiStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });

    // A certificate for the custom domain in us-east-2. The custom domain is
    // the only place an HTTP API can declare a minimum TLS version, so it is
    // modeled explicitly to satisfy Req 11.3 and the task-21.3 synthesis test.
    // When a hosted zone id is supplied (real deploy), bind the imported zone
    // so the ACM DNS-validation record is created automatically; otherwise use
    // the zone-less form for credential-free synth/tests.
    const apiCertValidation =
      this.hostedZoneId !== undefined
        ? acm.CertificateValidation.fromDns(
            route53.HostedZone.fromHostedZoneAttributes(this, "ApiCertZone", {
              hostedZoneId: this.hostedZoneId,
              zoneName: this.hostedZoneName,
            })
          )
        : acm.CertificateValidation.fromDns();
    const apiCertificate = new acm.Certificate(this, "ApiDomainCertificate", {
      domainName: apiDomainName,
      validation: apiCertValidation,
    });

    const domain = new apigwv2.CfnDomainName(this, "ChatApiDomain", {
      domainName: apiDomainName,
      domainNameConfigurations: [
        {
          certificateArn: apiCertificate.certificateArn,
          endpointType: "REGIONAL",
          // Minimum TLS version 1.2 (Req 11.3).
          securityPolicy: "TLS_1_2",
        },
      ],
    });

    new apigwv2.CfnApiMapping(this, "ChatApiMapping", {
      apiId: httpApi.ref,
      domainName: domain.ref,
      stage: "$default",
    });

    // Publish a Route53 alias for the API custom domain so CloudFront's
    // `/api/*` origin (which targets `api.<app-domain>`) actually resolves to
    // the regional API Gateway endpoint. Without this record CloudFront cannot
    // reach the API origin and returns 502. Only created on a real deploy (a
    // hosted zone id is supplied); omitted in synth/tests. The alias target is
    // the CfnDomainName's regional domain + hosted zone id.
    if (this.hostedZoneId !== undefined) {
      const apiZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        "ApiAliasZone",
        { hostedZoneId: this.hostedZoneId, zoneName: this.hostedZoneName }
      );
      const apiAliasTarget = route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: domain.attrRegionalDomainName,
          hostedZoneId: domain.attrRegionalHostedZoneId,
        }),
      });
      new route53.ARecord(this, "ApiDomainAliasRecord", {
        zone: apiZone,
        recordName: `${apiDomainName}.`,
        target: apiAliasTarget,
        comment:
          "ClaimClarify API custom domain → regional API Gateway endpoint " +
          "(resolves CloudFront's /api/* origin)",
      });
      new route53.AaaaRecord(this, "ApiDomainAliasRecordAaaa", {
        zone: apiZone,
        recordName: `${apiDomainName}.`,
        target: apiAliasTarget,
        comment:
          "ClaimClarify API custom domain (IPv6) → regional API Gateway endpoint",
      });
    }

    return { httpApi, chatRoute, domain };
  }

  /**
   * Deploy both MCP servers to Bedrock AgentCore Runtime in the Primary_Region
   * (Req 4.1, 6.1).
   *
   * Modeling choice: AgentCore Runtime has a first-class CloudFormation/CDK
   * construct (`aws-bedrockagentcore.CfnRuntime`) that hosts each MCP server as
   * a container exposing the MCP protocol. Each runtime is given a minimal
   * execution role here; task 18.2 refines these to least privilege (e.g. the
   * policy-lookup runtime's read-only access to the Policy_Table). Config_Store
   * references are passed as environment variables so the servers read their
   * configuration at runtime (Req 15.2).
   */
  private createAgentCoreRuntimes(
    configStore: ConfigStore,
    policyTable: dynamodb.ITable
  ): {
    policyLookupRuntime?: agentcore.CfnRuntime;
    repairEstimatorRuntime?: agentcore.CfnRuntime;
    policyLookupRole: iam.Role;
    repairEstimatorRole: iam.Role;
  } {
    const makeRuntimeRole = (name: string): iam.Role =>
      new iam.Role(this, `${name}RuntimeRole`, {
        assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        description: `Dedicated least-privilege execution role for the ${name} AgentCore runtime (Req 10.1, 10.3)`,
      });

    const policyLookupRole = makeRuntimeRole("PolicyLookup");
    const repairEstimatorRole = makeRuntimeRole("RepairEstimator");

    // Policy_Lookup_Server: READ-ONLY on the Policy_Table (Req 10.2). CDK's
    // grantReadData grants only read actions (GetItem/Query/BatchGetItem/
    // Scan/DescribeTable/ConditionCheckItem) — never PutItem/UpdateItem/
    // DeleteItem — so the role can read coverage/deductible/prior-claim data
    // but can never write or delete it.
    policyTable.grantReadData(policyLookupRole);

    // Core-only deploy: skip the AgentCore CfnRuntime resources (they require
    // pushed ECR images). The roles above are retained so least-privilege
    // grants still resolve and a later full deploy can attach the runtimes.
    if (!this.deployAgentCore) {
      return { policyLookupRole, repairEstimatorRole };
    }

    const policyLookupRuntime = new agentcore.CfnRuntime(
      this,
      "PolicyLookupRuntime",
      {
        agentRuntimeName: "claimclarify_policy_lookup",
        description:
          "Policy_Lookup_Server MCP server on AgentCore Runtime (Req 4.1)",
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: this.policyLookupImageUri },
        },
        networkConfiguration: { networkMode: "PUBLIC" },
        protocolConfiguration: "MCP",
        roleArn: policyLookupRole.roleArn,
        environmentVariables: {
          // Config_Store reference: the policy-lookup server reads the table
          // name parameter at runtime (Req 15.2).
          POLICY_TABLE_NAME_PARAM: configStore.policyTableName.parameterName,
        },
      }
    );

    const repairEstimatorRuntime = new agentcore.CfnRuntime(
      this,
      "RepairEstimatorRuntime",
      {
        agentRuntimeName: "claimclarify_repair_estimator",
        description:
          "Repair_Estimator_Server MCP server on AgentCore Runtime (Req 6.1)",
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: this.repairEstimatorImageUri,
          },
        },
        networkConfiguration: { networkMode: "PUBLIC" },
        protocolConfiguration: "MCP",
        roleArn: repairEstimatorRole.roleArn,
        environmentVariables: {
          // Config_Store reference: the repair-estimator server reads its
          // environment parameter at runtime (Req 15.2).
          REPAIR_ESTIMATOR_ENVIRONMENT_PARAM:
            configStore.repairEstimatorEnvironment.parameterName,
        },
      }
    );

    return {
      policyLookupRuntime,
      repairEstimatorRuntime,
      policyLookupRole,
      repairEstimatorRole,
    };
  }

  /**
   * The Bedrock_Agent that orchestrates the two MCP servers. Modeled with the
   * first-class `aws-bedrock.CfnAgent` construct. A dedicated agent role is
   * created minimally here and refined to least privilege in task 18.2; the
   * agent's instruction describes the two-tool triage orchestration. The MCP
   * servers are attached to the agent through AgentCore wiring at deploy time
   * (task 19); the agent id is exported for the Config_Store wiring above.
   */
  private createBedrockAgent(): {
    agent?: bedrock.CfnAgent;
    agentRole: iam.Role;
  } {
    const agentRole = new iam.Role(this, "BedrockAgentRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description:
        "Dedicated least-privilege execution role for the ClaimClarify " +
        "Bedrock_Agent (Req 10.1, 10.3)",
    });

    // Core-only deploy: skip the Bedrock_Agent resource. The role is retained.
    if (!this.deployAgentCore) {
      return { agentRole };
    }

    const agent = new bedrock.CfnAgent(this, "ClaimClarifyAgent", {
      agentName: "ClaimClarify-Agent",
      agentResourceRoleArn: agentRole.roleArn,
      foundationModel: this.foundationModel,
      description:
        "ClaimClarify auto-insurance claims triage agent orchestrating the " +
        "policy-lookup and repair-estimator MCP servers (Req 3.*)",
      instruction:
        "You are ClaimClarify, an auto-insurance claims triage assistant. " +
        "Use the policy-lookup tools to retrieve coverage, deductibles, and " +
        "prior-claim history, and the repair-estimator tool to classify " +
        "damage severity and estimate repair cost and turnaround. Combine the " +
        "tool results into a single clear triage answer and name any tool " +
        "that fails.",
      autoPrepare: true,
    });

    return { agent, agentRole };
  }

  /**
   * Define the Observability_Service resources — CloudWatch logs, metrics, and
   * alarms — for all four components (task 19.4, Req 8.5, 12.1, 12.2, 12.3,
   * 12.4). Every resource is created in the scope of this construct's enclosing
   * Primary_Region stack, so all CloudWatch resources live in `us-east-2`
   * (Req 8.5).
   *
   * ## Log groups (Req 12.1)
   *
   * An explicit {@link logs.LogGroup} is defined for EACH of the four
   * components — the Bedrock_Agent, the API_Layer chat Lambda, the
   * Policy_Lookup_Server, and the Repair_Estimator_Server — so all four log
   * groups are guaranteed present and in `us-east-2`. The chat Lambda's
   * explicit group is created with the function (see
   * {@link createChatHandler}) and reused here; the agent/MCP groups are
   * defined here using the log group names those services write to by
   * convention
   * (`/aws/bedrock/agents/...`, `/aws/bedrock-agentcore/runtimes/...`).
   *
   * ## Metrics (Req 12.2)
   *
   * For the API_Layer Lambda, invocation/error/latency are the function's
   * built-in `AWS/Lambda` metrics (`Invocations`, `Errors`, `Duration`). For
   * each MCP server, metric references are defined over the custom
   * {@link MCP_METRIC_NAMESPACE} namespace with the appropriate `Server`
   * dimension, representing the invocation/error/latency the servers emit.
   *
   * ## Alarms (Req 12.3, 12.4)
   *
   * For each monitored component (the API Lambda and the two MCP servers) an
   * error-rate alarm is defined over a `MathExpression` of
   * `errors / invocations * 100` with a {@link ERROR_RATE_ALARM_THRESHOLD_PERCENT}
   * (5%) threshold, a {@link ERROR_RATE_ALARM_PERIOD_MINUTES} (5-minute) period
   * and a single evaluation period. The alarm enters ALARM when the error rate
   * is strictly greater than 5% and returns to OK at/below 5% — the default
   * CloudWatch ALARM↔OK transition behavior. Missing data is treated as "not
   * breaching" so a component with no traffic does not spuriously alarm.
   */
  private createObservability(): {
    logGroups: ComponentLogGroups;
    metrics: {
      chatHandler: ComponentMetrics;
      policyLookup: ComponentMetrics;
      repairEstimator: ComponentMetrics;
    };
    alarms: ComponentAlarms;
  } {
    // --- Log groups for all four components (Req 12.1) ---------------------
    // Log group names use the well-known service conventions and the stable
    // agent/runtime names (constants), so all four groups are present whether
    // or not the AgentCore runtimes/agent resources themselves are provisioned
    // in this deploy. A later full deploy reuses these same log groups.
    const bedrockAgentLogGroup = new logs.LogGroup(this, "BedrockAgentLogs", {
      logGroupName: `/aws/bedrock/agents/ClaimClarify-Agent`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const policyLookupLogGroup = new logs.LogGroup(this, "PolicyLookupLogs", {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${POLICY_LOOKUP_SERVER_DIMENSION}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const repairEstimatorLogGroup = new logs.LogGroup(
      this,
      "RepairEstimatorLogs",
      {
        logGroupName: `/aws/bedrock-agentcore/runtimes/${REPAIR_ESTIMATOR_SERVER_DIMENSION}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    const logGroups: ComponentLogGroups = {
      bedrockAgent: bedrockAgentLogGroup,
      // The chat Lambda's explicit group is created with the function so it
      // replaces the implicit one; reuse that reference here (Req 12.1).
      chatHandler: this.chatHandlerLogGroup,
      policyLookup: policyLookupLogGroup,
      repairEstimator: repairEstimatorLogGroup,
    };

    // --- Metrics for the API Lambda and the two MCP servers (Req 12.2) -----
    const alarmPeriod = Duration.minutes(ERROR_RATE_ALARM_PERIOD_MINUTES);

    // API_Layer Lambda: built-in AWS/Lambda metrics.
    const chatHandlerMetrics: ComponentMetrics = {
      invocations: this.chatHandler.metricInvocations({ period: alarmPeriod }),
      errors: this.chatHandler.metricErrors({ period: alarmPeriod }),
      latency: this.chatHandler.metricDuration({ period: alarmPeriod }),
    };

    // MCP servers: references to the custom-namespace metrics they emit.
    const mcpMetrics = (serverDimension: string): ComponentMetrics => ({
      invocations: new cloudwatch.Metric({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_INVOCATION_METRIC,
        dimensionsMap: { Server: serverDimension },
        statistic: cloudwatch.Stats.SUM,
        period: alarmPeriod,
      }),
      errors: new cloudwatch.Metric({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_ERROR_METRIC,
        dimensionsMap: { Server: serverDimension },
        statistic: cloudwatch.Stats.SUM,
        period: alarmPeriod,
      }),
      latency: new cloudwatch.Metric({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_LATENCY_METRIC,
        dimensionsMap: { Server: serverDimension },
        statistic: cloudwatch.Stats.AVERAGE,
        period: alarmPeriod,
      }),
    });

    const policyLookupMetrics = mcpMetrics(POLICY_LOOKUP_SERVER_DIMENSION);
    const repairEstimatorMetrics = mcpMetrics(REPAIR_ESTIMATOR_SERVER_DIMENSION);

    // --- Error-rate alarms: 5% over a 5-minute window (Req 12.3, 12.4) -----
    const makeErrorRateAlarm = (
      id: string,
      componentLabel: string,
      componentMetrics: ComponentMetrics
    ): cloudwatch.Alarm => {
      // error rate (%) = errors / invocations * 100. IF_UNSET keeps the
      // expression defined (0%) when a component has had no traffic, so the
      // alarm resolves to OK rather than INSUFFICIENT_DATA.
      const errorRate = new cloudwatch.MathExpression({
        expression: "FILL(errors, 0) / FILL(invocations, 1) * 100",
        usingMetrics: {
          errors: componentMetrics.errors,
          invocations: componentMetrics.invocations,
        },
        label: `${componentLabel} error rate (%)`,
        period: alarmPeriod,
      });

      return new cloudwatch.Alarm(this, id, {
        alarmDescription:
          `${componentLabel}: enter ALARM when the error rate exceeds ` +
          `${ERROR_RATE_ALARM_THRESHOLD_PERCENT}% over a ` +
          `${ERROR_RATE_ALARM_PERIOD_MINUTES}-minute window and return to OK ` +
          `at/below it (Req 12.3, 12.4)`,
        metric: errorRate,
        threshold: ERROR_RATE_ALARM_THRESHOLD_PERCENT,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // Error rate is 0 when there is no traffic, so missing data is not a
        // breach; the alarm supports the default ALARM↔OK transitions.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    };

    const alarms: ComponentAlarms = {
      chatHandler: makeErrorRateAlarm(
        "ChatHandlerErrorRateAlarm",
        "API_Layer chat Lambda",
        chatHandlerMetrics
      ),
      policyLookup: makeErrorRateAlarm(
        "PolicyLookupErrorRateAlarm",
        "Policy_Lookup_Server",
        policyLookupMetrics
      ),
      repairEstimator: makeErrorRateAlarm(
        "RepairEstimatorErrorRateAlarm",
        "Repair_Estimator_Server",
        repairEstimatorMetrics
      ),
    };

    return {
      logGroups,
      metrics: {
        chatHandler: chatHandlerMetrics,
        policyLookup: policyLookupMetrics,
        repairEstimator: repairEstimatorMetrics,
      },
      alarms,
    };
  }

  /**
   * Attach the per-component least-privilege Config_Store and resource grants
   * (task 18.2). Each component is granted read access ONLY to the Config_Store
   * entries it needs (Req 15.4) and only the specific resource actions required
   * to perform its function (Req 10.3) — no wildcard resources/actions beyond
   * what each needs:
   *
   * - API_Layer chat Lambda → read the `BEDROCK_AGENT_ID` parameter and invoke
   *   the Bedrock_Agent (so it can forward adjuster messages).
   * - Policy_Lookup_Server → read the policy-table-name parameter (the
   *   READ-ONLY table data grant is attached where the role is created).
   * - Repair_Estimator_Server → read the repair-estimator environment
   *   parameter only.
   * - Bedrock_Agent → invoke the foundation model and the two MCP-server
   *   AgentCore runtimes it orchestrates.
   */
  private grantLeastPrivilege(configStore: ConfigStore): void {
    const stack = Stack.of(this);

    // --- API_Layer chat Lambda --------------------------------------------
    // Read ONLY the agent-id parameter it forwards to (Req 15.4) ...
    configStore.bedrockAgentId.grantRead(this.chatHandlerRole);
    // ... and invoke that specific Bedrock_Agent (Req 10.3). Scoped to the
    // agent's own ARN, not "*". Only granted when the agent is provisioned; a
    // core-only deploy has no agent to invoke.
    if (this.bedrockAgent) {
      this.chatHandlerRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeAgent"],
          resources: [
            stack.formatArn({
              service: "bedrock",
              resource: "agent",
              resourceName: this.bedrockAgent.attrAgentId,
            }),
          ],
        })
      );
    }

    // --- Policy_Lookup_Server ---------------------------------------------
    // Read ONLY the policy-table-name parameter (Req 15.4). The READ-ONLY
    // Policy_Table data grant is attached in createAgentCoreRuntimes.
    configStore.policyTableName.grantRead(this.policyLookupRole);

    // --- Repair_Estimator_Server ------------------------------------------
    // Read ONLY the repair-estimator environment parameter (Req 15.4).
    configStore.repairEstimatorEnvironment.grantRead(this.repairEstimatorRole);

    // --- Bedrock_Agent -----------------------------------------------------
    // The agent's model + runtime-invoke grants only apply when the agent and
    // its AgentCore runtimes are provisioned (full deploy).
    if (
      this.bedrockAgent &&
      this.policyLookupRuntime &&
      this.repairEstimatorRuntime
    ) {
      // Invoke the foundation model it reasons with ...
      this.bedrockAgentRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: [
            stack.formatArn({
              service: "bedrock",
              account: "",
              region: stack.region,
              resource: "foundation-model",
              resourceName: this.foundationModel,
            }),
          ],
        })
      );
      // ... and invoke the two MCP-server AgentCore runtimes it orchestrates
      // (Req 10.3), scoped to those two runtime ARNs only.
      this.bedrockAgentRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [
            this.policyLookupRuntime.attrAgentRuntimeArn,
            this.repairEstimatorRuntime.attrAgentRuntimeArn,
          ],
        })
      );
    }
  }
}
