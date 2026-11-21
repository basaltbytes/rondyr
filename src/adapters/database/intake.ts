import { Effect, Layer, Option, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { parseSuccessUrl } from "../../domain/forms/form.ts";
import type { TurnstileToken } from "../../domain/forms/turnstile.ts";
import {
  repetitionKeys,
  repetitionThresholds,
  repetitionWindowMs,
} from "../../domain/submissions/classifier-input.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import {
  EmptySubmission,
  FormNotFound,
  FormRateLimited,
  FormSuspended,
  OriginRefused,
  OrganizationRateLimited,
  SubmissionIntake,
  type OriginMatch,
} from "../../ports/intake.ts";
import { SealedSecret } from "../../ports/secret-cipher.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { TurnstileVerifier } from "../../ports/turnstile-verifier.ts";
import { d1, database } from "./d1.ts";

const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));
const AccessRow = Schema.Struct({
  restricted: Schema.Literals([0, 1]),
  listed: Schema.Literals([0, 1]),
  active: Schema.Literals([0, 1]),
  success_url: Schema.NullOr(Schema.String),
  honeypot_field: Schema.NullOr(Schema.String),
  quota_retry_after: Schema.NullOr(Schema.Int),
});
const decodeAccess = Schema.decodeUnknownEffect(Schema.Array(AccessRow));

// One row for a known form, none for an unknown one. ?1 is the public ID and
// ?2 the request's origin, or NULL. The success URL is read only while its
// origin, the URL up to its first slash after the host, is an allowed origin.
const accessQuery = `
  SELECT
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id) AS restricted,
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id AND o.origin = ?2) AS listed,
    f.status = 'active' AS active,
    CASE WHEN EXISTS (
      SELECT 1 FROM form_origins o
      WHERE o.form_id = f.id AND substr(f.success_url, 1, length(o.origin) + 1) = o.origin || '/'
    ) THEN f.success_url END AS success_url,
    f.honeypot_field AS honeypot_field,
    CASE WHEN u.submissions >= o.daily_submission_limit
      THEN 86400 - unixepoch() % 86400 END AS quota_retry_after
  FROM forms f
  JOIN organizations o ON o.id = f.organization_id
  LEFT JOIN organization_daily_usage u ON u.organization_id = f.organization_id
    AND u.day = date('now')
  WHERE f.public_id = ?1
`;

const originAllowed = (parameter: "?2" | "?4") => `(
  ${parameter} IS NULL
  OR NOT EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id)
  OR EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id AND origin = ${parameter})
)`;

// The indexed counts and the write use the same D1 transaction. The organization
// ID is the leading column of each fingerprint index and comes from the form.
// D1 sets the reception time so concurrent batches count in transaction order.
const insertStatement = `
  WITH intake_time AS (
    SELECT CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER) AS received_at
  ), admitted AS MATERIALIZED (
    SELECT f.id, f.organization_id, f.honeypot_field, f.turnstile_secret, t.received_at,
      COALESCE(u.classifications, 0) >= o.daily_classification_limit AS classification_limited,
      (SELECT COUNT(*) FROM submissions s
       WHERE s.organization_id = f.organization_id AND s.sender_fingerprint = ?5
         AND s.received_at BETWEEN t.received_at - ?7 AND t.received_at) AS prior_same_sender,
      (SELECT COUNT(*) FROM submissions s
       WHERE s.organization_id = f.organization_id AND s.content_fingerprint = ?6
         AND s.received_at BETWEEN t.received_at - ?7 AND t.received_at) AS prior_same_content
    FROM forms f CROSS JOIN intake_time t
    JOIN organizations o ON o.id = f.organization_id
    LEFT JOIN organization_daily_usage u ON u.organization_id = f.organization_id
      AND u.day = date(t.received_at / 1000, 'unixepoch')
    WHERE f.public_id = ?3
      AND f.status = 'active'
      AND ${originAllowed("?4")}
      AND COALESCE(u.submissions, 0) < o.daily_submission_limit
      AND (
        f.honeypot_field IS NULL
        OR EXISTS (SELECT 1 FROM json_each(?2) WHERE key <> f.honeypot_field OR value <> '')
      )
      AND (
        SELECT COUNT(*) FROM submissions WHERE form_id = f.id AND received_at > t.received_at - 60000
      ) < 30
  )
  INSERT INTO submissions (
    id, organization_id, form_id, fields, received_at, intake_reason,
    sender_fingerprint, content_fingerprint, prior_same_sender, prior_same_content
  )
  SELECT
    ?1,
    f.organization_id,
    f.id,
    CASE
      WHEN EXISTS (SELECT 1 FROM json_each(?2) WHERE key = f.honeypot_field AND value = '')
      THEN (
        SELECT json_group_object(key, value)
        FROM (SELECT key, value FROM json_each(?2) WHERE key <> f.honeypot_field ORDER BY id)
      )
      ELSE ?2
    END,
    f.received_at,
    CASE
      WHEN EXISTS (SELECT 1 FROM json_each(?2) WHERE key = f.honeypot_field AND value <> '')
      THEN 'honeypot'
      WHEN f.turnstile_secret IS NOT NULL AND (?10 IS NOT f.turnstile_secret OR ?11 = 0)
      THEN 'turnstile-failed'
      WHEN prior_same_sender >= ?8 OR prior_same_content >= ?9
      THEN 'repetition'
      WHEN f.classification_limited THEN 'quota'
    END,
    ?5,
    ?6,
    prior_same_sender,
    prior_same_content
  FROM admitted f
`;

