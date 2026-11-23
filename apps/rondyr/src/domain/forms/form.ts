import { Result, Schema } from "effect";

import { isSubmittedFieldName } from "../submissions/submission-fields.ts";
import { AllowedOrigin } from "./allowed-origin.ts";
import { TurnstileSiteKey, turnstileField } from "./turnstile.ts";

/** A suspended form refuses submissions and keeps its messages, destinations and public URL. */
export const FormStatus = Schema.Literals(["active", "suspended"]);
export type FormStatus = typeof FormStatus.Type;

export const FormName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

/** What the organization does, given to the classifier. An empty context is stored as none. */
export const BusinessContext = Schema.Trim.check(Schema.isMaxLength(2000));

/**
 * The name of a form field that people leave empty and bots fill in. It follows
 * the rule of the field names that intake accepts, without surrounding spaces.
 */
export const HoneypotField = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.makeFilter(
    (name) =>
      (isSubmittedFieldName(name) && name !== turnstileField) ||
      "Expected a field name without control characters, line breaks or reserved names",
  ),
);

export const SetHoneypotField = Schema.Struct({ field: HoneypotField });

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pictograph = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Whether a text is one emoji as a reader sees it: a single grapheme with a pictograph. */
function isOneEmoji(text: string) {
  const [first, second] = graphemes.segment(text);
  return first !== undefined && second === undefined && pictograph.test(text);
}

/**
 * The emoji shown next to the form's name, so a reader tells the forms of an
 * organization apart at a glance: one emoji, a flag or a joined sequence included.
 */
export const FormEmoji = Schema.Trim.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((text) => isOneEmoji(text) || "Expected a single emoji"),
);

/** A form of one of the account's organizations, as the admin API returns it. */
export const ManagedForm = Schema.Struct({
  name: Schema.String,
  publicId: Schema.String,
  status: FormStatus,
  emoji: Schema.NullOr(Schema.String),
  businessContext: Schema.NullOr(Schema.String),
  successUrl: Schema.NullOr(Schema.String),
  honeypotField: Schema.NullOr(Schema.String),
  turnstileSiteKey: Schema.NullOr(TurnstileSiteKey),
});

export const CreateForm = Schema.Struct({
  name: FormName,
  emoji: Schema.optionalKey(FormEmoji),
  businessContext: Schema.optionalKey(BusinessContext),
});

/** A change of name, of emoji, of business context, or of several of them. */
export const UpdateForm = Schema.Struct({
  name: Schema.optionalKey(FormName),
  emoji: Schema.optionalKey(FormEmoji),
  businessContext: Schema.optionalKey(BusinessContext),
}).check(
  Schema.makeFilter(
    (changes) =>
      changes.name !== undefined ||
      changes.emoji !== undefined ||
      changes.businessContext !== undefined ||
      "Expected a name, an emoji or a business context",
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

export const FormRequestError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("success-url-refused"), reason: SuccessUrlRefusalReason }),
  Schema.Struct({ error: Schema.Literal("secrets-key-missing") }),
  Schema.Struct({ error: Schema.Literal("turnstile-secret-refused") }),
  Schema.Struct({ error: Schema.Literal("siteverify-unavailable") }),
]);
