// Copyright Amazon.com Inc. or its affiliates.

import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi" // ES Modules import
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { KendraClient, RetrieveCommand } from "@aws-sdk/client-kendra"
import type { SQSHandler } from "aws-lambda"
import { randomUUID } from "node:crypto"
import {BedrockRuntimeClient, ConverseStreamCommand, ConverseCommandInput, Message} from '@aws-sdk/client-bedrock-runtime';

import { GENERATION_PROMPT } from "./src/prompts"
import type { RagMessage, RetrievalResult, Thread, WsMessage } from "./src/types"
import { aggregateReferences, getThreadDetail, putThreadMetadata, putThreadTurn } from "./src/threads"

const { APIGW_ENDPOINT_URL = "", KENDRA_INDEX_ID = "", MODEL_ID = "", MODEL_REGION = "", GUARDRAIL_ID = "" } = process.env

const client = new BedrockRuntimeClient({region: MODEL_REGION});

//User can edit the inference parameters given below based on his/her requirement
const MEMORY_TURNS = 10

const MAX_TOKENS = 2000
const TOP_P = 0.99
const TEMPERATURE = 0.2
const STOP_SEQUENCES = ["Human: ", "Assistant: "]

const CLIENT_APIGW = new ApiGatewayManagementApiClient({
  endpoint: APIGW_ENDPOINT_URL,
})
const CLIENT_DDB = new DynamoDBClient()
const CLIENT_KENDRA = new KendraClient()

const createNewThread = async (userId: string, question: string): Promise<Thread> => {
  const threadId = randomUUID()
  const metadata = await putThreadMetadata(CLIENT_DDB, userId, threadId, question)
  return { metadata, turns: [] }
}

const getOrCreateThread = async (userId: string, question: string, threadId?: string): Promise<Thread | undefined> => {
  if (threadId === undefined) {
    // If threadId is not specified, create a new one.
    return await createNewThread(userId, question)
  }

  // If threadId is specified, verify it exists and belongs to the logged-in user. Otherwise, return an error.
  return await getThreadDetail(CLIENT_DDB, userId, threadId, undefined, MEMORY_TURNS)
}

const postWsMessage = async (connectionId: string, message: WsMessage): Promise<void> => {
  await CLIENT_APIGW.send(
    new PostToConnectionCommand({
      Data: Buffer.from(JSON.stringify(message)),
      ConnectionId: connectionId,
    }),
  )
}

const retrieve = async (question: string): Promise<RetrievalResult[]> => {
  const res = await CLIENT_KENDRA.send(
    new RetrieveCommand({
      IndexId: KENDRA_INDEX_ID,
      QueryText: question,
    }),
  )

  return (
    res.ResultItems?.map((i) => {
      return {
        // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
        text: i.Content!,
        // biome-ignore lint/style/noNonNullAssertion: Throwing an error is an expected behavior if this field does not exist.
        s3Uri: i.DocumentId!,
        page: i.DocumentAttributes?.filter((a) => a.Key === "_excerpt_page_number").pop()?.Value?.LongValue,
        // Score is not available from Retrieve command when searching non-English text.
      }
    }) ?? []
  )
}

const buildLlmMessages = (
  question: string,
  retrievalResults: RetrievalResult[],
  thread: Thread,
): { system_: string; messages_: Message[] } => {
  const referenceItems = retrievalResults.map((r) => {
    const filename = r.s3Uri.split("/").pop()
    return `
    <document_name>${filename}</document_name>
    <text>${r.text}</text>
`
  })
  const references = `
  <reference>
${referenceItems.join("\n  </reference>\n  <reference>\n")}
  </reference>
`
  const system_ = GENERATION_PROMPT.replace("__REFERENCES__", references)

  // `as const` is required for the typescript compiler to detect this is an array of MessageParam.
  const messages_ = [
    ...thread.turns.flatMap((t) => [
      { role: "user" as const, content: [{ text: t.userQuestion }]},
      { role: "assistant" as const, content: [{ text: t.llmAnswer }]},
    ]),
    { role: "user" as const, content: [{ text: question }]},
  ]

  return { system_, messages_ }
}

const generate = async (
  question: string,
  retrievalResults: RetrievalResult[],
  thread: Thread,
  connectionId: string,
): Promise<string> => {
  const { system_, messages_ } = buildLlmMessages(question, retrievalResults, thread)

  // biome-ignore lint/suspicious/noExplicitAny: The content of this promise is not a subject of interest.
  let previousPromise: Promise<any> = Promise.resolve()
  
  const input: ConverseCommandInput = {
    system: [{ 
      text: system_,
    }],
    inferenceConfig: {
        maxTokens: MAX_TOKENS,
        stopSequences: STOP_SEQUENCES,
        temperature: TEMPERATURE,
        topP: TOP_P
    },
    messages: messages_,
    modelId: MODEL_ID,
    guardrailConfig: {
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: 'DRAFT',
      trace: "enabled",
    }
  }
  const command = new ConverseStreamCommand(input);
  const response = await client.send(command);

  let answer = "";
  const streams=response.stream
  if(streams){
    for await (const event of streams) {
      if(event.contentBlockDelta != undefined)
      {
        if(event.contentBlockDelta.delta != undefined){
          const ans = event.contentBlockDelta.delta.text
          if(ans){
            answer+=ans
            previousPromise = previousPromise.then(() =>
              postWsMessage(connectionId, {
               type: "chunk",
               chunk: ans
              }),
            )
          }
        }
        console.log("receieved answer", event);    
      }

      if(event.messageStop){
        await previousPromise
      }
    }
  }

  return answer
}

export const handler: SQSHandler = async (event, _): Promise<void> => {
  console.debug("received event: ", JSON.stringify(event))
  const message: RagMessage = JSON.parse(event.Records[0].body)

  const { connectionId, threadId, question, userId } = message

  try {
    const thread = await getOrCreateThread(userId, question, threadId)
    if (thread) {
      await postWsMessage(connectionId, {
        type: "ack",
        threadId: thread.metadata.threadId,
      })
    } else {
      await postWsMessage(connectionId, {
        type: "error",
        error: "THREAD_NOT_FOUND",
      })
      return
    }

    // Retrieve the knowledge source.
    const retrievalResults = await retrieve(question)
    console.info("Retrieved results  ", retrievalResults)
    console.info(`Retrieved ${retrievalResults.length} reference texts.`)

    // Generate an answer.
    const answer = await generate(question, retrievalResults, thread, connectionId)

    // To minimize answer latency, send retrieved texts to the client after completing answer generation.
    await postWsMessage(connectionId, {
      type: "references",
      references: aggregateReferences(retrievalResults),
    })

    // Send `eos` symbol.
    await postWsMessage(connectionId, {
      type: "eos",
    })

    // Save the new turn.
    await putThreadTurn(CLIENT_DDB, userId, thread.metadata, GENERATION_PROMPT, question, answer, retrievalResults)
  } catch (e) {
    // Error handlings.
    if (e instanceof GoneException) {
      console.info("Client gone.")
    } else {
      console.error(e)
      try {
        await postWsMessage(connectionId, {
          type: "error",
          error: "INTERNAL_SERVER_ERROR",
        })
      } catch {
        // Just do nothing.
      }
    }
  }
}