const incrementUsage = `
  INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications)
  SELECT organization_id, date(received_at / 1000, 'unixepoch'), 1, intake_reason IS NULL
  FROM submissions WHERE id = ?
  ON CONFLICT (organization_id) DO UPDATE SET
    submissions = excluded.submissions + CASE WHEN day = excluded.day THEN submissions ELSE 0 END,
    classifications = excluded.classifications +
      CASE WHEN day = excluded.day THEN classifications ELSE 0 END,
    day = excluded.day
`;

const fingerprint = (value: string | null) =>
  value === null
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
        catch: () => StorageUnavailable.make(),
      }).pipe(Effect.map((hash) => Hex.encode(new Uint8Array(hash))));

const originMatch = (row: typeof AccessRow.Type): OriginMatch => {
  if (row.restricted === 0) return "unrestricted";
  return row.listed === 1 ? "listed" : "unlisted";
};

const readAccess = (rows: ReadonlyArray<unknown> | undefined) =>
  decodeAccess(rows ?? []).pipe(
    Effect.mapBoth({
      onFailure: () => StorageUnavailable.make(),
      onSuccess: (decoded) =>
        Option.map(Option.fromNullishOr(decoded[0]), (row) => ({
          origins: originMatch(row),
          active: row.active === 1,
          // The admin API stores only URLs that pass this rule; a row edited by hand may not.
          successUrl: Option.flatMap(Option.fromNullOr(row.success_url), (url) =>
            Result.getSuccess(parseSuccessUrl(url)),
          ),
          honeypotField: Option.fromNullOr(row.honeypot_field),
          quotaRetryAfter: row.quota_retry_after,
        })),
    }),
  );

/** Whether the only field of a submission is the form's honeypot field, left empty. */
const onlyEmptyHoneypot = (fields: typeof SubmissionFields.Type, honeypot: Option.Option<string>) =>
  Option.exists(honeypot, (name) => {
    const names = Object.keys(fields);
    return names.length === 1 && names[0] === name && fields[name] === "";
  });

const decodeTurnstileRow = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.Struct({ turnstile_secret: SealedSecret })),
);

