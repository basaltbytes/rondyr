# API tokens

An organization member can create or revoke tokens in **Settings → API tokens**. Enter a name that identifies the client. Copy the token when Rondyr displays it after creation. The list shows the name, creation date, and last four characters. Each organization can have up to ten active tokens. Revoking one frees a slot and invalidates the credential for subsequent requests.

## Authentication

Send the token in the `Authorization` header as a Bearer credential. Tokens start with `rdr_`, followed by 32 random bytes encoded as unpadded base64url. Rondyr uses the token whenever the request includes it, even if the request also has a dashboard session cookie. An `Origin` header is optional.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer ${RONDYR_API_TOKEN}" \
  https://rondyr.example.com/api/organizations
```

The response contains the token's organization and its forms. Use the organization's `id` in the review routes below.

## Routes

Paths beginning with `/{organizationId}` in this table are relative to `/api/organizations`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/organizations` | An array with the token's organization and its forms |
| `GET` | `/{organizationId}/submissions` | Up to 25 submissions and a cursor for the next page. Optional filters are `status`, `form` (the form's public ID), and `after` (the cursor) |
| `GET` | `/{organizationId}/submission-counts` | Submission counts by status for the organization and each form with submissions |
| `GET` | `/{organizationId}/submissions/{submissionId}` | Submission detail |
| `POST` | `/{organizationId}/submissions/{submissionId}/approve` | Accepts a quarantined submission and returns its updated detail |
| `POST` | `/{organizationId}/submissions/{submissionId}/dismiss` | Archives a quarantined submission and returns its updated detail |

Both decision routes take an empty body. The decision event stores the token ID. Other administrative routes require a dashboard session.

## HTTP errors

| Status | Meaning |
| --- | --- |
| `400` | An invalid route parameter, filter, or cursor |
| `401` | A missing, invalid, unknown, or revoked credential |
| `403` | The token is valid but the administrative route requires a dashboard session |
| `404` | The organization or submission is missing or inaccessible to the token |
| `409` | The submission is no longer quarantined |
| `503` | Authentication or the inbox is temporarily unavailable |

## Manage tokens with a session

Use the same-origin Better Auth session for these routes. The base path is `/api/organizations/{organizationId}/api-tokens`.

| Method | Request | Result |
| --- | --- | --- |
| `GET` | Base path | `200` with active tokens. Each entry contains `id`, `name`, `suffix`, and `createdAt` (Unix milliseconds) |
| `POST` | Base path with JSON `{"name":"Site inbox"}` | `201` with the metadata and a `token` field. This response has `Cache-Control: no-store` |
| `DELETE` | Base path with `?id={tokenId}` | `204` after revocation |

Creation returns `400` for an invalid name and `409` at the active token limit. Names have 1 to 100 characters after trimming. A non-member gets `404`, as does a revoke for a missing or already revoked token.
