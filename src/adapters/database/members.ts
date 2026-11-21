import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { MemberRole } from "../../domain/organizations/member-role.ts";
import {
  invitationLifetimeMillis,
  InvitationId,
  invitationEmailsPerDay,
  InvitationSummary,
  maxPendingInvitations,
  Member,
  PendingInvitation,
} from "../../domain/organizations/members.ts";
import { OrganizationId, type UserId } from "../../domain/submissions/submission.id.ts";
import {
  AlreadyMember,
  InvitationForOtherAccount,
  InvitationLimit,
  InvitationNeedsSignIn,
  InvitationNotFound,
  LastAdmin,
  MemberNotFound,
  Members,
  type NewAccount,
} from "../../ports/members.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";
import { hashSecret, newLinkSecret } from "./secret-hash.ts";

const dayMillis = 24 * 60 * 60 * 1000;
const unreadable = () => StorageUnavailable.make();

const decodeMembers = Schema.decodeUnknownEffect(Schema.Array(Member));
const decodeInvitations = Schema.decodeUnknownEffect(Schema.Array(PendingInvitation));
const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ total: Schema.Int }));
const decodeFlags = Schema.decodeUnknownEffect(
  Schema.Struct({ member: Schema.Literals([0, 1]), joined: Schema.Literals([0, 1]) }),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));
const decodeJoined = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ organizationId: OrganizationId })),
);
const decodeSummary = Schema.decodeUnknownEffect(
  Schema.Struct({
    organizationName: InvitationSummary.fields.organizationName,
    email: InvitationSummary.fields.email,
    role: MemberRole,
    existing: Schema.Literals([0, 1]),
  }),
);
const decodeValid = Schema.decodeUnknownEffect(
  Schema.Struct({ valid: Schema.Literals([0, 1]), existing: Schema.Literals([0, 1]) }),
);

// ?1 is the acting account and ?2 the organization in every statement scoped to one.
const actor = "SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2";
const memberColumns = "u.id AS userId, u.name, u.email, m.role";
const invitationColumns = "id, email, role, created_at AS createdAt, expires_at AS expiresAt";
const admins =
  "SELECT count(*) FROM organization_members WHERE organization_id = ?2 AND role = 'admin'";
// An invitation is usable while nobody has accepted or cancelled it and it has not expired.
const usable = (now: string) =>
  `i.accepted_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > ${now}`;

const list = Effect.fn("Members.list")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const key = [scope.userId, scope.organizationId] as const;
  const [member, members, invitations] = yield* d1(() =>
    db.batch([
      db.prepare(actor).bind(...key),
      db
        .prepare(`
        SELECT ${memberColumns} FROM organization_members m JOIN auth_users u ON u.id = m.user_id
        WHERE m.organization_id = ?2 AND EXISTS (${actor}) ORDER BY lower(u.name), u.id
      `)
        .bind(...key),
      db
        .prepare(`
        SELECT ${invitationColumns} FROM organization_invitations
        WHERE organization_id = ?2 AND accepted_at IS NULL AND cancelled_at IS NULL
          AND EXISTS (${actor})
        ORDER BY created_at DESC, id
      `)
        .bind(...key),
    ]),
  );
  if (member?.results.length === 0) return yield* MemberNotFound.make();
  return {
    members: yield* decodeMembers(members?.results).pipe(Effect.mapError(unreadable)),
    invitations: yield* decodeInvitations(invitations?.results).pipe(Effect.mapError(unreadable)),
  };
});

