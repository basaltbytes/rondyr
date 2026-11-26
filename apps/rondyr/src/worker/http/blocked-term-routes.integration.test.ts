import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import { setupOwner } from "../../../tests/integration/organization-fixture.ts";
import {
  FormBlockedTerm,
  maxBlockedTermLength,
  maxFormBlockedTerms,
  maxOrganizationBlockedTerms,
  type BlockedTermRefusalReason,
} from "../../domain/forms/blocked-term.ts";
import { ManagedForm } from "../../domain/forms/form.ts";
import { DailyUsage } from "../../domain/organizations/organization-quotas.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";
import { SubmissionDetail } from "../../domain/submissions/inbox.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readForm = Schema.decodeUnknownEffect(ManagedForm);
const readTerms = Schema.decodeUnknownEffect(Schema.Array(FormBlockedTerm));
const readTerm = Schema.decodeUnknownEffect(FormBlockedTerm);
const readAccepted = Schema.decodeUnknownEffect(
  Schema.Struct({ "submission-id": SubmissionId, status: Schema.Literal("received") }),
);
const readSubmission = Schema.decodeUnknownEffect(SubmissionDetail);
const readUsage = Schema.decodeUnknownEffect(DailyUsage);
const readToken = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }));
const readCalls = Schema.decodeUnknownEffect(
  Schema.Array(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
);
const readStored = Schema.decodeUnknownEffect(
  Schema.Struct({ intake_reason: Schema.NullOr(Schema.String) }),
);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => env.TEST_WORKER.fetch(new URL(path, origin), init));
}

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
const withBody = (response: Response) =>
  Effect.map(json(response), (body) => ({ status: response.status, body }));

const signIn = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const { cookie } = yield* setupOwner({
        name: "Blocked terms",
        email: "blocked-terms@example.test",
      });
      return { cookie, origin };
    }),
  ),
);

