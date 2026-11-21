import { Context, Effect, Option, Schema } from "effect";

import type { SuccessUrl } from "../domain/forms/form.ts";
import type { TurnstileToken } from "../domain/forms/turnstile.ts";
import type { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import type { IdempotencyKey } from "../domain/submissions/idempotency-key.ts";
import type { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";
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

export class OrganizationRateLimited extends Schema.TaggedError<
  OrganizationRateLimited,
  { readonly brand: unique symbol }
>()("OrganizationRateLimited", { origins: OriginMatch, retryAfter: Schema.Int }) {}

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

/** A submission sent by a server with an API token of the form's organization. */
export interface ServerIntake {
  readonly organizationId: OrganizationId;
  readonly idempotencyKey: Option.Option<IdempotencyKey>;
}

export interface ReceivedFromServer {
  readonly submissionId: SubmissionId;
  /** The key named a submission stored earlier: nothing was stored or published. */
  readonly replayed: boolean;
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
     * Turnstile failures and exhausted classification quotas also quarantine the
     * message without changing the response. The organization storage quota can
     * refuse the submission before it is stored.
     */
    readonly receive: (
      publicId: string,
      fields: typeof SubmissionFields.Type,
      origin: Option.Option<string>,
      token?: Option.Option<TurnstileToken>,
    ) => Effect.Effect<
      ReceivedSubmission,
      | FormNotFound
      | FormRateLimited
      | OrganizationRateLimited
      | FormSuspended
      | OriginRefused
      | EmptySubmission
      | StorageUnavailable
    >;
    /**
     * Store a submission sent by a server, in the same single D1 batch as
     * `receive`. The form must belong to the intake's organization, otherwise it
     * is not found. The allowed origins and Turnstile do not apply; the honeypot
     * field, the form cap and the organization quotas do.
     *
     * With an idempotency key, the batch looks for a submission of the form with
     * that key before the insert. When one exists, nothing is stored and its ID
     * is returned with `replayed`, whatever the form's state or quotas now are.
     */
    readonly receiveFromServer: (
      publicId: string,
      fields: typeof SubmissionFields.Type,
      intake: ServerIntake,
    ) => Effect.Effect<
      ReceivedFromServer,
      | FormNotFound
      | FormRateLimited
      | OrganizationRateLimited
      | FormSuspended
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