const invite = Effect.fn("Members.invite")(function* (
  scope: OrganizationScope,
  address: string,
  role: MemberRole,
) {
  const db = yield* database;
  const email = address.toLowerCase();
  const id = InvitationId.make(SecureRandom.uuidV4Unsafe());
  const token = newLinkSecret();
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  // ?3 is the address, ?4 the time. A new invitation replaces the pending one of
  // the same address; both statements have the same conditions, so either both
  // apply or neither does.
  const admissible = `
    EXISTS (${actor})
    AND NOT EXISTS (
      SELECT 1 FROM organization_members m JOIN auth_users u ON u.id = m.user_id
      WHERE m.organization_id = ?2 AND lower(u.email) = ?3
    )
    AND (
      SELECT count(*) FROM organization_invitations i
      WHERE i.organization_id = ?2 AND i.email <> ?3 AND ${usable("?4")}
    ) < ?5
  `;
  const key = [scope.userId, scope.organizationId, email, now, maxPendingInvitations] as const;
  const [, sent, inserted, flags] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        UPDATE organization_invitations SET cancelled_at = ?4
        WHERE organization_id = ?2 AND email = ?3 AND accepted_at IS NULL AND cancelled_at IS NULL
          AND ${admissible}
      `)
        .bind(...key),
      db
        .prepare(
          "SELECT count(*) AS total FROM organization_invitations WHERE email = ? AND created_at > ?",
        )
        .bind(email, now - dayMillis),
      db
        .prepare(`
        INSERT INTO organization_invitations
          (id, organization_id, email, role, token_hash, created_by, created_at, expires_at)
        SELECT ?6, ?2, ?3, ?7, ?8, ?1, ?4, ?9 WHERE ${admissible}
        RETURNING ${invitationColumns}
      `)
        .bind(...key, id, role, tokenHash, now + invitationLifetimeMillis),
      db
        .prepare(`
        SELECT EXISTS (${actor}) AS member, EXISTS (
          SELECT 1 FROM organization_members m JOIN auth_users u ON u.id = m.user_id
          WHERE m.organization_id = ?2 AND lower(u.email) = ?3
        ) AS joined
      `)
        .bind(scope.userId, scope.organizationId, email),
    ]),
  );
  const [invitation] = yield* decodeInvitations(inserted?.results).pipe(
    Effect.mapError(unreadable),
  );
  if (invitation === undefined) {
    const state = yield* decodeFlags(flags?.results[0]).pipe(Effect.mapError(unreadable));
    if (state.member === 0) return yield* MemberNotFound.make();
    if (state.joined === 1) return yield* AlreadyMember.make();
    return yield* InvitationLimit.make();
  }
  const { total } = yield* decodeCount(sent?.results[0]).pipe(Effect.mapError(unreadable));
  return { invitation, token, mayEmail: total < invitationEmailsPerDay };
});

const cancelInvitation = Effect.fn("Members.cancelInvitation")(function* (
  scope: OrganizationScope,
  id: InvitationId,
) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* d1(() =>
    db
      .prepare(`
      UPDATE organization_invitations SET cancelled_at = ?4
      WHERE id = ?3 AND organization_id = ?2 AND accepted_at IS NULL AND cancelled_at IS NULL
        AND EXISTS (${actor})
      RETURNING id
    `)
      .bind(scope.userId, scope.organizationId, id, now)
      .all(),
  );
  const cancelled = yield* decodeIds(rows.results).pipe(Effect.mapError(unreadable));
  if (cancelled.length === 0) return yield* InvitationNotFound.make();
});

const memberQuery = `
  SELECT ${memberColumns} FROM organization_members m JOIN auth_users u ON u.id = m.user_id
  WHERE m.organization_id = ?2 AND m.user_id = ?3 AND EXISTS (${actor})
`;

// ?2 is the organization, ?3 the member and ?4 the time. A member who loses the
// admin role, or the organization, keeps no invitation that it issued: one of
// them could bring it back, as an admin or under another address.
const withdrawInvitations = `
  UPDATE organization_invitations SET cancelled_at = ?4
  WHERE organization_id = ?2 AND created_by = ?3 AND accepted_at IS NULL AND cancelled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM organization_members
      WHERE organization_id = ?2 AND user_id = ?3 AND role = 'admin'
    )
`;

const changeRole = Effect.fn("Members.changeRole")(function* (
  scope: OrganizationScope,
  member: typeof UserId.Type,
  role: MemberRole,
) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  const key = [scope.userId, scope.organizationId, member] as const;
  // The last admin keeps the role: the condition is part of the statement, so two
  // admins who demote each other at the same time cannot both succeed.
  const [changed, , current] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        UPDATE organization_members SET role = ?4
        WHERE organization_id = ?2 AND user_id = ?3 AND EXISTS (${actor})
          AND (?4 = 'admin' OR role <> 'admin' OR (${admins}) > 1)
        RETURNING user_id AS id
      `)
        .bind(...key, role),
      db.prepare(withdrawInvitations).bind(...key, now),
      db.prepare(memberQuery).bind(...key),
    ]),
  );
  const [row] = yield* decodeMembers(current?.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* MemberNotFound.make();
  const updated = yield* decodeIds(changed?.results).pipe(Effect.mapError(unreadable));
  if (updated.length === 0) return yield* LastAdmin.make();
  return row;
});

