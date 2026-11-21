import { Clock, Effect, Layer, Redacted, Schema } from "effect";

import {
  passwordResetEmailsPerDay,
  passwordResetLifetimeMillis,
} from "../../domain/organizations/password-reset.ts";
import { PasswordResetNotFound, PasswordResets } from "../../ports/password-resets.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";
import { passwordHash } from "./password-hash.ts";
import { hashSecret, newLinkSecret } from "./secret-hash.ts";

const dayMillis = 86_400_000;
const unreadable = () => StorageUnavailable.make();
const decodeIssued = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ email: Schema.String })),
);
const decodeUsed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ user_id: Schema.String })),
);

const issue = Effect.fn("PasswordResets.issue")(function* (address: string) {
  const db = yield* database;
  const token = newLinkSecret();
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + passwordResetLifetimeMillis;
  // ?1 the address in lowercase, ?2 the hash of the link, ?3 the time, ?4 its
  // expiry, ?5 the daily number of links. One statement, whether an account has
  // the address or not, so the time of the answer does not tell.
  const rows = yield* d1(() =>
    db
      .prepare(`
      INSERT INTO password_resets (token_hash, user_id, created_at, expires_at)
      SELECT ?2, u.id, ?3, ?4 FROM auth_users u
      WHERE lower(u.email) = ?1 AND (
        SELECT count(*) FROM password_resets r WHERE r.user_id = u.id AND r.created_at > ?3 - ${dayMillis}
      ) < ?5
      RETURNING (SELECT email FROM auth_users WHERE id = user_id) AS email
    `)
      .bind(address.toLowerCase(), tokenHash, now, expiresAt, passwordResetEmailsPerDay)
      .all(),
  );
  const [issued] = yield* decodeIssued(rows.results).pipe(Effect.mapError(unreadable));
  return issued === undefined ? null : { email: issued.email, token, expiresAt };
});

const complete = Effect.fn("PasswordResets.complete")(function* (
  token: Redacted.Redacted<string>,
  password: Redacted.Redacted<string>,
) {
  const db = yield* database;
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  // ?1 the hash of the link, ?2 the time. A cheap read first: hashing a password
  // costs CPU, which nobody should be able to spend with a random link.
  const account = `(
    SELECT user_id FROM password_resets
    WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
  )`;
  const usable = yield* d1(() =>
    db.prepare(`SELECT ${account} AS user_id`).bind(tokenHash, now).first("user_id"),
  );
  if (usable === null) return yield* PasswordResetNotFound.make();
  const hash = yield* passwordHash(password);
  // One transaction: the new password, the address verified by the link, every
  // session signed out, and every link of the account used, this one last.
  const [, , , used] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        UPDATE auth_accounts SET password = ?3, updated_at = ?2
        WHERE provider_id = 'credential' AND user_id = ${account}
      `)
        .bind(tokenHash, now, hash),
      db
        .prepare(`UPDATE auth_users SET email_verified = 1, updated_at = ?2 WHERE id = ${account}`)
        .bind(tokenHash, now),
      db.prepare(`DELETE FROM auth_sessions WHERE user_id = ${account}`).bind(tokenHash, now),
      db
        .prepare(`
        UPDATE password_resets SET used_at = ?2
        WHERE user_id = ${account} AND used_at IS NULL
        RETURNING user_id
      `)
        .bind(tokenHash, now),
    ]),
  );
  const rows = yield* decodeUsed(used?.results).pipe(Effect.mapError(unreadable));
  if (rows.length === 0) return yield* PasswordResetNotFound.make();
});

export const passwordResetsLive = Layer.succeed(PasswordResets, { issue, complete });
