import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Exit, Layer, Schema } from "effect";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import { submissionRetentionLive } from "../adapters/database/submission-retention.ts";
import { dayMillis } from "../domain/organizations/retention.ts";
import { InboxPage } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { purgeExpiredSubmissions, purgeOnTheHour } from "../jobs/retention-purge.ts";
import type { SubmissionRetention } from "../ports/submission-retention.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readPage = Schema.decodeUnknownEffect(InboxPage);
const encodeFields = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      submissionId: Schema.String,
      receivedAt: Schema.String,
      form: Schema.Struct({ publicId: Schema.String, name: Schema.String }),
      status: Schema.String,
      fields: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

let counter = 0;

/** A UUID v4 that sorts after the previous one. */
function nextId() {
  counter += 1;
  return `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

const formIdOf = Effect.fnUntraced(function* (publicId: string) {
  const id = yield* Effect.promise(() =>
    env.DB.prepare("SELECT id FROM forms WHERE public_id = ?").bind(publicId).first("id"),
  );
  return String(id);
});

interface Seed {
  readonly fields: Readonly<Record<string, string>>;
  readonly receivedAt: number;
  /** The status in the inbox, or null for a message still received. */
  readonly status: "accepted" | "quarantined" | "archived" | null;
}

/** Store messages directly in D1, with their inbox row, and return their IDs in order. */
const seed = Effect.fnUntraced(function* (
  organizationId: string,
  publicId: string,
  messages: ReadonlyArray<Seed>,
) {
  const formId = yield* formIdOf(publicId);
  const ids = messages.map(() => nextId());
  const stored = yield* Effect.forEach(messages, ({ fields }) => encodeFields(fields));
  yield* Effect.promise(() =>
    env.DB.batch(
      messages.flatMap(({ receivedAt, status }, index) => [
        env.DB.prepare(
          "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(ids[index], organizationId, formId, stored[index], receivedAt),
        ...(status === null
          ? []
          : [
              env.DB.prepare(
                "INSERT INTO submission_inbox (submission_id, version, status) VALUES (?, 1, ?)",
              ).bind(ids[index], status),
            ]),
      ]),
    ),
  );
  return ids;
});

const listed = Effect.fnUntraced(function* (
  organizationId: string,
  query: string,
  headers: HeadersInit,
) {
  const response = yield* call(
    "GET",
    `/api/organizations/${organizationId}/submissions?${query}`,
    undefined,
    headers,
  );
  assert.strictEqual(response.status, 200);
  return yield* json(response).pipe(Effect.flatMap(readPage));
});

/** The body as UTF-8 text, whatever its media type. */
const bodyText = (response: Response) =>
  Effect.promise(() => response.arrayBuffer()).pipe(
    Effect.map((body) => new TextDecoder().decode(body)),
  );

const idsOf = (page: typeof InboxPage.Type) => page.entries.map(({ submissionId }) => submissionId);

it.live("searches the field values, with % and _ as ordinary characters, in one organization", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const own = yield* createInbox("Search studio", admin);
    const other = yield* createInbox("Other search studio", admin);
    const form = own.forms[0]?.publicId ?? "";
    const [percent, words, underscore, letter, fieldName] = yield* seed(own.id, form, [
      { fields: { message: "I am 100% SURE about the date" }, receivedAt: 5, status: "accepted" },
      { fields: { message: "100 percent sure" }, receivedAt: 4, status: "accepted" },
      { fields: { code: "ref a_b" }, receivedAt: 3, status: "quarantined" },
      { fields: { code: "ref axb" }, receivedAt: 2, status: "quarantined" },
      { fields: { "0% sure": "the name, not the value" }, receivedAt: 1, status: "accepted" },
    ]);
    yield* seed(other.id, other.forms[0]?.publicId ?? "", [
      { fields: { message: "100% sure, elsewhere" }, receivedAt: 6, status: "accepted" },
    ]);

    const byPercent = yield* listed(own.id, "q=0%25%20sure", admin);
    const byUnderscore = yield* listed(own.id, `q=${encodeURIComponent("a_b")}`, admin);
    const byCase = yield* listed(own.id, "q=PERCENT", admin);
    const withStatus = yield* listed(own.id, "q=ref&status=quarantined", admin);
    const short = yield* call(
      "GET",
      `/api/organizations/${own.id}/submissions?q=ab`,
      undefined,
      admin,
    );

    assert.deepEqual(idsOf(byPercent), [percent]);
    assert.deepEqual(idsOf(byUnderscore), [underscore]);
    assert.deepEqual(idsOf(byCase), [words]);
    assert.deepEqual(idsOf(withStatus), [underscore, letter]);
    assert.notInclude(idsOf(byPercent), fieldName);
    assert.strictEqual(short.status, 400);
  }),
);

it.live("pages through the results of a search with the status filter", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const inbox = yield* createInbox("Search pages", admin);
    const form = inbox.forms[0]?.publicId ?? "";
    const matching = yield* seed(
      inbox.id,
      form,
      Array.from({ length: 30 }, (_, index) => ({
        fields: { message: `needle ${index}` },
        receivedAt: 100 + index,
        status: "accepted" as const,
      })),
    );
    yield* seed(inbox.id, form, [
      { fields: { message: "needle in quarantine" }, receivedAt: 1_000, status: "quarantined" },
      { fields: { message: "haystack" }, receivedAt: 1_001, status: "accepted" },
    ]);

    const first = yield* listed(inbox.id, "q=needle&status=accepted", admin);
    const second = yield* listed(
      inbox.id,
      `q=needle&status=accepted&after=${encodeURIComponent(first.cursor ?? "")}`,
      admin,
    );

    assert.deepEqual([...idsOf(first), ...idsOf(second)], matching.toReversed());
    assert.lengthOf(first.entries, 25);
    assert.isNull(second.cursor);
  }),
);

it.live("exports the filtered list as CSV and JSON Lines, never cached", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const inbox = yield* createInbox("Export studio", admin);
    const form = inbox.forms[0];
    if (form === undefined) return assert.fail("Expected the contact form");
    const [first, second] = yield* seed(inbox.id, form.publicId, [
      {
        fields: { email: "ann@example.test", message: '=HYPERLINK("x")' },
        receivedAt: 1_000,
        status: "accepted",
      },
      {
        fields: { message: 'She said "hello", then left', status: "field" },
        receivedAt: 2_000,
        status: "accepted",
      },
    ]);
    yield* seed(inbox.id, form.publicId, [
      { fields: { message: "in quarantine" }, receivedAt: 3_000, status: "quarantined" },
    ]);
    const path = `/api/organizations/${inbox.id}/submission-export`;

    const csv = yield* call("GET", `${path}?format=csv&status=accepted`, undefined, admin);
    const csvText = yield* Effect.promise(() => csv.text());
    const jsonl = yield* call(
      "GET",
      `${path}?format=jsonl&status=accepted&q=hello`,
      undefined,
      admin,
    );
    const lines = (yield* bodyText(jsonl)).split("\n").filter((line) => line !== "");
    const decoded = yield* Effect.forEach(lines, (line) => readLine(line));
    const invalid = yield* call("GET", `${path}?format=xml`, undefined, admin);

    assert.strictEqual(csv.status, 200);
    assert.strictEqual(csv.headers.get("cache-control"), "no-store");
    assert.strictEqual(csv.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(
      csv.headers.get("content-disposition") ?? "",
      /^attachment; filename="rondyr-messages-\d{4}-\d{2}-\d{2}\.csv"$/u,
    );
    assert.strictEqual(csv.headers.get("rondyr-export-truncated"), "false");
    assert.deepEqual(csvText.split("\r\n"), [
      "submission_id,received_at,form,form_name,status,reason,label,email,message,status (field)",
      `${second},1970-01-01T00:00:02.000Z,${form.publicId},Contact,accepted,,,,"She said ""hello"", then left",field`,
      `${first},1970-01-01T00:00:01.000Z,${form.publicId},Contact,accepted,,,ann@example.test,"'=HYPERLINK(""x"")",`,
      "",
    ]);
    assert.strictEqual(jsonl.status, 200);
    assert.strictEqual(jsonl.headers.get("cache-control"), "no-store");
    assert.deepEqual(decoded, [
      {
        submissionId: second ?? "",
        receivedAt: "1970-01-01T00:00:02.000Z",
        form: { publicId: form.publicId, name: "Contact" },
        status: "accepted",
        fields: { message: 'She said "hello", then left', status: "field" },
      },
    ]);
    assert.strictEqual(invalid.status, 400);
  }),
);

it.live(
  "exports the newest 10,000 messages of a longer list",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const inbox = yield* createInbox("Bulk export", admin);
      const formId = yield* formIdOf(inbox.forms[0]?.publicId ?? "");
      yield* Effect.promise(() =>
        env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
        INSERT INTO submissions (id, organization_id, form_id, fields, received_at)
        SELECT printf('%08x-0000-4000-8000-%012x', i, i), ?, ?, json_object('message', 'bulk ' || i), i
        FROM n
      `)
          .bind(inbox.id, formId)
          .run(),
      );

      const response = yield* call(
        "GET",
        `/api/organizations/${inbox.id}/submission-export?format=jsonl`,
        undefined,
        admin,
      );
      const lines = (yield* bodyText(response)).split("\n").filter((line) => line !== "");
      const firstLine = yield* readLine(lines[0] ?? "");
      const lastLine = yield* readLine(lines.at(-1) ?? "");

      assert.strictEqual(response.headers.get("rondyr-export-truncated"), "true");
      assert.lengthOf(lines, 10_000);
      assert.deepEqual(
        [firstLine.fields, lastLine.fields],
        [{ message: "bulk 10001" }, { message: "bulk 2" }],
      );
    }),
  60_000,
);

