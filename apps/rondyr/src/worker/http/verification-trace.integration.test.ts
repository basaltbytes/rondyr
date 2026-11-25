import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import { addMember } from "../../../tests/integration/member-fixture.ts";
import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { SubmissionDetail } from "../../domain/submissions/inbox.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { ScreeningPreview } from "../../domain/submissions/verification.ts";

const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readDetail = Schema.decodeUnknownEffect(SubmissionDetail);
const readPreview = Schema.decodeUnknownEffect(ScreeningPreview);
const readToken = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }));

const submit = Effect.fnUntraced(function* (
  publicId: string,
  fields: Schema.Json,
  headers?: HeadersInit,
) {
  const response = yield* call("POST", `/f/${publicId}`, fields, headers);
  assert.strictEqual(response.status, 202);
  const { "submission-id": submissionId } = yield* json(response).pipe(
    Effect.flatMap(readAccepted),
  );
  return submissionId;
});

const waitForStatus = (submissionId: SubmissionId, status: string, minVersion = 1) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare("SELECT status, version FROM submission_inbox WHERE submission_id = ?")
          .bind(submissionId)
          .first<{ status: string; version: number }>()
          .then((row) => {
            assert.isNotNull(row);
            assert.strictEqual(row.status, status);
            assert.isAtLeast(row.version, minVersion);
          }),
      { timeout: 20_000, interval: 100 },
    ),
  );

