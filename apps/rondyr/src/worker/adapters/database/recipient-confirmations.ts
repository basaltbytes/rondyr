import { Clock, Effect, Layer, Redacted, Schema } from "effect";

import {
  EmailAddress,
  legacyEmailLanguage,
  type EmailAddress as Address,
} from "../../../domain/deliveries/email.ts";
import {
  confirmationEmailsPerDay,
  confirmationLifetimeMillis,
} from "../../../domain/deliveries/recipient-confirmation.ts";
import type { OrganizationId } from "../../../domain/submissions/submission.id.ts";
import type { TargetScope } from "../../ports/notification-targets.ts";
import {
  ConfirmationLimit,
  ConfirmationNotFound,
  RecipientConfirmations,
  RecipientConfirmed,
  RecipientNotFound,
} from "../../ports/recipient-confirmations.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { EmailConfiguration } from "../notifications/email-configuration.ts";
import { d1, database } from "./d1.ts";
import { hashSecret, newLinkSecret } from "./secret-hash.ts";

const unreadable = () => StorageUnavailable.make();
const decodeAddresses = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ address: Schema.String })),
);
const decodeTarget = Schema.decodeUnknownEffect(
  Schema.Struct({ configuration: Schema.fromJsonString(EmailConfiguration) }),
);
const decodeConfirmed = Schema.decodeUnknownEffect(
  Schema.Struct({ confirmed: Schema.Literals([0, 1]) }),
);
const encodeAddresses = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(EmailAddress)));

/** Addresses are compared without case, as the recipients of a target are. */
const key = (address: string) => address.toLowerCase();

// ?1 organization, ?2 address in lowercase, ?3 hash of the link, ?4 its expiry,
// ?5 the time in milliseconds, ?6 the daily number of emails. The day is the UTC
// date of ?5. The count covers every organization, so that the owner of an
// address gets at most ?6 emails a day however many organizations add it.
const reserve = `
  INSERT INTO email_recipient_confirmations
    (organization_id, address, token_hash, token_expires_at, emails_day, emails_sent, created_at)
  SELECT ?1, ?2, ?3, ?4, date(?5 / 1000, 'unixepoch'), 1, ?5
  WHERE (
      SELECT coalesce(sum(emails_sent), 0) FROM email_recipient_confirmations
      WHERE address = ?2 AND emails_day = date(?5 / 1000, 'unixepoch')
    ) < ?6
    AND NOT EXISTS (
      SELECT 1 FROM email_recipient_confirmations
      WHERE organization_id = ?1 AND address = ?2 AND confirmed_at IS NOT NULL
    )
  ON CONFLICT (organization_id, address) DO UPDATE SET
    token_hash = excluded.token_hash,
    token_expires_at = excluded.token_expires_at,
    emails_sent = CASE
      WHEN email_recipient_confirmations.emails_day = excluded.emails_day
        THEN email_recipient_confirmations.emails_sent + 1
      ELSE 1
    END,
    emails_day = excluded.emails_day
  RETURNING address
`;

const issue = Effect.fnUntraced(function* (organizationId: OrganizationId, address: Address) {
  const token = newLinkSecret();
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + confirmationLifetimeMillis;
  const db = yield* database;
  const statement = db
    .prepare(reserve)
    .bind(organizationId, key(address), tokenHash, expiresAt, now, confirmationEmailsPerDay);
  return { address, token, expiresAt, statement };
});

const request = Effect.fn("RecipientConfirmations.request")(function* (
  organizationId: OrganizationId,
  addresses: ReadonlyArray<Address>,
) {
  if (addresses.length === 0) return [];
  const db = yield* database;
  const pending = yield* Effect.forEach(addresses, (address) => issue(organizationId, address));
  const results = yield* d1(() => db.batch(pending.map(({ statement }) => statement)));
  const issued = yield* Effect.forEach(results, (result) =>
    decodeAddresses(result.results).pipe(Effect.mapError(unreadable)),
  );
  return pending
    .filter((_, index) => (issued[index]?.length ?? 0) > 0)
    .map(({ address, token, expiresAt }) => ({ address, token, expiresAt }));
});

