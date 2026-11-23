# Send messages to Discord, Slack or Airtable

A connector sends every accepted message of a form to a service your team already uses. Rondyr has three: Discord and Slack post the message to a channel, and Airtable adds it as a row of a table.

A connector is a destination, like an [email](./email.md) or a [webhook](./webhooks.md). A form can have several, and each one gets its own delivery, with the same retries and the same history. For a service that has no connector, use a webhook, or [write the connector](./writing-a-connector.md).

Rondyr encrypts the webhook URL or the token of a connector with `RONDYR_SECRETS_KEY`, which button deployments generate automatically. On an Alchemy deployment, set `RONDYR_SECRETS_KEY_PROD` first; see [deployment.md](./deployment.md#encryption-key). Without the key, the dashboard refuses to add a connector and says why.

## Add a connector

1. Open your form from **Forms** in the sidebar (admins only) and go to **Destinations**.
2. Under **New destination**, choose the service and give the destination a name, such as the name of the channel. The name shows in the list of destinations and in the deliveries of a message.
3. Fill in the settings of the service, described below, and select **Add connector**.
4. The new destination opens on its settings. Select **Send a test** to check them. The answer of the service shows under the button.

A secret setting is never shown again once it is saved. To change a setting, open the destination, select **Edit settings** and type every secret again.

Only messages accepted after you add (or reactivate) a connector are sent to it; a quarantined message goes out when someone accepts it.

## Discord

Rondyr posts one embed per message to a channel: the form name as the title, one field per form field, and the delivery ID at the bottom.

1. In Discord, open the settings of the channel, then **Integrations → Webhooks**, and create a webhook.
2. Select **Copy Webhook URL** and paste it in **Webhook URL**. It looks like `https://discord.com/api/webhooks/123456789012345678/…`.

The message pings nobody: `@everyone`, a role or a member typed by a visitor stays plain text, and a link always shows its real URL. Discord limits an embed to 25 fields, 1,024 characters per value and 6,000 characters in total, so Rondyr cuts a longer message and says so in the embed. The whole message stays in the Rondyr inbox. A field that the visitor left empty is not shown.

## Slack

Rondyr posts the form name, one section per form field, and the delivery ID.

1. Create a Slack app for your workspace at [api.slack.com/apps](https://api.slack.com/apps), or open one you have.
2. Under **Incoming Webhooks**, turn the feature on, select **Add New Webhook to Workspace** and choose the channel.
3. Copy the webhook URL and paste it in **Webhook URL**. It starts with `https://hooks.slack.com/services/`.

Rondyr escapes what a visitor types, so `<!channel>` or a disguised link stays plain text. A value longer than 3,000 characters is cut. The URL of a Slack workflow trigger (`https://hooks.slack.com/triggers/…`) is refused, because a workflow takes another body: send to a workflow through a [webhook](./webhooks.md) instead.

## Airtable

Rondyr adds one row per message. Each form field goes to the column of the same name, and Airtable converts the text to the type of the column, for example a date or a single select.

1. Give the table one column per field of your form, with the exact name of the field: a form that posts `email` and `message` needs the columns `email` and `message`.
2. Create a personal access token in the [Airtable Builder Hub](https://airtable.com/create/tokens), with the `data.records:write` scope and access to the base. Paste it in **Personal access token**.
3. Copy the base ID from the URL of the base (`airtable.com/appXXXXXXXXXXXXXX/…`) to **Base ID**, and type the name of the table in **Table**.

A message with a field that has no column fails with `HTTP 422`, and its delivery says to check the columns. Add the column, then retry the delivery from the message. Airtable answers `HTTP 403` both for a token without the scope or the base and for a base ID or a table that it does not find, so check all four.

**ID column** is optional. Rondyr may send the same delivery twice, for example when Airtable answers too late. With the name of a text column in **ID column**, Rondyr writes the submission ID there and updates the row it already added, so a retry never adds a second row. Without it, a retry after a lost answer can add a duplicate row. Choose a column that no field of your form is named after: Rondyr matches rows on this column, so the ID replaces the value of a form field of the same name.

A test adds an empty row, or a row with only the ID column, since your table may have no column that a test message fits. Delete it afterwards.

## Retries and failures

A connector delivery follows the rules of every destination. Rondyr retries after a network error, a timeout of 30 seconds, or an answer `408`, `425`, `429` or `5xx`: six attempts, 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours apart. Any other answer ends the delivery, because a retry would get the same one: a deleted webhook, a revoked token, a missing column.

Open the message in the inbox to see its deliveries, the answer of each attempt and, for a failed one, **Retry delivery** ([Read and sort messages](./inbox.md)). The error of an attempt has the HTTP status and, for the common ones, what to check. It never contains the answer of the service or the content of the message.
