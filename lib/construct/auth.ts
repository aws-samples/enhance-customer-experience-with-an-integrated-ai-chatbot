// Copyright Amazon.com Inc. or its affiliates.

import { RemovalPolicy, Stack, CfnOutput } from "aws-cdk-lib"
import { AdvancedSecurityMode, type IUserPool, UserPool } from "aws-cdk-lib/aws-cognito"
import { type IFunction, Runtime } from "aws-cdk-lib/aws-lambda"
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs"
import { Construct } from "constructs"
import { NagSuppressions } from "cdk-nag"

const DEV_FRONTEND_DOMAIN = "http://localhost:3000"

export interface AuthProps {
  readonly stackName: string
  readonly cognitoDomainPrefix: string
  readonly frontendDomain?: string
}

export class Auth extends Construct {
  readonly userPool: IUserPool
  readonly apiAuthFn: IFunction

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id)
    
    //User can change the password policy according to their requirements
    this.userPool = new UserPool(this, "UserPool", {
      advancedSecurityMode: AdvancedSecurityMode.ENFORCED,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
      },
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      userPoolName: `${props.stackName}UserPool`,
    })
    const domain = this.userPool.addDomain("cognitoDomain", {
      cognitoDomain: {
        domainPrefix: `${props.cognitoDomainPrefix}-${Stack.of(this).account}`,
      },
    })

    const callbackUrls = [props.frontendDomain ?? DEV_FRONTEND_DOMAIN]
    const client = this.userPool.addClient("Client", {
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        callbackUrls: callbackUrls,
        logoutUrls: callbackUrls,
        flows: {
          authorizationCodeGrant: true,
        },
      },
      userPoolClientName: `${props.stackName}UserPoolClient`,
    })

    this.apiAuthFn = new NodejsFunction(this, "ApiAuthFn", {
      bundling: {
        format: OutputFormat.ESM,
      },
      entry: "lib/lambda/auth-api.ts",
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        USER_POOL_CLIENT: client.userPoolClientId,
      },
      functionName: `${props.stackName}ApiAuthFn`,
      runtime: Runtime.NODEJS_20_X,
    })

    new CfnOutput(this, "CognitoDomain", {
      value: `${domain.domainName}.auth.${Stack.of(this).region}.amazoncognito.com`,
    })
    new CfnOutput(this, "CognitoUserPoolId", {
      value: this.userPool.userPoolId,
    })
    new CfnOutput(this, "CognitoClientId", {
      value: client.userPoolClientId,
    })

    NagSuppressions.addResourceSuppressions(
      this.apiAuthFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The IAM policy for this Lambda function is auto-generated with CDK, and the use of asterisk here is not overly permissive.",
        },
      ],
      true,
    )
  }
}
