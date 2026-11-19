import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { OrganizationId, UserId } from "./submission.id.ts";

export const Reviewer = Schema.Struct({
  userId: UserId,
  organizations: Schema.Array(OrganizationId),
});
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
