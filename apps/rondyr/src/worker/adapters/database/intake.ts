import { Effect, Layer, Option, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { searchableSubmissionText } from "../../../domain/forms/blocked-term.ts";
import { parseSuccessUrl, type SuccessUrl } from "../../../domain/forms/form.ts";
import type { TurnstileToken } from "../../../domain/forms/turnstile.ts";
import { junkIntakeReasons } from "../../../domain/organizations/organization-quotas.ts";
import {
  repetitionKeys,
  repetitionThresholds,
  repetitionWindowMs,
} from "../../../domain/submissions/classifier-input.ts";
import { SubmissionFields } from "../../../domain/submissions/submission-fields.ts";
import {
  intakeChecksMetric,
  intakeSubmissionsMetric,
  recordMetric,
} from "../../../domain/submissions/submission-metrics.ts";
import { SubmissionId } from "../../../domain/submissions/submission.id.ts";
import { IntakeVerification } from "../../../domain/submissions/verification.ts";
import {
  EmptySubmission,
  FormNotFound,
  FormRateLimited,
  FormSuspended,
  OriginRefused,
  OrganizationRateLimited,
  SubmissionIntake,
  type OriginMatch,
  type ServerIntake,
} from "../../ports/intake.ts";
import { IntakeTrace } from "../../ports/outbox.ts";
import { SealedSecret } from "../../ports/secret-cipher.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { TurnstileVerifier } from "../../ports/turnstile-verifier.ts";
import { d1, database } from "./d1.ts";

const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));
const encodeErrorCodes = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeTrace = Schema.encodeEffect(Schema.fromJsonString(IntakeTrace));
const decodeIntakeChecks = Schema.decodeUnknownOption(Schema.fromJsonString(IntakeVerification));
const repetitionWindowDays = Math.round(repetitionWindowMs / (24 * 60 * 60 * 1000));
const OriginRow = Schema.Struct({
  restricted: Schema.Literals([0, 1]),
  listed: Schema.Literals([0, 1]),
});
const decodeOrigins = Schema.decodeUnknownEffect(Schema.Array(OriginRow));
const AccessRow = Schema.Struct({
  ...OriginRow.fields,
  active: Schema.Literals([0, 1]),
  success_url: Schema.NullOr(Schema.String),
  honeypot_field: Schema.NullOr(Schema.String),
  quota_retry_after: Schema.NullOr(Schema.Int),
  replay_id: Schema.NullOr(SubmissionId),
  intake_checks: Schema.NullOr(Schema.String),
});
const decodeAccess = Schema.decodeUnknownEffect(Schema.Array(AccessRow));

/** Whether the form `f` lists origins, and whether it lists the origin of the parameter. */
const originColumns = (parameter: "?2" | "?4") => `
  EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id) AS restricted,
  EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id AND o.origin = ${parameter}) AS listed
`;

// One row for a known form, none for an unknown one. ?1 is the public ID and
// ?2 the request's origin, or NULL.
const originQuery = `SELECT ${originColumns("?2")} FROM forms f WHERE f.public_id = ?1`;

const originAllowed = (parameter: "?2" | "?4") => `(
  ${parameter} IS NULL
  OR NOT EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id)
  OR EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id AND origin = ${parameter})
)`;

const junkReasons = junkIntakeReasons.map((reason) => `'${reason}'`).join(", ");

