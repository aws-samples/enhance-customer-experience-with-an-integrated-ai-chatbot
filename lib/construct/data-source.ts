// Copyright Amazon.com Inc. or its affiliates.

import { CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib"
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam"
import { CfnDataSource, CfnIndex } from "aws-cdk-lib/aws-kendra"
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket, ObjectOwnership } from "aws-cdk-lib/aws-s3"
import { NagSuppressions } from "cdk-nag"
import { kebabCase } from "change-case"
import { Construct } from "constructs"

export interface DataSourceProps {
  readonly stackName: string
  readonly logBucket: IBucket
}

export class DataSource extends Construct {
  public readonly dataSourceBucket: Bucket
  public readonly kendraIndexArn: string
  public readonly kendraIndexId: string

  constructor(scope: Construct, id: string, props: DataSourceProps) {
    super(scope, id)

    const stack = Stack.of(this)
    const indexRole = new Role(this, "KendraIndexRole", {
      assumedBy: new ServicePrincipal("kendra.amazonaws.com"),
      inlinePolicies: {
        KendraDefault: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["cloudwatch:PutMetricData"],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "cloudwatch:namespace": "AWS/Kendra",
                },
              },
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["logs:DescribeLogGroups"],
              resources: ["*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["logs:CreateLogGroup"],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/kendra/*`],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/kendra/*:log-stream:*`],
            }),
          ],
        }),
      },
      roleName: `${props.stackName}KendraIndexRole`,
    })

    const index = new CfnIndex(this, "Kendra", {
      name: `${props.stackName}KendraIndex`,
      edition: "DEVELOPER_EDITION",
      roleArn: indexRole.roleArn,
    })
    this.kendraIndexArn = index.attrArn
    this.kendraIndexId = index.attrId

    this.dataSourceBucket = new Bucket(this, "Bucket", {
      autoDeleteObjects: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: `${kebabCase(props.stackName)}-data-source-${stack.account}`,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      serverAccessLogsBucket: props.logBucket,
      serverAccessLogsPrefix: "s3/data-source-bucket/",
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      versioned: true,
    })

    const s3DataSourceRole = new Role(this, "DataSourceRole", {
      assumedBy: new ServicePrincipal("kendra.amazonaws.com"),
      inlinePolicies: {
        KendraDefault: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["s3:ListBucket"],
              resources: [`arn:aws:s3:::${this.dataSourceBucket.bucketName}`],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["s3:GetObject"],
              resources: [`arn:aws:s3:::${this.dataSourceBucket.bucketName}/*`],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["kendra:BatchPutDocument", "kendra:BatchDeleteDocument"],
              resources: [index.attrArn],
            }),
          ],
        }),
      },
    })

    const s3DataSource = new CfnDataSource(this, "S3DataSource", {
      indexId: index.attrId,
      name: `${props.stackName}KendraS3DataSource`,
      type: "S3",
      dataSourceConfiguration: {
        s3Configuration: {
          bucketName: this.dataSourceBucket.bucketName,
          documentsMetadataConfiguration: {
            s3Prefix: "metadata",
          },
        },
      },
      languageCode: "en",
      roleArn: s3DataSourceRole.roleArn,
    })
    s3DataSource.addDependency(index)

    new CfnOutput(this, "DataSourceBucketLink", {
      value: `https://s3.console.aws.amazon.com/s3/buckets/${this.dataSourceBucket.bucketName}?region=${stack.region}`,
      description: "Link to Data Source Bucket",
    })

    NagSuppressions.addResourceSuppressions(
      this.dataSourceBucket,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The IAM policy exactly follows the guidance in the AWS officail doc, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      indexRole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "The IAM policy exactly follows the guidance in the AWS officail doc, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      s3DataSourceRole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "The use of asterisk here is not overly permissive because the s3 connector must be able to read any files in the bucket.",
        },
      ],
      true,
    )
  }
}