it.live("caps the CSV at 100 field columns and puts the other fields in other_fields", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const inbox = yield* createInbox("Many field names", admin);
    // Visitors choose the names: 5 messages of 32 names each have 160 of them.
    const messages = Array.from({ length: 5 }, (_, message) => ({
      fields: Object.fromEntries(
        Array.from({ length: 32 }, (__, field) => [`m${message}f${field}`, `v${message}-${field}`]),
      ),
      receivedAt: message + 1,
      status: "accepted" as const,
    }));
    yield* seed(inbox.id, inbox.forms[0]?.publicId ?? "", messages);

    const response = yield* call(
      "GET",
      `/api/organizations/${inbox.id}/submission-export?format=csv`,
      undefined,
      admin,
    );
    const [header = "", ...lines] = (yield* bodyText(response)).split("\r\n");
    const columns = header.split(",");
    const rows = lines.filter((line) => line !== "");

    assert.strictEqual(response.status, 200);
    assert.lengthOf(columns, 7 + 100 + 1);
    assert.strictEqual(columns.at(-1), "other_fields");
    assert.lengthOf(rows, 5);
    // Each message keeps all 32 of its fields, in their columns or in other_fields.
    const all = rows.join("\n");
    for (const message of messages) {
      for (const value of Object.values(message.fields)) assert.include(all, value);
    }
  }),
);