const createForm = Effect.fnUntraced(function* (headers: HeadersInit, organizationName: string) {
  const created = yield* call(
    "POST",
    "/api/organizations",
    { organizationName, formName: "Contact", businessContext: "Pottery workshops" },
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
  return {
    inboxId: inbox.id,
    publicId: form.publicId,
    formPath: `/api/organizations/${inbox.id}/forms/${form.publicId}`,
  };
});

const submitJson = Effect.fnUntraced(function* (
  publicId: string,
  fields: Schema.Json,
  extra?: HeadersInit,
) {
  const response = yield* call("POST", `/f/${publicId}`, fields, extra);
  assert.strictEqual(response.status, 202);
  const { "submission-id": submissionId } = yield* json(response).pipe(
    Effect.flatMap(readAccepted),
  );
  return submissionId;
});

const postHtml = (publicId: string, body: string) =>
  request(`/f/${publicId}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    body,
  });

const inboxReaches = (
  submissionId: SubmissionId,
  expected: { status: string; version: number; reason: string | null },
) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare(
          "SELECT status, version, reason FROM submission_inbox WHERE submission_id = ?",
        )
          .bind(submissionId)
          .first()
          .then((row) => {
            assert.deepEqual(row, expected);
          }),
      { timeout: 20_000, interval: 100 },
    ),
  );

const storedReason = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const row = yield* Effect.promise(() =>
    env.DB.prepare("SELECT intake_reason FROM submissions WHERE id = ?").bind(submissionId).first(),
  );
  return (yield* readStored(row)).intake_reason;
});

const callsWith = (marker: string) =>
  Effect.promise(() =>
    env.WORKERS_AI_FIXTURE.fetch("https://workers-ai.test/__calls").then((response) =>
      response.json(),
    ),
  ).pipe(
    Effect.flatMap(readCalls),
    Effect.map((calls) =>
      calls.filter(
        (fields) =>
          fields !== null && Object.values(fields).some((value) => value.includes(marker)),
      ),
    ),
  );

const storedFormTerms = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT bt.term FROM form_blocked_terms bt JOIN forms f ON f.id = bt.form_id WHERE f.public_id = ? ORDER BY bt.term",
    )
      .bind(publicId)
      .all(),
  ).pipe(Effect.map(({ results }) => results.map((row) => row.term)));

const storedOrgTerms = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT term FROM organization_blocked_terms WHERE organization_id = ? ORDER BY term",
    )
      .bind(organizationId)
      .all(),
  ).pipe(Effect.map(({ results }) => results.map((row) => row.term)));

it.live(
  "manages form and organization blocked terms, folds accents, enforces limits and isolates organizations",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inboxId, publicId, formPath } = yield* createForm(headers, "Blocked terms admin");
      const formEndpoint = `${formPath}/blocked-terms`;
      const orgEndpoint = `/api/organizations/${inboxId}/blocked-terms`;
      const removeFrom = (endpoint: string, value: string, extra: HeadersInit = headers) =>
        request(`${endpoint}?${new URLSearchParams({ term: value })}`, {
          method: "DELETE",
          headers: extra,
        });

      const anonymous = yield* Effect.all([
        request(formEndpoint),
        call("POST", formEndpoint, { term: "seo" }),
        removeFrom(formEndpoint, "seo", { origin }),
        request(orgEndpoint),
        call("POST", orgEndpoint, { term: "seo" }),
        removeFrom(orgEndpoint, "seo", { origin }),
      ]);
      assert.deepEqual(anonymous.map(statusOf), [401, 401, 401, 401, 401, 401]);

      const emptyForm = yield* request(formEndpoint, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTerms),
      );
      const emptyOrg = yield* request(orgEndpoint, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTerms),
      );
      assert.deepEqual([emptyForm, emptyOrg], [[], []]);

      // Invalid terms are refused with the reason the dashboard shows.
      const refusedTerms: ReadonlyArray<readonly [string, BlockedTermRefusalReason]> = [
        ["", "empty"],
        ["   !!! ", "empty"],
        ["a".repeat(maxBlockedTermLength + 1), "too-long"],
      ];
      for (const endpoint of [formEndpoint, orgEndpoint]) {
        const refusals = yield* Effect.forEach(refusedTerms, ([value]) =>
          call("POST", endpoint, { term: value }, headers).pipe(Effect.flatMap(withBody)),
        );
        assert.deepEqual(
          refusals,
          refusedTerms.map(([, reason]) => ({
            status: 400,
            body: { error: "term-refused", reason },
          })),
        );
        const malformed = yield* call("POST", endpoint, { word: "seo" }, headers);
        assert.strictEqual(malformed.status, 400);
      }

      // Stored normalized with accents folded; adding another spelling returns 200 without duplicating.
      const added = yield* call("POST", formEndpoint, { term: "  Agence  SEO!! " }, headers);
      assert.strictEqual(added.status, 201);
      assert.strictEqual(added.headers.get("cache-control"), "no-store");
      const first = yield* json(added).pipe(Effect.flatMap(readTerm));
      assert.strictEqual(first.term, "agence seo");

      const again = yield* call("POST", formEndpoint, { term: "agence seo" }, headers);
      assert.strictEqual(again.status, 200);
      const unchanged = yield* json(again).pipe(Effect.flatMap(readTerm));
      assert.deepEqual(unchanged, first);

      const accented = yield* call("POST", formEndpoint, { term: "Société" }, headers);
      assert.strictEqual(accented.status, 201);
      const folded = yield* json(accented).pipe(Effect.flatMap(readTerm));
      assert.strictEqual(folded.term, "societe");
      const foldedAgain = yield* call("POST", formEndpoint, { term: "societe" }, headers);
      assert.strictEqual(foldedAgain.status, 200);

      const listed = yield* request(formEndpoint, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTerms),
      );
      assert.deepEqual(
        listed.map(({ term }) => term),
        ["agence seo", "societe"],
      );

      // Removal normalizes and folds accents on its query parameter too.
      const removed = yield* removeFrom(formEndpoint, "  AGENCE SEO ");
      assert.strictEqual(removed.status, 204);
      const removedTwice = yield* removeFrom(formEndpoint, "agence seo");
      assert.strictEqual(removedTwice.status, 404);
      const removeRefused = yield* removeFrom(formEndpoint, "!!!").pipe(Effect.flatMap(withBody));
      assert.deepEqual(removeRefused, {
        status: 400,
        body: { error: "term-refused", reason: "empty" },
      });

      // Enforce the form limit; duplicates at the limit still answer 200.
      const formRow = yield* Effect.promise(() =>
        env.DB.prepare("SELECT id FROM forms WHERE public_id = ?").bind(publicId).first("id"),
      );
      const formStatements: Array<D1PreparedStatement> = [];
      for (let i = 1; i < maxFormBlockedTerms; i += 1) {
        formStatements.push(
          env.DB.prepare(
            "INSERT INTO form_blocked_terms (form_id, term, created_at) VALUES (?, ?, ?)",
          ).bind(formRow, `term ${i}`, i),
        );
      }
      yield* Effect.promise(() => env.DB.batch(formStatements));
      const atFormLimitDuplicate = yield* call("POST", formEndpoint, { term: "société" }, headers);
      assert.strictEqual(atFormLimitDuplicate.status, 200);
      const overFormLimit = yield* call("POST", formEndpoint, { term: "one more" }, headers).pipe(
        Effect.flatMap(withBody),
      );
      assert.deepEqual(overFormLimit, { status: 409, body: { error: "term-limit" } });

      // Organization-level CRUD, accent folding and limit.
      const orgAdded = yield* call("POST", orgEndpoint, { term: "Cásino" }, headers);
      assert.strictEqual(orgAdded.status, 201);
      const orgFirst = yield* json(orgAdded).pipe(Effect.flatMap(readTerm));
      assert.strictEqual(orgFirst.term, "casino");
      const orgDup = yield* call("POST", orgEndpoint, { term: "casino" }, headers);
      assert.strictEqual(orgDup.status, 200);

      const orgStatements: Array<D1PreparedStatement> = [];
      for (let i = 1; i < maxOrganizationBlockedTerms; i += 1) {
        orgStatements.push(
          env.DB.prepare(
            "INSERT INTO organization_blocked_terms (organization_id, term, created_at) VALUES (?, ?, ?)",
          ).bind(inboxId, `org term ${i}`, i),
        );
      }
      yield* Effect.promise(() => env.DB.batch(orgStatements));
      const atOrgLimitDuplicate = yield* call("POST", orgEndpoint, { term: "cásino" }, headers);
      assert.strictEqual(atOrgLimitDuplicate.status, 200);
      const overOrgLimit = yield* call("POST", orgEndpoint, { term: "another" }, headers).pipe(
        Effect.flatMap(withBody),
      );
      assert.deepEqual(overOrgLimit, { status: 409, body: { error: "term-limit" } });
      const orgRemoved = yield* removeFrom(orgEndpoint, "CÁSINO");
      assert.strictEqual(orgRemoved.status, 204);
      const orgRemovedTwice = yield* removeFrom(orgEndpoint, "casino");
      assert.strictEqual(orgRemovedTwice.status, 404);

      // Another organization's form and organization list answer 404 and keep their rows.
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(
            "INSERT INTO organizations (id, name) VALUES ('other-blocked-org', 'Other')",
          ),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('other-blocked-form', 'other-blocked-org', 'other-blocked', 'Other')",
          ),
          env.DB.prepare(
            "INSERT INTO form_blocked_terms (form_id, term, created_at) VALUES ('other-blocked-form', 'secret', 0)",
          ),
          env.DB.prepare(
            "INSERT INTO organization_blocked_terms (organization_id, term, created_at) VALUES ('other-blocked-org', 'orgsecret', 0)",
          ),
        ]),
      );
      const foreignForm = "/api/organizations/other-blocked-org/forms/other-blocked/blocked-terms";
      const mixedForm = `/api/organizations/${inboxId}/forms/other-blocked/blocked-terms`;
      const foreignOrg = "/api/organizations/other-blocked-org/blocked-terms";
      const foreign = yield* Effect.all([
        request(foreignForm, { headers }),
        request(mixedForm, { headers }),
        call("POST", foreignForm, { term: "intruder" }, headers),
        call("POST", mixedForm, { term: "intruder" }, headers),
        removeFrom(foreignForm, "secret"),
        removeFrom(mixedForm, "secret"),
        request(foreignOrg, { headers }),
        call("POST", foreignOrg, { term: "intruder" }, headers),
        removeFrom(foreignOrg, "orgsecret"),
      ]);
      assert.deepEqual(foreign.map(statusOf), [404, 404, 404, 404, 404, 404, 404, 404, 404]);
      const keptForm = yield* storedFormTerms("other-blocked");
      const keptOrg = yield* storedOrgTerms("other-blocked-org");
      assert.deepEqual([keptForm, keptOrg], [["secret"], ["orgsecret"]]);
    }),
  60_000,
);

it.live(
  "quarantines matching words via intake SQL for form and org lists, ignores partial words and cross-field splits, and allows approval",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inboxId, publicId, formPath } = yield* createForm(headers, "Blocked terms intake");
      const secondFormRes = yield* call(
        "POST",
        `/api/organizations/${inboxId}/forms`,
        { name: "Support", businessContext: "Pottery workshops" },
        headers,
      );
      assert.strictEqual(secondFormRes.status, 201);
      const secondForm = yield* json(secondFormRes).pipe(Effect.flatMap(readForm));
      const otherOrg = yield* createForm(headers, "Unrelated studio");

      for (const term of [
        "seo",
        "agence web",
        "societe",
        "casino",
        "spam.example.com",
        "bot@bad.example",
      ]) {
        const res = yield* call("POST", `${formPath}/blocked-terms`, { term }, headers);
        assert.strictEqual(res.status, 201);
      }
      for (const term of ["crypto deal", "société générale"]) {
        const res = yield* call(
          "POST",
          `/api/organizations/${inboxId}/blocked-terms`,
          { term },
          headers,
        );
        assert.strictEqual(res.status, 201);
      }
      yield* Effect.promise(() =>
        env.DB.prepare(`
          INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
          SELECT 'blocked-webhook', organization_id, id, 'webhook', '{}', 0 FROM forms WHERE public_id = ?
        `)
          .bind(publicId)
          .run(),
      );

      // HTML responses are identical whether a blocked word is present or not.
      const cleanHtml = yield* postHtml(publicId, "email=a%40example.com&message=Hello+world");
      const blockedHtml = yield* postHtml(
        publicId,
        "email=b%40example.com&message=Boost+your+SEO+today",
      );
      const pages = yield* Effect.forEach([cleanHtml, blockedHtml], (response) =>
        Effect.promise(() => response.text()).pipe(
          Effect.map((text) => ({
            status: response.status,
            type: response.headers.get("content-type"),
            cache: response.headers.get("cache-control"),
            text,
          })),
        ),
      );
      assert.strictEqual(pages[0]?.status, 202);
      assert.deepEqual(pages[1], pages[0]);

      // Form-level SQL matches: phrase, accent folding ("société" matches "societe", "cásino" matches "casino"),
      // domain in email/URL, and full email address — all bypass the classifier.
      const blockedMarker = "blocked-word-probe-1";
      const accentId = yield* submitJson(publicId, {
        email: "visitor@example.com",
        message: `${blockedMarker} notre société recommande ce cásino`,
        "fixture-verdict": "accept",
      });
      const domainId = yield* submitJson(publicId, {
        email: "promo@spam.example.com",
        message: "Hello there",
        "fixture-verdict": "accept",
      });
      const addressId = yield* submitJson(publicId, {
        email: "bot@bad.example",
        message: "Quick question",
        "fixture-verdict": "accept",
      });
      const phraseId = yield* submitJson(publicId, {
        email: "visitor2@example.com",
        message: "Contactez notre Agence Web pour votre site.",
        "fixture-verdict": "accept",
      });
      for (const id of [accentId, domainId, addressId, phraseId]) {
        const reason = yield* storedReason(id);
        assert.strictEqual(reason, "blocked-term");
        yield* inboxReaches(id, { status: "quarantined", version: 1, reason: "blocked-term" });
      }
      const detail = yield* request(`/api/organizations/${inboxId}/submissions/${accentId}`, {
        headers,
      }).pipe(Effect.flatMap(json), Effect.flatMap(readSubmission));
      assert.deepEqual([detail.status, detail.reason], ["quarantined", "blocked-term"]);
      const blockedCallsBefore = yield* callsWith(blockedMarker);
      assert.deepEqual(blockedCallsBefore, []);

      // Organization-level SQL matches apply to BOTH forms of the organization (with accent folding),
      // and do NOT affect another organization's form.
      const orgMarker = "org-blocked-probe-1";
      const orgMatchOnFirst = yield* submitJson(publicId, {
        message: `${orgMarker} exclusive Crypto Deal today`,
        "fixture-verdict": "accept",
      });
      const orgMatchOnSecond = yield* submitJson(secondForm.publicId, {
        message: `${orgMarker} offre societe generale urgente`,
        "fixture-verdict": "accept",
      });
      for (const id of [orgMatchOnFirst, orgMatchOnSecond]) {
        const reason = yield* storedReason(id);
        assert.strictEqual(reason, "blocked-term");
        yield* inboxReaches(id, { status: "quarantined", version: 1, reason: "blocked-term" });
      }
      const orgBlockedCalls = yield* callsWith(orgMarker);
      assert.deepEqual(orgBlockedCalls, []);

      const otherOrgMarker = "other-org-clean-probe";
      const otherOrgId = yield* submitJson(otherOrg.publicId, {
        message: `${otherOrgMarker} Crypto Deal discussion`,
        "fixture-verdict": "accept",
      });
      const otherOrgReason = yield* storedReason(otherOrgId);
      assert.isNull(otherOrgReason);
      yield* inboxReaches(otherOrgId, { status: "accepted", version: 2, reason: null });

      // Partial-word and cross-field negatives tested directly against intake SQL (form + org lists).
      const safeFormMarker = "blocked-safe-form-probe";
      const safeFormId = yield* submitJson(publicId, {
        name: "Agence",
        subject: "Web",
        message: `${safeFormMarker} visite au museo pres des casinos`,
        "fixture-verdict": "accept",
      });
      const safeFormReason = yield* storedReason(safeFormId);
      assert.isNull(safeFormReason);
      yield* inboxReaches(safeFormId, { status: "accepted", version: 2, reason: null });
      const safeFormCalls = yield* callsWith(safeFormMarker);
      assert.strictEqual(safeFormCalls.length, 1);

      const safeOrgMarker = "blocked-safe-org-probe";
      const safeOrgId = yield* submitJson(secondForm.publicId, {
        name: "Crypto",
        subject: "Deal",
        message: `${safeOrgMarker} bonjour, la societes et generale`,
        "fixture-verdict": "accept",
      });
      const safeOrgReason = yield* storedReason(safeOrgId);
      assert.isNull(safeOrgReason);
      yield* inboxReaches(safeOrgId, { status: "accepted", version: 2, reason: null });
      const safeOrgCalls = yield* callsWith(safeOrgMarker);
      assert.strictEqual(safeOrgCalls.length, 1);

      // A reviewer can approve a blocked-term message and deliver it without calling the model.
      const approval = yield* request(
        `/api/organizations/${inboxId}/submissions/${accentId}/approve`,
        { method: "POST", headers },
      );
      assert.strictEqual(approval.status, 200);
      yield* inboxReaches(accentId, { status: "accepted", version: 2, reason: null });
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare(
              "SELECT target_id, attempt_count FROM deliveries WHERE submission_id = ?",
            )
              .bind(accentId)
              .all()
              .then(({ results }) => {
                assert.deepEqual(results, [{ target_id: "blocked-webhook", attempt_count: 1 }]);
              }),
          { timeout: 20_000, interval: 100 },
        ),
      );
      const blockedCallsAfter = yield* callsWith(blockedMarker);
      assert.deepEqual(blockedCallsAfter, []);

      // Server intake applies both form and organization blocked terms.
      const tokenRes = yield* call(
        "POST",
        `/api/organizations/${inboxId}/api-tokens`,
        { name: "Blocked terms token" },
        headers,
      );
      assert.strictEqual(tokenRes.status, 201);
      const { token } = yield* json(tokenRes).pipe(Effect.flatMap(readToken));
      const serverFormId = yield* submitJson(
        publicId,
        { message: "Free SEO audit for your site", "fixture-verdict": "accept" },
        { authorization: `Bearer ${token}` },
      );
      const serverOrgId = yield* submitJson(
        secondForm.publicId,
        { message: "Join this crypto deal now", "fixture-verdict": "accept" },
        { authorization: `Bearer ${token}` },
      );
      yield* inboxReaches(serverFormId, {
        status: "quarantined",
        version: 1,
        reason: "blocked-term",
      });
      yield* inboxReaches(serverOrgId, {
        status: "quarantined",
        version: 1,
        reason: "blocked-term",
      });
    }),
  60_000,
);

it.live(
  "counts form and organization blocked terms in the junk budget and respects intake precedence",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inboxId, publicId, formPath } = yield* createForm(headers, "Blocked terms quota");
      assert.strictEqual(
        (yield* call("PUT", `${formPath}/honeypot`, { field: "_hp" }, headers)).status,
        200,
      );
      assert.strictEqual(
        (yield* call("POST", `${formPath}/blocked-terms`, { term: "backlinks" }, headers)).status,
        201,
      );
      assert.strictEqual(
        (yield* call(
          "POST",
          `/api/organizations/${inboxId}/blocked-terms`,
          { term: "guest post" },
          headers,
        )).status,
        201,
      );
      // Set daily submission/junk limit to 3 and classification limit to 0.
      const quotaPath = `/api/organizations/${inboxId}/quotas`;
      assert.strictEqual(
        (yield* call("PUT", quotaPath, { submissions: 3, classifications: 0 }, headers)).status,
        200,
      );

      // Precedence 1: honeypot beats blocked-term.
      const hpId = yield* submitJson(publicId, { _hp: "bot", message: "Buy backlinks now" });
      const hpReason = yield* storedReason(hpId);
      assert.strictEqual(hpReason, "honeypot");

      // Precedence 2: form and org blocked-terms beat exhausted classification quota.
      const formBlockedId = yield* submitJson(publicId, { message: "Cheap backlinks offer" });
      const formBlockedReason = yield* storedReason(formBlockedId);
      assert.strictEqual(formBlockedReason, "blocked-term");

      const orgBlockedId = yield* submitJson(publicId, { message: "Interested in a guest post" });
      const orgBlockedReason = yield* storedReason(orgBlockedId);
      assert.strictEqual(orgBlockedReason, "blocked-term");

      // Junk budget (3) is now full: another blocked-term submission gets 429,
      // while a non-junk submission still gets 202 (quarantined with quota).
      const overJunk = yield* call("POST", `/f/${publicId}`, { message: "More backlinks" });
      assert.strictEqual(overJunk.status, 429);

      const nonJunkId = yield* submitJson(publicId, { message: "Question about pottery classes" });
      const nonJunkReason = yield* storedReason(nonJunkId);
      assert.strictEqual(nonJunkReason, "quota");

      const usage = yield* request(quotaPath, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readUsage),
      );
      assert.deepEqual(usage.used, { submissions: 1, classifications: 0, junk: 3 });
    }),
  60_000,
);
