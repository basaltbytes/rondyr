import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin, testSetupToken } from "../../../tests/integration/auth-fixture.ts";
import { ManagedForm, type SuccessUrlRefusalReason } from "../../domain/forms/form.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";
import { InboxPage, SubmissionDetail } from "../../domain/submissions/inbox.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readForm = Schema.decodeUnknownEffect(ManagedForm);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readPage = Schema.decodeUnknownEffect(InboxPage);
const readSubmission = Schema.decodeUnknownEffect(SubmissionDetail);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => env.TEST_WORKER.fetch(new URL(path, origin), init));
}

/** A JSON request from the dashboard's origin. */
const call = Effect.fnUntraced(function* (
  method: string,
  path: string,
  data?: Schema.Json,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("origin", origin);
  if (data === undefined) return yield* request(path, { method, headers });
  headers.set("content-type", "application/json");
  const body = yield* encode(data);
  return yield* request(path, { method, headers, body });
});

const json = (response: Response) => Effect.promise(() => response.json());

const statusOf = (response: Response) => response.status;

const formOf = (response: Response) => json(response).pipe(Effect.flatMap(readForm));

const withBody = (response: Response) =>
  Effect.map(json(response), (body) => ({ status: response.status, body }));

const credentials = { email: "forms@example.test", password: "form-routes-password" };

/**
 * The cookie of the file's account. The first call creates the account. The tests reuse one
 * session, so their sign-ins stay within the rate limit window.
 */
const signIn = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const setup = yield* call(
        "POST",
        "/api/setup",
        { name: "Forms", ...credentials },
        { authorization: `Bearer ${testSetupToken}` },
      );
      // 201 the first time; the setup endpoint answers 404 once an account exists.
      assert.oneOf(setup.status, [201, 404]);
      const session = yield* call("POST", "/api/auth/sign-in/email", credentials);
      assert.strictEqual(session.status, 200);
      const cookie = session.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      return { cookie, origin };
    }),
  ),
);

/** Create an organization with its first form, and return the organization. */
const createInbox = Effect.fnUntraced(function* (
  headers: HeadersInit,
  organizationName: string,
  businessContext: string,
) {
  const created = yield* call(
    "POST",
    "/api/organizations",
    { organizationName, formName: "Contact", businessContext },
    headers,
  );
  assert.strictEqual(created.status, 201);
  const inboxes = yield* request("/api/organizations", { headers }).pipe(
    Effect.flatMap(json),
    Effect.flatMap(readInboxes),
  );
  const inbox = inboxes.find(({ name }) => name === organizationName);
  const form = inbox?.forms[0];
  if (inbox === undefined || form === undefined) return assert.fail("Expected a form");
  return { inbox, form };
});

const storedForm = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(`
      SELECT name, status, business_context, success_url, turnstile_site_key, turnstile_secret
      FROM forms WHERE public_id = ?
    `)
      .bind(publicId)
      .first(),
  );