const countIn = (table: string, column: string, value: string) =>
  Effect.promise(() =>
    env.DB.prepare(`SELECT count(*) AS total FROM ${table} WHERE ${column} = ?`)
      .bind(value)
      .first("total"),
  );

it.live(
  "deletes a message, its outbox event, inbox row, deliveries and attempts, and logs it",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const inbox = yield* createInbox("Deletion studio", admin);
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const target = yield* call(
        "POST",
        `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
        { type: "webhook", url: "https://webhooks.example.test/deletion/ok" },
        admin,
      );
      assert.strictEqual(target.status, 201);
      const posted = yield* call("POST", `/f/${form.publicId}`, {
        message: "Delete me with my deliveries",
        "fixture-verdict": "accept",
      });
      const { "submission-id": id } = yield* json(posted).pipe(Effect.flatMap(readAccepted));
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT status FROM deliveries WHERE submission_id = ?")
              .bind(id)
              .first("status")
              .then((status) => assert.strictEqual(status, "delivered")),
          { timeout: 20_000, interval: 100 },
        ),
      );
      const storedDelivery = yield* Effect.promise(() =>
        env.DB.prepare("SELECT id FROM deliveries WHERE submission_id = ?").bind(id).first("id"),
      );
      const deliveryId = String(storedDelivery);
      const before = yield* Effect.all([
        countIn("submissions", "id", id),
        countIn("outbox_events", "submission_id", id),
        countIn("submission_inbox", "submission_id", id),
        countIn("deliveries", "submission_id", id),
        countIn("delivery_attempts", "delivery_id", deliveryId),
      ]);
      const submissions = `/api/organizations/${inbox.id}/submissions`;

      const deleted = yield* call("DELETE", `${submissions}/${id}`, undefined, admin);
      const again = yield* call("DELETE", `${submissions}/${id}`, undefined, admin);
      const after = yield* Effect.all([
        countIn("submissions", "id", id),
        countIn("outbox_events", "submission_id", id),
        countIn("submission_inbox", "submission_id", id),
        countIn("deliveries", "submission_id", id),
        countIn("delivery_attempts", "delivery_id", deliveryId),
      ]);
      const log = yield* Effect.promise(() =>
        env.DB.prepare("SELECT * FROM submission_deletions WHERE submission_id = ?")
          .bind(id)
          .first(),
      );
      const owner = yield* Effect.promise(() =>
        env.DB.prepare("SELECT id FROM auth_users WHERE email = ?")
          .bind("settings-admin@example.test")
          .first("id"),
      );
      const page = yield* listed(inbox.id, "status=accepted", admin);
      const statuses = yield* Effect.forEach(
        [
          ["GET", `${submissions}/${id}`],
          ["GET", `${submissions}/${id}/deliveries`],
          ["POST", `${submissions}/${id}/approve`],
          ["POST", `${submissions}/${id}/dismiss`],
        ] as const,
        ([method, path]) =>
          call(method, path, undefined, admin).pipe(Effect.map(({ status }) => status)),
      );

      assert.deepEqual(before, [1, 1, 1, 1, 1]);
      assert.deepEqual([deleted.status, again.status], [204, 404]);
      assert.deepEqual(after, [0, 0, 0, 0, 0]);
      assert.deepEqual(log, {
        submission_id: id,
        organization_id: inbox.id,
        deleted_at: log?.deleted_at,
        deleted_by: owner,
        cause: "request",
      });
      assert.isNumber(log?.deleted_at);
      assert.notInclude(idsOf(page), id);
      assert.deepEqual(statuses, [404, 404, 404, 404]);
    }),
  40_000,
);

it.live(
  "answers 404 to a review decision on a deleted message, which stays deleted",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const inbox = yield* createInbox("Deleted review", admin);
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const honeypot = yield* call(
        "PUT",
        `/api/organizations/${inbox.id}/forms/${form.publicId}/honeypot`,
        { field: "_hp" },
        admin,
      );
      assert.strictEqual(honeypot.status, 200);
      const posted = yield* call("POST", `/f/${form.publicId}`, {
        message: "Quarantined",
        _hp: "x",
      });
      const { "submission-id": id } = yield* json(posted).pipe(Effect.flatMap(readAccepted));
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
              .bind(id)
              .first("status")
              .then((status) => assert.strictEqual(status, "quarantined")),
          { timeout: 15_000, interval: 100 },
        ),
      );
      const submissions = `/api/organizations/${inbox.id}/submissions`;
      const deleted = yield* call("DELETE", `${submissions}/${id}`, undefined, admin);

      const approved = yield* call("POST", `${submissions}/${id}/approve`, undefined, admin);
      const quarantined = yield* listed(inbox.id, "status=quarantined", admin);

      assert.deepEqual([deleted.status, approved.status], [204, 404]);
      assert.notInclude(idsOf(quarantined), id);
      const rows = yield* countIn("submission_inbox", "submission_id", id);
      assert.strictEqual(rows, 0);
    }),
  30_000,
);

it.live("keeps retention periods per organization and refuses invalid ones", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const own = yield* createInbox("Retention studio", admin);
    const path = `/api/organizations/${own.id}/retention`;

    const initial = yield* call("GET", path, undefined, admin).pipe(Effect.flatMap(json));
    const saved = yield* call("PUT", path, { accepted: 30, quarantine: 7 }, admin);
    const savedBody = yield* json(saved);
    const refused = yield* Effect.forEach(
      [
        { accepted: 0, quarantine: null },
        { accepted: 3_651, quarantine: null },
        { accepted: 1.5, quarantine: null },
        { accepted: 30 },
      ],
      (body) => call("PUT", path, body, admin).pipe(Effect.map(({ status }) => status)),
    );
    const reread = yield* call("GET", path, undefined, admin).pipe(Effect.flatMap(json));

    assert.deepEqual(initial, { accepted: null, quarantine: null });
    assert.deepEqual([saved.status, savedBody], [200, { accepted: 30, quarantine: 7 }]);
    assert.deepEqual(refused, [400, 400, 400, 400]);
    assert.deepEqual(reread, { accepted: 30, quarantine: 7 });
  }),
);

/** Run with the D1 adapter of the retention, as the Cron does. */
const withRetention = <A, E>(effect: Effect.Effect<A, E, SubmissionRetention>) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(submissionRetentionLive), (context) =>
      Effect.provideContext(effect, context),
    ),
  );

const purgeAt = (now: number) => withRetention(purgeExpiredSubmissions(now));

const purgeNow = Effect.flatMap(Clock.currentTimeMillis, purgeAt);

const remaining = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT id FROM submissions WHERE organization_id = ? ORDER BY received_at")
      .bind(organizationId)
      .all(),
  ).pipe(Effect.map(({ results }) => results.map(({ id }) => String(id))));

it.live("purges each status at the exact end of its retention period, and logs it", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const own = yield* createInbox("Purge boundary", admin);
    const unlimited = yield* createInbox("Purge unlimited", admin);
    const retention = yield* call(
      "PUT",
      `/api/organizations/${own.id}/retention`,
      { accepted: 30, quarantine: 7 },
      admin,
    );
    assert.strictEqual(retention.status, 200);
    const now = yield* Clock.currentTimeMillis;
    const form = own.forms[0]?.publicId ?? "";
    const accepted = now - 30 * dayMillis;
    const quarantine = now - 7 * dayMillis;
    const [
      acceptedAtLimit,
      acceptedBefore,
      quarantinedAtLimit,
      archivedAfter,
      quarantinedBefore,
      stillReceived,
    ] = yield* seed(own.id, form, [
      { fields: { message: "a" }, receivedAt: accepted, status: "accepted" },
      { fields: { message: "b" }, receivedAt: accepted + 1, status: "accepted" },
      { fields: { message: "c" }, receivedAt: quarantine, status: "quarantined" },
      { fields: { message: "d" }, receivedAt: quarantine - 1, status: "archived" },
      { fields: { message: "e" }, receivedAt: quarantine + 1, status: "quarantined" },
      { fields: { message: "f" }, receivedAt: now - 365 * dayMillis, status: null },
    ]);
    const [kept] = yield* seed(unlimited.id, unlimited.forms[0]?.publicId ?? "", [
      { fields: { message: "g" }, receivedAt: now - 365 * dayMillis, status: "accepted" },
    ]);

    const purged = yield* purgeAt(now);
    const left = yield* remaining(own.id);
    const leftElsewhere = yield* remaining(unlimited.id);
    const log = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT submission_id, deleted_by, cause, deleted_at FROM submission_deletions WHERE organization_id = ? ORDER BY submission_id",
      )
        .bind(own.id)
        .all(),
    );

    // The messages kept here expire a millisecond later: the next tests run without retention.
    const reset = yield* call(
      "PUT",
      `/api/organizations/${own.id}/retention`,
      { accepted: null, quarantine: null },
      admin,
    );
    assert.strictEqual(reset.status, 200);
    assert.strictEqual(purged, 3);
    assert.deepEqual(
      left.toSorted(),
      [stillReceived, acceptedBefore, quarantinedBefore].toSorted(),
    );
    assert.deepEqual(leftElsewhere, [kept]);
    assert.deepEqual(
      log.results,
      [acceptedAtLimit, quarantinedAtLimit, archivedAfter].toSorted().map((id) => ({
        submission_id: id,
        deleted_by: null,
        cause: "retention",
        deleted_at: now,
      })),
    );
  }),
);

it.live(
  "resumes an interrupted purge at the next run, in batches of 500",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const inbox = yield* createInbox("Interrupted purge", admin);
      const saved = yield* call(
        "PUT",
        `/api/organizations/${inbox.id}/retention`,
        { accepted: 1, quarantine: null },
        admin,
      );
      assert.strictEqual(saved.status, 200);
      const ids = yield* seed(
        inbox.id,
        inbox.forms[0]?.publicId ?? "",
        Array.from({ length: 600 }, (_, index) => ({
          fields: { message: `old ${index}` },
          receivedAt: index,
          status: "accepted" as const,
        })),
      );
      // The second batch fails on its 50th message, as if the Worker stopped there.
      yield* Effect.promise(() =>
        env.DB.prepare(`
        CREATE TRIGGER interrupt_purge BEFORE DELETE ON submissions
        WHEN old.id = '${ids[549] ?? ""}' BEGIN SELECT RAISE(ABORT, 'interrupted'); END
      `).run(),
      );

      const interrupted = yield* Effect.exit(purgeNow);
      const afterFirst = yield* remaining(inbox.id);
      const loggedFirst = yield* countIn("submission_deletions", "organization_id", inbox.id);
      yield* Effect.promise(() => env.DB.prepare("DROP TRIGGER interrupt_purge").run());
      const resumed = yield* purgeNow;
      const afterSecond = yield* remaining(inbox.id);
      const logged = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT count(*) AS total, count(DISTINCT submission_id) AS distinct_total FROM submission_deletions WHERE organization_id = ?",
        )
          .bind(inbox.id)
          .first(),
      );

      assert.isTrue(Exit.isFailure(interrupted));
      assert.deepEqual(afterFirst, ids.slice(500));
      assert.strictEqual(loggedFirst, 500);
      assert.strictEqual(resumed, 100);
      assert.deepEqual(afterSecond, []);
      assert.deepEqual(logged, { total: 600, distinct_total: 600 });
    }),
  30_000,
);

/** Store `count` accepted messages received at 1 ms, 2 ms… with ID prefix `prefix`. */
const seedAccepted = Effect.fnUntraced(function* (
  organizationId: string,
  publicId: string,
  prefix: string,
  count: number,
) {
  const formId = yield* formIdOf(publicId);
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4)
        INSERT INTO submissions (id, organization_id, form_id, fields, received_at)
        SELECT printf('%s-0000-4000-8000-%012x', ?3, i), ?1, ?2, json_object('message', 'old ' || i), i
        FROM n
      `).bind(organizationId, formId, prefix, count),
      env.DB.prepare(`
        INSERT INTO submission_inbox (submission_id, version, status)
        SELECT id, 1, 'accepted' FROM submissions WHERE organization_id = ?
      `).bind(organizationId),
    ]),
  );
});

