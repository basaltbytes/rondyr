import { Effect, Schema } from "effect";

import { emailContent } from "../../domain/deliveries/email-message.ts";
import { EmailSender } from "../../ports/email-sender.ts";
import {
  NotificationFailed,
  type Notification,
  type NotificationProvider,
} from "../../ports/notification-provider.ts";
import { EmailConfiguration } from "./email-configuration.ts";

const decodeConfiguration = Schema.decodeUnknownEffect(EmailConfiguration);

function permanent(summary: string) {
  return NotificationFailed.make({ retryable: false, summary });
}

const notConfigured =
  "Email is not configured on this stage. Set RESEND_API_KEY and RONDYR_EMAIL_FROM, then redeploy.";

/**
 * Sends a delivery as one plain text email to the recipients of its target,
 * through the provider of the stage. The delivery ID is the idempotency key.
 */
export const emailProvider = Effect.gen(function* () {
  const email = yield* EmailSender;

  const send = Effect.fn("EmailProvider.send")(function* (notification: Notification) {
    yield* Effect.annotateCurrentSpan({
      deliveryId: notification.deliveryId,
      targetId: notification.target.id,
    });
    const configuration = yield* decodeConfiguration(notification.target.configuration).pipe(
      Effect.mapError(() => permanent("The email target configuration is invalid.")),
    );
    const from = yield* email.sender.pipe(Effect.mapError(() => permanent(notConfigured)));
    const content = emailContent(notification);
    yield* email
      .send({
        from,
        to: configuration.recipients,
        replyTo: content.replyTo,
        subject: content.subject,
        text: content.text,
        idempotencyKey: notification.deliveryId,
      })
      .pipe(
        Effect.catchTags({
          EmailRejected: ({ summary }) => Effect.fail(permanent(summary)),
          EmailUnavailable: ({ summary }) =>
            Effect.fail(NotificationFailed.make({ retryable: true, summary })),
          EmailProviderMissing: () => Effect.fail(permanent(notConfigured)),
        }),
      );
  });

  return { send } satisfies NotificationProvider["Service"];
});