const fetchDetail = (organizationId: string, submissionId: SubmissionId, headers: HeadersInit) =>
  call(
    "GET",
    `/api/organizations/${organizationId}/submissions/${submissionId}`,
    undefined,
    headers,
  ).pipe(Effect.flatMap(json), Effect.flatMap(readDetail));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it.live(
  "records intake check details for repetition, blocked terms, honeypot, Turnstile failures and fail-open, and exposes them to reviewers",
  () =>
    Effect.gen(function* () {
      const owner = yield* signIn;
      const { id: orgId, forms } = yield* createInbox("Verification intake checks", owner);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected a form");
      const reviewer = yield* addMember(orgId, owner, "verify-reviewer@example.test", "reviewer");
      const formPath = `/api/organizations/${orgId}/forms/${form.publicId}`;

      assert.strictEqual(
        (yield* call("PUT", `${formPath}/honeypot`, { field: "_hp" }, owner)).status,
        200,
      );
      assert.strictEqual(
        (yield* call(
          "POST",
          `/api/organizations/${orgId}/blocked-terms`,
          { term: "seo agency" },
          owner,
        )).status,
        201,
      );

      // 1. Blocked term matched at intake: reviewer sees exact matched term and organization scope.
      const blockedId = yield* submit(form.publicId, {
        _hp: "",
        email: "pitch@example.test",
        message: "We are an SEO agency offering backlinks.",
        "fixture-verdict": "accept",
      });
      yield* waitForStatus(blockedId, "quarantined", 1);
      const blocked = yield* fetchDetail(orgId, blockedId, reviewer);
      assert.strictEqual(blocked.reason, "blocked-term");
      assert.isNotNull(blocked.verification.intakeTraceId);
      assert.deepEqual(blocked.verification.intake?.honeypot, { _tag: "Passed", field: "_hp" });
      assert.deepEqual(blocked.verification.intake?.blockedTerm, {
        _tag: "Failed",
        term: "seo agency",
        scope: "organization",
      });
      assert.deepEqual(blocked.verification.intake?.quota, {
        _tag: "Skipped",
        reason: "quarantined-earlier",
      });
      assert.strictEqual(blocked.verification.intake?.decisiveReason, "blocked-term");
      assert.strictEqual(blocked.verification.events[0]?.detail._tag, "SubmissionQuarantined");

      // 2. Repeated identical content triggers repetition check with exact prior counts.
      const repeatedPayload = {
        _hp: "",
        email: "repeat@example.test",
        message: "Je souhaite obtenir plus d'informations — sites web.",
        "fixture-verdict": "accept",
      };
      yield* submit(form.publicId, { ...repeatedPayload, email: "first@example.test" });
      yield* submit(form.publicId, { ...repeatedPayload, email: "second@example.test" });
      const thirdId = yield* submit(form.publicId, {
        ...repeatedPayload,
        email: "third@example.test",
      });
      yield* waitForStatus(thirdId, "quarantined", 1);
      const repeated = yield* fetchDetail(orgId, thirdId, reviewer);
      assert.strictEqual(repeated.reason, "repetition");
      assert.deepEqual(repeated.verification.intake?.repetition, {
        outcome: "failed",
        priorSameSender: 0,
        priorSameContent: 2,
        senderThreshold: 3,
        contentThreshold: 2,
        windowDays: 30,
      });
      assert.deepEqual(repeated.verification.intake?.blockedTerm, { _tag: "Passed" });
      assert.strictEqual(repeated.verification.intake?.decisiveReason, "repetition");

      // 3. Turnstile rejection captures Cloudflare error codes; Siteverify outage records fail-open.
      assert.strictEqual(
        (yield* call(
          "PUT",
          `${formPath}/turnstile`,
          { siteKey: "verify-site-key", secretKey: "verify-secret" },
          owner,
        )).status,
        200,
      );
      const expiredTurnstileId = yield* submit(form.publicId, {
        _hp: "",
        email: "expired@example.test",
        message: "Turnstile expired test message.",
        "cf-turnstile-response": "expired",
        "fixture-verdict": "accept",
      });
      yield* waitForStatus(expiredTurnstileId, "quarantined", 1);
      const expiredDetail = yield* fetchDetail(orgId, expiredTurnstileId, reviewer);
      assert.strictEqual(expiredDetail.reason, "turnstile-failed");
      assert.deepEqual(expiredDetail.verification.intake?.turnstile, {
        _tag: "Failed",
        cause: "rejected",
        errorCodes: ["timeout-or-duplicate"],
      });

      const failOpenId = yield* submit(form.publicId, {
        _hp: "",
        email: "failopen@example.test",
        message: "Turnstile unavailable fail-open test message.",
        "cf-turnstile-response": "unavailable",
        "fixture-verdict": "accept",
      });
      yield* waitForStatus(failOpenId, "accepted", 2);
      const failOpenDetail = yield* fetchDetail(orgId, failOpenId, reviewer);
      assert.strictEqual(failOpenDetail.status, "accepted");
      assert.deepEqual(failOpenDetail.verification.intake?.turnstile, {
        _tag: "Unavailable",
        source: "siteverify",
      });
      assert.strictEqual(failOpenDetail.verification.intake?.decisiveReason, null);

      // 4. Server intake skips origin and Turnstile checks unless opted in.
      const createdToken = yield* call(
        "POST",
        `/api/organizations/${orgId}/api-tokens`,
        { name: "Verification server" },
        owner,
      );
      assert.strictEqual(createdToken.status, 201);
      const { token } = yield* json(createdToken).pipe(Effect.flatMap(readToken));
      const serverId = yield* submit(
        form.publicId,
        {
          email: "server@example.test",
          message: "Submitted via server API token.",
          "fixture-verdict": "accept",
        },
        { authorization: `Bearer ${token}` },
      );
      yield* waitForStatus(serverId, "accepted", 2);
      const serverDetail = yield* fetchDetail(orgId, serverId, owner);
      assert.strictEqual(serverDetail.verification.intake?.channel, "server");
      assert.deepEqual(serverDetail.verification.intake?.origin, {
        _tag: "Skipped",
        reason: "server-intake",
      });
      assert.deepEqual(serverDetail.verification.intake?.turnstile, {
        _tag: "Skipped",
        reason: "server-intake",
      });
    }),
  60_000,
);

