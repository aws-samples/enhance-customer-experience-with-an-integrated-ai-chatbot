// Copyright Amazon.com Inc. or its affiliates.

export interface MessageAck {
  type: "ack"
  threadId: string
}

export interface MessageReferences {
  type: "references"
  references: Reference[]
}

export interface MessageChunk {
  type: "chunk"
  chunk: string
}

export interface MessageEos {
  type: "eos"
}

export interface MessageError {
  type: "error"
  error: "THREAD_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
}

export interface RagMessage {
  type: "question"
  connectionId: string
  threadId?: string
  question: string
  userId: string
}

export interface Reference {
  filename: string
  s3Path: string
  hits: ReferenceHit[]
}

export interface ReferenceHit {
  text: string
  score?: number
  page?: number
}

export interface RetrievalResult {
  text: string
  s3Uri: string
  score?: number
  page?: number
}

export interface Thread {
  metadata: ThreadMetadata
  turns: ThreadTurn[]
}

export interface ThreadMetadata {
  threadId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ThreadTurn {
  userQuestion: string
  llmAnswer: string
  createdAt: number
  references: Reference[]
}

export interface UserMessage {
  type: "question"
  threadId?: string
  input: string
}

export type WsMessage = MessageAck | MessageChunk | MessageReferences | MessageEos | MessageError
