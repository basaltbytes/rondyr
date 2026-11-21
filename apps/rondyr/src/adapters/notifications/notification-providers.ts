import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  NotificationFailed,
  NotificationProvider,
  type Notification,
  type TestNotification,
} from "../../ports/notification-provider.ts";
import { emailProvider } from "./email-provider.ts";
import { webhookProvider } from "./webhook-provider.ts";

type Provider = NotificationProvider["Service"];

function dispatch(providers: ReadonlyMap<string, Provider>): Provider {
  const providerFor = (type: string) => {
    const provider = providers.get(type);
    return provider === undefined
      ? Effect.fail(
          NotificationFailed.make({
            retryable: false,
            summary: `No notification provider for target type "${type}".`,
          }),
        )
      : Effect.succeed(provider);
  };
  return {
    send: (notification: Notification) =>
      Effect.flatMap(providerFor(notification.target.type), (provider) =>
        provider.send(notification),
      ),
    sendTest: (test: TestNotification) =>
      Effect.flatMap(providerFor(test.target.type), (provider) => provider.sendTest(test)),
  };
}

/** One provider per target type. A target of another type fails without a retry. */
export function notificationProviders(providers: ReadonlyMap<string, Provider>) {
  return Layer.succeed(NotificationProvider, dispatch(providers));
}

/** Webhooks over `fetch`, and email through the `EmailSender` of the stage. */
export const notificationProvidersLive = Layer.effect(
  NotificationProvider,
  Effect.map(Effect.all([webhookProvider, emailProvider]), ([webhook, email]) =>
    dispatch(
      new Map([
        ["webhook", webhook],
        ["email", email],
      ]),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));
