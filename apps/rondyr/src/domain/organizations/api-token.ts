import { Schema } from "effect";

import { ApiTokenId } from "../submissions/submission.id.ts";

export const maxActiveApiTokens = 10;

export const maxApiTokenNameLength = 100;

export const ApiTokenInput = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maxApiTokenNameLength)),
});

export const ApiTokenSummary = Schema.Struct({
  id: ApiTokenId,
  name: ApiTokenInput.fields.name,
  suffix: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  createdAt: Schema.Int,
});

export const ApiTokenList = Schema.Array(ApiTokenSummary);
export type ApiTokenList = typeof ApiTokenList.Type;

export const CreatedApiToken = Schema.Struct({
  ...ApiTokenSummary.fields,
  token: Schema.RedactedFromValue(Schema.String),
});
