import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { listForms, setupInbox } from "../adapters/database/inbox-setup.ts";
import { organizationsFor } from "../adapters/database/inbox.ts";
import { InboxOrganizationWithForms, SetupInbox } from "../domain/submissions/inbox-setup.ts";
import { InboxPage, SubmissionDetail, SubmissionStatus } from "../domain/submissions/inbox.ts";
import { ReviewApi } from "../domain/submissions/review.api.ts";
import {
  CurrentReviewer,
  ReviewSession,
  ReviewUnauthorized,
} from "../domain/submissions/review-session.middleware.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const SubmissionPath = Schema.Struct({
  organizationId: OrganizationId,
  submissionId: SubmissionId,
});
const ReviewPath = SubmissionPath.mapFields((fields) => ({
  ...fields,
  decision: Schema.Literals(["approve", "dismiss"]),
}));
const ListParams = OrganizationPath.mapFields((fields) => ({
  ...fields,
  status: Schema.optionalKey(SubmissionStatus),
  after: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };

const reviewer = Effect.fn("ReviewRoute.reviewer")(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const user = yield* auth.userId(request);
  if (user === null) return yield* ReviewUnauthorized.make();
  const userId = yield* Schema.decodeEffect(UserId)(user);
  const organizations = yield* organizationsFor(userId);
  return { userId, organizations };
});

const reviewClient = Effect.gen(function* () {
  const { userId, organizations } = yield* reviewer();
  const session = ReviewSession.of((effect) =>
    Effect.provideService(effect, CurrentReviewer, {
      userId,
      organizations: organizations.map(({ id }) => id),
    }),
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
        SchemaError: () => errorResponse(400),
        InvalidInboxCursor: () => errorResponse(400),
      }).pipe(Effect.catch(() => errorResponse(503)));
    }),
  );

const organizationList = Effect.gen(function* () {
  const { organizations, userId } = yield* reviewer();
  const inboxes = yield* Effect.forEach(organizations, (organization) =>
    Effect.map(listForms(userId, organization.id), (forms) => ({ ...organization, forms })),
  );
  return yield* HttpServerResponse.schemaJson(Schema.Array(InboxOrganizationWithForms))(
    inboxes,
    jsonOptions,
  );
});

const create = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const input = yield* HttpServerRequest.schemaBodyJson(SetupInbox);
  yield* setupInbox(userId, input);
  return HttpServerResponse.empty({ status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const list = Effect.gen(function* () {
  const client = yield* reviewClient;
  const { after, ...input } = yield* HttpRouter.schemaParams(ListParams);
  const page = yield* client.ListSubmissions(input, after === undefined ? {} : { after });
  return yield* HttpServerResponse.schemaJson(InboxPage)(page, jsonOptions);
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
  yield* client.GetSubmission(input);
  const receipt =
    decision === "approve"
      ? yield* client.ApproveSubmission(input.submissionId)
      : yield* client.DismissSubmission(input.submissionId);
  const submission = yield* client.GetSubmission(input, { atLeast: receipt });
  return yield* HttpServerResponse.schemaJson(SubmissionDetail)(submission, jsonOptions);
});

export const reviewRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/organizations", withErrors(organizationList)),
  HttpRouter.add("POST", "/api/organizations", withErrors(create)),
  HttpRouter.add("GET", "/api/organizations/:organizationId/submissions", withErrors(list)),
  HttpRouter.add(
    "GET",
    "/api/organizations/:organizationId/submissions/:submissionId",
    withErrors(detail),
  ),
  HttpRouter.add(
    "POST",
    "/api/organizations/:organizationId/submissions/:submissionId/:decision",
    withErrors(review),
  ),
);