// The form ?3 with its counts, its intake reason and whether the daily budget of
// that reason has room. ?2 is the fields in JSON, ?5 and ?6 the sender and content
// fingerprints, ?7 the repetition window, ?8 and ?9 the repetition thresholds, ?10
// the secret that Siteverify checked the token with or NULL, and ?11 whether it
// accepted the token. ?12 is the organization of a server intake's API token, or
// NULL for a public request. ?13 is the idempotency key or NULL, ?14 says
// whether to screen for Turnstile, ?15 is the normalized searchable text of
// the submission's fields for whole-word/phrase blocked-term matching, ?16 is
// the Turnstile verification status, ?17 the JSON array of Siteverify error
// codes or NULL, ?18 the Turnstile unavailable source or NULL, and ?19 the
// repetition window in days.
const screening = `
  WITH intake_time AS (
    SELECT CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER) AS received_at
  ), counted AS MATERIALIZED (
    SELECT f.id, f.organization_id, f.status, f.success_url, f.honeypot_field,
      f.turnstile_secret, t.received_at, o.daily_submission_limit, o.daily_classification_limit,
      COALESCE(u.submissions, 0) AS submissions_used,
      COALESCE(u.classifications, 0) AS classifications_used,
      COALESCE(u.junk, 0) AS junk_used,
      COALESCE(u.classifications, 0) >= o.daily_classification_limit AS classification_limited,
      EXISTS (SELECT 1 FROM form_origins fo WHERE fo.form_id = f.id) AS origin_restricted,
      CASE
        WHEN f.honeypot_field IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(?2) WHERE key = f.honeypot_field AND value <> '')
        THEN 1 ELSE 0
      END AS honeypot_triggered,
      (SELECT COUNT(*) FROM submissions s
       WHERE s.organization_id = f.organization_id AND s.sender_fingerprint = ?5
         AND s.received_at BETWEEN t.received_at - ?7 AND t.received_at) AS prior_same_sender,
      (SELECT COUNT(*) FROM submissions s
       WHERE s.organization_id = f.organization_id AND s.content_fingerprint = ?6
         AND s.received_at BETWEEN t.received_at - ?7 AND t.received_at) AS prior_same_content,
      (
        EXISTS (SELECT 1 FROM form_blocked_terms bt WHERE bt.form_id = f.id)
        OR EXISTS (SELECT 1 FROM organization_blocked_terms obt WHERE obt.organization_id = f.organization_id)
      ) AS has_blocked_terms,
      (
        SELECT bt.term FROM form_blocked_terms bt
        WHERE bt.form_id = f.id AND ?15 <> '' AND instr(?15, ' ' || bt.term || ' ') > 0
        ORDER BY bt.term LIMIT 1
      ) AS matched_form_term,
      (
        SELECT obt.term FROM organization_blocked_terms obt
        WHERE obt.organization_id = f.organization_id AND ?15 <> '' AND instr(?15, ' ' || obt.term || ' ') > 0
        ORDER BY obt.term LIMIT 1
      ) AS matched_org_term
    FROM forms f CROSS JOIN intake_time t
    JOIN organizations o ON o.id = f.organization_id
    LEFT JOIN organization_daily_usage u ON u.organization_id = f.organization_id
      AND u.day = date(t.received_at / 1000, 'unixepoch')
    WHERE f.public_id = ?3 AND (?12 IS NULL OR f.organization_id = ?12)
  ), screened AS (
    SELECT c.*,
      CASE
        WHEN c.honeypot_triggered = 1
        THEN 'honeypot'
        WHEN ?14 = 1 AND c.turnstile_secret IS NOT NULL
          AND (?10 IS NOT c.turnstile_secret OR ?11 = 0)
        THEN 'turnstile-failed'
        WHEN c.prior_same_sender >= ?8 OR c.prior_same_content >= ?9
        THEN 'repetition'
        WHEN c.matched_form_term IS NOT NULL OR c.matched_org_term IS NOT NULL
        THEN 'blocked-term'
        WHEN c.classification_limited THEN 'quota'
      END AS intake_reason
    FROM counted c
  ), budgeted AS (
    SELECT s.*,
      CASE WHEN s.intake_reason IN (${junkReasons}) THEN s.junk_used ELSE s.submissions_used END
        < s.daily_submission_limit AS within_budget
    FROM screened s
  )
`;