it.live(
  "gives every organization a batch before a large backlog gets another, and stops after 20",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const backlog = yield* createInbox("Purge backlog", admin);
      const small = yield* createInbox("Purge small", admin);
      for (const inbox of [backlog, small]) {
        const saved = yield* call(
          "PUT",
          `/api/organizations/${inbox.id}/retention`,
          { accepted: 1, quarantine: null },
          admin,
        );
        assert.strictEqual(saved.status, 200);
      }
      yield* seedAccepted(backlog.id, backlog.forms[0]?.publicId ?? "", "baccbacc", 10_500);
      yield* seedAccepted(small.id, small.forms[0]?.publicId ?? "", "5a115a11", 10);

      const deleted = yield* purgeNow;
      const left = yield* Effect.forEach([backlog.id, small.id], (id) =>
        countIn("submissions", "organization_id", id),
      );

      // The small organization is done in its first turn; the backlog keeps
      // whole batches for the next runs.
      assert.deepEqual(left[1], 0);
      assert.isAtMost(deleted, 20 * 500);
      assert.isAtLeast(Number(left[0]), 500);
      assert.strictEqual((10_500 - Number(left[0])) % 500, 0);
      assert.strictEqual(deleted, 10_500 - Number(left[0]) + 10);
      for (const inbox of [backlog, small]) {
        const reset = yield* call(
          "PUT",
          `/api/organizations/${inbox.id}/retention`,
          { accepted: null, quarantine: null },
          admin,
        );
        assert.strictEqual(reset.status, 200);
      }
    }),
  60_000,
);