it.live("manages the forms of the account's organizations and refuses other organizations", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const { inbox, form: first } = yield* createInbox(headers, "Pottery studio", "");
    assert.deepEqual(first, {
      name: "Contact",
      publicId: first.publicId,
      status: "active",
      emoji: null,
      businessContext: null,
      successUrl: null,
      honeypotField: null,
      turnstileSiteKey: null,
    });
    const forms = `/api/organizations/${inbox.id}/forms`;
    const formPath = (publicId: string) => `${forms}/${encodeURIComponent(publicId)}`;
    const contact = formPath(first.publicId);

    const anonymous = yield* Effect.all([
      call("POST", forms, { name: "Classes" }),
      call("PATCH", contact, { name: "Renamed" }),
      call("POST", `${contact}/suspend`),
      call("POST", `${contact}/reactivate`),
      call("PUT", `${contact}/success-url`, { url: "https://shop.example.com/merci" }),
      call("DELETE", `${contact}/success-url`),
    ]);
    assert.deepEqual(anonymous.map(statusOf), [401, 401, 401, 401, 401, 401]);

    // Add a form: the same bounds as the first form of an organization.
    const invalidForms: ReadonlyArray<Schema.Json> = [
      {},
      { name: "" },
      { name: "   " },
      { name: "n".repeat(101) },
      { name: 42 },
      { name: "Classes", businessContext: "c".repeat(2001) },
      { name: "Classes", emoji: "" },
      { name: "Classes", emoji: "pot" },
      { name: "Classes", emoji: "🏺🏺" },
    ];
    const invalidCreations = yield* Effect.forEach(invalidForms, (body) =>
      call("POST", forms, body, headers),
    );
    assert.deepEqual(
      invalidCreations.map(statusOf),
      invalidForms.map(() => 400),
    );
    const createdClasses = yield* call(
      "POST",
      forms,
      { name: "  Classes  ", emoji: " 🏺 ", businessContext: " Pottery workshops " },
      headers,
    );
    assert.strictEqual(createdClasses.status, 201);
    assert.strictEqual(createdClasses.headers.get("cache-control"), "no-store");
    const classes = yield* formOf(createdClasses);
    assert.deepEqual(classes, {
      name: "Classes",
      publicId: classes.publicId,
      status: "active",
      emoji: "🏺",
      businessContext: "Pottery workshops",
      successUrl: null,
      honeypotField: null,
      turnstileSiteKey: null,
    });
    assert.notStrictEqual(classes.publicId, first.publicId);
    const shop = yield* call("POST", forms, { name: "Shop", businessContext: "" }, headers).pipe(
      Effect.flatMap(formOf),
    );
    assert.strictEqual(shop.businessContext, null);
    // The new form has its own public URL.
    const posted = yield* call("POST", `/f/${shop.publicId}`, { message: "Hello" });
    assert.strictEqual(posted.status, 202);

    const listed = yield* request("/api/organizations", { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );
    assert.deepEqual(listed.find(({ id }) => id === inbox.id)?.forms, [classes, first, shop]);

    // Rename and change the business context, separately or together.
    const lesson = formPath(classes.publicId);
    const edits = yield* Effect.forEach(
      [
        { name: "Lessons" },
        { businessContext: "Wheel throwing lessons" },
        { name: " Courses ", businessContext: "c".repeat(2000) },
        { businessContext: "" },
      ],
      (body) => call("PATCH", lesson, body, headers).pipe(Effect.flatMap(withBody)),
    );
    assert.deepEqual(
      edits.map(({ status }) => status),
      [200, 200, 200, 200],
    );
    const edited = yield* Effect.forEach(edits, ({ body }) => readForm(body));
    assert.deepEqual(
      edited.map(({ name, businessContext }) => [name, businessContext]),
      [
        ["Lessons", "Pottery workshops"],
        ["Lessons", "Wheel throwing lessons"],
        ["Courses", "c".repeat(2000)],
        ["Courses", null],
      ],
    );
    const invalidEdits = yield* Effect.forEach(
      [{}, { name: "" }, { name: "n".repeat(101) }, { businessContext: "c".repeat(2001) }],
      (body) => call("PATCH", lesson, body, headers),
    );
    assert.deepEqual(invalidEdits.map(statusOf), [400, 400, 400, 400]);

    // The emoji changes alone, a flag and a joined sequence included, and the other edits keep it.
    const emojis = yield* Effect.forEach(
      [{ emoji: "🎓" }, { emoji: "🇫🇷" }, { emoji: " 🧑‍🏫 " }, { name: "Courses" }],
      (body) => call("PATCH", lesson, body, headers).pipe(Effect.flatMap(formOf)),
    );
    assert.deepEqual(
      emojis.map(({ name, emoji, businessContext }) => [name, emoji, businessContext]),
      [
        ["Courses", "🎓", null],
        ["Courses", "🇫🇷", null],
        ["Courses", "🧑‍🏫", null],
        ["Courses", "🧑‍🏫", null],
      ],
    );
    const invalidEmojis = yield* Effect.forEach(
      [{ emoji: "" }, { emoji: "course" }, { emoji: "🎓🎓" }, { emoji: 7 }, { emoji: null }],
      (body) => call("PATCH", lesson, body, headers),
    );
    assert.deepEqual(invalidEmojis.map(statusOf), [400, 400, 400, 400, 400]);

    // Suspend and reactivate; repeating an action changes nothing.
    const statuses = yield* Effect.forEach(
      ["suspend", "suspend", "reactivate", "reactivate"],
      (action) =>
        call("POST", `${lesson}/${action}`, undefined, headers).pipe(Effect.flatMap(formOf)),
    );
    assert.deepEqual(
      statuses.map(({ status }) => status),
      ["suspended", "suspended", "active", "active"],
    );

    // A success URL needs an HTTPS URL whose origin is on the form's list.
    const successUrl = `${lesson}/success-url`;
    const refusedUrls: ReadonlyArray<readonly [string, SuccessUrlRefusalReason]> = [
      ["https://shop.example.com/merci", "origin-not-listed"],
      ["http://shop.example.com/merci", "not-https"],
      ["merci.html", "invalid-url"],
      ["https://user:secret@shop.example.com/merci", "credentials"],
      ["javascript:alert(1)", "not-https"],
    ];
    const refusals = yield* Effect.forEach(refusedUrls, ([url]) =>
      call("PUT", successUrl, { url }, headers).pipe(Effect.flatMap(withBody)),
    );
    assert.deepEqual(
      refusals,
      refusedUrls.map(([, reason]) => ({
        status: 400,
        body: { error: "success-url-refused", reason },
      })),
    );
    const malformed = yield* call(
      "PUT",
      successUrl,
      { href: "https://shop.example.com/" },
      headers,
    );
    assert.strictEqual(malformed.status, 400);

    const origins = `${lesson}/origins`;
    const addOrigin = (value: string) => call("POST", origins, { origin: value }, headers);
    const removeOrigin = (value: string) =>
      request(`${origins}?${new URLSearchParams({ origin: value })}`, {
        method: "DELETE",
        headers,
      });
    assert.strictEqual((yield* addOrigin("https://shop.example.com")).status, 201);
    assert.strictEqual((yield* addOrigin("https://www.example.com")).status, 201);
    const withUrl = yield* call(
      "PUT",
      successUrl,
      { url: " HTTPS://Shop.Example.com:443/merci?from=form#top " },
      headers,
    ).pipe(Effect.flatMap(formOf));
    assert.strictEqual(withUrl.successUrl, "https://shop.example.com/merci?from=form#top");

    const redirected = yield* request(`/f/${classes.publicId}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: "https://shop.example.com",
      },
      body: "message=Hello",
    });
    assert.strictEqual(redirected.status, 303);
    assert.strictEqual(redirected.headers.get("location"), withUrl.successUrl);

    // The origin of the success URL stays on the list until the URL is cleared.
    const inUse = yield* removeOrigin("https://shop.example.com").pipe(Effect.flatMap(withBody));
    assert.deepEqual(inUse, { status: 409, body: { error: "origin-in-use" } });
    assert.strictEqual((yield* removeOrigin("https://www.example.com")).status, 204);
    const cleared = yield* call("DELETE", successUrl, undefined, headers).pipe(
      Effect.flatMap(formOf),
    );
    assert.strictEqual(cleared.successUrl, null);
    assert.strictEqual((yield* removeOrigin("https://shop.example.com")).status, 204);
    assert.strictEqual((yield* removeOrigin("https://shop.example.com")).status, 404);

    // No edit changed a public ID.
    for (const changed of [...edited, ...statuses, withUrl, cleared]) {
      assert.strictEqual(changed.publicId, classes.publicId);
    }
    const final = yield* request("/api/organizations", { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );
    assert.deepEqual(
      final.find(({ id }) => id === inbox.id)?.forms.map(({ publicId }) => publicId),
      // Sorted by name: Contact, then Courses, then Shop.
      [first.publicId, classes.publicId, shop.publicId],
    );

    // Another organization's form answers 404 and keeps its settings.
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('other-org', 'Other')"),
        env.DB.prepare(`
          INSERT INTO forms (
            id, organization_id, public_id, name, business_context, success_url,
            turnstile_site_key, turnstile_secret
          )
          VALUES (
            'other-form', 'other-org', 'other', 'Other', 'Other context',
            'https://other.example.com/thanks', 'other_site_key', 'v1.other.secret'
          )
        `),
        env.DB.prepare(
          "INSERT INTO form_origins (form_id, origin, created_at) VALUES ('other-form', 'https://other.example.com', 0)",
        ),
      ]),
    );
    const before = yield* storedForm("other");
    const foreignSecret = "foreign-form-secret";
    const foreignPaths = ["/api/organizations/other-org/forms/other", `${forms}/other`];
    const foreign = yield* Effect.forEach(foreignPaths, (path) =>
      Effect.all([
        call("PATCH", path, { name: "Taken" }, headers),
        call("POST", `${path}/suspend`, undefined, headers),
        call("POST", `${path}/reactivate`, undefined, headers),
        call("PUT", `${path}/success-url`, { url: "https://other.example.com/x" }, headers),
        call("DELETE", `${path}/success-url`, undefined, headers),
        call("PUT", `${path}/turnstile`, { siteKey: "taken", secretKey: foreignSecret }, headers),
        call("DELETE", `${path}/turnstile`, undefined, headers),
      ]),
    );
    assert.deepEqual(
      foreign.map((responses) => responses.map(statusOf)),
      [
        [404, 404, 404, 404, 404, 404, 404],
        [404, 404, 404, 404, 404, 404, 404],
      ],
    );
    const checked = yield* Effect.promise(() =>
      env.SITEVERIFY_FIXTURE.fetch(`https://siteverify.test/__calls?secret=${foreignSecret}`),
    );
    const checks = yield* json(checked);
    assert.deepEqual(checks, []);
    const foreignCreate = yield* call(
      "POST",
      "/api/organizations/other-org/forms",
      { name: "Intruder" },
      headers,
    );
    assert.strictEqual(foreignCreate.status, 404);
    const unknownCreate = yield* call(
      "POST",
      "/api/organizations/unknown-org/forms",
      { name: "Intruder" },
      headers,
    );
    assert.strictEqual(unknownCreate.status, 404);
    const after = yield* storedForm("other");
    assert.deepEqual(after, before);
    const otherForms = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM forms WHERE organization_id = 'other-org'",
      ).first("count"),
    );
    assert.strictEqual(otherForms, 1);
    // The list of the account does not show the other organization.
    assert.isUndefined(final.find(({ id }) => id === "other-org"));
  }),
);

