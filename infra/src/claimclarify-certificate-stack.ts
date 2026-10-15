/**
 * ClaimClarify ACM certificate stack (task 19.1).
 *
 * CloudFront requires its viewer ACM certificate to live in `us-east-1`
 * (Certificate_Region), while every other ClaimClarify resource lives in the
 * Primary_Region `us-east-2` (see {@link ClaimClarifyDataStack}). This module
 * models that two-region split as a dedicated {@link ClaimClarifyCertificateStack}
 * pinned to `us-east-1` inside the same CDK app.
 *
 * ## Why a separate stack (us-east-1 placement — Req 8.2, 8.4)
 *
 * A CloudFront distribution's `viewerCertificate` must reference an ACM
 * certificate in `us-east-1`; ACM certificates are regional. Because the main
 * app stack is region-pinned to `us-east-2`, the certificate cannot be defined
 * there. Rather than reach for the deprecated `DnsValidatedCertificate` (which
 * provisions a Lambda custom resource to create a cross-region cert and is no
 * longer recommended), this uses the modern, first-class CDK pattern: a second
 * `Stack` whose `env.region` is `us-east-1`, created in the same `App`. The
 * CloudFront stack (task 19.2) consumes {@link certificate} across regions via
 * `crossRegionReferences: true`, which CDK resolves with SSM-parameter exports
 * and reader custom resources at deploy time — no AWS credentials are needed to
 * `cdk synth`.
 *
 * ## Ordering / validation gate (Req 8.2, 8.3)
 *
 * The certificate uses DNS validation; the validation CNAME is published into
 * the existing `awsteach.com` Hosted_Zone alongside the App_DNS_Record in
 * task 19.3. A DNS-validated `acm.Certificate` resource does not reach
 * `CREATE_COMPLETE` in CloudFormation until ACM observes the validation CNAME
 * and the certificate transitions to ISSUED. Because the CloudFront
 * distribution (task 19.2) references this certificate's ARN, CloudFormation
 * places an implicit dependency on the certificate: CloudFront is only
 * provisioned after the certificate is issued and validated (Req 8.2). If
 * validation never completes, the certificate's stack event stalls and then
 * fails, halting the deployment and surfacing the failing certificate's logical
 * id / ARN in the stack events — exactly the certificate-validation failure the
 * requirement calls for (Req 8.3). This gate is inherent to DNS-validated ACM
 * certificates; no custom wait condition is required.
 *
 * The certificate reference is exposed as the public {@link certificate}
 * property so the CloudFront stack in task 19.2 can attach it as its viewer
 * certificate (Req 8.4).
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

/**
 * The Certificate_Region. CloudFront only accepts a viewer ACM certificate
 * that resides in `us-east-1` (Req 8.2, 8.4).
 */
export const CERTIFICATE_REGION = "us-east-1";

/** The existing public Hosted_Zone the App_DNS_Record is published into. */
export const HOSTED_ZONE_NAME = "awsteach.com";

/**
 * The App_DNS_Record domain the CloudFront distribution answers on. Distinct
 * from the pre-existing `www.awsteach.com` record (Req 9.2); the certificate is
 * issued for this name so CloudFront can serve it over TLS.
 */
export const APP_DOMAIN_NAME = "ohio.awsteach.com";

/** Props for {@link ClaimClarifyCertificateStack}. */
export interface ClaimClarifyCertificateStackProps extends StackProps {
  /**
   * The App_DNS_Record fully-qualified domain the certificate is issued for.
   * Defaults to {@link APP_DOMAIN_NAME} (`ohio.awsteach.com`).
   */
  readonly appDomainName?: string;

  /**
   * The existing Hosted_Zone name used for DNS validation. Defaults to
   * {@link HOSTED_ZONE_NAME} (`awsteach.com`).
   */
  readonly hostedZoneName?: string;

  /**
   * The id of the existing Hosted_Zone. When provided, the certificate binds
   * the imported zone so ACM DNS-validation records are created automatically
   * (hands-off issuance). When omitted (synth/tests), the certificate uses the
   * zone-less `fromDns()` form so `cdk synth` stays credential-free. Only the
   * certificate's own validation CNAME(s) for its subdomain are written; the
   * shared zone and its `www` record are never otherwise touched (Req 9.3).
   */
  readonly hostedZoneId?: string;
}

