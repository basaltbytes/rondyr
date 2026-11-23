import { Effect } from "effect";

import type {
  Notification,
  NotificationFailed,
  NotificationProvider,
  TestNotification,
} from "../../ports/notification-provider.ts";

/**
 * A provider for tests, with no external system behind it. It records each
 * notification and test it receives, then answers with `answer` or `answerTest`.
 */
export function testNotificationProvider(
  answer: (notification: Notification) => Effect.Effect<void, NotificationFailed>,
  answerTest: (test: TestNotification) => Effect.Effect<void, NotificationFailed> = () =>
    Effect.void,
) {
  const received: Array<Notification> = [];
  const tested: Array<TestNotification> = [];
  const provider: NotificationProvider["Service"] = {
    send: (notification) =>
      Effect.andThen(
        Effect.sync(() => {
          received.push(notification);
        }),
        answer(notification),
      ),
    sendTest: (test) =>
      Effect.andThen(
        Effect.sync(() => {
          tested.push(test);
        }),
        answerTest(test),
      ),
  };
  return { provider, received, tested };
}