it.live(
  "records AI scores, signals, failure diagnostics, manual review actor history, and never leaks message content into Worker logs",
  () =>
    Effect.gen(function* () {
      const owner = yield* signIn;
      const { id: orgId, forms } = yield* createInbox("Verification AI history", owner);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected a form");
      assert.strictEqual(
        (yield* call(
          "PATCH",
          `/api/organizations/${orgId}/forms/${form.publicId}`,
          { name: form.name, businessContext: "Pottery workshops" },
          owner,
        )).status,
        200,
      );
      assert.strictEqual(
        (yield* call(
          "POST",
          `/api/organizations/${orgId}/domains`,
          { domain: "studio.test" },
          owner,
        )).status,
        201,
      );
      const secretBody = "private-verification-body-91f8c2";

      // 1. Automatic acceptance records scores, policy, signals, attempts and trace IDs.
      const acceptedId = yield* submit(form.publicId, {
        name: "Ada https://example.test",
        email: "ada@studio.test",
        message: `Hello studio, ${secretBody} can I book a class?`,
        "fixture-verdict": "accept",
      });
      yield* waitForStatus(acceptedId, "accepted", 2);
      const accepted = yield* fetchDetail(orgId, acceptedId, owner);
      assert.strictEqual(accepted.status, "accepted");
      const acceptedEvent = accepted.verification.events.find(
        ({ detail }) => detail._tag === "SubmissionAccepted",
      );
      assert.isDefined(acceptedEvent);
      if (acceptedEvent?.detail._tag === "SubmissionAccepted") {
        assert.strictEqual(acceptedEvent.detail.mode, "automatic");
        assert.strictEqual(acceptedEvent.detail.classifier, "jev");
        assert.strictEqual(acceptedEvent.detail.attempts, 1);
        assert.strictEqual(acceptedEvent.detail.scores?.spam, 0.02);
        assert.strictEqual(acceptedEvent.detail.scores?.solicitation, 0.03);
        assert.strictEqual(acceptedEvent.detail.scores?.relevance, 0.98);
        assert.deepEqual(acceptedEvent.detail.signals, {
          hasBusinessContext: true,
          urlOrHtmlOutsideLongestField: true,
          senderMatchesOrganizationDomain: true,
        });
      }

      // 2. Solicitation quarantine then manual approval preserves original scores AND reviewer identity.
      const pitchId = yield* submit(form.publicId, {
        email: "sales@agency.test",
        message: "We can double your leads with cold outreach.",
        "fixture-verdict": "solicitation",
      });
      yield* waitForStatus(pitchId, "quarantined", 2);
      const approvedRes = yield* call(
        "POST",
        `/api/organizations/${orgId}/submissions/${pitchId}/approve`,
        undefined,
        owner,
      );
      assert.strictEqual(approvedRes.status, 200);
      const approved = yield* json(approvedRes).pipe(Effect.flatMap(readDetail));
      assert.strictEqual(approved.status, "accepted");
      const tags = approved.verification.events.map(({ detail }) => detail._tag);
      assert.deepEqual(tags, [
        "ClassificationRequested",
        "SubmissionQuarantined",
        "SubmissionAccepted",
      ]);
      const quarantined = approved.verification.events[1]?.detail;
      if (quarantined?._tag === "SubmissionQuarantined") {
        assert.strictEqual(quarantined.reason, "solicitation");
        assert.strictEqual(quarantined.scores?.solicitation, 0.93);
      } else {
        return assert.fail("Expected preserved SubmissionQuarantined event");
      }
      const manual = approved.verification.events[2]?.detail;
      if (manual?._tag === "SubmissionAccepted") {
        assert.strictEqual(manual.mode, "manual");
        assert.strictEqual(manual.actor?._tag, "Reviewer");
        if (manual.actor?._tag === "Reviewer") {
          assert.isNotNull(manual.actor.name);
        }
      } else {
        return assert.fail("Expected manual SubmissionAccepted event");
      }

      // 3. Incomplete AI response records invalid-response classification failure detail.
      const brokenId = yield* submit(form.publicId, {
        email: "broken@example.test",
        message: "Broken classifier answer test.",
        "fixture-verdict": "missing-solicitation",
      });
      yield* waitForStatus(brokenId, "quarantined", 2);
      const broken = yield* fetchDetail(orgId, brokenId, owner);
      const failedEvent = broken.verification.events.find(
        ({ detail }) => detail._tag === "SubmissionQuarantined",
      );
      if (failedEvent?.detail._tag === "SubmissionQuarantined") {
        assert.strictEqual(failedEvent.detail.reason, "classification-error");
        assert.deepEqual(failedEvent.detail.failure, {
          kind: "invalid-response",
          retryable: false,
          attempts: 1,
        });
      } else {
        return assert.fail("Expected SubmissionQuarantined failure event");
      }

      // 4. Structured observability logs are emitted and never contain private submission text.
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.WORKER_LOGS.fetch(`${origin}/`)
              .then((response) => response.text())
              .then((logs) => {
                assert.include(logs, "Submission received");
                assert.include(logs, acceptedId);
                assert.notInclude(logs, secretBody);
              }),
          { timeout: 10_000, interval: 100 },
        ),
      );
    }),
  60_000,
);

