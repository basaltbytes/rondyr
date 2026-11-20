import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { InboxStore } from "../../domain/submissions/inbox-store.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";
import { inboxStoreLive } from "./inbox.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const store = Effect.map(Layer.build(inboxStoreLive), Context.get(InboxStore));

/** An organization with one form. Each test has its own, so tests do not share rows. */
const seedOrganization = (organization: string) =>
  Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        organization,
        organization,
      ),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${organization}-form`, organization, organization, "Contact"),
    ]),
  );

/** A stored submission that no projection has seen yet. */
const receive = (organization: string, submission: string, fields: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 1000)",
    )
      .bind(submission, organization, `${organization}-form`, fields)
      .run(),
  );

/** The row that the inbox projection writes once a submission has a status. */
const project = (submission: string, status: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "INSERT INTO submission_inbox (submission_id, version, status, reason) VALUES (?, 1, ?, NULL)",
    )
      .bind(submission, status)
      .run(),
  );

it.live("counts the submissions of an organization by status", () =>
  Effect.gen(function* () {
    yield* seedOrganization("counts-by-status");
    yield* receive("counts-by-status", "11111111-1111-4111-8111-111111111111", "{}");
    yield* receive("counts-by-status", "11111111-1111-4111-8111-111111111112", "{}");
    yield* receive("counts-by-status", "11111111-1111-4111-8111-111111111113", "{}");
    yield* project("11111111-1111-4111-8111-111111111111", "quarantined");
    yield* project("11111111-1111-4111-8111-111111111112", "quarantined");
    yield* project("11111111-1111-4111-8111-111111111113", "accepted");
    const inbox = yield* store;

    const counts = yield* inbox.counts(OrganizationId.make("counts-by-status"));

    assert.deepEqual(counts, {
      received: 0,
      classifying: 0,
      accepted: 1,
      quarantined: 2,
      archived: 0,
    });
  }),
);

it.live("counts a submission that no projection has seen yet as received", () =>
  Effect.gen(function* () {
    yield* seedOrganization("counts-unprojected");
    yield* receive("counts-unprojected", "22222222-2222-4222-8222-222222222221", "{}");
    const inbox = yield* store;

    const counts = yield* inbox.counts(OrganizationId.make("counts-unprojected"));

    assert.strictEqual(counts.received, 1);
  }),
);

it.live("leaves the submissions of another organization out of the counts", () =>
  Effect.gen(function* () {
    yield* seedOrganization("counts-own");
    yield* seedOrganization("counts-other");
    yield* receive("counts-other", "33333333-3333-4333-8333-333333333331", "{}");
    yield* project("33333333-3333-4333-8333-333333333331", "quarantined");
    const inbox = yield* store;

    const counts = yield* inbox.counts(OrganizationId.make("counts-own"));

    assert.strictEqual(counts.quarantined, 0);
  }),
);

it.live("lists a submission with the fields that the visitor sent", () =>
  Effect.gen(function* () {
    yield* seedOrganization("list-fields");
    yield* receive(
      "list-fields",
      "44444444-4444-4444-8444-444444444441",
      '{"email":"ada@example.test","message":"Bonjour."}',
    );
    const inbox = yield* store;

    const page = yield* inbox.list(OrganizationId.make("list-fields"), undefined, 25, undefined);

    assert.deepEqual(page.entries[0]?.fields, {
      email: "ada@example.test",
      message: "Bonjour.",
    });
  }),
);