/** Wait until the classifier has decided on the submission. */
const decided = (submissionId: string) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
          .bind(submissionId)
          .first("status")
          .then((status) => {
            assert.oneOf(status, ["accepted", "quarantined"]);
          }),
      { timeout: 20_000, interval: 100 },
    ),
  );

it.live(
  "keeps the messages of a suspended form and classifies with the edited business context",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inbox, form } = yield* createInbox(headers, "Ceramics", "Pottery workshops");
      const formPath = `/api/organizations/${inbox.id}/forms/${form.publicId}`;
      const submissions = `/api/organizations/${inbox.id}/submissions`;
      const message = { message: "Is there room in the class?", "fixture-verdict": "accept" };
      const submit = call("POST", `/f/${form.publicId}`, message);
      const detail = (submissionId: string) =>
        request(`${submissions}/${submissionId}`, { headers }).pipe(
          Effect.flatMap(json),
          Effect.flatMap(readSubmission),
        );
      const storedCount = Effect.promise(() =>
        env.DB.prepare(
          "SELECT COUNT(*) AS count FROM submissions s JOIN forms f ON f.id = s.form_id WHERE f.public_id = ?",
        )
          .bind(form.publicId)
          .first("count"),
      );

      const first = yield* submit;
      assert.strictEqual(first.status, 202);
      const { "submission-id": firstId } = yield* json(first).pipe(Effect.flatMap(readAccepted));
      yield* decided(firstId);
      const accepted = yield* detail(firstId);
      assert.deepEqual([accepted.status, accepted.reason], ["accepted", null]);

      // Suspended: refused, nothing stored, and earlier messages stay in the inbox.
      const suspended = yield* call("POST", `${formPath}/suspend`, undefined, headers).pipe(
        Effect.flatMap(formOf),
      );
      assert.strictEqual(suspended.status, "suspended");
      const refused = yield* submit;
      assert.strictEqual(refused.status, 403);
      const storedWhileSuspended = yield* storedCount;
      assert.strictEqual(storedWhileSuspended, 1);
      const page = yield* request(submissions, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readPage),
      );
      assert.deepEqual(
        page.entries.map(({ submissionId }) => submissionId),
        [firstId],
      );
      const kept = yield* detail(firstId);
      assert.deepEqual(kept.fields, message);
      const listed = yield* request("/api/organizations", { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readInboxes),
      );
      assert.deepEqual(
        listed
          .find(({ id }) => id === inbox.id)
          ?.forms.map(({ publicId, status }) => [publicId, status]),
        [[form.publicId, "suspended"]],
      );

      // Reactivated with a context that the fixture scores as unrelated to the message.
      const reactivated = yield* call("POST", `${formPath}/reactivate`, undefined, headers).pipe(
        Effect.flatMap(formOf),
      );
      assert.strictEqual(reactivated.status, "active");
      const described = yield* call(
        "PATCH",
        formPath,
        { businessContext: "Bakery. fixture-relevance: low" },
        headers,
      ).pipe(Effect.flatMap(formOf));
      assert.strictEqual(described.businessContext, "Bakery. fixture-relevance: low");
      const second = yield* submit;
      assert.strictEqual(second.status, 202);
      const { "submission-id": secondId } = yield* json(second).pipe(Effect.flatMap(readAccepted));
      yield* decided(secondId);
      const quarantined = yield* detail(secondId);
      assert.deepEqual([quarantined.status, quarantined.reason], ["quarantined", "low-relevance"]);
      const storedAfter = yield* storedCount;
      assert.strictEqual(storedAfter, 2);
    }),
  45_000,
);

