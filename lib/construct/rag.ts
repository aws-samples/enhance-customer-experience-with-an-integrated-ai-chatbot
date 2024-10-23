// Copyright Amazon.com Inc. or its affiliates.

import { CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib"
import { Effect, PolicyStatement} from "aws-cdk-lib/aws-iam"
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2"
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers"
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations"
import { AttributeType, Billing, TableV2, TableEncryptionV2 } from "aws-cdk-lib/aws-dynamodb"
import { type IFunction, Runtime } from "aws-cdk-lib/aws-lambda"
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources"
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs"
import type { IBucket } from "aws-cdk-lib/aws-s3"
import { Queue } from "aws-cdk-lib/aws-sqs"
import { NagSuppressions } from "cdk-nag"
import { Construct, Dependable } from "constructs"
import { Provider } from "aws-cdk-lib/custom-resources";
import * as s3 from "aws-cdk-lib/aws-s3"
import { CfnGuardrail } from "aws-cdk-lib/aws-bedrock";

const RAG_TIMEOUT_SECONDS = 120

export interface RagProps {
  readonly stackName: string
  readonly chatHistoryTable: TableV2
  readonly dataSourceBucket: IBucket
  readonly kendraIndexArn: string
  readonly kendraIndexId: string
  readonly apiAuthFn: IFunction
  readonly modelId: string
  readonly modelRegion: string
  readonly bedrockLogBucket: IBucket
  readonly bedrocklogPolicy: s3.CfnBucketPolicy
}

export class Rag extends Construct {
  constructor(scope: Construct, id: string, props: RagProps) {
    super(scope, id)

    const connectionTable = new TableV2(this, "ConnectionTable", {
      partitionKey: {
        name: "ConnectionId",
        type: AttributeType.STRING,
      },
      billing: Billing.onDemand(),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: `${props.stackName}Connection`,
      encryption: TableEncryptionV2.awsManagedKey(),
    })

    const customFn = new NodejsFunction(this, "CustomFn", {
      entry: "lib/lambda/customFn.ts",
      environment: {
        logBucketName: props.bedrockLogBucket.bucketName
      },
      functionName: `${props.stackName}CustomFn`,
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          resources: ["*"],
          actions: ["bedrock:PutModelInvocationLoggingConfiguration"],
        }),
      ],
      retryAttempts: 0,
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(RAG_TIMEOUT_SECONDS),
    })

    const customResourceProvider = new Provider(this, "customResourceProvider", {
      onEventHandler: customFn,
    });
    
    const customResourceResult = new CustomResource(this, "customResourceResult", {
      serviceToken: customResourceProvider.serviceToken,
    });

    customResourceResult.node.addDependency(props.bedrocklogPolicy)

    // Guardrail properties can be modified as per your requirement
    const guardrailBedrock = new CfnGuardrail(this, 'guardrailBedrock', {
      blockedInputMessaging: 'Guardrail applied based on user input.',
      blockedOutputsMessaging: 'Guardrail applied based on model output.',
      name: 'bedrock-guardrail-cdk',
      
      contentPolicyConfig: {
        filtersConfig: [{
          inputStrength: 'HIGH',
          outputStrength: 'HIGH',
          type: 'SEXUAL'
        },
        {
          inputStrength: 'HIGH',
          outputStrength: 'HIGH',
          type: 'VIOLENCE'
        },
        {
          inputStrength: 'HIGH',
          outputStrength: 'HIGH',
          type: 'HATE'
        },
        {
          inputStrength: 'HIGH',
          outputStrength: 'HIGH',
          type: 'MISCONDUCT'
        },
        {
          inputStrength: 'NONE',
          outputStrength: 'NONE',
          type: 'PROMPT_ATTACK'
        }],
      },
      description: 'My Bedrock Guardrail created with AWS CDK',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [{
          action : 'BLOCK',
          type : 'EMAIL'
        },
        {
          action : 'BLOCK',
          type : 'PASSWORD'
        },
        {
          action : 'ANONYMIZE',
          type : 'IP_ADDRESS'
        }],
      },
    });

    const GUARDRAIL_ARN = guardrailBedrock.attrGuardrailArn
    
    const wsApi = new WebSocketApi(this, "WsApi", {
      apiName: `${props.stackName}RagWsApi`,
    })
    const stage = new WebSocketStage(this, "WsApiStage", {
      stageName: "dev",
      webSocketApi: wsApi,
      autoDeploy: true,
    })

    const queue = new Queue(this, "QuestionQueue", {
      enforceSSL: true,
      receiveMessageWaitTime: Duration.seconds(20),
      visibilityTimeout: Duration.seconds(RAG_TIMEOUT_SECONDS * 6),
    })

    const wsApiDomain = `${wsApi.apiId}.execute-api.${Stack.of(this).region}.amazonaws.com`
    const ragFn = new NodejsFunction(this, "RagFn", {
      bundling: {
        format: OutputFormat.ESM,
      },
      entry: "lib/lambda/rag.ts",
      environment: {
        APIGW_ENDPOINT_URL: `https://${wsApiDomain}/${stage.stageName}`,
        CHAT_HISTORY_TABLE_NAME: props.chatHistoryTable.tableName,
        KENDRA_INDEX_ID: props.kendraIndexId,
        MODEL_ID: props.modelId,
        MODEL_REGION: props.modelRegion,
        GUARDRAIL_ID: GUARDRAIL_ARN,
      },
      events: [
        new SqsEventSource(queue, {
          batchSize: 1,
        }),
      ],
      functionName: `${props.stackName}RagFn`,
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          resources: [props.kendraIndexArn],
          actions: ["kendra:Retrieve"],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [`arn:aws:bedrock:${props.modelRegion}::foundation-model/${props.modelId}`],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["bedrock:ApplyGuardrail"],
          resources: [GUARDRAIL_ARN],
        }),
      ],
      retryAttempts: 0,
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(RAG_TIMEOUT_SECONDS),
    })
    wsApi.grantManageConnections(ragFn)
    props.chatHistoryTable.grantReadWriteData(ragFn)
    props.dataSourceBucket.grantRead(ragFn)

    const wsFn = new NodejsFunction(this, "WsFn", {
      bundling: {
        format: OutputFormat.ESM,
      },
      entry: "lib/lambda/websocket.ts",
      environment: {
        CONNECTION_TABLE_NAME: connectionTable.tableName,
        QUEUE_URL: queue.queueUrl,
      },
      functionName: `${props.stackName}WsFn`,
      retryAttempts: 0,
      runtime: Runtime.NODEJS_20_X,
    })
    connectionTable.grantReadWriteData(wsFn)
    queue.grantSendMessages(wsFn)

    wsApi.addRoute("$connect", {
      integration: new WebSocketLambdaIntegration("ConnectIntegration", wsFn),
      authorizer: new WebSocketLambdaAuthorizer("Authorizer", props.apiAuthFn, {
        authorizerName: `${props.stackName}WebSocketAuthorizer`,
        identitySource: ["route.request.querystring.token"],
      }),
    })
    wsApi.addRoute("$disconnect", {
      integration: new WebSocketLambdaIntegration("DisconnectIntegration", wsFn),
    })
    wsApi.addRoute("$default", {
      integration: new WebSocketLambdaIntegration("DefaultIntegration", wsFn),
    })

    NagSuppressions.addResourceSuppressions(queue, [
      {
        id: "AwsSolutions-SQS3",
        reason: "DLQ is not requried because failed questions can just be ignored.",
      },
    ])
    NagSuppressions.addResourceSuppressions(
      ragFn,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      ragFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      customFn,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      customFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      wsApi,
      [
        {
          id: "AwsSolutions-APIG4",
          reason: "Authentication cannot be configured on $disconnect and $default route of WS API.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      wsFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
    NagSuppressions.addResourceSuppressions(
      stage,
      [
        {
          id: "AwsSolutions-APIG1",
          reason: "access log not required.",
        },
      ],
      true,
    )
  }
}
