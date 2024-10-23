#!/usr/bin/env node

// Copyright Amazon.com Inc. or its affiliates.

import "source-map-support/register"
import { App, Aspects } from "aws-cdk-lib"
import { AwsSolutionsChecks } from "cdk-nag"
import { RagBlogCdkStack } from "../lib/rag-blog-cdk-stack"

const app = new App()
const PROJECT_NAME = app.node.tryGetContext("projectName")
const MODEL_ID = app.node.tryGetContext("modelId")
const MODEL_REGION = app.node.tryGetContext("modelRegion")
const FRONTEND_DOMAIN: string | undefined = app.node.tryGetContext("frontendDomain")

new RagBlogCdkStack(app, "RagBlogCdkStack", {
  env: {
    region: MODEL_REGION,
  },
  projectName: PROJECT_NAME,
  cognitoDomainPrefix: PROJECT_NAME,
  frontendDomain: FRONTEND_DOMAIN,
  modelId: MODEL_ID,
  modelRegion: MODEL_REGION,
})

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
