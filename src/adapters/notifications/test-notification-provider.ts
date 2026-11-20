import { Effect } from "effect";

import type {
  Notification,
  NotificationFailed,
  NotificationProvider,
} from "../../ports/notification-provider.ts";

/**
 * A provider for tests, with no external system behind it. It records each
 * notification it receives, then answers with `answer`.
 */
export function testNotificationProvider(
  answer: (notification: Notification) => Effect.Effect<void, NotificationFailed>,
) {
  const received: Array<Notification> = [];
  const provider: NotificationProvider["Service"] = {
    send: (notification) =>
      Effect.andThen(
        Effect.sync(() => {
          received.push(notification);
        }),
        answer(notification),
      ),
  };
  return { provider, received };
}
