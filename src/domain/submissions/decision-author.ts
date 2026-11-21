import { Schema } from "effect";

import { ApiTokenId, UserId } from "./submission.id.ts";

/** The author fields of a review decision taken by a signed-in account. */
export const ByReviewer = { reviewerId: UserId, apiTokenId: Schema.optionalKey(Schema.Never) };

/** The author fields of a review decision taken with an API token. */
export const ByApiToken = { apiTokenId: ApiTokenId, reviewerId: Schema.optionalKey(Schema.Never) };

/** Who accepted or dismissed a quarantined submission: an account or an API token, never both. */
export const DecisionAuthor = Schema.Union([Schema.Struct(ByReviewer), Schema.Struct(ByApiToken)]);
export type DecisionAuthor = typeof DecisionAuthor.Type;
