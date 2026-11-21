import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";

import { TargetId } from "../../domain/deliveries/delivery.ts";
import {
  EmailTarget,
  legacyEmailLanguage,
  type EmailLanguage,
  type EmailRecipients,
} from "../../domain/deliveries/email.ts";
import type { DestinationTarget } from "../../domain/deliveries/targets.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";
import type { WebhookUrl } from "../../domain/deliveries/webhook-destination.ts";
import { secretRotationWindowMillis, WebhookTarget } from "../../domain/deliveries/webhook.ts";
import { EmailSender } from "../../ports/email-sender.ts";
import {
  NotificationTargets,
  TargetChanged,
  TargetNotFound,
  type FormScope,
  type TargetScope,
  type TargetStatus,
} from "../../ports/notification-targets.ts";
import { SecretCipher } from "../../ports/secret-cipher.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { EmailConfiguration } from "../notifications/email-configuration.ts";
import { WebhookConfiguration } from "../notifications/webhook-configuration.ts";
import { d1, database } from "./d1.ts";

const StoredConfiguration = Schema.fromJsonString(WebhookConfiguration);
const StoredEmailConfiguration = Schema.fromJsonString(EmailConfiguration);
const TargetRow = Schema.Struct({
  id: TargetId,
  type: Schema.Literals(["webhook", "email"]),
  configuration: Schema.String,
  active: Schema.Literals([0, 1]),
  created_at: Schema.Int,
});
const FormRow = Schema.Struct({ id: Schema.String });

const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(TargetRow));
const decodeForms = Schema.decodeUnknownEffect(Schema.Array(FormRow));
const decodeConfiguration = Schema.decodeUnknownEffect(StoredConfiguration);
const encodeConfiguration = Schema.encodeEffect(StoredConfiguration);
const decodeEmailConfiguration = Schema.decodeUnknownEffect(StoredEmailConfiguration);
const encodeEmailConfiguration = Schema.encodeEffect(StoredEmailConfiguration);

const unreadable = () => StorageUnavailable.make();

/** 32 random bytes, shown once. Recipients use the whole string as the HMAC key. */
function newSecret() {
  return Redacted.make(`whsec_${Base64Url.encode(SecureRandom.randomBytesUnsafe(32))}`);
}

const webhookSummary = Effect.fnUntraced(function* (row: typeof TargetRow.Type) {
  const configuration = yield* decodeConfiguration(row.configuration).pipe(
    Effect.mapError(unreadable),
  );
  return WebhookTarget.make({
    id: row.id,
    type: "webhook",
    url: configuration.url,
    active: row.active === 1,
    createdAt: row.created_at,
    previousSecretExpiresAt: configuration.previousSecret?.expiresAt ?? null,
  });
});

/** The addresses, in lowercase, that an organization has confirmed. */
type Confirmed = ReadonlySet<string>;

const decodeConfirmed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ address: Schema.String })),
);

// ?1 is the organization in this statement.
const confirmedQuery = `
  SELECT address FROM email_recipient_confirmations
  WHERE organization_id = ?1 AND confirmed_at IS NOT NULL
`;

const confirmedSet = Effect.fnUntraced(function* (rows: ReadonlyArray<unknown> | undefined) {
  const decoded = yield* decodeConfirmed(rows ?? []).pipe(Effect.mapError(unreadable));
  return new Set(decoded.map(({ address }) => address));
});

const emailSummary = Effect.fnUntraced(function* (
  row: typeof TargetRow.Type,
  confirmed: Confirmed,
) {
  const configuration = yield* decodeEmailConfiguration(row.configuration).pipe(
    Effect.mapError(unreadable),
  );
  return EmailTarget.make({
    id: row.id,
    type: "email",
    recipients: configuration.recipients,
    language: configuration.language ?? legacyEmailLanguage,
    recipientStatuses: configuration.recipients.map((address) => ({
      address,
      status: confirmed.has(address.toLowerCase()) ? "confirmed" : "pending",
    })),
    active: row.active === 1,
    createdAt: row.created_at,
  });
});

function summary(
  row: typeof TargetRow.Type,
  confirmed: Confirmed,
): Effect.Effect<typeof DestinationTarget.Type, StorageUnavailable> {
  return row.type === "webhook" ? webhookSummary(row) : emailSummary(row, confirmed);
}

const targetColumns = "t.id, t.type, t.configuration, t.active, t.created_at";
const returnedColumns = "id, type, configuration, active, created_at";
const listedTypes = "t.type IN ('webhook', 'email')";