const intakeChecksJson = `
  json_object(
    'channel', CASE WHEN ?12 IS NULL THEN 'public' ELSE 'server' END,
    'origin', CASE
      WHEN ?12 IS NOT NULL THEN json_object('_tag', 'Skipped', 'reason', 'server-intake')
      ELSE json_object(
        '_tag', 'Passed',
        'mode', CASE WHEN f.origin_restricted = 1 THEN 'listed' ELSE 'unrestricted' END,
        'hasOrigin', CASE WHEN ?4 IS NOT NULL THEN json('true') ELSE json('false') END
      )
    END,
    'honeypot', CASE
      WHEN f.honeypot_field IS NULL THEN json_object('_tag', 'NotConfigured')
      WHEN f.honeypot_triggered = 1 THEN json_object('_tag', 'Failed', 'field', f.honeypot_field)
      ELSE json_object('_tag', 'Passed', 'field', f.honeypot_field)
    END,
    'turnstile', CASE
      WHEN f.turnstile_secret IS NULL THEN json_object('_tag', 'NotConfigured')
      WHEN ?14 = 0 THEN json_object('_tag', 'Skipped', 'reason', 'server-intake')
      WHEN ?16 = 'no-token' THEN json_object('_tag', 'Failed', 'cause', 'missing-token')
      WHEN ?10 IS NOT f.turnstile_secret THEN json_object('_tag', 'Failed', 'cause', 'key-changed')
      WHEN ?16 = 'rejected' THEN CASE
        WHEN ?17 IS NOT NULL THEN json_object('_tag', 'Failed', 'cause', 'rejected', 'errorCodes', json(?17))
        ELSE json_object('_tag', 'Failed', 'cause', 'rejected')
      END
      WHEN ?16 = 'unavailable' THEN json_object('_tag', 'Unavailable', 'source', ?18)
      ELSE json_object('_tag', 'Passed')
    END,
    'repetition', json_object(
      'outcome', CASE WHEN f.prior_same_sender >= ?8 OR f.prior_same_content >= ?9 THEN 'failed' ELSE 'passed' END,
      'priorSameSender', f.prior_same_sender,
      'priorSameContent', f.prior_same_content,
      'senderThreshold', ?8,
      'contentThreshold', ?9,
      'windowDays', ?19
    ),
    'blockedTerm', CASE
      WHEN f.matched_form_term IS NOT NULL THEN json_object('_tag', 'Failed', 'term', f.matched_form_term, 'scope', 'form')
      WHEN f.matched_org_term IS NOT NULL THEN json_object('_tag', 'Failed', 'term', f.matched_org_term, 'scope', 'organization')
      WHEN f.has_blocked_terms = 0 THEN json_object('_tag', 'NotConfigured')
      ELSE json_object('_tag', 'Passed')
    END,
    'quota', CASE
      WHEN f.intake_reason IS NOT NULL AND f.intake_reason <> 'quota'
        THEN json_object('_tag', 'Skipped', 'reason', 'quarantined-earlier')
      WHEN f.classification_limited
        THEN json_object('_tag', 'Failed', 'used', f.classifications_used, 'limit', f.daily_classification_limit)
      ELSE json_object('_tag', 'Passed', 'used', f.classifications_used, 'limit', f.daily_classification_limit)
    END,
    'decisiveReason', f.intake_reason
  )
`;

// What the batch needs to explain a refusal, read before the insert in the same
// transaction. The success URL is read only while its origin, the URL up to its
// first slash after the host, is an allowed origin. `replay_id` is the submission
// of the form that already has the idempotency key ?13: D1 runs one batch at a
// time, so a concurrent request with the same key sees the first one's row here.
const accessQuery = `${screening}
  SELECT
    ${originColumns("?4")},
    f.status = 'active' AS active,
    CASE WHEN EXISTS (
      SELECT 1 FROM form_origins o
      WHERE o.form_id = f.id AND substr(f.success_url, 1, length(o.origin) + 1) = o.origin || '/'
    ) THEN f.success_url END AS success_url,
    f.honeypot_field AS honeypot_field,
    CASE WHEN NOT f.within_budget THEN 86400 - unixepoch() % 86400 END AS quota_retry_after,
    (SELECT p.id FROM submissions p WHERE p.form_id = f.id AND p.idempotency_key = ?13)
      AS replay_id,
    ${intakeChecksJson} AS intake_checks
  FROM budgeted f
`;

