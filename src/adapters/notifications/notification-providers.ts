import { Effect, Layer } from "effect";

import {
  NotificationFailed,
  NotificationProvider,
  type Notification,
} from "../../ports/notification-provider.ts";

type Provider = NotificationProvider["Service"];

/** One provider per target type. A target of another type fails without a retry. */
export function notificationProviders(providers: ReadonlyMap<string, Provider>) {
  return Layer.succeed(NotificationProvider, {
    send: (notification: Notification) => {
      const provider = providers.get(notification.target.type);
      return provider === undefined
        ? Effect.fail(
            NotificationFailed.make({
              retryable: false,
              summary: `No notification provider for target type "${notification.target.type}".`,
            }),
          )
        : provider.send(notification);
    },
  });
}

/** Webhook (#13) and email (#14) providers are not built yet. */
export const notificationProvidersLive = notificationProviders(new Map());