it.live(
  "previews screening against current saved rules without mutating state, enforces admin rights and quota, and keeps message content out of logs",
  () =>
    Effect.gen(function* () {
      const owner = yield* signIn;
      const { id: orgId, forms } = yield* createInbox("Screening preview", owner);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected a form");
      const reviewer = yield* addMember(orgId, owner, "preview-reviewer@example.test", "reviewer");
      const formPath = `/api/organizations/${orgId}/forms/${form.publicId}`;
      const secretBody = "private-preview-content-73e1a9";

      // Submit while businessContext is empty -> accepted without relevance score.
      const submissionId = yield* submit(form.publicId, {
        email: "lead@example.test",
        message: `Hello team, ${secretBody} looking for ceramic pottery classes.`,
        "fixture-verdict": "accept",
      });
      yield* waitForStatus(submissionId, "accepted", 2);
      const before = yield* fetchDetail(orgId, submissionId, owner);
      const beforeEventCount = before.verification.events.length;
      const beforeEvent = before.verification.events.find(
        ({ detail }) => detail._tag === "SubmissionAccepted",
      );
      if (beforeEvent?.detail._tag === "SubmissionAccepted") {
        assert.isUndefined(beforeEvent.detail.scores?.relevance);
        assert.strictEqual(beforeEvent.detail.signals?.hasBusinessContext, false);
      } else {
        return assert.fail("Expected automatic SubmissionAccepted event");
      }

      const previewPath = `/api/organizations/${orgId}/submissions/${submissionId}/test-screening`;

      // Reviewers cannot trigger dry-run previews.
      assert.strictEqual((yield* call("POST", previewPath, undefined, reviewer)).status, 403);

      // Admin updates form businessContext, then dry-runs screening on the existing accepted message.
      assert.strictEqual(
        (yield* call(
          "PATCH",
          formPath,
          { name: form.name, businessContext: "Ceramic pottery studio and weekend classes" },
          owner,
        )).status,
        200,
      );
      const previewRes = yield* call("POST", previewPath, undefined, owner);
      assert.strictEqual(previewRes.status, 200);
      const preview = yield* json(previewRes).pipe(Effect.flatMap(readPreview));
      assert.strictEqual(preview.outcome, "accepted");
      assert.isNull(preview.reason);
      assert.deepEqual(preview.blockedTerm, { _tag: "NotConfigured" });
      assert.strictEqual(preview.classifier, "jev");
      assert.strictEqual(preview.scores?.relevance, 0.98);
      assert.strictEqual(preview.signals?.hasBusinessContext, true);
      assert.isNotNull(preview.traceId);

      // Dry-run never mutates submission status or event history.
      const afterContextPreview = yield* fetchDetail(orgId, submissionId, owner);
      assert.strictEqual(afterContextPreview.status, "accepted");
      assert.strictEqual(afterContextPreview.verification.events.length, beforeEventCount);

      // Adding a matching blocked term stops the dry-run before AI without spending AI quota.
      assert.strictEqual(
        (yield* call("POST", `${formPath}/blocked-terms`, { term: "pottery" }, owner)).status,
        201,
      );
      const blockedPreviewRes = yield* call("POST", previewPath, undefined, owner);
      assert.strictEqual(blockedPreviewRes.status, 200);
      const blockedPreview = yield* json(blockedPreviewRes).pipe(Effect.flatMap(readPreview));
      assert.strictEqual(blockedPreview.outcome, "quarantined");
      assert.strictEqual(blockedPreview.reason, "blocked-term");
      assert.deepEqual(blockedPreview.blockedTerm, {
        _tag: "Failed",
        term: "pottery",
        scope: "form",
      });
      assert.isUndefined(blockedPreview.scores);

      // Removing the blocked term and tightening the daily classification quota returns 429.
      assert.strictEqual(
        (yield* call("DELETE", `${formPath}/blocked-terms?term=pottery`, undefined, owner)).status,
        204,
      );
      assert.strictEqual(
        (yield* call(
          "PUT",
          `/api/organizations/${orgId}/quotas`,
          { submissions: 500, classifications: 1 },
          owner,
        )).status,
        200,
      );
      const quotaRes = yield* call("POST", previewPath, undefined, owner);
      assert.strictEqual(quotaRes.status, 429);

      // Message status and history remain untouched after all previews.
      const finalDetail = yield* fetchDetail(orgId, submissionId, owner);
      assert.strictEqual(finalDetail.status, "accepted");
      assert.strictEqual(finalDetail.verification.events.length, beforeEventCount);

      // Preview logs record metadata only and never leak submission content.
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.WORKER_LOGS.fetch(`${origin}/`)
              .then((response) => response.text())
              .then((logs) => {
                assert.include(logs, "Screening preview completed");
                assert.include(logs, submissionId);
                assert.notInclude(logs, secretBody);
              }),
          { timeout: 10_000, interval: 100 },
        ),
      );
    }),
  60_000,
);
