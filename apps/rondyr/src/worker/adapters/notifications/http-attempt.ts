import { Effect, Option } from "effect";
import { HttpClientResponse } from "effect/http";

import { NotificationFailed } from "../../ports/notification-provider.ts";

export function permanent(summary: string) {
  return NotificationFailed.make({ retryable: false, summary });
}

export function retryable(summary: string) {
  return NotificationFailed.make({ retryable: true, summary });
}

/**
 * What the status of a response means for an attempt. 2xx is a success. 408,
 * 425, 429 and 5xx are retried; any other status ends the delivery. `who`
 * names the service that answered.
 */
export function failureFor(status: number, who: string) {
  if (status >= 200 && status < 300) return Option.none<NotificationFailed>();
  const answered = `${who} answered HTTP ${status}.`;
  if (status >= 300 && status < 400) {
    return Option.some(permanent(`${answered} Redirects are not followed.`));
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return Option.some(retryable(answered));
  }
  return Option.some(permanent(answered));
}

// The body is never read: a summary is the status code only.
export function discardBody(response: HttpClientResponse.HttpClientResponse) {
  const body = Option.flatMapNullishOr(HttpClientResponse.toWeb(response), (web) => web.body);
  if (Option.isNone(body)) return Effect.void;
  return Effect.tryPromise({ try: () => body.value.cancel(), catch: () => "cancel-failed" }).pipe(
    Effect.ignore,
  );
}
