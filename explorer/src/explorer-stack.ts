/**
 * ClaimClarify Explorer stack — a completely separate application from the
 * ClaimClarify stacks.
 *
 * Provides students insight into everything deployed for the class:
 *  - a static front end (S3) served over CloudFront/HTTPS,
 *  - `projectknowledge.md` stored in S3 (the living description of the system),
 *  - a Bedrock-backed chat Lambda that answers from that document,
 *  - a read-only CloudWatch Logs Lambda that surfaces live logs + the chatbot's
 *    own LLM prompt/response ("reasoning") entries,
 *  - all fronted by API Gateway under the same CloudFront distribution.
 *
 * Security posture:
 *  - No API keys anywhere; Bedrock is invoked via the Lambda's IAM role.
 *  - The logs Lambda is granted read-only access ONLY to the allow-listed
 *    ClaimClarify + Explorer log groups (never the whole account).
 *  - The chat Lambda may only read the knowledge object and invoke the model.
 */
import * as path from "node:path";
import {
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

/** Primary region (same as ClaimClarify core). */
export const PRIMARY_REGION = "us-east-2";
/**
 * Bedrock inference-profile id used to invoke the model. Claude Sonnet 4.5 is
 * not available for direct on-demand model-id invocation; it must be called via
 * a cross-region inference profile. We use the US profile.
 */
export const EXPLORER_MODEL_ID =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
/** The underlying foundation model id (used for IAM resource scoping). */
export const EXPLORER_FOUNDATION_MODEL =
  "anthropic.claude-sonnet-4-5-20250929-v1:0";
/** Knowledge object key in the Explorer bucket. */
export const KNOWLEDGE_KEY = "projectknowledge.md";

export interface ExplorerStackProps extends StackProps {
  /** Absolute path to the built static web assets directory. */
  readonly webAssetPath: string;
  /** Absolute path to the bundled Lambda directory (contains chat/ and logs/). */
  readonly lambdaBundleDir: string;
  /** ACM cert (us-east-1) for the CloudFront viewer, when using a custom domain. */
  readonly viewerCertificate?: acm.ICertificate;
  /** Fully-qualified domain name for the Explorer (e.g. explorer.awsteach.com). */
  readonly domainName?: string;
  /** Hosted zone id of awsteach.com for the DNS alias + ACM validation. */
  readonly hostedZoneId?: string;
  /** Hosted zone name (defaults to awsteach.com). */
  readonly hostedZoneName?: string;
  /**
   * The CloudWatch log group names the logs Lambda is allowed to read
   * (ClaimClarify core groups + the Explorer's own). Read-only, allow-listed.
   */
  readonly allowedLogGroupNames: string[];
}

export class ExplorerStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ExplorerStackProps) {
    super(scope, id, { ...props, env: { ...props.env, region: PRIMARY_REGION } });

    const hostedZoneName = props.hostedZoneName ?? "awsteach.com";

