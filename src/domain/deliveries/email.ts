import { Result, Schema } from "effect";

import { TargetId } from "./delivery.ts";

// A dot-atom local part and a hostname of two or more DNS labels, in ASCII.
// Spaces, quotes, angle brackets, commas, semicolons, parentheses and control
// characters are refused, so an address can never carry a display name, a
// second address or a line break into a header.
const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const addressPattern = new RegExp(`^${atom}(?:\\.${atom})*@${label}(?:\\.${label})+$`, "u");
const numeric = /^\d+$/u;

const maxAddressLength = 254;
const maxLocalPartLength = 64;

function isEmailAddress(input: string) {
  if (input.length > maxAddressLength || !addressPattern.test(input)) return false;
  const at = input.lastIndexOf("@");
  const topLevel = input.slice(input.lastIndexOf(".") + 1);
  return at <= maxLocalPartLength && !numeric.test(topLevel);
}

/** A bare ASCII address such as `team@example.com`, with no display name and no line break. */
export const EmailAddress = Schema.String.check(
  Schema.makeFilter(
    (input) => isEmailAddress(input) || "Expected a bare email address such as team@example.com",
  ),
).pipe(Schema.brand("EmailAddress"));
export type EmailAddress = typeof EmailAddress.Type;

/** Each recipient counts as one email in the provider's quota. */
export const maxRecipients = 10;

const sameAddress = (address: string) => address.toLowerCase();

/** One to `maxRecipients` distinct addresses. Two addresses that differ only by case are the same. */
export const EmailRecipients = Schema.Array(EmailAddress)
  .check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxRecipients),
    Schema.makeFilter(
      (addresses) =>
        new Set(addresses.map(sameAddress)).size === addresses.length ||
        "Expected distinct addresses",
    ),
  )
  .pipe(Schema.brand("EmailRecipients"));
export type EmailRecipients = typeof EmailRecipients.Type;

/** Why a list of recipients is refused. */
export const RecipientsRefusalReason = Schema.Literals([
  "no-recipients",
  "too-many-recipients",
  "invalid-address",
  "duplicate-address",
]);
export type RecipientsRefusalReason = typeof RecipientsRefusalReason.Type;

const isAddress = Schema.is(EmailAddress);

export function parseEmailRecipients(
  input: ReadonlyArray<string>,
): Result.Result<EmailRecipients, RecipientsRefusalReason> {
  if (input.length === 0) return Result.fail("no-recipients");
  if (input.length > maxRecipients) return Result.fail("too-many-recipients");
  const addresses = input.filter(isAddress);
  if (addresses.length !== input.length) return Result.fail("invalid-address");
  if (new Set(addresses.map(sameAddress)).size !== addresses.length) {
    return Result.fail("duplicate-address");
  }
  return Result.succeed(EmailRecipients.make(addresses));
}

/** The languages in which Rondyr writes the email of a destination. */
export const EmailLanguage = Schema.Literals(["en", "fr"]);
export type EmailLanguage = typeof EmailLanguage.Type;

/** The language of a destination created without one. */
export const defaultEmailLanguage: EmailLanguage = "en";

/** A destination stored before the language setting got its emails in French, and keeps them. */
export const legacyEmailLanguage: EmailLanguage = "fr";

/** An address gets messages once its owner has confirmed it for the organization. */
export const RecipientStatus = Schema.Literals(["pending", "confirmed"]);
export type RecipientStatus = typeof RecipientStatus.Type;

export const RecipientConfirmationStatus = Schema.Struct({
  address: EmailAddress,
  status: RecipientStatus,
});

/** An email target as the admin API returns it. */
export const EmailTarget = Schema.Struct({
  id: TargetId,
  type: Schema.Literal("email"),
  recipients: EmailRecipients,
  /** The language of the emails that the recipients get. */
  language: EmailLanguage,
  /**
   * Each recipient, `pending` until its owner confirms it for the organization.
   * Deliveries and tests go to the confirmed ones only.
   */
  recipientStatuses: Schema.Array(RecipientConfirmationStatus),
  active: Schema.Boolean,
  createdAt: Schema.Int,
});

// Addresses are checked by `parseEmailRecipients`, which gives the reason of a refusal.
const RecipientsInput = Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
  Schema.isMaxLength(100),
);

export const CreateEmailTarget = Schema.Struct({
  type: Schema.Literal("email"),
  recipients: RecipientsInput,
  language: Schema.optionalKey(EmailLanguage),
});

/** New recipients, and a new language when the request has one. */
export const ReplaceEmailRecipients = Schema.Struct({
  recipients: RecipientsInput,
  language: Schema.optionalKey(EmailLanguage),
});
