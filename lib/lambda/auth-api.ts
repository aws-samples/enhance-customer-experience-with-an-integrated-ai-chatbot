// Copyright Amazon.com Inc. or its affiliates.

import { CognitoJwtVerifier } from "aws-jwt-verify"
import type { APIGatewayIAMAuthorizerResult, APIGatewayRequestIAMAuthorizerHandlerV2 } from "aws-lambda"

const { USER_POOL_ID = "", USER_POOL_CLIENT = "" } = process.env

const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: "access",
  clientId: USER_POOL_CLIENT,
})

export const handler: APIGatewayRequestIAMAuthorizerHandlerV2 = async (event) => {
  console.debug("received event: ", JSON.stringify(event))

  try {
    const token = event.queryStringParameters?.token
    //const token = event.headers?.Authorization ?? event.headers?.authorization;
    if (token === undefined) {
      throw Error("Token is not set.")
    }
    console.info("JWT: ", token)

    const payload = await verifier.verify(token)
    console.info("Token is valid. Payload: ", JSON.stringify(payload))

    // @ts-ignore: If this authorizer is attached to a WebSocket API, @connect route is passed in methodArn, not routeArn.
    const arn = event.methodArn ?? event.routeArn
    if (arn === undefined) {
      throw Error("API endpoint arn is not set.")
    }
    const policy = allowPolicy(arn, payload.sub)
    console.info("Policy generated: ", JSON.stringify(policy))
    return policy
  } catch (e) {
    console.error("Token is not valid!")
    console.error(e)
    return denyAllPolicy()
  }
}

const denyAllPolicy = (): APIGatewayIAMAuthorizerResult => {
  return {
    principalId: "deny",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "*",
          Effect: "Deny",
          Resource: "*",
        },
      ],
    },
  }
}

const allowPolicy = (methodArn: string, sub: string): APIGatewayIAMAuthorizerResult => {
  console.debug(methodArn)
  return {
    principalId: sub,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          // FIXME fine-grained access control over routes
          // Resource: methodArn,
          Resource: "*",
        },
      ],
    },
    context: {
      userId: sub,
    },
  }
}
