import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { allows, MemberRole, type Permission } from "../organizations/member-role.ts";
import { ApiTokenId, OrganizationId, UserId } from "./submission.id.ts";

/** The organizations of the reviewer, each with the reviewer's role in it. */
const memberships = Schema.Array(
  Schema.Struct({ organizationId: OrganizationId, role: MemberRole }),
);
export const Reviewer = Schema.Union([
  Schema.Struct({ userId: UserId, apiTokenId: Schema.optionalKey(Schema.Never), memberships }),
  Schema.Struct({
    apiTokenId: ApiTokenId,
    userId: Schema.optionalKey(Schema.Never),
    memberships,
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

/**
 * Whether the reviewer's role in the organization allows `permission`. A
 * reviewer without a role in the organization may do nothing in it.
 */
export function reviewerMay(
  reviewer: typeof Reviewer.Type,
  organizationId: OrganizationId,
  permission: Permission,
) {
  return reviewer.memberships.some(
    (membership) =>
      membership.organizationId === organizationId && allows(membership.role, permission),
  );
}
