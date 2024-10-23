// Copyright Amazon.com Inc. or its affiliates.

import { BedrockClient, PutModelInvocationLoggingConfigurationCommand } from "@aws-sdk/client-bedrock";
import {
    CdkCustomResourceEvent,
    CdkCustomResourceResponse,
    Context,
  } from 'aws-lambda';

const {logBucketName = ""} = process.env

export const handler = async (event: CdkCustomResourceEvent, context: Context, ): Promise<CdkCustomResourceResponse> => {
    console.log('Lambda is invoked with:' + JSON.stringify(event));
  
    const response: CdkCustomResourceResponse = {
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: context.functionName
    };

    if (event.RequestType == 'Delete') {
        response.Status = 'SUCCESS';
        response.Data = { Result: 'None' };
        return response;
    }

    try {
        const client = new BedrockClient(process.config);
        const input = { 
          loggingConfig: { 
            s3Config: {
                bucketName: logBucketName, 
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: true,
            embeddingDataDeliveryEnabled: true,
          },
        };
        
        const command = new PutModelInvocationLoggingConfigurationCommand(input);
        const res = await client.send(command);
        response.Status = 'SUCCESS';
        response.Data = { Result: 'Added Model Invocation logging' };
        return response;
    }
    catch (error) {
        if (error instanceof Error) {
          response.Reason = error.message;
        }
        response.Status = 'FAILED';
        response.Data = { Result: error };
        return response;
    }
}