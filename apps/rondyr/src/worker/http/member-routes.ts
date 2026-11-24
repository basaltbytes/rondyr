import { ByteSize, Duration, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { defaultEmailLanguage, parseEmailRecipients } from "../../domain/deliveries/email.ts";
import { invitationEmail } from "../../domain/organizations/invitation-email.ts";
import {
  ChangeMemberRole,
  InvitationId,
  InviteMember,
  IssuedInvitation,
  Member,
  MemberRequestError,
  OrganizationMembers,
  type InvitationEmail,
} from "../../domain/organizations/members.ts";
import { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import { EmailSender } from "../ports/email-sender.ts";
import { Members } from "../ports/members.ts";
import { authorize } from "./organization-access.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const MemberPath = OrganizationPath.mapFields((fields) => ({ ...fields, userId: UserId }));
const CancelParams = OrganizationPath.mapFields((fields) => ({ ...fields, id: InvitationId }));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const errorJson = HttpServerResponse.schemaJson(MemberRequestError);
const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        PermissionDenied: () => empty(403),
        NotAnAdmin: () => empty(403),
        OrganizationNotFound: () => empty(404),
        MemberNotFound: () => empty(404),
        InvitationNotFound: () => empty(404),
        LastAdmin: () => errorJson({ error: "last-admin" }, { status: 409, ...jsonOptions }),
        AlreadyMember: () =>
          errorJson({ error: "already-member" }, { status: 409, ...jsonOptions }),
        InvitationLimit: () =>
          errorJson({ error: "invitation-limit" }, { status: 409, ...jsonOptions }),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** An admin of the organization of the path. */
const administrator = Effect.gen(function* () {
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const { userId } = yield* authorize(organizationId, "manage-members");
  return { userId, organizationId };
});

const list = Effect.gen(function* () {
  const scope = yield* administrator;
  const members = yield* Members;
  const found = yield* members.list(scope);
  return yield* HttpServerResponse.schemaJson(OrganizationMembers)(found, jsonOptions);
});

/** The invitation page of the dashboard. The secret is in the fragment, which no request carries. */
const invitationLink = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
  // Authentication refuses a request whose origin is not the Worker's, so this is the Worker's origin.
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  return `${new URL(request.url).origin}/invitation#${Redacted.value(token)}`;
});

/** Send the invitation email, and tell what became of it. A failure never fails the invitation. */
const sendInvitation = Effect.fnUntraced(function* (
  address: string,
  link: string,
  expiresAt: number,
  language: typeof InviteMember.Type.language,
) {
  const recipients = parseEmailRecipients([address]);
  if (Result.isFailure(recipients)) return "failed" satisfies InvitationEmail;
  const email = yield* EmailSender;
  const { subject, text } = invitationEmail(link, expiresAt, language ?? defaultEmailLanguage);
  return yield* email.sender.pipe(
    Effect.flatMap((from) =>
      email.send({
        from,
        to: recipients.success,
        replyTo: Option.none(),
        subject,
        text,
        idempotencyKey: SecureRandom.uuidV4Unsafe(),
      }),
    ),
    Effect.timeout(Duration.seconds(30)),
    Effect.as<InvitationEmail>("sent"),
    Effect.catchTag("EmailProviderMissing", () => Effect.succeed<InvitationEmail>("no-provider")),
    Effect.tapError((error) => Effect.logWarning("Invitation email failed", { tag: error._tag })),
    Effect.orElseSucceed((): InvitationEmail => "failed"),
  );
});

const invite = Effect.gen(function* () {
  const scope = yield* administrator;
  const input = yield* HttpServerRequest.schemaBodyJson(InviteMember, {
    onExcessProperty: "error",
  });
  const members = yield* Members;
  const created = yield* members.invite(scope, input.email, input.role);
  const link = yield* invitationLink(created.token);
  const email = created.mayEmail
    ? yield* sendInvitation(
        created.invitation.email,
        link,
        created.invitation.expiresAt,
        input.language,
      )
    : ("limit-reached" as const);
  return yield* HttpServerResponse.schemaJson(IssuedInvitation)(
    { invitation: created.invitation, link: Redacted.make(link), email },
    { status: 201, ...jsonOptions },
  );
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const cancel = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaParams(CancelParams);
  const scope = yield* administrator;
  const members = yield* Members;
  yield* members.cancelInvitation(scope, id);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const changeRole = Effect.gen(function* () {
  const { userId: member } = yield* HttpRouter.schemaPathParams(MemberPath);
  const scope = yield* administrator;
  const { role } = yield* HttpServerRequest.schemaBodyJson(ChangeMemberRole, {
    onExcessProperty: "error",
  });
  const members = yield* Members;
  const changed = yield* members.changeRole(scope, member, role);
  return yield* HttpServerResponse.schemaJson(Member)(changed, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const remove = Effect.gen(function* () {
  const { userId: member } = yield* HttpRouter.schemaPathParams(MemberPath);
  const scope = yield* administrator;
  const members = yield* Members;
  yield* members.remove(scope, member);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const organization = "/api/organizations/:organizationId";

export const memberRoutes = Layer.mergeAll(
  HttpRouter.add("GET", `${organization}/members`, withErrors(list)),
  HttpRouter.add("PATCH", `${organization}/members/:userId`, withErrors(changeRole)),
  HttpRouter.add("DELETE", `${organization}/members/:userId`, withErrors(remove)),
  HttpRouter.add("POST", `${organization}/invitations`, withErrors(invite)),
  HttpRouter.add("DELETE", `${organization}/invitations`, withErrors(cancel)),
);
