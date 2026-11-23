import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url, Hex } from "effect/encoding";

import {
  ApiTokenList,
  ApiTokenSummary,
  maxActiveApiTokens,
  type ApiTokenInput,
} from "../../../domain/organizations/api-token.ts";
import { ApiTokenId } from "../../../domain/submissions/submission.id.ts";
import {
  ApiTokenLimit,
  ApiTokenNotFound,
  ApiTokenPrincipal,
  ApiTokens,
} from "../../ports/api-tokens.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const encoder = new TextEncoder();
const hashToken = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", encoder.encode(Redacted.value(token))),
    catch: () => StorageUnavailable.make(),
  });
  return Hex.encode(new Uint8Array(digest));
});

const unreadable = () => StorageUnavailable.make();
const columns = "id, name, token_suffix AS suffix, created_at AS createdAt";
const membership = "SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2";
const readToken = Schema.decodeUnknownEffect(ApiTokenSummary);
const readTokens = Schema.decodeUnknownEffect(ApiTokenList);
const readPrincipal = Schema.decodeUnknownEffect(ApiTokenPrincipal);
const readId = Schema.decodeUnknownEffect(Schema.Struct({ id: ApiTokenId }));

const verify = Effect.fn("ApiTokens.verify")(function* (token: Redacted.Redacted<string>) {
  if (!/^rdr_[A-Za-z0-9_-]{43}$/u.test(Redacted.value(token))) return null;
  const hash = yield* hashToken(token);
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT id AS apiTokenId, organization_id AS organizationId
      FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL
    `)
      .bind(hash)
      .first(),
  );
  if (row === null) return null;
  return yield* readPrincipal(row).pipe(Effect.mapError(unreadable));
});

const list = Effect.fn("ApiTokens.list")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const key = [scope.userId, scope.organizationId] as const;
  const [member, rows] = yield* d1(() =>
    db.batch([
      db.prepare(membership).bind(...key),
      db
        .prepare(`
        SELECT ${columns} FROM api_tokens
        WHERE organization_id = ?2 AND revoked_at IS NULL AND EXISTS (${membership})
        ORDER BY created_at DESC, id
      `)
        .bind(...key),
    ]),
  );
  if (member?.results.length === 0) return yield* ApiTokenNotFound.make();
  return yield* readTokens(rows?.results).pipe(Effect.mapError(unreadable));
});

const create = Effect.fn("ApiTokens.create")(function* (
  scope: OrganizationScope,
  { name }: typeof ApiTokenInput.Type,
) {
  const db = yield* database;
  const token = Redacted.make(`rdr_${Base64Url.encode(SecureRandom.randomBytesUnsafe(32))}`);
  const hash = yield* hashToken(token);
  const suffix = Redacted.value(token).slice(-4);
  const id = SecureRandom.uuidV4Unsafe();
  const createdAt = yield* Clock.currentTimeMillis;
  const key = [scope.userId, scope.organizationId] as const;
  // The count and insertion execute in a single statement, including under concurrent creation.
  const [inserted, member] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO api_tokens (created_by, organization_id, id, name, token_hash, token_suffix, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (${membership})
          AND (SELECT count(*) FROM api_tokens WHERE organization_id = ?2 AND revoked_at IS NULL) < ?8
        RETURNING ${columns}
      `)
        .bind(...key, id, name, hash, suffix, createdAt, maxActiveApiTokens),
      db.prepare(membership).bind(...key),
    ]),
  );
  const row = inserted?.results[0];
  if (row === undefined) {
    if (member?.results.length === 0) return yield* ApiTokenNotFound.make();
    return yield* ApiTokenLimit.make();
  }
  const summary = yield* readToken(row).pipe(Effect.mapError(unreadable));
  return { ...summary, token };
});

const revoke = Effect.fn("ApiTokens.revoke")(function* (scope: OrganizationScope, id: ApiTokenId) {
  const db = yield* database;
  const revokedAt = yield* Clock.currentTimeMillis;
  const row = yield* d1(() =>
    db
      .prepare(`
      UPDATE api_tokens SET revoked_at = ?4
      WHERE id = ?3 AND organization_id = ?2 AND revoked_at IS NULL AND EXISTS (${membership})
      RETURNING id
    `)
      .bind(scope.userId, scope.organizationId, id, revokedAt)
      .first(),
  );
  if (row === null) return yield* ApiTokenNotFound.make();
  yield* readId(row).pipe(Effect.mapError(unreadable));
});

export const apiTokensLive = Layer.succeed(ApiTokens, { verify, list, create, revoke });