const requestFor = Effect.fn("RecipientConfirmations.requestFor")(function* (
  target: TargetScope,
  address: string,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT t.configuration FROM notification_targets t
      WHERE t.id = ?1 AND t.organization_id = ?2 AND t.type = 'email'
        AND EXISTS (
          SELECT 1 FROM organization_members m
          WHERE m.organization_id = t.organization_id AND m.user_id = ?3 AND m.role = 'admin'
        )
    `)
      .bind(target.targetId, target.organizationId, target.userId)
      .first(),
  );
  if (row === null) return yield* RecipientNotFound.make();
  const { configuration } = yield* decodeTarget(row).pipe(Effect.mapError(unreadable));
  const recipient = configuration.recipients.find((other) => key(other) === key(address));
  if (recipient === undefined) return yield* RecipientNotFound.make();
  const pending = yield* issue(target.organizationId, recipient);
  const [reserved, current] = yield* d1(() =>
    db.batch([
      pending.statement,
      db
        .prepare(`
        SELECT EXISTS (
          SELECT 1 FROM email_recipient_confirmations
          WHERE organization_id = ?1 AND address = ?2 AND confirmed_at IS NOT NULL
        ) AS confirmed
      `)
        .bind(target.organizationId, key(recipient)),
    ]),
  );
  const rows = yield* decodeAddresses(reserved?.results).pipe(Effect.mapError(unreadable));
  if (rows.length === 0) {
    const { confirmed } = yield* decodeConfirmed(current?.results[0]).pipe(
      Effect.mapError(unreadable),
    );
    return yield* confirmed === 1 ? RecipientConfirmed.make() : ConfirmationLimit.make();
  }
  return {
    address: recipient,
    token: pending.token,
    expiresAt: pending.expiresAt,
    language: configuration.language ?? legacyEmailLanguage,
  };
});

const confirm = Effect.fn("RecipientConfirmations.confirm")(function* (
  token: Redacted.Redacted<string>,
) {
  const db = yield* database;
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  // The link is single-use: its hash goes when it confirms the address.
  const rows = yield* d1(() =>
    db
      .prepare(`
      UPDATE email_recipient_confirmations
      SET confirmed_at = ?2, token_hash = NULL, token_expires_at = NULL
      WHERE token_hash = ?1 AND token_expires_at > ?2 AND confirmed_at IS NULL
      RETURNING address
    `)
      .bind(tokenHash, now)
      .all(),
  );
  const confirmed = yield* decodeAddresses(rows.results).pipe(Effect.mapError(unreadable));
  if (confirmed.length === 0) return yield* ConfirmationNotFound.make();
});

const confirmedAmong = Effect.fn("RecipientConfirmations.confirmedAmong")(function* (
  organizationId: OrganizationId,
  addresses: ReadonlyArray<Address>,
  asOf: number,
) {
  const db = yield* database;
  const list = yield* encodeAddresses(
    addresses.map((address) => EmailAddress.make(key(address))),
  ).pipe(Effect.mapError(unreadable));
  const rows = yield* d1(() =>
    db
      .prepare(`
      SELECT address FROM email_recipient_confirmations
      WHERE organization_id = ?1 AND confirmed_at <= ?3
        AND address IN (SELECT value FROM json_each(?2))
    `)
      .bind(organizationId, list, asOf)
      .all(),
  );
  const confirmed = yield* decodeAddresses(rows.results).pipe(Effect.mapError(unreadable));
  const keys = new Set(confirmed.map(({ address }) => address));
  return addresses.filter((address) => keys.has(key(address)));
});

export const recipientConfirmationsLive = Layer.succeed(RecipientConfirmations, {
  request,
  requestFor,
  confirm,
  confirmedAmong,
});