// ?1 is the submission ID.
const insertStatement = `${screening}
  INSERT INTO submissions (
    id, organization_id, form_id, fields, received_at, intake_reason, intake_checks,
    sender_fingerprint, content_fingerprint, prior_same_sender, prior_same_content,
    idempotency_key
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
    f.intake_reason,
    ${intakeChecksJson},
    ?5,
    ?6,
    f.prior_same_sender,
    f.prior_same_content,
    ?13
  FROM budgeted f
  WHERE NOT EXISTS (SELECT 1 FROM submissions p WHERE p.form_id = f.id AND p.idempotency_key = ?13)
    AND f.status = 'active'
    AND ${originAllowed("?4")}
    AND f.within_budget
    AND (
      f.honeypot_field IS NULL
      OR EXISTS (SELECT 1 FROM json_each(?2) WHERE key <> f.honeypot_field OR value <> '')
    )
    AND (
      SELECT COUNT(*) FROM submissions WHERE form_id = f.id AND received_at > f.received_at - 60000
    ) < 30
`;

// Junk counts in `junk`, every other stored submission in `submissions`.
const incrementUsage = `
  INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications, junk)
  SELECT organization_id, date(received_at / 1000, 'unixepoch'),
    COALESCE(intake_reason NOT IN (${junkReasons}), 1),
    intake_reason IS NULL,
    COALESCE(intake_reason IN (${junkReasons}), 0)
  FROM submissions WHERE id = ?
  ON CONFLICT (organization_id) DO UPDATE SET
    submissions = excluded.submissions + CASE WHEN day = excluded.day THEN submissions ELSE 0 END,
    classifications = excluded.classifications +
      CASE WHEN day = excluded.day THEN classifications ELSE 0 END,
    junk = excluded.junk + CASE WHEN day = excluded.day THEN junk ELSE 0 END,
    day = excluded.day
`;

const fingerprint = (value: string | null) =>
  value === null
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
        catch: () => StorageUnavailable.make(),
      }).pipe(Effect.map((hash) => Hex.encode(new Uint8Array(hash))));

const originMatch = (row: typeof OriginRow.Type): OriginMatch => {
  if (row.restricted === 0) return "unrestricted";
  return row.listed === 1 ? "listed" : "unlisted";
};

const readAccess = (
  rows: ReadonlyArray<unknown> | undefined,
): Effect.Effect<Option.Option<Access>, StorageUnavailable> =>
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
          replayId: Option.fromNullOr(row.replay_id),
          intakeChecks: Option.flatMap(Option.fromNullOr(row.intake_checks), decodeIntakeChecks),
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
  Schema.NullOr(
    Schema.Struct({
      turnstile_secret: Schema.NullOr(SealedSecret),
      replay_id: Schema.NullOr(SubmissionId),
    }),
  ),
);

