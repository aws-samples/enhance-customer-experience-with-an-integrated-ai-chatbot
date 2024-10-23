// Copyright Amazon.com Inc. or its affiliates.

import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda"
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"

import type { RagMessage, UserMessage } from "./src/types"
import { DynamoDBClient, PutItemCommand, DeleteItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb"

const { QUEUE_URL = "" } = process.env
const CONNECTION_TABLE_NAME = process.env.CONNECTION_TABLE_NAME
const CLIENT_SQS = new SQSClient()
const CLIENT_DDB = new DynamoDBClient()

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const {
    body,
    requestContext: { connectionId, routeKey },
  } = event

  console.info("webscoket event", event)

  switch (routeKey) {
    case "$connect": {
      try {
        // @ts-ignore: authorizer should exist
        const userId = event.requestContext.authorizer?.userId
        console.info("authorised user id", userId)
        await CLIENT_DDB.send(
          new PutItemCommand({
            TableName: CONNECTION_TABLE_NAME,
            Item: {
              ConnectionId: { S: connectionId },
              UserId: { S: userId },
            },
          }),
        )
        return { statusCode: 200 }
      } catch (err) {
        console.error(err)
        return { statusCode: 500, body: "Connection failed." }
      }
    }

    case "$disconnect": {
      try {
        await CLIENT_DDB.send(
          new DeleteItemCommand({
            TableName: CONNECTION_TABLE_NAME,
            Key: {
              ConnectionId: { S: connectionId },
            },
          }),
        )
        return { statusCode: 200 }
      } catch (err) {
        console.error(err)
        return { statusCode: 500, body: "Connection failed." }
      }
    }

    case "$default": {
      if (body === undefined) {
        return { statusCode: 400 }
      }
      const userMessage: UserMessage = JSON.parse(body)
      const userId = (
        await CLIENT_DDB.send(
          new GetItemCommand({
            TableName: CONNECTION_TABLE_NAME,
            Key: {
              ConnectionId: { S: connectionId },
            },
          }),
        )
      ).Item?.UserId?.S
      if (userId === undefined) {
        console.error("User ID not found in connections table.")
        return { statusCode: 500, body: "Connection failed." }
      }
      const ragMessage: RagMessage = {
        type: "question",
        connectionId,
        threadId: userMessage.threadId,
        question: userMessage.input,
        userId,
      }
      const res = await CLIENT_SQS.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify(ragMessage),
        }),
      )

      return { statusCode: res.$metadata.httpStatusCode }
    }

    default: {
      throw `unexpected route key: "${routeKey}"`
    }
  }
}
