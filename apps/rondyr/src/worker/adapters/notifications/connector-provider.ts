import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type {
  Connector,
  ConnectorMessage,
  ConnectorRequest,
} from "../../../domain/deliveries/connectors/connector.ts";
import type { NotificationTarget } from "../../../domain/deliveries/delivery.ts";
import { testWebhookFields } from "../../../domain/deliveries/webhook.ts";
import type {
  Notification,
  NotificationProvider,
  TestNotification,
} from "../../ports/notification-provider.ts";
import { SecretCipher } from "../../ports/secret-cipher.ts";
import { ConnectorConfiguration } from "./connector-configuration.ts";
import { discardBody, failureFor, permanent, retryable } from "./http-attempt.ts";

const decodeConfiguration = Schema.decodeUnknownEffect(ConnectorConfiguration);
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** An HTTPS URL on the default port of one of the hosts of the connector, without credentials. */
function ownHost(connector: Connector, request: ConnectorRequest) {
  if (!URL.canParse(request.url)) return false;
  const url = new URL(request.url);
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    connector.hosts.includes(url.hostname)
  );
}

/**
 * Sends the deliveries of the targets of one connector: opens the secrets of
 * the target, asks the connector for its request and sends it. Only the status
 * of the response is read, and a summary never contains the submission fields.
 */
export const connectorProvider = Effect.fnUntraced(function* (connector: Connector) {
  const cipher = yield* SecretCipher;
  const client = yield* HttpClient.HttpClient;

  const deliver = Effect.fnUntraced(function* (
    target: typeof NotificationTarget.Type,
    message: ConnectorMessage,
  ) {
    const configuration = yield* decodeConfiguration(target.configuration).pipe(
      Effect.mapError(() => permanent("The configuration of this destination is invalid.")),
    );
    const secrets = yield* Effect.forEach(Object.entries(configuration.secrets), ([name, sealed]) =>
      cipher.open(sealed, target.id).pipe(
        Effect.mapBoth({
          onSuccess: (secret) => [name, Redacted.value(secret)] as const,
          onFailure: () => permanent("A secret of this destination cannot be decrypted."),
        }),
      ),
    );
    // A connector that throws is a bug of the connector. It ends this delivery with an
    // error to read, and leaves the other deliveries of the batch alone.
    const built = yield* Effect.try({
      try: () =>
        connector.request({ ...configuration.settings, ...Object.fromEntries(secrets) }, message),
      catch: () => permanent(`The ${connector.label} connector could not build its request.`),
    }).pipe(
      Effect.tapError(() =>
        Effect.logError("Connector failed to build its request", {
          connector: connector.type,
          targetId: target.id,
        }),
      ),
    );
    if (Option.isNone(built)) {
      return yield* permanent(
        `The settings of this destination no longer fit ${connector.label}. Save them again.`,
      );
    }
    const request = built.value;
    if (!ownHost(connector, request)) {
      return yield* permanent(`The request is not for a host of ${connector.label}.`);
    }
    const body = yield* encodeBody(request.body).pipe(
      Effect.mapError(() => permanent("The body of the request cannot be encoded.")),
    );
    const outgoing = (
      request.method === "POST"
        ? HttpClientRequest.post(request.url)
        : HttpClientRequest.patch(request.url)
    ).pipe(
      HttpClientRequest.setHeaders({ ...request.headers, "user-agent": "Rondyr-Connector/1" }),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const response = yield* client.execute(outgoing).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(() => retryable(`${connector.label} could not be reached.`)),
    );
    yield* discardBody(response);
    const failure = failureFor(response.status, connector.label);
    if (Option.isNone(failure)) return;
    const { retryable: again, summary } = failure.value;
    // The hint of the connector is its own text, never a part of the response.
    return yield* Option.match(connector.explain(response.status), {
      onNone: () => failure.value,
      onSome: (hint) => (again ? retryable : permanent)(`${summary} ${hint}`),
    });
  });

  const send = Effect.fn("ConnectorProvider.send")(function* (notification: Notification) {
    yield* Effect.annotateCurrentSpan({
      deliveryId: notification.deliveryId,
      targetId: notification.target.id,
      connector: connector.type,
    });
    yield* deliver(notification.target, {
      kind: "submission",
      id: notification.deliveryId,
      submissionId: notification.submission.id,
      receivedAt: notification.submission.receivedAt,
      form: {
        publicId: notification.submission.formPublicId,
        name: notification.submission.formName,
      },
      fields: notification.fields,
    });
  });

  const sendTest = Effect.fn("ConnectorProvider.sendTest")(function* (test: TestNotification) {
    yield* Effect.annotateCurrentSpan({
      testId: test.testId,
      targetId: test.target.id,
      connector: connector.type,
    });
    const now = yield* Clock.currentTimeMillis;
    yield* deliver(test.target, {
      kind: "test",
      id: test.testId,
      submissionId: test.testId,
      receivedAt: now,
      form: test.form,
      fields: testWebhookFields,
    });
  });

  return { send, sendTest } satisfies NotificationProvider["Service"];
});
