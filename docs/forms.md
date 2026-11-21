# Forms

Each form has a public URL, `https://<your Rondyr origin>/f/<public-id>`. Open **Forms** in the dashboard to copy it. A browser, a page script, or a server can post to it; this page describes what the URL accepts and what it answers. A server that holds an API token can also use [server intake](./api.md#server-intake), which skips the browser checks.

## Send a submission

Post the fields of the message to the form URL:

```sh
curl --json '{"email":"visitor@example.com","message":"Is there room in the pottery class?"}' \
  https://rondyr.example.com/f/YOUR_PUBLIC_ID
```

```json
{ "submission-id": "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640", "status": "received" }
```

An HTML form works with the same URL:

```html
<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

A page on another origin can call the same URL with `fetch`. Rondyr answers the CORS preflight on the form URL, so the browser lets the page post JSON:

```js
const response = await fetch("https://rondyr.example.com/f/YOUR_PUBLIC_ID", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visitor@example.com", message: "Is there room in the pottery class?" }),
});
if (!response.ok) throw new Error(`Rondyr answered ${response.status}`);
const { "submission-id": submissionId } = await response.json();
```

Don't send cookies: `credentials: "include"` makes the browser refuse the response.

A `202` means D1 has stored the submission and the event that queues it for classification, in one transaction. It doesn't mean the classifier has run.

## Request body

The body can be `application/json`, `application/x-www-form-urlencoded`, or `multipart/form-data`, up to 16 KiB, with 1 to 32 message fields of at most 4,000 characters each. A field name has 1 to 100 characters, with no control character or line break. The optional `cf-turnstile-response` field is separate from the message. See [Rate limits and daily quotas](#rate-limits-and-daily-quotas) for the per-client, per-form, and daily organization limits.

## Responses

| Status | Meaning |
| --- | --- |
| `202` | Stored. The JSON body has `submission-id` and `status: "received"` |
| `303` | Stored, and the browser is sent to the form's success URL (see below) |
| `400` | Invalid body or fields, a file in a multipart body, or no message fields after removing the Turnstile token and an empty honeypot |
| `403` | The form is suspended, or a browser on an origin that the form doesn't allow sent it. Nothing is stored |
| `404` | Unknown form |
| `413` | Body larger than 16 KiB |
| `415` | Another content type |
| `429` | The client or form reached its minute limit, or the organization reached a daily quota: the submission quota, or the junk quota for a submission that intake would quarantine as junk. `Retry-After` gives the wait in seconds. Nothing is stored |
| `503` | D1 unavailable |

## HTML forms

A browser that posts an HTML form sends `Accept: text/html`. Rondyr answers it with a confirmation page, in French or in English depending on the browser's `Accept-Language`, and the status `202`, or, when the form has a success URL, with `303 See Other` to that URL. You set the success URL for each form in **Forms**. It must use HTTPS, and its origin must be one of the form's [allowed origins](#allowed-origins), so add the origin first. Rondyr only redirects to the stored URL: a field, a query parameter, or a header of the request can't choose another one. A `fetch` with a JSON body, or a client that doesn't accept HTML, gets the `202` JSON answer.

A group of checkboxes or a multiple `<select>` sends the same field name several times. Rondyr joins the values with `, ` in the order received, so `topic=glaze&topic=kiln` is stored as `topic: "glaze, kiln"`. The joined value must still fit in 4,000 characters. JSON bodies take string values only.

`multipart/form-data` (`enctype="multipart/form-data"`) works for text fields only. A part with a filename, including a file input left empty, makes Rondyr answer `400` and store nothing.

## Honeypot field

A honeypot is a field that people don't see and leave empty, while many bots fill in every field they find. Name it for each form in **Forms**, for example `_hp`, then add it to your form, hidden with CSS rather than with `type="hidden"`, out of the tab order and of autofill:

```html
<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <div aria-hidden="true" style="position: absolute; left: -10000px">
    <label>Leave this field empty <input type="text" name="_hp" tabindex="-1" autocomplete="off" /></label>
  </div>
  <button type="submit">Send</button>