const remove = Effect.fn("Members.remove")(function* (
  scope: OrganizationScope,
  member: typeof UserId.Type,
) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  const key = [scope.userId, scope.organizationId, member] as const;
  // A removed member knows the API tokens it created and the links it issued:
  // the same transaction revokes them, so none of them keeps the access.
  const [removed, , , current] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        DELETE FROM organization_members
        WHERE organization_id = ?2 AND user_id = ?3 AND EXISTS (${actor})
          AND (role <> 'admin' OR (${admins}) > 1)
        RETURNING user_id AS id
      `)
        .bind(...key),
      db
        .prepare(`
        UPDATE api_tokens SET revoked_at = ?4
        WHERE organization_id = ?2 AND created_by = ?3 AND revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM organization_members WHERE organization_id = ?2 AND user_id = ?3
          )
      `)
        .bind(...key, now),
      db.prepare(withdrawInvitations).bind(...key, now),
      db.prepare(memberQuery).bind(...key),
    ]),
  );
  const deleted = yield* decodeIds(removed?.results).pipe(Effect.mapError(unreadable));
  if (deleted.length > 0) return;
  const [row] = yield* decodeMembers(current?.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* MemberNotFound.make();
  return yield* LastAdmin.make();
});

const readInvitation = Effect.fn("Members.readInvitation")(function* (
  token: Redacted.Redacted<string>,
) {
  const db = yield* database;
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT o.name AS organizationName, i.email, i.role,
        EXISTS (SELECT 1 FROM auth_users u WHERE lower(u.email) = i.email) AS existing
      FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = ?1 AND ${usable("?2")}
    `)
      .bind(tokenHash, now)
      .first(),
  );
  if (row === null) return yield* InvitationNotFound.make();
  const { existing, ...summary } = yield* decodeSummary(row).pipe(Effect.mapError(unreadable));
  return { ...summary, account: existing === 1 ? ("existing" as const) : ("new" as const) };
});

const acceptAsAccount = Effect.fn("Members.acceptAsAccount")(function* (
  token: Redacted.Redacted<string>,
  account: typeof UserId.Type,
) {
  const db = yield* database;
  const tokenHash = yield* hashSecret(token);
  const now = yield* Clock.currentTimeMillis;
  // ?1 is the hash of the link, ?2 the account and ?3 the time.
  const invited = `
    FROM organization_invitations i JOIN auth_users u ON u.id = ?2 AND lower(u.email) = i.email
    WHERE i.token_hash = ?1 AND ${usable("?3")}
  `;
  const [, accepted, valid] = yield* d1(() =>
    db.batch([
      // An account that is already a member keeps its role.
      db
        .prepare(`
        INSERT INTO organization_members (organization_id, user_id, role)
        SELECT i.organization_id, u.id, i.role ${invited}
        ON CONFLICT (organization_id, user_id) DO NOTHING
      `)
        .bind(tokenHash, account, now),
      db
        .prepare(`
        UPDATE organization_invitations AS i SET accepted_at = ?3
        WHERE i.id IN (SELECT i.id ${invited})
        RETURNING organization_id AS organizationId
      `)
        .bind(tokenHash, account, now),
      db
        .prepare(`
        SELECT EXISTS (SELECT 1 FROM organization_invitations i WHERE i.token_hash = ?1 AND ${usable("?2")})
          AS valid, 0 AS existing
      `)
        .bind(tokenHash, now),
    ]),
  );
  const [joined] = yield* decodeJoined(accepted?.results).pipe(Effect.mapError(unreadable));
  if (joined !== undefined) return joined.organizationId;
  const state = yield* decodeValid(valid?.results[0]).pipe(Effect.mapError(unreadable));
  if (state.valid === 1) return yield* InvitationForOtherAccount.make();
  return yield* InvitationNotFound.make();
});