const list = Effect.fn("NotificationTargets.list")(function* (form: FormScope) {
  const db = yield* database;
  const [forms, targets, confirmed] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      SELECT f.id FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
      WHERE m.user_id = ?1 AND f.organization_id = ?2 AND f.public_id = ?3
    `)
        .bind(form.userId, form.organizationId, form.formPublicId),
      db
        .prepare(`
      SELECT ${targetColumns} FROM notification_targets t
        JOIN forms f ON f.id = t.form_id AND f.organization_id = t.organization_id
        JOIN organization_members m ON m.organization_id = t.organization_id
      WHERE m.user_id = ?1 AND t.organization_id = ?2 AND f.public_id = ?3 AND ${listedTypes}
      ORDER BY t.created_at, t.id
    `)
        .bind(form.userId, form.organizationId, form.formPublicId),
      db.prepare(confirmedQuery).bind(form.organizationId),
    ]),
  );
  const found = yield* decodeForms(forms?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* TargetNotFound.make();
  const rows = yield* decodeTargets(targets?.results ?? []).pipe(Effect.mapError(unreadable));
  const addresses = yield* confirmedSet(confirmed?.results);
  return yield* Effect.forEach(rows, (row) => summary(row, addresses));
});

const createWebhook = Effect.fn("NotificationTargets.createWebhook")(function* (
  form: FormScope,
  url: WebhookUrl,
) {
  const cipher = yield* SecretCipher;
  const db = yield* database;
  const id = TargetId.make(SecureRandom.uuidV4Unsafe());
  const secret = newSecret();
  const sealed = yield* cipher.seal(secret, id);
  const configuration = yield* encodeConfiguration({
    url,
    secret: sealed,
    previousSecret: null,
  }).pipe(Effect.orDie);
  const now = yield* Clock.currentTimeMillis;
  const inserted = yield* d1(() =>
    db
      .prepare(`
    INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, active, created_at)
    SELECT ?1, f.organization_id, f.id, 'webhook', ?2, 1, ?3
    FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
    WHERE m.user_id = ?4 AND f.organization_id = ?5 AND f.public_id = ?6
    RETURNING ${returnedColumns}
  `)
      .bind(id, configuration, now, form.userId, form.organizationId, form.formPublicId)
      .all(),
  );
  const [row] = yield* decodeTargets(inserted.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  return { target: yield* webhookSummary(row), secret: Redacted.value(secret) };
});

const scopedTarget = `
  t.id = ?1 AND t.organization_id = ?2
  AND EXISTS (
    SELECT 1 FROM organization_members m WHERE m.organization_id = t.organization_id AND m.user_id = ?3
  )
`;

const rotateSecret = Effect.fn("NotificationTargets.rotateSecret")(function* (target: TargetScope) {
  const cipher = yield* SecretCipher;
  const db = yield* database;
  const found = yield* d1(() =>
    db
      .prepare(
        `SELECT ${targetColumns} FROM notification_targets t WHERE ${scopedTarget} AND t.type = 'webhook'`,
      )
      .bind(target.targetId, target.organizationId, target.userId)
      .all(),
  );
  const [row] = yield* decodeTargets(found.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  const current = yield* decodeConfiguration(row.configuration).pipe(Effect.mapError(unreadable));
  const secret = newSecret();
  const sealed = yield* cipher.seal(secret, row.id);
  const now = yield* Clock.currentTimeMillis;
  // A secret older than the current one stops signing now.
  const configuration = yield* encodeConfiguration({
    url: current.url,
    secret: sealed,
    previousSecret: { secret: current.secret, expiresAt: now + secretRotationWindowMillis },
  }).pipe(Effect.orDie);
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE notification_targets AS t SET configuration = ?4
    WHERE ${scopedTarget} AND t.type = 'webhook' AND t.configuration = ?5
    RETURNING ${returnedColumns}
  `)
      .bind(target.targetId, target.organizationId, target.userId, configuration, row.configuration)
      .all(),
  );
  const [rotated] = yield* decodeTargets(updated.results).pipe(Effect.mapError(unreadable));
  if (rotated === undefined) return yield* TargetChanged.make();
  return { target: yield* webhookSummary(rotated), secret: Redacted.value(secret) };
});

