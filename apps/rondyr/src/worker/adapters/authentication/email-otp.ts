import { Clock, Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  otpLifetimeMillis,
  otpMaxAttempts,
  otpMaxCodesPerDay,
  otpMaxCodesPerHour,
} from "../../../domain/organizations/authentication.ts";
import {
  AuthUnavailable,
  OtpInvalid,
  type AuthenticatedSession,
  type IssuedEmailOtp,
} from "../../ports/authentication.ts";
import {
  bindings,
  dayMillis,
  decodeUserRow,
  equalSecrets,
  hourMillis,
  readConfig,
  sha256Hex,
} from "./config.ts";
import { prepareSession } from "./sessions.ts";

const OtpRow = Schema.Struct({
  id: Schema.String,
  codeHash: Schema.String,
});

const decodeOtpRows = Schema.decodeUnknownEffect(Schema.Array(OtpRow));

/** Generate an unbiased 6-digit numeric OTP code using Web Crypto CSPRNG. */
function generateOtpCode(): string {
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  while (true) {
    const bytes = SecureRandom.randomBytesUnsafe(4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const value = view.getUint32(0, false);
    if (value < limit) return String(value % max).padStart(6, "0");
  }
}

export const issueEmailOtp = Effect.fn("Authentication.issueEmailOtp")(function* (
  rawEmail: string,
) {
  const env = yield* bindings;
  const email = rawEmail.toLowerCase();
  const now = yield* Clock.currentTimeMillis;
  const id = SecureRandom.uuidV4Unsafe();
  const code = generateOtpCode();
  const codeHash = yield* sha256Hex(`${id}:${email}:${code}`);
  // One statement finds the account, checks both caps and stores the code: an unknown
  // address and a capped one cost the same round trip as an address that gets a code,
  // so the time of the answer does not tell them apart. A new code leaves the earlier
  // ones valid, so asking for a code in someone's name cannot cancel the one they hold.
  const issued = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        INSERT INTO auth_email_otps (id, email, code_hash, attempts, expires_at, consumed_at, created_at)
        SELECT ?1, ?2, ?3, 0, ?4, NULL, ?5
        WHERE EXISTS (SELECT 1 FROM auth_users WHERE lower(email) = ?2)
          AND (SELECT count(*) FROM auth_email_otps WHERE email = ?2 AND created_at > ?6) < ?7
          AND (SELECT count(*) FROM auth_email_otps WHERE email = ?2 AND created_at > ?8) < ?9
        RETURNING id
      `)
        .bind(
          id,
          email,
          codeHash,
          now + otpLifetimeMillis,
          now,
          now - hourMillis,
          otpMaxCodesPerHour,
          now - dayMillis,
          otpMaxCodesPerDay,
        )
        .all(),
    catch: () => AuthUnavailable.make(),
  });
  return issued.results.length === 1 ? ({ email, code } satisfies IssuedEmailOtp) : null;
});

export const verifyEmailOtp = Effect.fn("Authentication.verifyEmailOtp")(function* (
  request: Request,
  rawEmail: string,
  code: string,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const email = rawEmail.toLowerCase();
  const now = yield* Clock.currentTimeMillis;
  const [otpResult, userResult] = yield* Effect.tryPromise({
    try: () =>
      env.DB.batch([
        env.DB.prepare(`
          SELECT id, code_hash AS codeHash
          FROM auth_email_otps
          WHERE email = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < ?
          ORDER BY created_at DESC LIMIT ?
        `).bind(email, now, otpMaxAttempts, otpMaxCodesPerHour),
        env.DB.prepare(
          "SELECT id, name, email FROM auth_users WHERE lower(email) = ? LIMIT 1",
        ).bind(email),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  const liveCodes = yield* decodeOtpRows(otpResult?.results ?? []).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  // Every live code of the address is compared, without stopping at the first match.
  let matchedId: string | null = null;
  for (const live of liveCodes) {
    const candidateHash = yield* sha256Hex(`${live.id}:${email}:${code}`);
    if (yield* equalSecrets(candidateHash, live.codeHash)) matchedId = live.id;
  }
  const userRaw = userResult?.results[0];
  if (matchedId === null || userRaw === undefined) {
    // A wrong code counts against every live code of the address, so several live codes
    // give no more guesses than one. The statement also runs for an address without an
    // account or without a code: the refusal costs the same round trips either way.
    yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(`
          UPDATE auth_email_otps
          SET attempts = attempts + 1,
              consumed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
          WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
        `)
          .bind(otpMaxAttempts, now, email, now)
          .run(),
      catch: () => AuthUnavailable.make(),
    });
    return yield* OtpInvalid.make();
  }
  const user = yield* decodeUserRow(userRaw).pipe(Effect.mapError(() => AuthUnavailable.make()));

  const consumed = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        UPDATE auth_email_otps SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < ?
        RETURNING id
      `)
        .bind(now, matchedId, now, otpMaxAttempts)
        .all(),
    catch: () => AuthUnavailable.make(),
  });
  if (consumed.results.length !== 1) return yield* OtpInvalid.make();

  const { session, setCookie } = yield* prepareSession(config, request, now);
  yield* Effect.tryPromise({
    try: () =>
      env.DB.batch([
        env.DB.prepare(
          "UPDATE auth_users SET email_verified = 1, updated_at = ? WHERE id = ?",
        ).bind(now, user.id),
        // The sign-in spends the other codes of the address too.
        env.DB.prepare(
          "UPDATE auth_email_otps SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
        ).bind(now, email),
        env.DB.prepare(`
          INSERT INTO auth_sessions
            (id, token, user_id, expires_at, created_at, updated_at, ip_address, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          session.id,
          session.tokenHash,
          user.id,
          session.expiresAt,
          now,
          now,
          session.ipAddress,
          session.userAgent,
        ),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  return {
    session: { user: { id: user.id, name: user.name, email: user.email } },
    setCookie,
  } satisfies AuthenticatedSession;
});
