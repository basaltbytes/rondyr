import { Schema } from "effect";

export class SubmissionNotFound extends Schema.TaggedError<
  SubmissionNotFound,
  { readonly brand: unique symbol }
>()("SubmissionNotFound", {}, { httpApiStatus: 404 }) {}

export class SubmissionNotReviewable extends Schema.TaggedError<
  SubmissionNotReviewable,
  { readonly brand: unique symbol }
>()("SubmissionNotReviewable", {}, { httpApiStatus: 409 }) {}

/** Only a submission quarantined with the reason `classification-error` can be classified again. */
export class SubmissionNotReclassifiable extends Schema.TaggedError<
  SubmissionNotReclassifiable,
  { readonly brand: unique symbol }
>()("SubmissionNotReclassifiable", {}, { httpApiStatus: 409 }) {}

export class InboxUnavailable extends Schema.TaggedError<
  InboxUnavailable,
  { readonly brand: unique symbol }
>()("InboxUnavailable", {}, { httpApiStatus: 503 }) {}

export class InvalidInboxCursor extends Schema.TaggedError<
  InvalidInboxCursor,
  { readonly brand: unique symbol }
>()("InvalidInboxCursor", {}, { httpApiStatus: 400 }) {}
