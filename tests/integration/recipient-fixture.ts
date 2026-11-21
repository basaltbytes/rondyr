import { env } from "cloudflare:workers";
import { assert, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { call } from "./organization-fixture.ts";

const ResendEmail = Schema.Struct({
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
});
const readEmails = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ body: Schema.fromJsonString(ResendEmail) })),
);

/** Mark addresses as confirmed by an organization, as its owner's click on the link does. */
export const confirmRecipients = (organizationId: string, addresses: ReadonlyArray<string>) =>
  Effect.promise(() =>
    env.DB.batch(
      addresses.map((address) =>
        env.DB.prepare(`
          INSERT INTO email_recipient_confirmations (organization_id, address, confirmed_at, created_at)
          VALUES (?, ?, 0, 0)
          ON CONFLICT (organization_id, address) DO UPDATE SET confirmed_at = 0
        `).bind(organizationId, address.toLowerCase()),
      ),
    ),
  );

const received = (recipient: string) =>
  env.RESEND_FIXTURE.fetch(
    `https://api.resend.com/__received?recipient=${encodeURIComponent(recipient)}`,
  ).then((response) => response.json());

/** The emails that the Resend fixture received for a recipient, oldest first. */
export const emailsTo = Effect.fnUntraced(function* (recipient: string) {
  const body = yield* Effect.promise(() => received(recipient));
  return (yield* readEmails(body)).map((entry) => entry.body);
});

const linkPattern = /\/confirm-recipient#([A-Za-z0-9_-]{43})/u;

/** The secret of the last confirmation link that a recipient got, once `count` links arrived. */
export const confirmationToken = Effect.fnUntraced(function* (recipient: string, count = 1) {
  const emails = yield* Effect.promise(() =>
    vi.waitFor(
      () =>
        received(recipient).then((body) => {
          const links = Array.isArray(body)
            ? body.filter((entry) => linkPattern.test(String(entry.body)))
            : [];
          assert.isAtLeast(links.length, count);
          return links;
        }),
      { timeout: 10_000, interval: 100 },
    ),
  );
  const decoded = yield* readEmails(emails);
  const token = linkPattern.exec(decoded.at(-1)?.body.text ?? "")?.[1];
  if (token === undefined) return assert.fail(`Expected a confirmation link for ${recipient}`);
  return token;
});

/** Confirm a recipient through the public route, with the link of its last email. */
export const confirmByEmail = Effect.fnUntraced(function* (
  recipient: string,
  worker: Fetcher = env.TEST_WORKER,
) {
  const token = yield* confirmationToken(recipient);
  const response = yield* call(
    "POST",
    "/api/recipient-confirmations",
    { token },
    undefined,
    worker,
  );
  assert.strictEqual(response.status, 204);
});
