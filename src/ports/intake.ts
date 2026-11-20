import { Context, Effect, Option, Schema } from "effect";

import type { SuccessUrl } from "../domain/forms/form.ts";
import type { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import type { SubmissionId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

/**
 * How the allowed origins of a form apply to the `Origin` header of a request.
 * `unrestricted`: the form has no allowed origin, so every origin is accepted.
 * `listed`: the request's origin is one of the form's allowed origins.
 * `unlisted`: the form has allowed origins, and the request has another origin or none.
 */
export const OriginMatch = Schema.Literals(["unrestricted", "listed", "unlisted"]);
export type OriginMatch = typeof OriginMatch.Type;

export class FormNotFound extends Schema.TaggedError<
  FormNotFound,
  { readonly brand: unique symbol }
>()("FormNotFound", {}) {}

export class FormRateLimited extends Schema.TaggedError<
  FormRateLimited,
  { readonly brand: unique symbol }
>()("FormRateLimited", { origins: OriginMatch }) {}

/** The request has an `Origin` header that is not one of the form's allowed origins. */
export class OriginRefused extends Schema.TaggedError<
  OriginRefused,
  { readonly brand: unique symbol }
>()("OriginRefused", {}) {}

/** The form is suspended: it stores nothing until it is active again. */
export class FormSuspended extends Schema.TaggedError<
  FormSuspended,
  { readonly brand: unique symbol }
>()("FormSuspended", { origins: OriginMatch }) {}

/**
 * The submission has no field once the form's empty honeypot field is removed:
 * the honeypot field was its only field.
 */
export class EmptySubmission extends Schema.TaggedError<
  EmptySubmission,
  { readonly brand: unique symbol }
>()("EmptySubmission", { origins: OriginMatch }) {}

export interface ReceivedSubmission {
  readonly submissionId: SubmissionId;
  readonly origins: OriginMatch;
  /** Where to redirect an HTML form post. Its origin is one of the form's allowed origins. */
  readonly successUrl: Option.Option<SuccessUrl>;
}

export class SubmissionIntake extends Context.Service<
  SubmissionIntake,
  {
    /**
     * Store a submission and its outbox event in one transaction. A returned ID
     * means that both rows exist. A request without an origin is not checked
     * against the form's allowed origins. A suspended form stores nothing.
     *
     * When the form has a honeypot field, an empty value of that field is
     * removed before storage, and a filled one is stored with the intake reason
     * `honeypot`, so that the submission is quarantined without a classifier.
     * The result is the same in both cases.
     */
    readonly receive: (
      publicId: string,
      fields: typeof SubmissionFields.Type,
      origin: Option.Option<string>,
    ) => Effect.Effect<
      ReceivedSubmission,
      | FormNotFound
      | FormRateLimited
      | FormSuspended
      | OriginRefused
      | EmptySubmission
      | StorageUnavailable
    >;
    /**
     * Match an origin against the allowed origins of a form, without storing
     * anything. A suspended form answers as an active one.
     */
    readonly matchOrigin: (
      publicId: string,
      origin: Option.Option<string>,
    ) => Effect.Effect<OriginMatch, FormNotFound | StorageUnavailable>;
  }
>()("rondyr/ports/intake/SubmissionIntake") {}
