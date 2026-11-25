import { Context, Effect, Schema } from "effect";

import type { ScreeningPreview } from "../../domain/submissions/verification.ts";
import type { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";
import type { UnreadableMessage } from "./stored-messages.ts";

/** The organization reached its daily classification limit, so no preview could run. */
export class ScreeningQuotaReached extends Schema.TaggedError<
  ScreeningQuotaReached,
  { readonly brand: unique symbol }
>()("ScreeningQuotaReached", {}) {}

export class SubmissionScreening extends Context.Service<
  SubmissionScreening,
  {
    /**
     * Evaluate an existing submission against its form's and organization's
     * current saved rules without mutating submission state or triggering
     * deliveries.
     */
    readonly preview: (
      submissionId: SubmissionId,
      organizationId: OrganizationId,
    ) => Effect.Effect<
      ScreeningPreview,
      StorageUnavailable | UnreadableMessage | ScreeningQuotaReached
    >;
  }
>()("rondyr/worker/ports/submission-screening/SubmissionScreening") {}
