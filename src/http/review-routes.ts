import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { InboxOrganizationWithForms, SetupInbox } from "../domain/submissions/inbox-setup.ts";
import {
  InboxFilter,
  InboxPage,
  OrganizationCounts,
  SubmissionDetail,
} from "../domain/submissions/inbox.ts";
import { ReviewApi } from "../domain/submissions/review.api.ts";
import {
  CurrentReviewer,
  ReviewSession,
  ReviewUnauthorized,
} from "../domain/submissions/review-session.middleware.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";
import { OrganizationDirectory } from "../ports/organization-directory.ts";
import { OrganizationQuotas } from "../ports/organization-quotas.ts";
import {
  countsPath,
  CurrentApiToken,
  decisionPath,
  detailPath,
  organizationPath,
  submissionsPath,
} from "./api-token-authentication.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const SubmissionPath = Schema.Struct({
  organizationId: OrganizationId,
  submissionId: SubmissionId,
});
const ReviewPath = SubmissionPath.mapFields((fields) => ({
  ...fields,
  decision: Schema.Literals(["approve", "dismiss", "reclassify"]),
}));
const ListParams = OrganizationPath.mapFields((fields) => ({
  ...fields,
  status: InboxFilter.fields.status,
  form: InboxFilter.fields.formPublicId,
  after: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const quotaReached = HttpServerResponse.schemaJson(
  Schema.Struct({ error: Schema.Literal("classification-quota-reached") }),
);

/** The signed-in account and its organizations, or `ReviewUnauthorized`. */
export const reviewer = Effect.fn("ReviewRoute.reviewer")(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const user = yield* auth.userId(request);
  if (user === null) return yield* ReviewUnauthorized.make();
  const userId = yield* Schema.decodeEffect(UserId)(user);
  const directory = yield* OrganizationDirectory;
  const organizations = yield* directory.organizationsFor(userId);
  return { userId, organizations };
});

const sessionReviewer = reviewer().pipe(
  Effect.map(({ userId, organizations }) => ({
    userId,
    organizations: organizations.map(({ id }) => id),
  })),
);

const reviewClient = Effect.gen(function* () {
  const token = yield* CurrentApiToken;
  const actor =
    token === null
      ? yield* sessionReviewer
      : { apiTokenId: token.apiTokenId, organizations: [token.organizationId] };
  const session = ReviewSession.of((effect) =>
    Effect.provideService(effect, CurrentReviewer, actor),
  );
  return yield* ReviewApi.clientInProcess.pipe(Effect.provideService(ReviewSession, session));
});

function errorResponse(status: number) {
  return Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
}

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.scoped,
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return errorResponse(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => errorResponse(401),
        AuthOriginRefused: () => errorResponse(403),
        SubmissionNotFound: () => errorResponse(404),
        SubmissionNotReviewable: () => errorResponse(409),
        SubmissionNotReclassifiable: () => errorResponse(409),
        SchemaError: () => errorResponse(400),
        InvalidInboxCursor: () => errorResponse(400),
      }).pipe(Effect.catch(() => errorResponse(503)));
    }),
  );

const organizationList = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory;
  const token = yield* CurrentApiToken;
  if (token !== null) {
    const inbox = yield* directory.inboxFor(token.organizationId);
    return yield* HttpServerResponse.schemaJson(Schema.Array(InboxOrganizationWithForms))(
      inbox === null ? [] : [inbox],
      jsonOptions,
    );
  }
  const { organizations, userId } = yield* reviewer();
  const inboxes = yield* Effect.forEach(organizations, (organization) =>
    Effect.map(directory.formsOf(userId, organization.id), (forms) => ({ ...organization, forms })),
  );
  return yield* HttpServerResponse.schemaJson(Schema.Array(InboxOrganizationWithForms))(
    inboxes,
    jsonOptions,
  );
});

const create = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const input = yield* HttpServerRequest.schemaBodyJson(SetupInbox);
  const directory = yield* OrganizationDirectory;
  yield* directory.create(userId, input);
  return HttpServerResponse.empty({ status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const list = Effect.gen(function* () {
  const client = yield* reviewClient;
  const { after, form, ...input } = yield* HttpRouter.schemaParams(ListParams);
  const page = yield* client.ListSubmissions(
    form === undefined ? input : { ...input, formPublicId: form },
    after === undefined ? {} : { after },
  );
  return yield* HttpServerResponse.schemaJson(InboxPage)(page, jsonOptions);
});

const counts = Effect.gen(function* () {
  const client = yield* reviewClient;
  const input = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const totals = yield* client.CountSubmissions(input);
  return yield* HttpServerResponse.schemaJson(OrganizationCounts)(totals, jsonOptions);
});

const detail = Effect.gen(function* () {
  const client = yield* reviewClient;
  const input = yield* HttpRouter.schemaPathParams(SubmissionPath);
  const submission = yield* client.GetSubmission(input);
  return yield* HttpServerResponse.schemaJson(SubmissionDetail)(submission, jsonOptions);
});

const review = Effect.gen(function* () {
  const client = yield* reviewClient;
  const { decision, ...input } = yield* HttpRouter.schemaPathParams(ReviewPath);
  const { status, reason } = yield* client.GetSubmission(input);
  // A new run calls the model again, so it takes a slot of the organization's daily
  // classification quota, as intake does. The aggregate still decides whether the
  // message can go back to classification.
  if (decision === "reclassify" && status === "quarantined" && reason === "classification-error") {
    const quotas = yield* OrganizationQuotas;
    const reservation = yield* quotas.reserveClassification(input.organizationId);
    if (reservation === "limit-reached") {
      return yield* quotaReached(
        { error: "classification-quota-reached" },
        {
          status: 429,
          ...jsonOptions,
        },
      );
    }
  }
  const receipt =
    decision === "approve"
      ? yield* client.ApproveSubmission(input.submissionId)
      : decision === "dismiss"
        ? yield* client.DismissSubmission(input.submissionId)
        : yield* client.ReclassifySubmission(
            input.submissionId,
            reason === null ? {} : { inboxReason: reason },
          );
  const submission = yield* client.GetSubmission(input, { atLeast: receipt });
  return yield* HttpServerResponse.schemaJson(SubmissionDetail)(submission, jsonOptions);
});

export const reviewRoutes = Layer.mergeAll(
  HttpRouter.add("GET", organizationPath, withErrors(organizationList)),
  HttpRouter.add("POST", organizationPath, withErrors(create)),
  HttpRouter.add("GET", submissionsPath, withErrors(list)),
  HttpRouter.add("GET", countsPath, withErrors(counts)),
  HttpRouter.add("GET", detailPath, withErrors(detail)),
  HttpRouter.add("POST", decisionPath, withErrors(review)),
);
