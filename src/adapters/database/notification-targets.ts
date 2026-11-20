import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";

import { TargetId } from "../../domain/deliveries/delivery.ts";
import type { WebhookUrl } from "../../domain/deliveries/webhook-destination.ts";
import { secretRotationWindowMillis, WebhookTarget } from "../../domain/deliveries/webhook.ts";
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
import { WebhookConfiguration } from "../notifications/webhook-configuration.ts";
import { d1, database } from "./d1.ts";

const StoredConfiguration = Schema.fromJsonString(WebhookConfiguration);
const TargetRow = Schema.Struct({
  id: TargetId,
  configuration: Schema.String,
  active: Schema.Literals([0, 1]),
  created_at: Schema.Int,
});
const FormRow = Schema.Struct({ id: Schema.String });

const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(TargetRow));
const decodeForms = Schema.decodeUnknownEffect(Schema.Array(FormRow));
const decodeConfiguration = Schema.decodeUnknownEffect(StoredConfiguration);
const encodeConfiguration = Schema.encodeEffect(StoredConfiguration);

const unreadable = () => StorageUnavailable.make();

/** 32 random bytes, shown once. Recipients use the whole string as the HMAC key. */
function newSecret() {
  return Redacted.make(`whsec_${Base64Url.encode(SecureRandom.randomBytesUnsafe(32))}`);
}

const summary = Effect.fnUntraced(function* (row: typeof TargetRow.Type) {
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

const targetColumns = "t.id, t.configuration, t.active, t.created_at";

const list = Effect.fn("NotificationTargets.list")(function* (form: FormScope) {
  const db = yield* database;
  const [forms, targets] = yield* d1(() =>
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
      WHERE m.user_id = ?1 AND t.organization_id = ?2 AND f.public_id = ?3 AND t.type = 'webhook'
      ORDER BY t.created_at, t.id
    `)
        .bind(form.userId, form.organizationId, form.formPublicId),
    ]),
  );
  const found = yield* decodeForms(forms?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* TargetNotFound.make();
  const rows = yield* decodeTargets(targets?.results ?? []).pipe(Effect.mapError(unreadable));
  return yield* Effect.forEach(rows, summary);
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
    RETURNING id, configuration, active, created_at
  `)
      .bind(id, configuration, now, form.userId, form.organizationId, form.formPublicId)
      .all(),
  );
  const [row] = yield* decodeTargets(inserted.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  return { target: yield* summary(row), secret: Redacted.value(secret) };
});

const scopedTarget = `
  t.id = ?1 AND t.organization_id = ?2 AND t.type = 'webhook'
  AND EXISTS (
    SELECT 1 FROM organization_members m WHERE m.organization_id = t.organization_id AND m.user_id = ?3
  )
`;

const rotateSecret = Effect.fn("NotificationTargets.rotateSecret")(function* (target: TargetScope) {
  const cipher = yield* SecretCipher;
  const db = yield* database;
  const found = yield* d1(() =>
    db
      .prepare(`SELECT ${targetColumns} FROM notification_targets t WHERE ${scopedTarget}`)
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
    WHERE ${scopedTarget} AND t.configuration = ?5
    RETURNING id, configuration, active, created_at
  `)
      .bind(target.targetId, target.organizationId, target.userId, configuration, row.configuration)
      .all(),
  );
  const [rotated] = yield* decodeTargets(updated.results).pipe(Effect.mapError(unreadable));
  if (rotated === undefined) return yield* TargetChanged.make();
  return { target: yield* summary(rotated), secret: Redacted.value(secret) };
});

const setStatus = Effect.fn("NotificationTargets.setStatus")(function* (
  target: TargetScope,
  status: typeof TargetStatus.Type,
) {
  const db = yield* database;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE notification_targets AS t SET active = ?4 WHERE ${scopedTarget}
    RETURNING id, configuration, active, created_at
  `)
      .bind(target.targetId, target.organizationId, target.userId, status === "active" ? 1 : 0)
      .all(),
  );
  const [row] = yield* decodeTargets(updated.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* TargetNotFound.make();
  return yield* summary(row);
});

export const notificationTargetsLive = Layer.effect(
  NotificationTargets,
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    const provideCipher = Effect.provideService(SecretCipher, cipher);
    return {
      list,
      createWebhook: (form: FormScope, url: WebhookUrl) => provideCipher(createWebhook(form, url)),
      rotateSecret: (target: TargetScope) => provideCipher(rotateSecret(target)),
      setStatus,
    };
  }),
);
