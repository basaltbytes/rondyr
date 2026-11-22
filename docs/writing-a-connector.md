# Write a connector

A connector sends the accepted messages of a form to one outside service; [docs/connectors.md](./connectors.md) describes the three that Rondyr has, and [architecture.md](../architecture.md) the design. A connector is one file in `apps/rondyr/src/domain/deliveries/connectors/`. It declares the settings an admin types and a pure function that builds one HTTPS request from these settings and a message. Rondyr does the rest for every connector: the admin API, the form in the dashboard, the encryption of secrets, the delivery with its retries and history, and the test send.

```ts
import { Schema } from "effect";

import { defineConnector, lineOf } from "./connector.ts";

export const ntfy = defineConnector({
  type: "ntfy",
  label: "ntfy",
  // A request to any other host is not sent.
  hosts: ["ntfy.sh"],
  // One key per setting. Schema.optionalKey makes a setting optional.
  settings: Schema.Struct({
    topic: lineOf(64),
    token: lineOf(200),
  }),
  // Encrypted in D1 and never returned by the API.
  secrets: ["token"],
  // Runs again with the same message on a retry.
  request: ({ topic, token }, message) => ({
    method: "POST",
    url: "https://ntfy.sh/",
    headers: { authorization: `Bearer ${token}` },
    body: { topic, title: message.form.name, message: Object.values(message.fields).join("\n") },
  }),
  // What a status means, in the error of an attempt.
  statusHints: new Map([[401, "ntfy refused the token."]]),
});
```

Then:

1. List it in `catalog.ts`, in `ConnectorType` and in `catalog`. The type check fails while one of the two is missing.
2. Add its texts to both locale files of the dashboard, under `inbox.connectors.types.<type>`: `about`, and a `label` and a `hint` per setting. `pnpm test` fails while a setting has no text in one language.
3. Test `request` as the other connectors do (`discord.test.ts`): it is a pure function, so a test needs no network and no double.
4. Document the service in [docs/connectors.md](./connectors.md), for the person who sets it up.

`message.kind` is `"test"` for a test send, when the service needs another request than for a real message, as Airtable does. `message.id` is the delivery ID, the same on every attempt, and `message.submissionId` is the same for every delivery of a submission: use one of them as the idempotency key when the service takes one.

A connector sends one request per attempt and gets only its status. A service that needs a token exchange before each request, or an answer to read, does not fit a connector yet: use a webhook to a small Worker of your own.
