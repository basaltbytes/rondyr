import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { apiTokenRole } from "../../domain/organizations/member-role.ts";
import {
  InboxOrganizationWithForms,
  OrganizationCreation,
  SetupInbox,
} from "../../domain/submissions/inbox-setup.ts";
import {
  InboxFilter,
  InboxPage,
  OrganizationCounts,
  SubmissionDetail,
} from "../../domain/submissions/inbox.ts";
import { ReviewApi } from "../../domain/submissions/review.api.ts";
import {
  CurrentReviewer,
  ReviewSession,
} from "../../domain/submissions/review-session.middleware.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
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
import { signedInAccount } from "./organization-access.ts";

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
  q: InboxFilter.fields.search,
  after: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const quotaReached = HttpServerResponse.schemaJson(
  Schema.Struct({ error: Schema.Literal("classification-quota-reached") }),
);

/** The signed-in account and its organizations, each with the account's role in it. */
const memberships = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const directory = yield* OrganizationDirectory;
  const organizations = yield* directory.organizationsFor(userId);
  return { userId, organizations };
});

/** The domain decides each review right from these roles, with `allows`. */
const sessionReviewer = memberships.pipe(
  Effect.map(({ userId, organizations }) => ({
    userId,
    memberships: organizations.map(({ id, role }) => ({ organizationId: id, role })),
  })),
);

const reviewClient = Effect.gen(function* () {
  const token = yield* CurrentApiToken;
  const actor =
    token === null
      ? yield* sessionReviewer
      : {
          apiTokenId: token.apiTokenId,
          memberships: [{ organizationId: token.organizationId, role: apiTokenRole }],
        };
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
        OrganizationCreationDenied: () => errorResponse(403),
        PermissionDenied: () => errorResponse(403),
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
      inbox === null ? [] : [{ ...inbox, role: apiTokenRole }],
      jsonOptions,
    );
  }
  const { organizations, userId } = yield* memberships;
  const inboxes = yield* Effect.forEach(organizations, (organization) =>
    Effect.map(directory.formsOf(userId, organization.id), (forms) => ({ ...organization, forms })),
  );
  return yield* HttpServerResponse.schemaJson(Schema.Array(InboxOrganizationWithForms))(
    inboxes,
    jsonOptions,
  );
});

/** The first organization, or another organization created by an admin of an existing one. */
const create = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const input = yield* HttpServerRequest.schemaBodyJson(SetupInbox);
  const directory = yield* OrganizationDirectory;
  yield* directory.create(userId, input);
  return HttpServerResponse.empty({ status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

/** Whether the account may create an organization, so the dashboard offers the form only then. */
const creation = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const directory = yield* OrganizationDirectory;
  const allowed = yield* directory.mayCreate(userId);
  return yield* HttpServerResponse.schemaJson(OrganizationCreation)({ allowed }, jsonOptions);
});

const list = Effect.gen(function* () {
  const client = yield* reviewClient;
  const { after, form, q, ...input } = yield* HttpRouter.schemaParams(ListParams);
  const page = yield* client.ListSubmissions(
    {
      ...input,
      ...(form !== undefined && { formPublicId: form }),
      ...(q !== undefined && { search: q }),
    },
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

/** The refusals of the domain model, after which a reclassification gives its slot back. */
const refusals = new Set([
  "SubmissionNotFound",
  "SubmissionNotReviewable",
  "SubmissionNotReclassifiable",
]);

/**
 * Send the message back to classification. A new run calls the model again, so
 * every request takes a slot of the organization's daily classification quota,
 * as intake does, before the aggregate decides from its own state; a request
 * that the aggregate refuses gives its slot back. A request over the quota is
 * refused and the message stays where it is.
 */
const reclassify = Effect.fnUntraced(function* (
  client: Effect.Success<typeof reviewClient>,
  input: typeof SubmissionPath.Type,
  inboxReason: typeof SubmissionDetail.Type.reason,
) {
  const quotas = yield* OrganizationQuotas;
  const reservation = yield* quotas.reserveClassification(input.organizationId);
  if (reservation === "limit-reached") return null;
  return yield* client
    .ReclassifySubmission(input.submissionId, inboxReason === null ? {} : { inboxReason })
    .pipe(
      Effect.tapError((error) =>
        refusals.has(error._tag)
          ? quotas.releaseClassification(input.organizationId).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
});

const review = Effect.gen(function* () {
  const client = yield* reviewClient;
  const { decision, ...input } = yield* HttpRouter.schemaPathParams(ReviewPath);
  // Reading the message first answers 404 outside the account's organizations,
  // before any quota is touched.
  const { reason } = yield* client.GetSubmission(input);
  const receipt =
    decision === "approve"
      ? yield* client.ApproveSubmission(input.submissionId)
      : decision === "dismiss"
        ? yield* client.DismissSubmission(input.submissionId)
        : yield* reclassify(client, input, reason);
  if (receipt === null) {
    return yield* quotaReached(
      { error: "classification-quota-reached" },
      { status: 429, ...jsonOptions },
    );
  }
  const submission = yield* client.GetSubmission(input, { atLeast: receipt });
  return yield* HttpServerResponse.schemaJson(SubmissionDetail)(submission, jsonOptions);
});

export const reviewRoutes = Layer.mergeAll(
  HttpRouter.add("GET", organizationPath, withErrors(organizationList)),
  HttpRouter.add("POST", organizationPath, withErrors(create)),
  HttpRouter.add("GET", "/api/organization-creation", withErrors(creation)),
  HttpRouter.add("GET", submissionsPath, withErrors(list)),
  HttpRouter.add("GET", countsPath, withErrors(counts)),
  HttpRouter.add("GET", detailPath, withErrors(detail)),
  HttpRouter.add("POST", decisionPath, withErrors(review)),
);
