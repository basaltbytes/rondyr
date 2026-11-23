import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  NotificationFailed,
  NotificationProvider,
  type Notification,
  type TestNotification,
} from "../../ports/notification-provider.ts";
import { connectors } from "../../../domain/deliveries/connectors/catalog.ts";
import { connectorProvider } from "./connector-provider.ts";
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

/**
 * Webhooks and the connectors of the catalog over `fetch`, and email through
 * the `EmailSender` of the stage.
 */
export const notificationProvidersLive = Layer.effect(
  NotificationProvider,
  Effect.gen(function* () {
    const webhook = yield* webhookProvider;
    const email = yield* emailProvider;
    const services = yield* Effect.forEach(connectors, (connector) =>
      Effect.map(connectorProvider(connector), (provider) => [connector.type, provider] as const),
    );
    return dispatch(
      new Map<string, Provider>([["webhook", webhook], ["email", email], ...services]),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
