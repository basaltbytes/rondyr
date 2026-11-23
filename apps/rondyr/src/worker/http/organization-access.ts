import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";

import {
  allows,
  type MemberRole,
  type Permission,
} from "../../domain/organizations/member-role.ts";
import { ReviewUnauthorized } from "../../domain/submissions/review-session.middleware.ts";
import { UserId, type OrganizationId } from "../../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";
import { OrganizationDirectory } from "../ports/organization-directory.ts";
import { CurrentApiToken } from "./api-token-authentication.ts";

/** The account has a role in the organization, and the role does not allow the action: 403. */
export class PermissionDenied extends Schema.TaggedError<
  PermissionDenied,
  { readonly brand: unique symbol }
>()("PermissionDenied", {}) {}

/** The account has no role in the organization, which may not exist: 404. */
export class OrganizationNotFound extends Schema.TaggedError<
  OrganizationNotFound,
  { readonly brand: unique symbol }
>()("OrganizationNotFound", {}) {}

/** The signed-in account, or `ReviewUnauthorized` without a session. */
export const signedInAccount = Effect.fn("OrganizationAccess.signedInAccount")(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const user = yield* auth.userId(request);
  if (user === null) return yield* ReviewUnauthorized.make();
  return yield* Schema.decodeEffect(UserId)(user);
});

export interface OrganizationAccess {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
  readonly role: MemberRole;
}

/**
 * The signed-in account and its role in the organization, when that role
 * allows `permission`: the check of every administration route. An account
 * without a role in the organization gets `OrganizationNotFound`, like an
 * organization that does not exist, and a role without the permission
 * `PermissionDenied`. An API token never reaches these routes: its
 * middleware refuses them, and this check refuses a token as well.
 */
export const authorize = Effect.fn("OrganizationAccess.authorize")(function* (
  organizationId: OrganizationId,
  permission: Permission,
) {
  const token = yield* CurrentApiToken;
  if (token !== null) return yield* PermissionDenied.make();
  const userId = yield* signedInAccount();
  const directory = yield* OrganizationDirectory;
  const role = yield* directory.roleOf({ userId, organizationId });
  if (role === null) return yield* OrganizationNotFound.make();
  if (!allows(role, permission)) return yield* PermissionDenied.make();
  return { userId, organizationId, role } satisfies OrganizationAccess;
});
