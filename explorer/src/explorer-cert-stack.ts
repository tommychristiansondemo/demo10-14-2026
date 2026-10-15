/**
 * Explorer certificate stack — the CloudFront viewer certificate in us-east-1.
 *
 * CloudFront requires its viewer ACM certificate in `us-east-1`, while the
 * Explorer app stack lives in `us-east-2`. This region-pinned stack owns the
 * DNS-validated certificate for the Explorer domain and exposes it for
 * cross-region consumption.
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export const CERT_REGION = "us-east-1";

export interface ExplorerCertStackProps extends StackProps {
  readonly domainName: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

export class ExplorerCertStack extends Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: ExplorerCertStackProps) {
    super(scope, id, {
      ...props,
      env: { ...props.env, region: CERT_REGION },
      crossRegionReferences: true,
    });

    const zoneName = props.hostedZoneName ?? "awsteach.com";
    const validation =
      props.hostedZoneId !== undefined
        ? acm.CertificateValidation.fromDns(
            route53.HostedZone.fromHostedZoneAttributes(this, "CertZone", {
              hostedZoneId: props.hostedZoneId,
              zoneName,
            })
          )
        : acm.CertificateValidation.fromDns();

    this.certificate = new acm.Certificate(this, "ExplorerCertificate", {
      domainName: props.domainName,
      validation,
    });
  }
}
