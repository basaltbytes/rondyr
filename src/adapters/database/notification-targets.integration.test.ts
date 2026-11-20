import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { testSecretsKey } from "../../../tests/integration/auth-fixture.ts";
import { EmailAddress, EmailTarget, parseEmailRecipients } from "../../domain/deliveries/email.ts";
import { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import { NotificationTargets, type FormScope } from "../../ports/notification-targets.ts";
import { secretCipherLayer } from "../crypto/secret-cipher.ts";
import { emailSenderLayer } from "../email/email-sender.ts";
import { notificationTargetsLive } from "./notification-targets.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const isEmail = Schema.is(EmailTarget);

const emailSender = emailSenderLayer(
  Effect.succeed({
    RESEND_API_KEY: Redacted.make("re_notification_targets_test_key"),
    RONDYR_EMAIL_FROM: EmailAddress.make("forms@rondyr.test"),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
const cipher = secretCipherLayer(Effect.succeedSome(Redacted.make(testSecretsKey)));
const service = Effect.map(
  Layer.build(notificationTargetsLive.pipe(Layer.provide(Layer.mergeAll(cipher, emailSender)))),
  Context.get(NotificationTargets),
);

/** A member of `<name>-org` and its form. Each test has its own, so tests do not share rows. */
const seedForm = Effect.fnUntraced(function* (name: string) {
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES (?1, ?1, ?2, 0, 0)",
      ).bind(`${name}-user`, `${name}@example.test`),
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        `${name}-org`,
        name,
      ),
      env.DB.prepare(
        "INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)",
      ).bind(`${name}-org`, `${name}-user`),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${name}-form`, `${name}-org`, name, name),
    ]),
  );
  const scope: FormScope = {
    userId: UserId.make(`${name}-user`),
    organizationId: OrganizationId.make(`${name}-org`),
    formPublicId: name,
  };
  return scope;
});

const recipients = (address: string) =>
  Result.getOrElse(parseEmailRecipients([address]), () => assert.fail(`${address} is refused`));

it.live("creates an email target with the language it is given", () =>
  Effect.gen(function* () {
    const form = yield* seedForm("language-created");
    const targets = yield* service;

    const target = yield* targets.createEmail(form, recipients("team@example.test"), "fr");

    assert.strictEqual(target.language, "fr");
  }),
);

it.live("keeps the language of an email target when only its recipients change", () =>
  Effect.gen(function* () {
    const form = yield* seedForm("language-kept");
    const targets = yield* service;
    const created = yield* targets.createEmail(form, recipients("team@example.test"), "fr");

    const changed = yield* targets.replaceRecipients(
      { userId: form.userId, organizationId: form.organizationId, targetId: created.id },
      recipients("owner@example.test"),
      undefined,
    );

    assert.deepEqual([changed.recipients, changed.language], [["owner@example.test"], "fr"]);
  }),
);

it.live("changes the language of an email target along with its recipients", () =>
  Effect.gen(function* () {
    const form = yield* seedForm("language-changed");
    const targets = yield* service;
    const created = yield* targets.createEmail(form, recipients("team@example.test"), "en");

    const changed = yield* targets.replaceRecipients(
      { userId: form.userId, organizationId: form.organizationId, targetId: created.id },
      recipients("team@example.test"),
      "fr",
    );

    assert.strictEqual(changed.language, "fr");
  }),
);

it.live("reads an email target stored before the language setting as French", () =>
  Effect.gen(function* () {
    const form = yield* seedForm("language-legacy");
    yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
         VALUES ('language-legacy-target', 'language-legacy-org', 'language-legacy-form', 'email', ?, 0)`,
      )
        .bind('{"recipients":["legacy@example.test"]}')
        .run(),
    );
    const targets = yield* service;

    const listed = yield* targets.list(form);

    assert.deepEqual(
      listed.filter(isEmail).map(({ language }) => language),
      ["fr"],
    );
  }),
);
