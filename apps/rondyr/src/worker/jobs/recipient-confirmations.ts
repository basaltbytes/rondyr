import { Duration, Effect, Option, Redacted } from "effect";
import { SecureRandom } from "effect/crypto";

import { EmailRecipients, type EmailLanguage } from "../../domain/deliveries/email.ts";
import { confirmationEmail } from "../../domain/deliveries/recipient-confirmation.ts";
import type { EmailAddress } from "../../domain/deliveries/email.ts";
import type { OrganizationId } from "../../domain/submissions/submission.id.ts";
import { EmailSender } from "../ports/email-sender.ts";
import type { TargetScope } from "../ports/notification-targets.ts";
import {
  RecipientConfirmations,
  type IssuedConfirmation,
} from "../ports/recipient-confirmations.ts";

/** The dashboard page of a link. The secret is in the fragment, which no request carries. */
function confirmationLink(origin: string, token: Redacted.Redacted<string>) {
  return `${origin}/confirm-recipient#${Redacted.value(token)}`;
}

/** Email one link. Each email has its own idempotency key. */
const sendLink = Effect.fnUntraced(function* (
  issued: IssuedConfirmation,
  language: EmailLanguage,
  origin: string,
) {
  const email = yield* EmailSender;
  const from = yield* email.sender;
  const { subject, text } = confirmationEmail(
    confirmationLink(origin, issued.token),
    issued.expiresAt,
    language,
  );
  yield* email
    .send({
      from,
      to: EmailRecipients.make([issued.address]),
      replyTo: Option.none(),
      subject,
      text,
      idempotencyKey: SecureRandom.uuidV4Unsafe(),
    })
    .pipe(Effect.timeout(Duration.seconds(30)));
});

/**
 * Ask the owner of each address that the organization has not confirmed yet,
 * once a destination lists it. Without an email provider nothing is issued and
 * no daily email is counted. A failed email leaves the recipient pending, and
 * an admin can send it again from the dashboard.
 */
export const requestConfirmations = Effect.fn("Confirmations.request")(function* (
  organizationId: OrganizationId,
  addresses: ReadonlyArray<EmailAddress>,
  language: EmailLanguage,
  origin: string,
) {
  const email = yield* EmailSender;
  const configured = yield* email.sender.pipe(
    Effect.as(true),
    Effect.catchTag("EmailProviderMissing", () => Effect.succeed(false)),
  );
  if (!configured) return;
  const confirmations = yield* RecipientConfirmations;
  const issued = yield* confirmations.request(organizationId, addresses);
  yield* Effect.forEach(
    issued,
    (link) =>
      sendLink(link, language, origin).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Confirmation email failed", { tag: error._tag }),
        ),
        Effect.ignore,
      ),
    { concurrency: "unbounded", discard: true },
  );
});

/** Send the confirmation email of one recipient of a destination again, with a new link. */
export const resendConfirmation = Effect.fn("Confirmations.resend")(function* (
  target: TargetScope,
  address: string,
  origin: string,
) {
  const email = yield* EmailSender;
  yield* email.sender;
  const confirmations = yield* RecipientConfirmations;
  const issued = yield* confirmations.requestFor(target, address);
  yield* sendLink(issued, issued.language, origin);
  return issued.address;
});
