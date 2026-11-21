import { Context, Effect, Redacted, Schema } from "effect";

import type {
  ApiTokenInput,
  ApiTokenList,
  CreatedApiToken,
} from "../domain/organizations/api-token.ts";
import { ApiTokenId, OrganizationId } from "../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

export const ApiTokenPrincipal = Schema.Struct({
  apiTokenId: ApiTokenId,
  organizationId: OrganizationId,
});
export type ApiTokenPrincipal = typeof ApiTokenPrincipal.Type;

export class ApiTokenNotFound extends Schema.TaggedError<
  ApiTokenNotFound,
  { readonly brand: unique symbol }
>()("ApiTokenNotFound", {}) {}

export class ApiTokenLimit extends Schema.TaggedError<
  ApiTokenLimit,
  { readonly brand: unique symbol }
>()("ApiTokenLimit", {}) {}

type TokenStorageError = ApiTokenNotFound | StorageUnavailable;

export class ApiTokens extends Context.Service<
  ApiTokens,
  {
    /** Resolve a credential to an active token and its organization. */
    readonly verify: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ApiTokenPrincipal | null, StorageUnavailable>;
    readonly list: (scope: OrganizationScope) => Effect.Effect<ApiTokenList, TokenStorageError>;
    readonly create: (
      scope: OrganizationScope,
      input: typeof ApiTokenInput.Type,
    ) => Effect.Effect<typeof CreatedApiToken.Type, TokenStorageError | ApiTokenLimit>;
    readonly revoke: (
      scope: OrganizationScope,
      id: ApiTokenId,
    ) => Effect.Effect<void, TokenStorageError>;
  }
>()("rondyr/ports/api-tokens/ApiTokens") {}