const readTurnstile = Effect.fnUntraced(function* (
  publicId: string,
  requestOrigin: string | null,
  server?: ServerIntake,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT CASE WHEN f.status = 'active' THEN f.turnstile_secret END AS turnstile_secret,
        (SELECT s.id FROM submissions s WHERE s.form_id = f.id AND s.idempotency_key = ?4)
          AS replay_id
      FROM forms f
      WHERE f.public_id = ?1 AND ${originAllowed("?2")}
        AND (?3 IS NULL OR f.organization_id = ?3)
    `)
      .bind(
        publicId,
        requestOrigin,
        server?.organizationId ?? null,
        server === undefined ? null : Option.getOrNull(server.idempotencyKey),
      )
      .first(),
  );
  return yield* decodeTurnstileRow(row).pipe(Effect.mapError(() => StorageUnavailable.make()));
});

type TurnstileOutcome =
  | { readonly status: "no-token"; readonly secret: null; readonly passed: false }
  | { readonly status: "passed"; readonly secret: SealedSecret; readonly passed: true }
  | {
      readonly status: "rejected";
      readonly secret: SealedSecret;
      readonly passed: false;
      readonly errorCodes: ReadonlyArray<string>;
    }
  | {
      readonly status: "unavailable";
      readonly secret: SealedSecret;
      readonly passed: true;
      readonly source: "secret" | "siteverify";
    };

const unchecked: TurnstileOutcome = { status: "no-token", secret: null, passed: false };

const verifyTurnstile = Effect.fnUntraced(function* (
  verifier: TurnstileVerifier["Service"],
  publicId: string,
  secret: SealedSecret | null,
  token: TurnstileToken,
  visitorIp = Option.none<string>(),
): Effect.fn.Return<TurnstileOutcome> {
  if (secret === null) return unchecked;
  const verified = yield* verifier.verify(publicId, secret, token, visitorIp).pipe(Effect.result);
  if (verified._tag === "Failure") {
    yield* Effect.logWarning("Turnstile verification unavailable", {
      publicId,
      source: verified.failure.source,
    });
    return {
      status: "unavailable",
      secret,
      passed: true,
      source: verified.failure.source,
    };
  }
  if (verified.success.passed) {
    return { status: "passed", secret, passed: true };
  }
  return {
    status: "rejected",
    secret,
    passed: false,
    errorCodes: verified.success.errorCodes,
  };
});

interface IntakeRequest {
  readonly publicId: string;
  readonly fields: typeof SubmissionFields.Type;
  readonly origin: Option.Option<string>;
  readonly turnstile: TurnstileOutcome;
  readonly server?: ServerIntake;
}

const currentIntakeTrace = Effect.currentParentSpan.pipe(
  Effect.flatMap((span) =>
    encodeTrace({ traceId: span.traceId, spanId: span.spanId, sampled: span.sampled }),
  ),
  Effect.orElseSucceed(() => null),
);

function checkOutcome(tag: string) {
  switch (tag) {
    case "Passed":
      return "passed";
    case "Failed":
      return "failed";
    case "Unavailable":
      return "unavailable";
    case "Skipped":
      return "skipped";
    default:
      return "not-configured";
  }
}

const recordIntakeObservability = Effect.fnUntraced(function* (
  submissionId: SubmissionId,
  publicId: string,
  checks: IntakeVerification,
) {
  const outcome = checks.decisiveReason === null ? "queued" : "quarantined";
  const reason = checks.decisiveReason ?? "none";
  const checkStates = {
    origin: checkOutcome(checks.origin._tag),
    honeypot: checkOutcome(checks.honeypot._tag),
    turnstile: checkOutcome(checks.turnstile._tag),
    repetition: checks.repetition.outcome,
    blockedTerm: checkOutcome(checks.blockedTerm._tag),
    quota: checkOutcome(checks.quota._tag),
  };
  yield* Effect.annotateCurrentSpan({
    submissionId,
    formPublicId: publicId,
    "intake.channel": checks.channel,
    "intake.outcome": outcome,
    "intake.reason": reason,
    "intake.check.origin": checkStates.origin,
    "intake.check.honeypot": checkStates.honeypot,
    "intake.check.turnstile": checkStates.turnstile,
    "intake.check.repetition": checkStates.repetition,
    "intake.check.blockedTerm": checkStates.blockedTerm,
    "intake.check.quota": checkStates.quota,
    "intake.priorSameSender": checks.repetition.priorSameSender,
    "intake.priorSameContent": checks.repetition.priorSameContent,
  });
  yield* recordMetric(intakeSubmissionsMetric, {
    channel: checks.channel,
    outcome,
    reason,
  });
  for (const [check, checkResult] of Object.entries(checkStates)) {
    yield* recordMetric(intakeChecksMetric, { check, outcome: checkResult });
  }
  yield* Effect.logInfo("Submission received", {
    submissionId,
    formPublicId: publicId,
    channel: checks.channel,
    outcome,
    ...(checks.decisiveReason !== null && { intakeReason: checks.decisiveReason }),
    ...(checks.blockedTerm._tag === "Failed" && { blockedTermScope: checks.blockedTerm.scope }),
    ...(checks.turnstile._tag === "Unavailable" && {
      turnstileUnavailableSource: checks.turnstile.source,
    }),
  });
});

/** Run the intake batch: one D1 round trip, after a Turnstile verification if any. */
const runBatch = Effect.fnUntraced(function* (request: IntakeRequest) {
  const { publicId, fields } = request;
  const db = yield* database;
  const id = SubmissionId.make(SecureRandom.uuidV4Unsafe());
  const keys = repetitionKeys(fields);
  const { sender, content } = yield* Effect.all({
    sender: fingerprint(keys.sender),
    content: fingerprint(keys.content),
  });
  const encoded = yield* encodeFields(fields).pipe(Effect.orDie);
  const searchableText = searchableSubmissionText(fields);
  const requestOrigin = Option.getOrNull(request.origin);
  // The batch compares the verified ciphertext with the current configuration.
  // A key changed during verification cannot authorize admission to classification.
  const { turnstile, server } = request;
  const turnstileErrorCodes =
    turnstile.status === "rejected" && turnstile.errorCodes.length > 0
      ? yield* encodeErrorCodes(turnstile.errorCodes).pipe(Effect.orElseSucceed(() => null))
      : null;
  const turnstileUnavailableSource = turnstile.status === "unavailable" ? turnstile.source : null;
  const intakeTrace = yield* currentIntakeTrace;
  const parameters = [
    id,
    encoded,
    publicId,
    requestOrigin,
    sender,
    content,
    repetitionWindowMs,
    repetitionThresholds.sender,
    repetitionThresholds.content,
    turnstile.secret,
    turnstile.passed ? 1 : 0,
    server?.organizationId ?? null,
    server === undefined ? null : Option.getOrNull(server.idempotencyKey),
    server === undefined || server.turnstile !== undefined ? 1 : 0,
    searchableText,
    turnstile.status,
    turnstileErrorCodes,
    turnstileUnavailableSource,
    repetitionWindowDays,
  ] as const;
  // The batch is one transaction, so the access row describes the state that the insert checked.
  const accessCheck = db.prepare(accessQuery).bind(...parameters);
  const insert = db.prepare(insertStatement).bind(...parameters);
  const outbox = db
    .prepare(`
    INSERT INTO outbox_events (submission_id, intake_trace)
    SELECT id, ?2 FROM submissions WHERE id = ?1
  `)
    .bind(id, intakeTrace);
  const usage = db.prepare(incrementUsage).bind(id);
  const [accessResult, received] = yield* d1(() => db.batch([accessCheck, insert, outbox, usage]));
  const access = yield* Effect.result(readAccess(accessResult?.results));
  return { id, stored: received?.meta.changes === 1, access };
});

interface Access {
  readonly origins: OriginMatch;
  readonly active: boolean;
  readonly successUrl: Option.Option<SuccessUrl>;
  readonly honeypotField: Option.Option<string>;
  readonly quotaRetryAfter: number | null;
  readonly replayId: Option.Option<SubmissionId>;
  readonly intakeChecks: Option.Option<IntakeVerification>;
}

/** Why a form that the batch found, or did not find, stored nothing. */
const refuse = Effect.fnUntraced(function* (
  fields: typeof SubmissionFields.Type,
  access: Option.Option<Access>,
) {
  if (Option.isNone(access)) return yield* FormNotFound.make();
  const { origins, active, honeypotField, quotaRetryAfter } = access.value;
  if (!active) return yield* FormSuspended.make({ origins });
  if (onlyEmptyHoneypot(fields, honeypotField)) return yield* EmptySubmission.make({ origins });
  if (quotaRetryAfter !== null) {
    return yield* OrganizationRateLimited.make({ origins, retryAfter: quotaRetryAfter });
  }
  return yield* FormRateLimited.make({ origins });
});

const receive = Effect.fn("Intake.receive")(function* (
  verifier: TurnstileVerifier["Service"],
  publicId: string,
  fields: typeof SubmissionFields.Type,
  origin: Option.Option<string>,
  token: Option.Option<TurnstileToken> = Option.none(),
) {
  yield* Effect.annotateCurrentSpan({ formPublicId: publicId, "intake.channel": "public" });
  const config = Option.isSome(token)
    ? yield* readTurnstile(publicId, Option.getOrNull(origin))
    : null;
  const turnstile = Option.isSome(token)
    ? yield* verifyTurnstile(verifier, publicId, config?.turnstile_secret ?? null, token.value)
    : unchecked;
  const { id, stored, access } = yield* runBatch({
    publicId,
    fields,
    origin,
    turnstile,
  });
  if (stored) {
    const metadata = Option.flatten(Result.getSuccess(access));
    if (Option.isSome(metadata)) {
      const { origins, successUrl, intakeChecks } = metadata.value;
      if (Option.isSome(intakeChecks)) {
        yield* recordIntakeObservability(id, publicId, intakeChecks.value);
      }
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
  if (
    Option.exists(access.success, ({ origins }) => origins === "unlisted") &&
    Option.isSome(origin)
  ) {
    yield* Effect.annotateCurrentSpan({ "intake.outcome": "refused", "intake.reason": "origin" });
    yield* recordMetric(intakeSubmissionsMetric, {
      channel: "public",
      outcome: "refused",
      reason: "origin",
    });
    return yield* OriginRefused.make();
  }
  return yield* refuse(fields, access.success).pipe(
    Effect.tapError((error) =>
      Effect.all([
        Effect.annotateCurrentSpan({
          "intake.outcome": "refused",
          "intake.reason": error._tag,
        }),
        recordMetric(intakeSubmissionsMetric, {
          channel: "public",
          outcome: "refused",
          reason: error._tag,
        }),
      ]),
    ),
  );
});

const receiveFromServer = Effect.fn("Intake.receiveFromServer")(function* (
  verifier: TurnstileVerifier["Service"],
  publicId: string,
  fields: typeof SubmissionFields.Type,
  intake: ServerIntake,
) {
  yield* Effect.annotateCurrentSpan({
    formPublicId: publicId,
    organizationId: intake.organizationId,
    "intake.channel": "server",
  });
  const check = intake.turnstile;
  let turnstile: TurnstileOutcome = unchecked;
  if (check !== undefined && Option.isSome(check.token)) {
    const config = yield* readTurnstile(publicId, null, intake);
    if (config?.replay_id != null) {
      yield* Effect.annotateCurrentSpan({
        submissionId: config.replay_id,
        "intake.outcome": "replayed",
      });
      yield* recordMetric(intakeSubmissionsMetric, {
        channel: "server",
        outcome: "replayed",
        reason: "idempotency-key",
      });
      return { submissionId: config.replay_id, replayed: true };
    }
    turnstile = yield* verifyTurnstile(
      verifier,
      publicId,
      config?.turnstile_secret ?? null,
      check.token.value,
      check.visitorIp,
    );
  }
  const { id, stored, access } = yield* runBatch({
    publicId,
    fields,
    origin: Option.none(),
    turnstile,
    server: intake,
  });
  if (stored) {
    const metadata = Option.flatten(Result.getSuccess(access));
    if (Option.isSome(metadata) && Option.isSome(metadata.value.intakeChecks)) {
      yield* recordIntakeObservability(id, publicId, metadata.value.intakeChecks.value);
    }
    return { submissionId: id, replayed: false };
  }
  if (Result.isFailure(access)) return yield* access.failure;
  const replayed = Option.flatMap(access.success, ({ replayId }) => replayId);
  if (Option.isSome(replayed)) {
    yield* Effect.annotateCurrentSpan({
      submissionId: replayed.value,
      "intake.outcome": "replayed",
    });
    yield* recordMetric(intakeSubmissionsMetric, {
      channel: "server",
      outcome: "replayed",
      reason: "idempotency-key",
    });
    return { submissionId: replayed.value, replayed: true };
  }
  return yield* refuse(fields, access.success).pipe(
    Effect.tapError((error) =>
      Effect.all([
        Effect.annotateCurrentSpan({
          "intake.outcome": "refused",
          "intake.reason": error._tag,
        }),
        recordMetric(intakeSubmissionsMetric, {
          channel: "server",
          outcome: "refused",
          reason: error._tag,
        }),
      ]),
    ),
  );
});

const matchOrigin = Effect.fn("Intake.matchOrigin")(function* (
  publicId: string,
  origin: Option.Option<string>,
) {
  const db = yield* database;
  const found = yield* d1(() =>
    db.prepare(originQuery).bind(publicId, Option.getOrNull(origin)).all(),
  );
  const [row] = yield* decodeOrigins(found.results).pipe(
    Effect.mapError(() => StorageUnavailable.make()),
  );
  if (row === undefined) return yield* FormNotFound.make();
  return originMatch(row);
});

export const submissionIntakeLive = Layer.effect(
  SubmissionIntake,
  Effect.gen(function* () {
    const verifier = yield* TurnstileVerifier;
    return {
      receive: (...args) => receive(verifier, ...args),
      receiveFromServer: (...args) => receiveFromServer(verifier, ...args),
      matchOrigin,
    };
  }),
);