const createEmail = Effect.fn("NotificationTargets.createEmail")(function* (
  form: FormScope,
  recipients: EmailRecipients,
  language: EmailLanguage,
) {
  const email = yield* EmailSender;
  // A target that no provider can send to is refused, as a webhook without a secrets key is.
  yield* email.sender;
  const db = yield* database;
  const id = TargetId.make(SecureRandom.uuidV4Unsafe());
  const configuration = yield* encodeEmailConfiguration({ recipients, language }).pipe(
    Effect.orDie,
  );
  const now = yield* Clock.currentTimeMillis;
  const [inserted, confirmed] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
    INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, active, created_at)
    SELECT ?1, f.organization_id, f.id, 'email', ?2, 1, ?3
    FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
    WHERE m.user_id = ?4 AND f.organization_id = ?5 AND f.public_id = ?6
    RETURNING ${returnedColumns}
  `)
        .bind(id, configuration, now, form.userId, form.organizationId, form.formPublicId),
      db.prepare(confirmedQuery).bind(form.organizationId),
    ]),
  );
  const [row] = yield* decodeTargets(inserted?.results ?? []).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  const addresses = yield* confirmedSet(confirmed?.results);
  return yield* emailSummary(row, addresses);
});

const replaceRecipients = Effect.fn("NotificationTargets.replaceRecipients")(function* (
  target: TargetScope,
  recipients: EmailRecipients,
  language: EmailLanguage | undefined,
) {
  const db = yield* database;
  const changes = yield* encodeEmailConfiguration(
    language === undefined ? { recipients } : { recipients, language },
  ).pipe(Effect.orDie);
  // A merge patch replaces the recipients and keeps the stored language when none is given.
  const [updated, confirmed] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
    UPDATE notification_targets AS t SET configuration = json_patch(t.configuration, ?4)
    WHERE ${scopedTarget} AND t.type = 'email'
    RETURNING ${returnedColumns}
  `)
        .bind(target.targetId, target.organizationId, target.userId, changes),
      db.prepare(confirmedQuery).bind(target.organizationId),
    ]),
  );
  const [row] = yield* decodeTargets(updated?.results ?? []).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  const addresses = yield* confirmedSet(confirmed?.results);
  return yield* emailSummary(row, addresses);
});

const setStatus = Effect.fn("NotificationTargets.setStatus")(function* (
  target: TargetScope,
  status: typeof TargetStatus.Type,
) {
  const db = yield* database;
  const [updated, confirmed] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
    UPDATE notification_targets AS t SET active = ?4 WHERE ${scopedTarget} AND ${listedTypes}
    RETURNING ${returnedColumns}
  `)
        .bind(target.targetId, target.organizationId, target.userId, status === "active" ? 1 : 0),
      db.prepare(confirmedQuery).bind(target.organizationId),
    ]),
  );
  const [row] = yield* decodeTargets(updated?.results ?? []).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  const addresses = yield* confirmedSet(confirmed?.results);
  return yield* summary(row, addresses);
});

const TestableRow = Schema.Struct({
  id: TargetId,
  organization_id: OrganizationId,
  type: Schema.Literals(["webhook", "email"]),
  configuration: Schema.fromJsonString(Schema.Json),
  public_id: Schema.String,
  name: Schema.String,
});
const decodeTestable = Schema.decodeUnknownEffect(Schema.Array(TestableRow));

const testable = Effect.fn("NotificationTargets.testable")(function* (target: TargetScope) {
  const db = yield* database;
  const found = yield* d1(() =>
    db
      .prepare(`
    SELECT t.id, t.organization_id, t.type, t.configuration, f.public_id, f.name
    FROM notification_targets t JOIN forms f ON f.id = t.form_id AND f.organization_id = t.organization_id
    WHERE ${scopedTarget} AND ${listedTypes}
  `)
      .bind(target.targetId, target.organizationId, target.userId)
      .all(),
  );
  const [row] = yield* decodeTestable(found.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  return {
    target: {
      id: row.id,
      organizationId: row.organization_id,
      type: row.type,
      configuration: row.configuration,
    },
    form: { publicId: row.public_id, name: row.name },
  };
});

export const notificationTargetsLive = Layer.effect(
  NotificationTargets,
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    const email = yield* EmailSender;
    const provideCipher = Effect.provideService(SecretCipher, cipher);
    return {
      list,
      createWebhook: (form: FormScope, url: WebhookUrl) => provideCipher(createWebhook(form, url)),
      rotateSecret: (target: TargetScope) => provideCipher(rotateSecret(target)),
      createEmail: (form: FormScope, recipients: EmailRecipients, language: EmailLanguage) =>
        createEmail(form, recipients, language).pipe(Effect.provideService(EmailSender, email)),
      replaceRecipients,
      testable,
      setStatus,
    };
  }),
);
