import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { ApiTokenId, OrganizationId, UserId } from "./submission.id.ts";

const organizations = Schema.Array(OrganizationId);
export const Reviewer = Schema.Union([
  Schema.Struct({ userId: UserId, apiTokenId: Schema.optionalKey(Schema.Never), organizations }),
  Schema.Struct({
    apiTokenId: ApiTokenId,
    userId: Schema.optionalKey(Schema.Never),
    organizations,
  }),
]);
export class CurrentReviewer extends Domain.RequestContext<CurrentReviewer>()(
  "Rondyr/CurrentReviewer",
  Reviewer,
) {}
export class ReviewUnauthorized extends Schema.TaggedError<
  ReviewUnauthorized,
  { readonly brand: unique symbol }
>()("ReviewUnauthorized", {}, { httpApiStatus: 401 }) {}
export class ReviewSession extends RpcMiddleware.Service<
  ReviewSession,
  { provides: CurrentReviewer }
>()("Rondyr/ReviewSession", { error: ReviewUnauthorized }) {}