/**
 * A `us-east-1` stack that owns the CloudFront viewer certificate.
 *
 * The stack is region-pinned to {@link CERTIFICATE_REGION} and enables
 * `crossRegionReferences` so the `us-east-2` CloudFront stack (task 19.2) can
 * read {@link certificate}'s ARN across regions.
 */
export class ClaimClarifyCertificateStack extends Stack {
  /**
   * The DNS-validated ACM_Certificate for the App_DNS_Record domain, created in
   * the Certificate_Region (`us-east-1`). Exposed so the CloudFront stack
   * (task 19.2) can use it as the distribution's viewer certificate (Req 8.4).
   * CloudFront's reference to this certificate is what gates its provisioning
   * on the certificate reaching an issued+validated state (Req 8.2, 8.3).
   */
  public readonly certificate: acm.ICertificate;

  /** The fully-qualified App_DNS_Record domain the certificate covers. */
  public readonly appDomainName: string;

  /** The Hosted_Zone the DNS validation record is published into. */
  public readonly hostedZoneName: string;

  constructor(
    scope: Construct,
    id: string,
    props: ClaimClarifyCertificateStackProps = {}
  ) {
    super(scope, id, {
      ...props,
      // Pin to us-east-1 (Certificate_Region) regardless of any inherited env;
      // CloudFront viewer certificates must live here (Req 8.2, 8.4).
      env: { ...props.env, region: CERTIFICATE_REGION },
      // Allow the us-east-2 CloudFront stack to consume this certificate's ARN
      // across regions. CDK wires this with SSM exports + reader custom
      // resources at deploy time; `cdk synth` needs no AWS credentials.
      crossRegionReferences: true,
    });

    this.appDomainName = props.appDomainName ?? APP_DOMAIN_NAME;
    // The Hosted_Zone the validation CNAME lives in. The existing
    // `awsteach.com` zone is shared with an unrelated application, so this
    // deployment must never create or mutate the zone itself (Req 9.3). The
    // App_DNS_Record and its validation record are published into that zone in
    // task 19.3.
    this.hostedZoneName = props.hostedZoneName ?? HOSTED_ZONE_NAME;

    // DNS-validated ACM certificate for the App_DNS_Record domain. DNS
    // validation (CertificateValidation.fromDns) requires the validation CNAME
    // to be published in the Hosted_Zone and blocks the certificate from
    // reaching CREATE_COMPLETE until ACM marks it ISSUED — this is the inherent
    // issued+validated gate (Req 8.2) whose failure halts the deployment and
    // identifies the certificate in the stack events (Req 8.3).
    //
    // `fromDns()` is used WITHOUT binding a `route53.IHostedZone` on purpose:
    // binding a zone would require a `HostedZone.fromLookup`, which needs
    // concrete account/region context and would break credential-free
    // `cdk synth`. The zone-less form synthesizes a plain ACM certificate with
    // `ValidationMethod: DNS`; task 19.3 publishes the validation CNAME into
    // the `awsteach.com` zone alongside the App_DNS_Record (this mirrors the
    // API custom-domain certificate pattern in the compute stack).
    // When a hosted zone id is supplied (a real deploy), import the existing
    // zone read-only and bind it so ACM's DNS-validation CNAME is written
    // automatically and the certificate issues hands-off. Importing by
    // attributes emits no zone-creating/mutating resource (Req 9.3). Without an
    // id (synth/tests) fall back to the zone-less form for credential-free
    // synth.
    const validation =
      props.hostedZoneId !== undefined
        ? acm.CertificateValidation.fromDns(
            route53.HostedZone.fromHostedZoneAttributes(this, "CertZone", {
              hostedZoneId: props.hostedZoneId,
              zoneName: this.hostedZoneName,
            })
          )
        : acm.CertificateValidation.fromDns();

    this.certificate = new acm.Certificate(this, "CloudFrontCertificate", {
      domainName: this.appDomainName,
      validation,
    });
  }
}
