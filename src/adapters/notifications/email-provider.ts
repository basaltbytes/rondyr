import { Clock, Effect, Schema } from "effect";

import type { DeliveryId, NotificationTarget } from "../../domain/deliveries/delivery.ts";
import { legacyEmailLanguage, type EmailLanguage } from "../../domain/deliveries/email.ts";
import {
  emailContent,
  testEmailContent,
  type EmailContent,
} from "../../domain/deliveries/email-message.ts";
import { EmailSender } from "../../ports/email-sender.ts";
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

/**
 * Sends a delivery as one plain text email to the recipients of its target,
 * through the provider of the stage. The delivery ID is the idempotency key.
 */
export const emailProvider = Effect.gen(function* () {
  const email = yield* EmailSender;

  /**
   * Send an email to the recipients of `target`, written in the language of the
   * target by `write`, with `key` as the idempotency key.
   */
  const mail = Effect.fnUntraced(function* (
    target: typeof NotificationTarget.Type,
    key: DeliveryId,
    write: (language: EmailLanguage) => Effect.Effect<EmailContent>,
  ) {
    const configuration = yield* decodeConfiguration(target.configuration).pipe(
      Effect.mapError(() => permanent("The email target configuration is invalid.")),
    );
    const from = yield* email.sender.pipe(Effect.mapError(() => permanent(notConfigured)));
    const { replyTo, subject, text } = yield* write(configuration.language ?? legacyEmailLanguage);
    yield* email
      .send({ from, to: configuration.recipients, replyTo, subject, text, idempotencyKey: key })
      .pipe(
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
    yield* mail(notification.target, notification.deliveryId, (language) =>
      Effect.sync(() => emailContent(notification, language)),
    );
  });

  const sendTest = Effect.fn("EmailProvider.sendTest")(function* (test: TestNotification) {
    yield* Effect.annotateCurrentSpan({ testId: test.testId, targetId: test.target.id });
    yield* mail(test.target, test.testId, (language) =>
      Effect.map(Clock.currentTimeMillis, (sentAt) =>
        testEmailContent({ testId: test.testId, formName: test.form.name, sentAt }, language),
      ),
    );
  });

  return { send, sendTest } satisfies NotificationProvider["Service"];
});
