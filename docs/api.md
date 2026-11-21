# API tokens

An organization member can create or revoke tokens in **Settings → API tokens**. Enter a name that identifies the client, then copy the token: Rondyr shows it once, right after creation, and never again. The list shows each token's name, creation date and last four characters. Each organization can have up to ten active tokens. Revoking a token frees a slot, and the next request with that token gets `401`; a revoked token can't be reactivated.

## Authentication

Send the token in the `Authorization` header as a Bearer credential. Tokens start with `rdr_`, followed by 32 random bytes encoded as unpadded base64url. Rondyr uses the token whenever the request includes it, even if the request also has a dashboard session cookie. An `Origin` header is optional.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer ${RONDYR_API_TOKEN}" \
  https://rondyr.example.com/api/organizations
```

The response is an array with one entry, the token's organization: `id`, `name`, and `forms`, each form with `name`, `publicId`, `status`, `businessContext`, `successUrl`, `honeypotField` and `turnstileSiteKey`. Use the organization's `id` in the review routes below.

## Routes

Paths beginning with `/{organizationId}` in this table are relative to `/api/organizations`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/organizations` | An array with the token's organization and its forms |
| `GET` | `/{organizationId}/submissions` | Up to 25 submissions, newest first, and a cursor for the next page. Optional filters are `status`, `form` (the form's public ID), and `after` (the cursor) |
| `GET` | `/{organizationId}/submission-counts` | Submission counts by status for the organization and each form with submissions |
| `GET` | `/{organizationId}/submissions/{submissionId}` | Submission detail |
| `POST` | `/{organizationId}/submissions/{submissionId}/approve` | Accepts a quarantined submission and returns its updated detail |
| `POST` | `/{organizationId}/submissions/{submissionId}/dismiss` | Archives a quarantined submission and returns its updated detail |

Both decision routes take an empty body, and the decision event stores the token ID. An accepted submission goes to the form's destinations, as when a reviewer accepts it in the dashboard. Every other `/api` route answers `403` to a token, including `POST /{organizationId}/submissions/{submissionId}/reclassify` and the stuck submission routes, which the dashboard uses.

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${RONDYR_API_TOKEN}" \
  "https://rondyr.example.com/api/organizations/${ORGANIZATION_ID}/submissions/${SUBMISSION_ID}/approve"
```

## Responses

A submission in a list or a detail has these fields:

| Field | Value |
| --- | --- |
| `submissionId` | The submission's UUID |
| `organizationId`, `formId` | Internal IDs |
| `formPublicId`, `formName` | The form's public ID, as in its submission URL, and its name |
| `receivedAt` | Unix milliseconds |
| `status` | `received`, `classifying`, `quarantined`, `accepted` or `archived` |
| `reason` | Why the submission is quarantined, or `null`: `probable-spam`, `ambiguous`, `solicitation`, `low-relevance`, `classification-error`, `honeypot`, `repetition`, `turnstile-failed` or `quota` |
| `label` | `off-topic` for a submission that the classifier accepted but found off-topic, or `null` |

A list entry also has `preview`, the fields with each value cut to 240 characters. A detail has `fields`, the full values. The list response is `{"entries": […], "cursor": …}`; pass `cursor` as `after` to read the next page, until it is `null`.

The counts response has one number per status (`received`, `classifying`, `accepted`, `quarantined`, `archived`) and `forms`, an array of `{"publicId", "counts"}` with the same numbers for each form that has a submission.

## HTTP errors

| Status | Meaning |
| --- | --- |
| `400` | An invalid route parameter, filter, or cursor |
| `401` | A missing, malformed, unknown, or revoked credential |
| `403` | The token is valid, but the route requires a dashboard session |
| `404` | The organization or submission doesn't exist or belongs to another organization |
| `409` | The submission is no longer quarantined |
| `503` | Authentication or the inbox is temporarily unavailable |

Error responses have an empty body.

## Manage tokens with a session

These routes take the dashboard's Better Auth session from the same origin, and answer `403` to a token. The base path is `/api/organizations/{organizationId}/api-tokens`.

| Method | Request | Result |
| --- | --- | --- |
| `GET` | Base path | `200` with the active tokens, newest first. Each entry contains `id`, `name`, `suffix`, and `createdAt` (Unix milliseconds) |
| `POST` | Base path with JSON `{"name":"Site inbox"}` | `201` with the metadata and a `token` field. This is the only response that contains the token, and it has `Cache-Control: no-store` |
| `DELETE` | Base path with `?id={tokenId}` | `204` after revocation |

Creation returns `400` for an invalid name and `409` when the organization already has ten active tokens. Names have 1 to 100 characters after trimming. An account that isn't a member of the organization gets `404`, and so does a revocation of a token that doesn't exist or is already revoked.