</form>
```

When the field arrives empty, Rondyr removes it before storing the message, so it never reaches the classifier, a webhook, or an email. When it has a value, Rondyr gives the usual answer (the same `202`, confirmation page, or redirect), stores the message with the field, and quarantines it with the reason **Honeypot field filled** without calling the classifier. You can still accept it in the dashboard, for example when a browser's autofill filled the field, and its deliveries then go out as for any accepted message. A body with the empty honeypot field as its only field gets `400`. Without a honeypot field, a field named `_hp` is an ordinary field.

## Suspended forms

A suspended form answers `403` to every submission and stores nothing, with the same CORS headers as an active form. Its messages, its destinations, its allowed origins, and its URL don't change, and reactivating it accepts submissions again. Suspend and reactivate a form in **Forms**.

## Turnstile

Create a Cloudflare Turnstile widget for the hostname that serves your form. In **Forms**, pick the form, save the widget's site key and secret key, then copy the HTML into your form. For a JSON integration, send the widget's token in the `cf-turnstile-response` field. The Worker needs `RONDYR_SECRETS_KEY` to encrypt the widget secret in D1. [Cloudflare's widget setup guide](https://developers.cloudflare.com/turnstile/get-started/)

When you save the keys, Rondyr asks Siteverify whether it knows the secret key. If Siteverify refuses it, for example because a character is missing, nothing is saved and the dashboard asks you to copy the key again. If Siteverify doesn't answer, nothing is saved either; try again a moment later. Cloudflare's [test secret keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) pass this check.

Rondyr removes the token before storing the message. A missing or refused token sends the message to **To review** with the reason **Turnstile verification failed**, and the visitor still gets the usual response. Rondyr reads Siteverify's answer from the JSON body of an HTTP 200 or 400 reply, so a refusal counts whatever its status. If Siteverify doesn't answer within five seconds, answers with another status, reports `internal-error`, or no longer recognizes the secret key, Rondyr logs the incident and lets the other intake checks and classification proceed.

A key can stop working after you saved it: someone deletes the widget in Cloudflare, or `RONDYR_SECRETS_KEY` changes and the stored key no longer decrypts. Messages then go to classification without the Turnstile check. Each time you open the form in **Forms**, Rondyr decrypts the stored key and asks Siteverify about it again. If the key no longer works, the Turnstile card warns that Turnstile isn't protecting the form; save both keys again to turn it back on. If Cloudflare doesn't answer, the card says so, and reloading the page checks again. The same check is available at `GET /api/organizations/:organizationId/forms/:publicId/turnstile`, which returns `{"state":"working"}`, `refused`, `unreadable` or `unchecked`.

## Allowed origins

By default a form accepts submissions from a page on any origin. To restrict it, open **Allowed origins** in the dashboard and add the origins of your site, such as `https://www.example.com`. An origin is a scheme, a host, and an optional port, with no path. It must use HTTPS, except `http://localhost` and loopback addresses such as `http://127.0.0.1:8080` during development.

Once a form has at least one allowed origin, Rondyr answers `403` to a browser that sends any other `Origin` header, whether it posts with `fetch` or with an HTML form, and stores nothing. The origin of the form's success URL can't be removed from the list while the success URL is set; clear the success URL first. A request without an `Origin` header, from curl or a server, is still accepted, and so is one with `Origin: null`, which a browser sends when the page hides its origin (a `no-referrer` policy, a sandboxed frame). This list keeps another site from sending messages to your form through its visitors' browsers; it doesn't stop spam from scripts, which can send any header.

## Rate limits and daily quotas

Rondyr limits each client to 5 submissions per minute on each form, before it stores anything, so a single client can't use up the form's own cap of 30 per minute and get other visitors' messages refused. A client is the IP address that Cloudflare sends in `CF-Connecting-IP`, or the `/64` network of an IPv6 address. The counters are in Cloudflare's [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding, not in D1, so Rondyr stores no IP address. Cloudflare counts per data center and approximately: a client can get a few more submissions through, and the form's cap still applies to everyone. When the counter doesn't answer, the submission is accepted. A request without `CF-Connecting-IP`, as in local development, isn't counted.

Both minute limits answer `429` with `Retry-After: 60` and store nothing. A page on an allowed origin can read the response and the `Retry-After` header.

**Daily quotas** shows usage across the organization's forms for the current UTC day. The defaults are 2,000 stored submissions and 1,000 classifications. An admin of the organization can change the limits there or with `PUT /api/organizations/:organizationId/quotas`, using integer fields `submissions` (1 to 100,000) and `classifications` (0 to 100,000). A `GET` on the same URL returns the UTC day, limits and usage.

Junk has its own storage quota, equal to the submission limit. Junk is a message that intake quarantines because it filled the honeypot field, failed Turnstile, or repeats earlier messages; **Daily quotas** counts it under **Junk caught at intake**, and the API under `used.junk`. A bot that sends junk all day uses up the junk quota, not the one of your visitors. An organization therefore stores at most twice its submission limit per day: 4,000 messages with the default.

After a storage quota is reached, Rondyr returns `429` with the number of seconds until midnight UTC in `Retry-After`, and stores nothing: junk is refused once the junk quota is reached, any other submission once the submission quota is reached. Junk normally gets the same `202` as other messages, so the `429` tells a bot that it was caught; that is the price of not letting it fill the submission quota. After the classification quota is reached, Rondyr stores messages and sends them to review with the reason **Daily classification quota reached**. Those messages can be real, so they use the submission quota, not the junk one. A submission uses one classification slot when intake admits it to the classifier. Workflow retries use the same slot. When an ambiguous submission goes to a second model, the escalation uses one more slot, taken before the call; if none is left, the second model isn't called and the submission stays in review as ambiguous.