    // --- S3: static site + knowledge document (private, OAC-only) ----------
    this.bucket = new s3.Bucket(this, "ExplorerBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Chat Lambda (Bedrock-backed) --------------------------------------
    const chatFn = new lambda.Function(this, "ExplorerChatFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(props.lambdaBundleDir, "chat")),
      timeout: Duration.seconds(29),
      memorySize: 256,
      environment: {
        KNOWLEDGE_BUCKET: this.bucket.bucketName,
        KNOWLEDGE_KEY,
        BEDROCK_MODEL_ID: EXPLORER_MODEL_ID,
      },
      logGroup: new logs.LogGroup(this, "ExplorerChatLogs", {
        logGroupName: "/claimclarify/explorer/chat",
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description: "ClaimClarify Explorer chat Lambda (Bedrock-backed, logs reasoning)",
    });
    // Read ONLY the knowledge object.
    this.bucket.grantRead(chatFn, KNOWLEDGE_KEY);
    // Invoke the model via its cross-region inference profile. Newer Bedrock
    // models (Claude Sonnet 4.5) are not callable by bare model id; they require
    // an inference profile. The policy therefore allows InvokeModel on:
    //   - the inference profile ARN (in this account/region), and
    //   - the underlying foundation-model ARNs in the US member regions the
    //     `us.` profile routes to (us-east-1, us-east-2, us-west-2).
    const usRegions = ["us-east-1", "us-east-2", "us-west-2"];
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          this.formatArn({
            service: "bedrock",
            region: PRIMARY_REGION,
            resource: "inference-profile",
            resourceName: EXPLORER_MODEL_ID,
          }),
          ...usRegions.map((r) =>
            this.formatArn({
              service: "bedrock",
              account: "",
              region: r,
              resource: "foundation-model",
              resourceName: EXPLORER_FOUNDATION_MODEL,
            })
          ),
        ],
      })
    );

    // --- Logs Lambda (read-only, allow-listed groups) ----------------------
    const logsFn = new lambda.Function(this, "ExplorerLogsFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(props.lambdaBundleDir, "logs")),
      timeout: Duration.seconds(29),
      memorySize: 256,
      environment: {
        ALLOWED_LOG_GROUPS: props.allowedLogGroupNames.join(","),
      },
      logGroup: new logs.LogGroup(this, "ExplorerLogsFnLogs", {
        logGroupName: "/claimclarify/explorer/logs",
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description: "ClaimClarify Explorer logs Lambda (read-only, allow-listed groups)",
    });
    // Read-only CloudWatch Logs. The actual log-CONTENT reads
    // (FilterLogEvents/GetLogEvents/DescribeLogStreams) are scoped to the
    // allow-listed group ARNs only — students can never read any other group's
    // contents. DescribeLogGroups is an account-level list operation that does
    // not support per-group resource scoping, so it is granted on `*`; it only
    // returns group metadata (names), never log content. The handler further
    // filters results to the allow-list.
    // Grant on BOTH ARN forms per group: FilterLogEvents acts on the bare
    // `log-group:<name>` resource, while GetLogEvents/DescribeLogStreams act on
    // the `log-group:<name>:*` (log-stream) form. Including both keeps the
    // read tightly scoped to exactly the allow-listed groups.
    // CloudWatch Logs ARNs use the COLON resource-name format:
    // `arn:aws:logs:<region>:<account>:log-group:<name>` (and `:<name>:*` for
    // the stream form). Using the default (slash) format produces an invalid
    // `log-group/<name>` ARN that never matches, so pin COLON_RESOURCE_NAME.
    const logGroupArns = props.allowedLogGroupNames.flatMap((name) => [
      this.formatArn({
        service: "logs",
        region: PRIMARY_REGION,
        resource: "log-group",
        resourceName: name,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
      this.formatArn({
        service: "logs",
        region: PRIMARY_REGION,
        resource: "log-group",
        resourceName: `${name}:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    ]);
    logsFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadAllowedLogGroupContent",
        actions: [
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:DescribeLogStreams",
        ],
        resources: logGroupArns,
      })
    );
    logsFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ListLogGroupMetadataOnly",
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      })
    );

    // --- API Gateway HTTP API: /api/chat + /api/logs -----------------------
    const httpApi = new apigwv2.CfnApi(this, "ExplorerApi", {
      name: "ClaimClarify-Explorer-Api",
      protocolType: "HTTP",
      description: "ClaimClarify Explorer API (chat + logs)",
    });

    const addRoute = (
      idPrefix: string,
      routeKey: string,
      fn: lambda.Function
    ): void => {
      fn.addPermission(`${idPrefix}Invoke`, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        action: "lambda:InvokeFunction",
        sourceArn: this.formatArn({
          service: "execute-api",
          resource: httpApi.ref,
          resourceName: "*/*/*",
        }),
      });
      const integration = new apigwv2.CfnIntegration(this, `${idPrefix}Integration`, {
        apiId: httpApi.ref,
        integrationType: "AWS_PROXY",
        integrationUri: fn.functionArn,
        payloadFormatVersion: "2.0",
        integrationMethod: "POST",
      });
      new apigwv2.CfnRoute(this, `${idPrefix}Route`, {
        apiId: httpApi.ref,
        routeKey,
        target: `integrations/${integration.ref}`,
      });
    };

    addRoute("Chat", "POST /api/chat", chatFn);
    addRoute("Logs", "GET /api/logs", logsFn);

    new apigwv2.CfnStage(this, "ExplorerApiStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });

    const apiEndpointHost = `${httpApi.ref}.execute-api.${PRIMARY_REGION}.amazonaws.com`;

    // --- CloudFront: static from S3 (OAC), /api/* to the HTTP API ----------
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    });
    const apiOrigin = new origins.HttpOrigin(apiEndpointHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    const useCustomDomain =
      props.viewerCertificate !== undefined && props.domainName !== undefined;

    this.distribution = new cloudfront.Distribution(this, "ExplorerDistribution", {
      comment: "ClaimClarify Explorer: static UI + /api/* to Explorer API",
      defaultRootObject: "index.html",
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      ...(useCustomDomain
        ? {
            certificate: props.viewerCertificate,
            domainNames: [props.domainName as string],
          }
        : {}),
    });

    // --- Deploy static site + knowledge doc into the bucket ----------------
    new s3deploy.BucketDeployment(this, "ExplorerSiteDeployment", {
      sources: [s3deploy.Source.asset(props.webAssetPath)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    // --- DNS alias explorer.awsteach.com -> CloudFront ---------------------
    if (props.hostedZoneId !== undefined && props.domainName !== undefined) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "ExplorerZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: hostedZoneName,
      });
      const target = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      );
      new route53.ARecord(this, "ExplorerDnsRecord", {
        zone,
        recordName: `${props.domainName}.`,
        target,
        comment: "ClaimClarify Explorer -> CloudFront",
      });
      new route53.AaaaRecord(this, "ExplorerDnsRecordAaaa", {
        zone,
        recordName: `${props.domainName}.`,
        target,
        comment: "ClaimClarify Explorer (IPv6) -> CloudFront",
      });
    }
  }
}
