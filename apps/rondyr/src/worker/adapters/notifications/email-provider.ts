import { Clock, Effect, Schema } from "effect";

import type { DeliveryId, NotificationTarget } from "../../../domain/deliveries/delivery.ts";
import {
  EmailRecipients,
  legacyEmailLanguage,
  type EmailLanguage,
} from "../../../domain/deliveries/email.ts";
import {
  emailContent,
  testEmailContent,
  type EmailContent,
} from "../../../domain/deliveries/email-message.ts";
import { EmailSender } from "../../ports/email-sender.ts";
import { RecipientConfirmations } from "../../ports/recipient-confirmations.ts";
import {
  NotificationFailed,
  type Notification,
  type NotificationProvider,
  type TestNotification,
} from "../../ports/notification-provider.ts";
import { EmailConfiguration } from "./email-configuration.ts";

const decodeConfiguration = Schema.decodeUnknownEffect(EmailConfiguration);

function permanent(summary: string) {
  return NotificationFailed.make({ retryable: false, summary });
}

const notConfigured =
  "Email is not configured on this stage. Check the email provider and RONDYR_EMAIL_FROM.";

const noConfirmedRecipient =
  "No recipient of this destination has confirmed their address yet. Rondyr sends email only to confirmed addresses.";

/**
 * Sends a delivery as one plain text email to the recipients of its target
 * that the organization has confirmed, through the provider of the stage. The
 * delivery ID is the idempotency key.
 */
export const emailProvider = Effect.gen(function* () {
  const email = yield* EmailSender;
  const confirmations = yield* RecipientConfirmations;

  /**
   * Send an email to the recipients of `target`, written in the language of the
   * target by `write`, with `key` as the idempotency key.
   */
  const mail = Effect.fnUntraced(function* (
    target: typeof NotificationTarget.Type,
    key: DeliveryId,
    confirmedBy: number,
    write: (language: EmailLanguage) => Effect.Effect<EmailContent>,
  ) {
    const configuration = yield* decodeConfiguration(target.configuration).pipe(
      Effect.mapError(() => permanent("The email target configuration is invalid.")),
    );
    const from = yield* email.sender.pipe(Effect.mapError(() => permanent(notConfigured)));
    // An address that its owner has not confirmed gets nothing. The recipients are
    // those confirmed at `confirmedBy`, so a confirmation between two attempts of a
    // delivery changes neither its message nor the meaning of its idempotency key.
    const confirmed = yield* confirmations
      .confirmedAmong(target.organizationId, configuration.recipients, confirmedBy)
      .pipe(
        Effect.mapError(() =>
          NotificationFailed.make({
            retryable: true,
            summary: "Rondyr could not read the confirmed recipients.",
          }),
        ),
      );
    if (confirmed.length === 0) return yield* permanent(noConfirmedRecipient);
    const to = EmailRecipients.make(confirmed);
    const { replyTo, subject, text } = yield* write(configuration.language ?? legacyEmailLanguage);
    yield* email.send({ from, to, replyTo, subject, text, idempotencyKey: key }).pipe(
      Effect.catchTags({
        EmailRejected: ({ summary }) => Effect.fail(permanent(summary)),
        EmailUnavailable: ({ summary }) =>
          Effect.fail(NotificationFailed.make({ retryable: true, summary })),
        EmailProviderMissing: () => Effect.fail(permanent(notConfigured)),
      }),
    );
  });

  const send = Effect.fn("EmailProvider.send")(function* (notification: Notification) {
    yield* Effect.annotateCurrentSpan({
      deliveryId: notification.deliveryId,
      targetId: notification.target.id,
    });
    yield* mail(notification.target, notification.deliveryId, notification.createdAt, (language) =>
      Effect.sync(() => emailContent(notification, language)),
    );
  });

  const sendTest = Effect.fn("EmailProvider.sendTest")(function* (test: TestNotification) {
    yield* Effect.annotateCurrentSpan({ testId: test.testId, targetId: test.target.id });
    const now = yield* Clock.currentTimeMillis;
    yield* mail(test.target, test.testId, now, (language) =>
      Effect.sync(() =>
        testEmailContent({ testId: test.testId, formName: test.form.name, sentAt: now }, language),
      ),
    );
  });

  return { send, sendTest } satisfies NotificationProvider["Service"];
});
