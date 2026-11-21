import { Context, Effect, Schema } from "effect";

import type { DailyQuotas, DailyUsage } from "../domain/organizations/organization-quotas.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OrganizationQuotasNotFound extends Schema.TaggedError<
  OrganizationQuotasNotFound,
  { readonly brand: unique symbol }
>()("OrganizationQuotasNotFound", {}) {}

type Failure = OrganizationQuotasNotFound | StorageUnavailable;

export class OrganizationQuotas extends Context.Service<
  OrganizationQuotas,
  {
    readonly usage: (scope: OrganizationScope) => Effect.Effect<typeof DailyUsage.Type, Failure>;
    readonly save: (
      scope: OrganizationScope,
      limits: DailyQuotas,
    ) => Effect.Effect<typeof DailyUsage.Type, Failure>;
  }
>()("rondyr/ports/organization-quotas/OrganizationQuotas") {}
