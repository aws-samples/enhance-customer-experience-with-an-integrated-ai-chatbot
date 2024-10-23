// Copyright Amazon.com Inc. or its affiliates.

import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib"
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3"
import { NagSuppressions } from "cdk-nag"
import { kebabCase } from "change-case"
import type { Construct } from "constructs"

import { Auth } from "./construct/auth"
import { DataSource } from "./construct/data-source"
import { Rag } from "./construct/rag"
import { ChatHistory } from "./construct/chat-history"
import * as s3 from "aws-cdk-lib/aws-s3"

export interface RagBlogCdkStackProps extends StackProps {
  readonly projectName: string
  readonly cognitoDomainPrefix: string
  readonly frontendDomain: string | undefined
  readonly modelId: string
  readonly modelRegion: string
}

export class RagBlogCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: RagBlogCdkStackProps) {
    super(scope, id, props)

    const stackName = `${props?.projectName}Backend`

    const logBucket = new Bucket(this, "LogBucket", {
      autoDeleteObjects: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: `${kebabCase(stackName)}-log-backend-${this.account}`,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      versioned: true,
    })

    const bedrockLogBucket = new Bucket(this, "BedrockLogBucket", {
      autoDeleteObjects: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: `${kebabCase(stackName)}-bedrock-log-${this.account}`,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      versioned: true,
    })
    
    const bedrocklogPolicy = new s3.CfnBucketPolicy(this, "BucketPolicy", {
      bucket: bedrockLogBucket.bucketName,
      policyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:Putobject',
            Principal: {
              Service: 'bedrock.amazonaws.com',
            },
            Resource: [`arn:aws:s3:::${bedrockLogBucket.bucketName}/AWSLogs/${this.account}/BedrockModelInvocationLogs/*`],
            Condition: {
              StringEquals: {
                "aws:SourceAccount": `${this.account}`,
              },
              ArnLike: {
                "aws:SourceArn": `arn:aws:bedrock:${props.modelRegion}:${this.account}:*`,
              },
            },
          },
        ],
        Version: '2012-10-17',
      },
    });

    bedrocklogPolicy.node.addDependency(bedrockLogBucket)

    const auth = new Auth(this, "Auth", {
      stackName,
      cognitoDomainPrefix: props.cognitoDomainPrefix,
      frontendDomain: props.frontendDomain,
    })

    const chatHistory = new ChatHistory(this, "ChatHistory", {
      stackName,
    })

    const dataSource = new DataSource(this, "DataSource", {
      stackName,
      logBucket,
    })

    new Rag(this, "Rag", {
      stackName,
      chatHistoryTable: chatHistory.chatHistoryTable,
      dataSourceBucket: dataSource.dataSourceBucket,
      kendraIndexArn: dataSource.kendraIndexArn,
      kendraIndexId: dataSource.kendraIndexId,
      apiAuthFn: auth.apiAuthFn,
      modelId: props.modelId,
      modelRegion: props.modelRegion,
      bedrockLogBucket,
      bedrocklogPolicy,
    })

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "This is a demo solution, so no need to log data to S3",
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "This is a demo solution, so no need to log data to S3",
        },
        {
          id: "AwsSolutions-S1",
          reason: "This is a demo solution, so no need to log data to S3",
        },
        {
          id: "AwsSolutions-S10",
          reason: "This is a demo solution, so no need to enable https traffic for S3",
        },
      ],
      true,
    )
  }
}
