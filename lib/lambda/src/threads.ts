// Copyright Amazon.com Inc. or its affiliates.

import {
  type AttributeValue,
  type DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"

import type { Reference, ReferenceHit, RetrievalResult, Thread, ThreadMetadata, ThreadTurn } from "./types"
import { strToNum } from "./utils"

const { CHAT_HISTORY_TABLE_NAME = "" } = process.env

const transformThreadMetadata = (item: Record<string, AttributeValue>): ThreadMetadata => {
  return {
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    threadId: item.ThreadId!.S!,
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    title: item.Title!.S!,
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    createdAt: strToNum(item.CreatedAt!.N!)!,
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    updatedAt: strToNum(item.UpdatedAt!.N!)!,
  }
}

export const aggregateReferences = (retrievalResults: RetrievalResult[]): Reference[] => {
  const referenceMap = new Map<string, ReferenceHit[]>()
  for (const r of retrievalResults) {
    const referenceHit = {
      text: r.text,
      page: r.page,
    }
    referenceMap.get(r.s3Uri)?.push(referenceHit) ?? referenceMap.set(r.s3Uri, [referenceHit])
  }
  return Array.from(referenceMap).map(([k, v]) => ({
    filename: k.split("/").slice(-1)[0],
    s3Path: k,
    hits: v,
  }))
}

const transformThreadTurn = (item: Record<string, AttributeValue>): ThreadTurn => {
  const references = aggregateReferences(JSON.parse(item.RetrievalResults?.S ?? "[]"))
  return {
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    userQuestion: item.UserQuestion!.S!,
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    llmAnswer: item.LlmAnswer!.S!,
    // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
    createdAt: strToNum(item.CreatedAt!.N!)!,
    references: references,
  }
}

const getThreadMetadata = async (
  clientDdb: DynamoDBClient,
  userId: string,
  threadId: string,
): Promise<ThreadMetadata | undefined> => {
  const resMeta = await clientDdb.send(
    new QueryCommand({
      TableName: CHAT_HISTORY_TABLE_NAME,
      KeyConditionExpression: "UserId = :user_id AND ThreadId = :thread_id",
      FilterExpression: "Deleted <> :true",
      ExpressionAttributeValues: {
        ":user_id": { S: userId },
        ":thread_id": { S: threadId },
        ":true": { BOOL: true },
      },
      IndexName: "ThreadIdLsi",
    }),
  )

  const count = resMeta.Count ?? 0
  if (count === 0) {
    return undefined
  }
  if (count > 1) {
    throw new Error(`Duplicate thread ID: ${threadId}`)
  }

  // biome-ignore lint/style/noNonNullAssertion: Items necessarily exist because we checked the count above.
  return transformThreadMetadata(resMeta.Items![0])
}

export const putThreadMetadata = async (
  clientDdb: DynamoDBClient,
  userId: string,
  threadId: string,
  title: string,
): Promise<ThreadMetadata> => {
  const timestamp = Date.now()

  await clientDdb.send(
    new PutItemCommand({
      TableName: CHAT_HISTORY_TABLE_NAME,
      Item: {
        UserId: { S: userId },
        SortKey: { S: `meta#${timestamp}` },
        ThreadId: { S: threadId },
        Title: { S: title },
        CreatedAt: { N: timestamp.toString() },
        UpdatedAt: { N: timestamp.toString() },
      },
    }),
  )

  return {
    threadId,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export const getThreadDetail = async (
  clientDdb: DynamoDBClient,
  userId: string,
  threadId: string,
  before: number | undefined,
  limit: number,
): Promise<Thread | undefined> => {
  const metadata = await getThreadMetadata(clientDdb, userId, threadId)
  if (metadata === undefined) {
    return undefined
  }

  let keyConditionExpression = "UserId = :user_id AND "
  let expressionAttributeValues: Record<string, AttributeValue> = {
    ":turn_begin": { S: `turn#${threadId}#` },
    ":user_id": { S: userId },
  }
  if (before !== undefined) {
    keyConditionExpression += "SortKey BETWEEN :turn_begin AND :turn_end"
    expressionAttributeValues = {
      ...expressionAttributeValues,
      ":turn_end": { S: `turn#${threadId}#${before - 1}` },
    }
  } else {
    keyConditionExpression += "begins_with(SortKey, :turn_begin)"
  }
  const resTurns = await clientDdb.send(
    new QueryCommand({
      TableName: CHAT_HISTORY_TABLE_NAME,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  const turns = resTurns.Items?.map(transformThreadTurn) ?? []

  return { metadata, turns }
}

export const putThreadTurn = async (
  clientDdb: DynamoDBClient,
  userId: string,
  metadata: ThreadMetadata,
  template: string,
  question: string,
  answer: string,
  retrievalResults: RetrievalResult[],
): Promise<void> => {
  const timestamp = Date.now()

  // Put new turn item.
  await clientDdb.send(
    new PutItemCommand({
      TableName: CHAT_HISTORY_TABLE_NAME,
      Item: {
        UserId: { S: userId },
        SortKey: { S: `turn#${metadata.threadId}#${timestamp}` },
        SystemTemplate: { S: template },
        UserQuestion: { S: question },
        LlmAnswer: { S: answer },
        RetrievalResults: { S: JSON.stringify(retrievalResults) },
        CreatedAt: { N: timestamp.toString() },
      },
    }),
  )

  // Update the `UpdatedAt` attribute of the metadata item.
  await clientDdb.send(
    new UpdateItemCommand({
      TableName: CHAT_HISTORY_TABLE_NAME,
      Key: {
        UserId: { S: userId },
        SortKey: { S: `meta#${metadata.createdAt}` },
      },
      UpdateExpression: "SET UpdatedAt = :ts",
      ExpressionAttributeValues: {
        ":ts": { N: timestamp.toString() },
      },
    }),
  )
}
