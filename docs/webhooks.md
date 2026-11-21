# Webhooks

When a message is accepted, automatically or in review, Rondyr sends it as an HTTPS `POST` to each active webhook of its form. Every request is signed with HMAC-SHA-256, and every attempt of the same delivery carries the same delivery ID.

A quarantined message is sent only once someone accepts it. A webhook created after a message was accepted doesn't receive that message, and neither does a webhook that was inactive when the message was accepted.

## Setup

The Worker needs `RONDYR_SECRETS_KEY` to store signing secrets; [deployment.md](./deployment.md#encryption-key) explains how to set it. Without it, creating a webhook or rotating its secret answers `503` with `{"error":"secrets-key-missing"}`, and the rest of Rondyr works as before.

In the dashboard, open **Destinations**, pick the form, enter the URL of the recipient under **Webhooks**, and click **Add webhook**. Rondyr generates a signing secret and shows it once: copy it into the recipient's configuration before you leave the page. **Rotate secret** issues a new one, **Deactivate** stops deliveries for messages accepted from then on, and **Send a test** sends a [test request](#test-requests) and shows the answer.

The dashboard calls these routes, which need a session cookie and the `Origin` of the Worker:

| Route | Effect |
| --- | --- |
| `GET /api/organizations/:organizationId/forms/:publicId/targets` | Lists the form's webhooks, without their secrets |
| `POST /api/organizations/:organizationId/forms/:publicId/targets` | Creates a webhook from `{"type":"webhook","url":"https://…"}` and returns it with its secret (`201`) |
| `POST /api/organizations/:organizationId/targets/:targetId/rotate-secret` | Returns the webhook with a new secret |
| `POST /api/organizations/:organizationId/targets/:targetId/deactivate` or `/activate` | Returns the webhook with its new state |
| `POST /api/organizations/:organizationId/targets/:targetId/test` | Sends a test request and returns its result |

A form or webhook of an organization the account isn't a member of answers `404`. The creation and rotation responses are the only ones that contain a secret, and they are sent with `Cache-Control: no-store`.

## Destination rules

Rondyr checks the URL when the webhook is created and again before each attempt. It refuses:

- any scheme other than `https:`;
- a user name or password in the URL;
- a port other than the default one, 443;
- `localhost`, names under `.localhost`, `.local`, `.internal` and `.home.arpa`, and names without a dot;
- IPv4 literals in reserved ranges: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4` and `240.0.0.0/4`;
- IPv6 literals outside `2000::/3`, which covers loopback, IPv4-mapped addresses, NAT64, unique local, link-local and multicast addresses, and inside it `2001::/23`, `2001:db8::/32`, `2002::/16` and `3fff::/20`;
- the host of the Worker itself, from `BETTER_AUTH_URL`.

The URL parser normalizes hosts first, so `https://2130706433/` and `https://0x7f.1/` are refused as `127.0.0.1`.

A Worker can't resolve a hostname before it calls `fetch`, so these rules only see the URL. A public hostname whose DNS record points to a private address passes them. Any admin of an organization can make the Worker send requests to such a hostname, so give the admin role to people you trust.

The API answers `400` with `{"error":"destination-refused","reason":"…"}` and one of these reasons: `invalid-url`, `not-https`, `credentials`, `custom-port`, `local-hostname`, `reserved-address`, `worker-origin`. A stored URL that fails the check before an attempt ends the delivery as failed, with the reason in its error summary.

## Request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: Rondyr-Webhook/1
Rondyr-Delivery-Id: 1b4e28ba-2fa1-4d2b-883f-0016d3cca427
Rondyr-Timestamp: 1795190400
Rondyr-Signature: v1=5f2b…
```

| Header | Value |
| --- | --- |
| `Rondyr-Delivery-Id` | UUID of the delivery, the same on every attempt. Use it to drop duplicates |
| `Rondyr-Timestamp` | When this attempt was signed, in seconds since the Unix epoch |
| `Rondyr-Signature` | One or two signatures, `v1=<hex>`, separated by commas |

The body is version 1 of the payload:

```json
{
  "version": 1,
  "type": "submission.accepted",
  "deliveryId": "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
  "submission": {
    "id": "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640",
    "receivedAt": "2026-11-20T13:20:00.000Z",
    "fields": {
      "email": "visitor@example.com",
      "message": "Is there room in the pottery class?"
    }
  },
  "form": { "id": "YOUR_PUBLIC_ID", "name": "Classes" }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Payload version. A change that removes or changes a field gets a new version |
| `type` | `"submission.accepted"` or `"test"` | `"test"` for a [test request](#test-requests) sent from the dashboard |
| `deliveryId` | UUID | Same value as `Rondyr-Delivery-Id` |
| `submission.id` | UUID | The `submission-id` returned by `POST /f/:public-id` |
| `submission.receivedAt` | ISO 8601, UTC | When Rondyr stored the submission |
| `submission.fields` | Object of strings | The fields as received, 1 to 32 of them |
| `form.id` | String | The public ID of the form, as in `/f/<public-id>` |
| `form.name` | String | The form name set in the dashboard |

Treat `submission.fields` as an unordered JSON object. Rondyr serializes field names that are JavaScript array indices, such as `"1"` and `"2"`, first in numeric order.

Version 1 can gain fields, so ignore the ones you don't know. Bodies larger than 64 KiB are never sent; a submission is at most 16 KiB, so this limit only stops a malformed record.

## Signature

Rondyr computes HMAC-SHA-256 over the UTF-8 bytes of `<Rondyr-Timestamp>.<body>`, with the UTF-8 bytes of the secret as the key, and writes it as lowercase hex. The secret is the whole string the dashboard shows, `whsec_` prefix included. A recipient should:

1. Reject a timestamp more than five minutes away from its own clock, which limits replays.
2. Compute the signature over the raw body, before parsing it as JSON.
3. Accept the request if any `v1=` value matches, with a constant-time comparison.

This TypeScript function does all three with Web Crypto. It runs in Workers, Deno, Bun, Node.js 20 and later, and browsers. It is [docs/examples/verify-webhook.ts](./examples/verify-webhook.ts), which the test suite runs against the requests Rondyr sends.

```ts
const toleranceSeconds = 300;
const encoder = new TextEncoder();

function hexBytes(hex: string) {
  if (!/^[0-9a-f]{64}$/u.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Returns the raw body of a Rondyr webhook request when one of its signatures
 * matches `secret` and its timestamp is at most five minutes away from `now`,
 * in milliseconds. Returns null otherwise.
 */
export async function verifyRondyrWebhook(request: Request, secret: string, now = Date.now()) {
  const timestamp = request.headers.get("rondyr-timestamp") ?? "";
  const header = request.headers.get("rondyr-signature") ?? "";
  if (!/^\d+$/u.test(timestamp)) return null;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return null;

  const body = await request.text();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${timestamp}.${body}`);
  for (const part of header.split(",")) {
    const [scheme, value = ""] = part.trim().split("=", 2);
    const signature = scheme === "v1" ? hexBytes(value) : null;
    // crypto.subtle.verify compares in constant time.
    if (signature !== null && (await crypto.subtle.verify("HMAC", key, signature, signed))) {
      return body;
    }
  }
  return null;
}
```

In a recipient Worker:

```ts
import { verifyRondyrWebhook } from "./verify-webhook.ts";

export default {
  async fetch(request: Request, env: { RONDYR_WEBHOOK_SECRET: string }) {
    const body = await verifyRondyrWebhook(request, env.RONDYR_WEBHOOK_SECRET);
    if (body === null) return new Response(null, { status: 401 });
    const payload = JSON.parse(body);
    // A test request from the dashboard: the signature is valid, there is nothing to store.
    if (payload.type === "test") return new Response(null, { status: 204 });
    // Look up payload.deliveryId in your own store and stop here if you have seen it.
    return new Response(null, { status: 204 });
  },
};
```

## Test requests

**Send a test** in the dashboard, or the `test` route, sends one request to the webhook. Rondyr checks the URL with the [destination rules](#destination-rules) and signs the request with the current secrets, as for a delivery. The body is version 1 of the payload with the type `test`:

```json
{
  "version": 1,
  "type": "test",
  "deliveryId": "4f0c8a52-91d3-4b6e-a8f7-2c5d1e9b3a60",
  "submission": {
    "id": "4f0c8a52-91d3-4b6e-a8f7-2c5d1e9b3a60",
    "receivedAt": "2026-11-20T15:42:07.000Z",
    "fields": {
      "message": "Test message sent from the Rondyr dashboard. No visitor sent it."
    }
  },
  "form": { "id": "YOUR_PUBLIC_ID", "name": "Classes" }
}
```

`deliveryId`, `submission.id` and the `Rondyr-Delivery-Id` header have the same value, a new UUID for each test, and no submission or delivery has it. `receivedAt` is the time of the test. A recipient that stores messages should verify the signature, then skip a request whose `type` is `test`.

Rondyr sends a test request once, never retries it, and waits up to 30 seconds for the answer. It stores nothing: no submission, no delivery, no attempt. The route answers with the result, where `summary` follows the rules of [Responses and retries](#responses-and-retries):

```json
{ "testId": "4f0c8a52-91d3-4b6e-a8f7-2c5d1e9b3a60", "outcome": "permanent-failure", "summary": "The recipient answered HTTP 400." }
```

`outcome` is `delivered` (without `summary`), `retryable-failure` for an answer that a delivery would retry, or `permanent-failure`. An inactive webhook can be tested. While a test of a webhook runs, a second test of the same webhook answers `409`; the check is per Worker instance, so two tests sent to different instances can run together.

## Secret rotation

**Rotate secret**, or the `rotate-secret` route, returns a new secret. For the next 24 hours Rondyr signs each request with both secrets, the new one first:

```http
Rondyr-Signature: v1=<signature with the new secret>,v1=<signature with the previous secret>
```

The recipient can therefore switch to the new secret at any point in those 24 hours without rejecting a request. After that, only the new secret signs. Rotating again within the window issues a third secret, drops the oldest one at once, and starts a new 24-hour window for the second one, so at most two secrets sign at any time. If a secret has leaked, rotate it and configure the recipient with the new one straight away: the recipient decides which secrets it accepts.

## Responses and retries

Rondyr reads only the status code of the response. It never reads or stores the body, and the error summary of an attempt contains the status code, never the message fields.

| Response | Result |
| --- | --- |
| `2xx` | Delivered |
| `3xx` | Failed. Redirects are not followed |
| `408`, `425`, `429`, `5xx` | Retried |
| No response, a network error, or no answer within 30 seconds | Retried |
| Any other `4xx` | Failed |

A delivery gets up to 6 attempts. After a retryable failure, the next attempt starts 1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours later; after the sixth, the delivery is marked as failed. The delay is a minimum: the cron job that publishes due deliveries runs once a minute.

A failure that no retry can fix also ends the delivery at once: an invalid stored configuration, a URL that the destination rules now refuse, or a secret that can't be decrypted because `RONDYR_SECRETS_KEY` was removed or changed.

## Delivery history and manual retry

Under the fields of an accepted message, the dashboard lists its deliveries: the destination, the status, the number of attempts, the time of the next attempt while a retry waits, and each attempt with its start and end times, its result and its error summary. The summary is the one Rondyr stored, so it contains a status code and never the message fields. **Refresh deliveries** reloads the list.

A failed delivery has a **Retry delivery** button. The retry keeps the delivery ID, so the recipient gets the same `Rondyr-Delivery-Id` and can drop the request if it processed it already. It starts a new series of up to 6 attempts with the delays above, and the attempts before it stay in the history, numbered on from the last one. The retry goes through the delivery queue like any attempt: two retries clicked at the same time, or a retry while the cron job runs, start one attempt. Only a failed delivery can be retried; any other status, and the second of two simultaneous retries, answers `409`.

| Route | Effect |
| --- | --- |
| `GET /api/organizations/:organizationId/submissions/:submissionId/deliveries` | Lists the deliveries of the submission, oldest first, each with its attempts |
| `POST /api/organizations/:organizationId/submissions/:submissionId/deliveries/:deliveryId/retry` | Retries a failed delivery and returns the list |

Each delivery in the list has this shape:

```json
{
  "id": "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
  "destination": { "targetId": "…", "type": "webhook", "url": "https://hooks.example.com/rondyr" },
  "status": "retrying",
  "attemptCount": 1,
  "nextAttemptAt": 1795190460000,
  "lastError": "The recipient answered HTTP 503.",
  "createdAt": 1795190399000,
  "attempts": [
    {
      "attempt": 1,
      "startedAt": 1795190399500,
      "finishedAt": 1795190400000,
      "outcome": "retryable-failure",
      "error": "The recipient answered HTTP 503."
    }
  ]
}
```

`status` is `pending`, `processing`, `delivered`, `retrying` or `failed`. `nextAttemptAt` is set only while the status is `retrying`. An attempt `outcome` is `delivered`, `retryable-failure`, `permanent-failure`, `interrupted` (the Worker stopped before it recorded the result), or `null` while the attempt runs. Times are milliseconds since the Unix epoch. An email destination has `"type": "email"` and `recipients` instead of `url`. A submission or delivery of an organization the account isn't a member of answers `404`.

## Delivery guarantee

Delivery is at least once. If the Worker stops between sending a request and recording its result, it sends the request again about two minutes later, with the same `Rondyr-Delivery-Id`, and a recipient that answered `2xx` the first time receives it twice. Store the delivery IDs you have processed and ignore repeats.

Attempts for different messages run independently, so a recipient can receive them out of order. Use `submission.receivedAt` to order them.

## Roles

Only an admin of the organization manages its webhooks, retries a failed delivery and sends a test, at most 3 tests a minute per destination. A reviewer reads the delivery history.
