import { Context, Effect, Schema } from "effect";

import type { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import type { SubmissionId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export class FormNotFound extends Schema.TaggedError<
  FormNotFound,
  { readonly brand: unique symbol }
>()("FormNotFound", {}) {}

export class FormRateLimited extends Schema.TaggedError<
  FormRateLimited,
  { readonly brand: unique symbol }
>()("FormRateLimited", {}) {}

export class SubmissionIntake extends Context.Service<
  SubmissionIntake,
  {
    /**
     * Store a submission and its outbox event in one transaction. A returned ID
     * means that both rows exist.
     */
    readonly receive: (
      publicId: string,
      fields: typeof SubmissionFields.Type,
    ) => Effect.Effect<SubmissionId, FormNotFound | FormRateLimited | StorageUnavailable>;
  }
>()("rondyr/ports/intake/SubmissionIntake") {}