const passwordHash = Effect.fnUntraced(function* (password: Redacted.Redacted<string>) {
  // Better Auth's hash, which its sign-in verifies. Loaded only on this path.
  const { hashPassword } = yield* Effect.tryPromise({
    try: () => import("better-auth/crypto"),
    catch: unreadable,
  });
  return yield* Effect.tryPromise({
    try: () => hashPassword(Redacted.value(password)),
    catch: unreadable,
  });
});

const acceptWithNewAccount = Effect.fn("Members.acceptWithNewAccount")(function* (
  token: Redacted.Redacted<string>,
  account: NewAccount,
) {
  // A cheap read first: hashing a password costs CPU, which nobody should be
  // able to spend with a random link.
  const summary = yield* readInvitation(token);
  if (summary.account === "existing") return yield* InvitationNeedsSignIn.make();
  const db = yield* database;
  const tokenHash = yield* hashSecret(token);
  const password = yield* passwordHash(account.password);
  const now = yield* Clock.currentTimeMillis;
  const userId = SecureRandom.uuidV4Unsafe();
  // ?1 is the hash of the link, ?2 the new account and ?3 the time. The account
  // is created only for a usable invitation whose address has no account yet;
  // every other statement depends on that account, in one transaction.
  const created = "EXISTS (SELECT 1 FROM auth_users WHERE id = ?2)";
  const [, , , accepted, valid] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO auth_users (id, name, email, created_at, updated_at)
        SELECT ?2, ?4, i.email, ?3, ?3 FROM organization_invitations i
        WHERE i.token_hash = ?1 AND ${usable("?3")}
          AND NOT EXISTS (SELECT 1 FROM auth_users u WHERE lower(u.email) = i.email)
      `)
        .bind(tokenHash, userId, now, account.name),
      db
        .prepare(`
        INSERT INTO auth_accounts
          (id, user_id, account_id, provider_id, password, created_at, updated_at)
        SELECT ?2, ?2, ?2, 'credential', ?4, ?3, ?3 WHERE ${created}
      `)
        .bind(tokenHash, userId, now, password),
      db
        .prepare(`
        INSERT INTO organization_members (organization_id, user_id, role)
        SELECT i.organization_id, ?2, i.role FROM organization_invitations i
        WHERE i.token_hash = ?1 AND ${usable("?3")} AND ${created}
      `)
        .bind(tokenHash, userId, now),
      db
        .prepare(`
        UPDATE organization_invitations AS i SET accepted_at = ?3
        WHERE i.token_hash = ?1 AND ${usable("?3")} AND ${created}
        RETURNING organization_id AS organizationId
      `)
        .bind(tokenHash, userId, now),
      db
        .prepare(`
        SELECT EXISTS (SELECT 1 FROM organization_invitations i WHERE i.token_hash = ?1 AND ${usable("?2")})
          AS valid,
          EXISTS (
            SELECT 1 FROM organization_invitations i JOIN auth_users u ON lower(u.email) = i.email
            WHERE i.token_hash = ?1
          ) AS existing
      `)
        .bind(tokenHash, now),
    ]),
  );
  const [joined] = yield* decodeJoined(accepted?.results).pipe(Effect.mapError(unreadable));
  if (joined !== undefined) return joined.organizationId;
  const state = yield* decodeValid(valid?.results[0]).pipe(Effect.mapError(unreadable));
  if (state.valid === 1 && state.existing === 1) return yield* InvitationNeedsSignIn.make();
  return yield* InvitationNotFound.make();
});

export const membersLive = Layer.succeed(Members, {
  list,
  invite,
  cancelInvitation,
  changeRole,
  remove,
  readInvitation,
  acceptAsAccount,
  acceptWithNewAccount,
});
