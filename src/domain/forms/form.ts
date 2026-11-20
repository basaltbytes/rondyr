import { Result, Schema } from "effect";

import { AllowedOrigin } from "./allowed-origin.ts";

/** A suspended form refuses submissions and keeps its messages, destinations and public URL. */
export const FormStatus = Schema.Literals(["active", "suspended"]);
export type FormStatus = typeof FormStatus.Type;

export const FormName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

/** What the organization does, given to the classifier. An empty context is stored as none. */
export const BusinessContext = Schema.Trim.check(Schema.isMaxLength(2000));

/** A form of one of the account's organizations, as the admin API returns it. */
export const ManagedForm = Schema.Struct({
  name: Schema.String,
  publicId: Schema.String,
  status: FormStatus,
  businessContext: Schema.NullOr(Schema.String),
  successUrl: Schema.NullOr(Schema.String),
});

export const CreateForm = Schema.Struct({
  name: FormName,
  businessContext: Schema.optionalKey(BusinessContext),
});

/** A change of name, of business context, or of both. */
export const UpdateForm = Schema.Struct({
  name: Schema.optionalKey(FormName),
  businessContext: Schema.optionalKey(BusinessContext),
}).check(
  Schema.makeFilter(
    (changes) =>
      changes.name !== undefined ||
      changes.businessContext !== undefined ||
      "Expected a name or a business context",
  ),
);

const maxSuccessUrlLength = 2048;

export const SetSuccessUrl = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(maxSuccessUrlLength)),
});

/**
 * Why a success URL is refused. `origin-not-listed`: the URL's origin is not
 * one of the form's allowed origins.
 */
export const SuccessUrlRefusalReason = Schema.Literals([
  "invalid-url",
  "not-https",
  "credentials",
  "origin-not-listed",
]);
export type SuccessUrlRefusalReason = typeof SuccessUrlRefusalReason.Type;

/** An absolute HTTPS URL without credentials, normalized by `parseSuccessUrl`. */
export const SuccessUrl = Schema.String.pipe(Schema.brand("SuccessUrl"));
export type SuccessUrl = typeof SuccessUrl.Type;

/**
 * Accept an absolute HTTPS URL without credentials and normalize it. Whether
 * its origin is allowed depends on the form, so the caller checks it.
 */
export function parseSuccessUrl(
  input: string,
): Result.Result<SuccessUrl, Exclude<SuccessUrlRefusalReason, "origin-not-listed">> {
  const trimmed = input.trim();
  if (trimmed.length > maxSuccessUrlLength || !URL.canParse(trimmed)) {
    return Result.fail("invalid-url");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "https:") return Result.fail("not-https");
  if (url.username !== "" || url.password !== "") return Result.fail("credentials");
  if (url.hostname === "") return Result.fail("invalid-url");
  return Result.succeed(SuccessUrl.make(url.href));
}

/** The origin of a success URL, in the form of an allowed origin. */
export function successUrlOrigin(url: SuccessUrl) {
  return AllowedOrigin.make(new URL(url).origin);
}

export const FormRequestError = Schema.Struct({
  error: Schema.Literal("success-url-refused"),
  reason: SuccessUrlRefusalReason,
});
