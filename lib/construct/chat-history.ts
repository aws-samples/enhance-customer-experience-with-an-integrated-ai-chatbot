// Copyright Amazon.com Inc. or its affiliates.

import { RemovalPolicy } from "aws-cdk-lib"
import { AttributeType, Billing, TableV2, TableEncryptionV2 } from "aws-cdk-lib/aws-dynamodb"
import { Construct } from "constructs"

export interface ChatHistoryProps {
  readonly stackName: string
}

export class ChatHistory extends Construct {
  readonly chatHistoryTable: TableV2
  readonly httpApiId: string
  readonly httpApiDomain: string
  readonly httpApiStage: string

  constructor(scope: Construct, id: string, props: ChatHistoryProps) {
    super(scope, id)

    this.chatHistoryTable = new TableV2(this, "Table", {
      partitionKey: {
        name: "UserId",
        type: AttributeType.STRING,
      },
      billing: Billing.onDemand(),
      deletionProtection: true,
      localSecondaryIndexes: [
        {
          indexName: "ThreadIdLsi",
          sortKey: { name: "ThreadId", type: AttributeType.STRING },
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      sortKey: {
        name: "SortKey",
        type: AttributeType.STRING,
      },
      tableName: `${props.stackName}ChatHistory`,
      encryption: TableEncryptionV2.awsManagedKey(),
    })
  }
}
