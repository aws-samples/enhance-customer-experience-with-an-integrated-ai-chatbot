// Copyright Amazon.com Inc. or its affiliates.

export const strToNum = (str: string | undefined): number | undefined => {
  const num = Number(str)
  return Number.isSafeInteger(num) ? num : undefined
}