/** Post a message to the form, wait for the classifier, and read the submission back. */
const classified = Effect.fnUntraced(function* (
  headers: HeadersInit,
  organizationId: string,
  publicId: string,
  fields: Record<string, string>,
) {
  const sent = yield* call("POST", `/f/${publicId}`, fields);
  assert.strictEqual(sent.status, 202);
  const { "submission-id": submissionId } = yield* json(sent).pipe(Effect.flatMap(readAccepted));
  yield* decided(submissionId);
  return yield* request(`/api/organizations/${organizationId}/submissions/${submissionId}`, {
    headers,
  }).pipe(Effect.flatMap(json), Effect.flatMap(readSubmission));
});

it.live(
  "quarantines a sales pitch for solicitation after the spam rules and before low relevance",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inbox, form } = yield* createInbox(
        headers,
        "Outreach",
        "Pottery workshops. fixture-relevance: low",
      );
      const pitch = {
        message: "Who handles your website? I have an idea to send them.",
        "fixture-verdict": "solicitation",
      };
      const spammyPitch = {
        message: "We send ceramics studios twenty workshop leads a month. Can I call you?",
        "fixture-verdict": "ambiguous-solicitation",
      };

      const solicited = yield* classified(headers, inbox.id, form.publicId, pitch);
      const ambiguous = yield* classified(headers, inbox.id, form.publicId, spammyPitch);

      // The relevance score is low for both, and the ambiguous spam score takes precedence.
      assert.deepEqual([solicited.status, solicited.reason], ["quarantined", "solicitation"]);
      assert.deepEqual(solicited.fields, pitch);
      assert.deepEqual([ambiguous.status, ambiguous.reason], ["quarantined", "ambiguous"]);
      const page = yield* request(`/api/organizations/${inbox.id}/submissions?status=quarantined`, {
        headers,
      }).pipe(Effect.flatMap(json), Effect.flatMap(readPage));
      assert.sameDeepMembers(
        page.entries.map(({ submissionId, reason }) => [submissionId, reason]),
        [
          [solicited.submissionId, "solicitation"],
          [ambiguous.submissionId, "ambiguous"],
        ],
      );
    }),
  45_000,
);