it.live("purges in the run scheduled for the first minute of an hour only", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const inbox = yield* createInbox("Hourly purge", admin);
    const saved = yield* call(
      "PUT",
      `/api/organizations/${inbox.id}/retention`,
      { accepted: 1, quarantine: null },
      admin,
    );
    assert.strictEqual(saved.status, 200);
    yield* seedAccepted(inbox.id, inbox.forms[0]?.publicId ?? "", "40a140a1", 3);
    const now = yield* Clock.currentTimeMillis;
    const hour = Math.floor(now / 3_600_000) * 3_600_000;

    yield* withRetention(purgeOnTheHour(hour + 60_000));
    const afterLateRun = yield* countIn("submissions", "organization_id", inbox.id);
    yield* withRetention(purgeOnTheHour(hour));
    const afterHourlyRun = yield* countIn("submissions", "organization_id", inbox.id);

    assert.deepEqual([afterLateRun, afterHourlyRun], [3, 0]);
    const reset = yield* call(
      "PUT",
      `/api/organizations/${inbox.id}/retention`,
      { accepted: null, quarantine: null },
      admin,
    );
    assert.strictEqual(reset.status, 200);
  }),
);

it.live("refuses search export, deletion and retention of another organization", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const own = yield* createInbox("Isolated records", admin);
    const [id] = yield* seed(own.id, own.forms[0]?.publicId ?? "", [
      { fields: { message: "private needle" }, receivedAt: 1, status: "accepted" },
    ]);
    yield* Effect.promise(() =>
      env.DB.prepare("DELETE FROM organization_members WHERE organization_id = ?")
        .bind(own.id)
        .run(),
    );
    const org = `/api/organizations/${own.id}`;

    const statuses = yield* Effect.forEach(
      [
        ["GET", `${org}/submissions?q=needle`],
        ["GET", `${org}/submission-export?format=csv`],
        ["DELETE", `${org}/submissions/${id}`],
        ["GET", `${org}/retention`],
        ["PUT", `${org}/retention`],
      ] as const,
      ([method, path]) =>
        call(
          method,
          path,
          method === "PUT" ? { accepted: 1, quarantine: 1 } : undefined,
          admin,
        ).pipe(Effect.map(({ status }) => status)),
    );

    assert.deepEqual(statuses, [404, 404, 404, 404, 404]);
    const kept = yield* countIn("submissions", "id", id ?? "");
    assert.strictEqual(kept, 1);
    assert.strictEqual(origin, "https://rondyr.test");
  }),
);
