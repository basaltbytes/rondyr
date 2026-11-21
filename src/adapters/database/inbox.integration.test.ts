import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { InboxStore } from "../../domain/submissions/inbox-store.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { inboxStoreLive } from "./inbox.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const store = Effect.map(Layer.build(inboxStoreLive), Context.get(InboxStore));

/** The fields of a message whose content a test does not read. */
const message = '{"message":"Hello."}';

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

/** One more form of an organization. Its public ID is its name. */
const addForm = (organization: string, form: string) =>
  Effect.promise(() =>
    env.DB.prepare("INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)")
      .bind(`${form}-form`, organization, form, form)
      .run(),
  );

/**
 * A stored submission that no projection has seen yet. It belongs to the first
 * form of the organization, or to the form added under the given name.
 */
const receive = (organization: string, submission: string, fields: string, form = organization) =>
  Effect.promise(() =>
    env.DB.prepare(
      "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 1000)",
    )
      .bind(submission, organization, `${form}-form`, fields)
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

    const expected = { received: 0, classifying: 0, accepted: 1, quarantined: 2, archived: 0 };
    assert.deepEqual(counts, {
      ...expected,
      forms: [{ publicId: "counts-by-status", counts: expected }],
    });
  }),
);

it.live("counts the submissions of each form of an organization apart", () =>
  Effect.gen(function* () {
    yield* seedOrganization("counts-by-form");
    yield* addForm("counts-by-form", "counts-by-form-quotes");
    yield* receive("counts-by-form", "55555555-5555-4555-8555-555555555551", "{}");
    yield* receive(
      "counts-by-form",
      "55555555-5555-4555-8555-555555555552",
      "{}",
      "counts-by-form-quotes",
    );
    yield* receive(
      "counts-by-form",
      "55555555-5555-4555-8555-555555555553",
      "{}",
      "counts-by-form-quotes",
    );
    yield* project("55555555-5555-4555-8555-555555555551", "accepted");
    yield* project("55555555-5555-4555-8555-555555555552", "quarantined");
    yield* project("55555555-5555-4555-8555-555555555553", "quarantined");
    const inbox = yield* store;

    const counts = yield* inbox.counts(OrganizationId.make("counts-by-form"));

    const none = { received: 0, classifying: 0, accepted: 0, quarantined: 0, archived: 0 };
    assert.deepEqual(counts, {
      ...none,
      accepted: 1,
      quarantined: 2,
      forms: [
        { publicId: "counts-by-form", counts: { ...none, accepted: 1 } },
        { publicId: "counts-by-form-quotes", counts: { ...none, quarantined: 2 } },
      ],
    });
  }),
);

it.live("leaves a form without a submission out of the counts of the forms", () =>
  Effect.gen(function* () {
    yield* seedOrganization("counts-empty-form");
    yield* addForm("counts-empty-form", "counts-empty-form-quotes");
    yield* receive("counts-empty-form", "66666666-6666-4666-8666-666666666661", "{}");
    const inbox = yield* store;

    const counts = yield* inbox.counts(OrganizationId.make("counts-empty-form"));

    assert.deepEqual(
      counts.forms.map(({ publicId }) => publicId),
      ["counts-empty-form"],
    );
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

it.live(
  "lists a quarantined submission with its reason and a preview of the visitor's fields",
  () =>
    Effect.gen(function* () {
      const submissionId = SubmissionId.make("44444444-4444-4444-8444-444444444441");
      yield* seedOrganization("list-fields");
      yield* receive(
        "list-fields",
        submissionId,
        '{"email":"ada@example.test","message":"Bonjour."}',
      );
      const inbox = yield* store;
      yield* inbox.project({
        submissionId,
        version: 2,
        status: "quarantined",
        reason: "solicitation",
        label: null,
      });

      const page = yield* inbox.list(OrganizationId.make("list-fields"), {}, 25, undefined);

      assert.strictEqual(page.entries[0]?.reason, "solicitation");
      assert.deepEqual(page.entries[0]?.preview, {
        email: "ada@example.test",
        message: "Bonjour.",
      });
    }),
);

it.live("lists a submission with the public ID of its form", () =>
  Effect.gen(function* () {
    yield* seedOrganization("list-public-id");
    yield* addForm("list-public-id", "list-public-id-quotes");
    yield* receive(
      "list-public-id",
      "77777777-7777-4777-8777-777777777771",
      message,
      "list-public-id-quotes",
    );
    const inbox = yield* store;

    const page = yield* inbox.list(OrganizationId.make("list-public-id"), {}, 25, undefined);

    assert.strictEqual(page.entries[0]?.formPublicId, "list-public-id-quotes");
  }),
);

it.live("lists only the submissions of the form that the filter names", () =>
  Effect.gen(function* () {
    yield* seedOrganization("list-one-form");
    yield* addForm("list-one-form", "list-one-form-quotes");
    yield* receive("list-one-form", "88888888-8888-4888-8888-888888888881", message);
    yield* receive(
      "list-one-form",
      "88888888-8888-4888-8888-888888888882",
      message,
      "list-one-form-quotes",
    );
    const inbox = yield* store;

    const page = yield* inbox.list(
      OrganizationId.make("list-one-form"),
      { formPublicId: "list-one-form-quotes" },
      25,
      undefined,
    );

    assert.deepEqual(
      page.entries.map(({ submissionId }) => submissionId),
      ["88888888-8888-4888-8888-888888888882"],
    );
  }),
);

it.live("lists the submissions of a form that have the status asked for", () =>
  Effect.gen(function* () {
    yield* seedOrganization("list-form-status");
    yield* receive("list-form-status", "99999999-9999-4999-8999-999999999991", message);
    yield* receive("list-form-status", "99999999-9999-4999-8999-999999999992", message);
    yield* project("99999999-9999-4999-8999-999999999991", "accepted");
    yield* project("99999999-9999-4999-8999-999999999992", "quarantined");
    const inbox = yield* store;

    const page = yield* inbox.list(
      OrganizationId.make("list-form-status"),
      { status: "quarantined", formPublicId: "list-form-status" },
      25,
      undefined,
    );

    assert.deepEqual(
      page.entries.map(({ submissionId }) => submissionId),
      ["99999999-9999-4999-8999-999999999992"],
    );
  }),
);

it.live("lists nothing for a form that belongs to another organization", () =>
  Effect.gen(function* () {
    yield* seedOrganization("list-own");
    yield* seedOrganization("list-foreign");
    yield* receive("list-foreign", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", message);
    const inbox = yield* store;

    const page = yield* inbox.list(
      OrganizationId.make("list-own"),
      { formPublicId: "list-foreign" },
      25,
      undefined,
    );

    assert.deepEqual(page.entries, []);
  }),
);