it.live("sets and clears the honeypot field of a form, within the account's organizations", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const { inbox, form } = yield* createInbox(headers, "Honeypot settings", "");
    const honeypot = `/api/organizations/${inbox.id}/forms/${encodeURIComponent(form.publicId)}/honeypot`;

    const anonymous = yield* Effect.all([
      call("PUT", honeypot, { field: "_hp" }),
      call("DELETE", honeypot),
    ]);
    assert.deepEqual(anonymous.map(statusOf), [401, 401]);

    // The rule of the field names that intake accepts, without surrounding spaces.
    const invalid: ReadonlyArray<Schema.Json> = [
      {},
      { field: "" },
      { field: "   " },
      { field: "n".repeat(101) },
      { field: "__proto__" },
      { field: "constructor" },
      { field: "web\nsite" },
      { field: "web\u2028site" },
      { field: 42 },
    ];
    const refused = yield* Effect.forEach(invalid, (body) => call("PUT", honeypot, body, headers));
    assert.deepEqual(
      refused.map(statusOf),
      invalid.map(() => 400),
    );

    const set = yield* call("PUT", honeypot, { field: "  _gotcha " }, headers);
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.headers.get("cache-control"), "no-store");
    const withField = yield* formOf(set);
    assert.deepEqual(withField, { ...form, honeypotField: "_gotcha" });
    const longest = yield* call("PUT", honeypot, { field: "h".repeat(100) }, headers).pipe(
      Effect.flatMap(formOf),
    );
    assert.strictEqual(longest.honeypotField, "h".repeat(100));
    const listed = yield* request("/api/organizations", { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );
    assert.strictEqual(
      listed.find(({ id }) => id === inbox.id)?.forms[0]?.honeypotField,
      "h".repeat(100),
    );
    const cleared = yield* call("DELETE", honeypot, undefined, headers).pipe(
      Effect.flatMap(formOf),
    );
    assert.deepEqual(cleared, form);

    // Another organization's form answers 404 and keeps its honeypot field.
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('trap-org', 'Trap')"),
        env.DB.prepare(`
          INSERT INTO forms (id, organization_id, public_id, name, honeypot_field)
          VALUES ('trap-form', 'trap-org', 'trap', 'Trap', '_hp')
        `),
      ]),
    );
    const foreign = yield* Effect.all([
      call("PUT", "/api/organizations/trap-org/forms/trap/honeypot", { field: "x" }, headers),
      call("DELETE", "/api/organizations/trap-org/forms/trap/honeypot", undefined, headers),
      call("PUT", `/api/organizations/${inbox.id}/forms/trap/honeypot`, { field: "x" }, headers),
    ]);
    assert.deepEqual(foreign.map(statusOf), [404, 404, 404]);
    const kept = yield* Effect.promise(() =>
      env.DB.prepare("SELECT honeypot_field FROM forms WHERE id = 'trap-form'").first(
        "honeypot_field",
      ),
    );
    assert.strictEqual(kept, "_hp");
  }),
);