const verifyTurnstile = Effect.fnUntraced(function* (
  verifier: TurnstileVerifier["Service"],
  publicId: string,
  requestOrigin: string | null,
  token: TurnstileToken,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT f.turnstile_secret FROM forms f
      WHERE f.public_id = ?1 AND f.status = 'active' AND f.turnstile_secret IS NOT NULL
        AND ${originAllowed("?2")}
    `)
      .bind(publicId, requestOrigin)
      .first(),
  );
  const config = yield* decodeTurnstileRow(row).pipe(
    Effect.mapError(() => StorageUnavailable.make()),
  );
  if (config === null) return { secret: null, passed: false };
  const { turnstile_secret: secret } = config;
  const passed = yield* verifier.verify(publicId, secret, token).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Turnstile verification unavailable", {
        publicId,
        source: error.source,
      }).pipe(Effect.as(true)),
    ),
  );
  return { secret, passed };
});

const receive = Effect.fn("Intake.receive")(function* (
  verifier: TurnstileVerifier["Service"],
  publicId: string,
  fields: typeof SubmissionFields.Type,
  origin: Option.Option<string>,
  token: Option.Option<TurnstileToken> = Option.none(),
) {
  const db = yield* database;
  const id = SubmissionId.make(SecureRandom.uuidV4Unsafe());
  const keys = repetitionKeys(fields);
  const { sender, content } = yield* Effect.all({
    sender: fingerprint(keys.sender),
    content: fingerprint(keys.content),
  });
  const encoded = yield* encodeFields(fields).pipe(Effect.orDie);
  const requestOrigin = Option.getOrNull(origin);
  // The batch compares the verified ciphertext with the current configuration.
  // A key changed during verification cannot authorize admission to classification.
  const { secret, passed } = Option.isSome(token)
    ? yield* verifyTurnstile(verifier, publicId, requestOrigin, token.value)
    : { secret: null, passed: false };
  // The batch is one transaction, so the access row describes the list that the insert checked.
  const accessCheck = db.prepare(accessQuery).bind(publicId, requestOrigin);
  const insert = db
    .prepare(insertStatement)
    .bind(
      id,
      encoded,
      publicId,
      requestOrigin,
      sender,
      content,
      repetitionWindowMs,
      repetitionThresholds.sender,
      repetitionThresholds.content,
      secret,
      passed ? 1 : 0,
    );
  const outbox = db
    .prepare(`
    INSERT INTO outbox_events (submission_id)
    SELECT id FROM submissions WHERE id = ?
  `)
    .bind(id);
  const usage = db.prepare(incrementUsage).bind(id);
  const [accessResult, received] = yield* d1(() => db.batch([accessCheck, insert, outbox, usage]));
  const access = yield* Effect.result(readAccess(accessResult?.results));
  if (received?.meta.changes === 1) {
    const metadata = Option.flatten(Result.getSuccess(access));
    if (Option.isSome(metadata)) {
      const { origins, successUrl } = metadata.value;
      return { submissionId: id, origins, successUrl };
    }
    yield* Effect.logWarning("Access metadata unavailable after submission commit", {
      submissionId: id,
    });
    // The insert already checked the request origin. Echo it without a redirect.
    return {
      submissionId: id,
      origins: Option.isSome(origin) ? ("listed" as const) : ("unlisted" as const),
      successUrl: Option.none(),
    };
  }
  if (Result.isFailure(access)) return yield* access.failure;
  if (Option.isNone(access.success)) return yield* FormNotFound.make();
  const { origins, active, honeypotField, quotaRetryAfter } = access.success.value;
  if (origins === "unlisted" && requestOrigin !== null) return yield* OriginRefused.make();
  if (!active) return yield* FormSuspended.make({ origins });
  if (onlyEmptyHoneypot(fields, honeypotField)) return yield* EmptySubmission.make({ origins });
  if (quotaRetryAfter !== null) {
    return yield* OrganizationRateLimited.make({ origins, retryAfter: quotaRetryAfter });
  }
  return yield* FormRateLimited.make({ origins });
});

const matchOrigin = Effect.fn("Intake.matchOrigin")(function* (
  publicId: string,
  origin: Option.Option<string>,
) {
  const db = yield* database;
  const found = yield* d1(() =>
    db.prepare(accessQuery).bind(publicId, Option.getOrNull(origin)).all(),
  );
  const access = yield* readAccess(found.results);
  if (Option.isNone(access)) return yield* FormNotFound.make();
  return access.value.origins;
});

export const submissionIntakeLive = Layer.effect(
  SubmissionIntake,
  Effect.gen(function* () {
    const verifier = yield* TurnstileVerifier;
    return {
      receive: (...args) => receive(verifier, ...args),
      matchOrigin,
    };
  }),
);
