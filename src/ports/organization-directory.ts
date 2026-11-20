import { Context, Effect } from "effect";

import type { InboxForm, SetupInbox } from "../domain/submissions/inbox-setup.ts";
import type { InboxOrganization } from "../domain/submissions/inbox.ts";
import type { InboxUnavailable } from "../domain/submissions/submission.rejection.ts";
import type { OrganizationId, UserId } from "../domain/submissions/submission.id.ts";

export class OrganizationDirectory extends Context.Service<
  OrganizationDirectory,
  {
    /** The organizations the account is a member of. */
    readonly organizationsFor: (
      userId: typeof UserId.Type,
    ) => Effect.Effect<ReadonlyArray<typeof InboxOrganization.Type>, InboxUnavailable>;
    /** The forms of an organization, or none when the account is not a member. */
    readonly formsOf: (
      userId: typeof UserId.Type,
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<typeof InboxForm.Type>, InboxUnavailable>;
    /** Create an organization, its first form, and the account's membership. */
    readonly create: (
      userId: typeof UserId.Type,
      input: typeof SetupInbox.Type,
    ) => Effect.Effect<void, InboxUnavailable>;
  }
>()("rondyr/ports/organization-directory/OrganizationDirectory") {}
