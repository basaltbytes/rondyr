import { Effect, Layer, Schema } from "effect";

import { OrganizationClassificationPolicy } from "../../domain/organizations/organization-classification-policy.ts";
import {
  ClassifierProvider,
  defaultClassificationPolicies,
  defaultClassifier,
} from "../../domain/submissions/classification-policy.ts";
import type { OrganizationId } from "../../domain/submissions/submission.id.ts";
import {
  ClassificationPolicies,
  ClassificationPolicyNotFound,
  ClassificationPolicyUnreadable,
} from "../../ports/classification-policies.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const policyJson = Schema.fromJsonString(OrganizationClassificationPolicy);
const encodePolicy = Schema.encodeEffect(policyJson);
const decodePolicy = Schema.decodeUnknownEffect(
  Schema.Struct({ policy: Schema.NullOr(policyJson) }),
);
const decodeProvider = Schema.decodeUnknownEffect(ClassifierProvider);
const unavailable = () => StorageUnavailable.make();
const unreadable = () => ClassificationPolicyUnreadable.make();

const configuredClassifier = Effect.gen(function* () {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  return yield* decodeProvider(env.RONDYR_CLASSIFIER ?? defaultClassifier).pipe(
    Effect.mapError(unreadable),
  );
});

const membership = "SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2";
const scopedPolicy = `
  SELECT (SELECT policy FROM organization_classification_policies WHERE organization_id = ?2)
    AS policy WHERE EXISTS (${membership})
`;

const resolve = Effect.fn("ClassificationPolicies.resolve")(function* (
  organizationId: OrganizationId,
) {
  const classifier = yield* configuredClassifier;
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      SELECT (SELECT policy FROM organization_classification_policies WHERE organization_id = ?)
        AS policy
    `)
      .bind(organizationId)
      .first(),
  );
  const { policy: override } = yield* decodePolicy(row).pipe(Effect.mapError(unreadable));
  const defaults = defaultClassificationPolicies[classifier];
  return { classifier, policy: { ...defaults, ...override } };
});

const settings = Effect.fn("ClassificationPolicies.settings")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const row = yield* d1(() =>
    db.prepare(scopedPolicy).bind(scope.userId, scope.organizationId).first(),
  );
  if (row === null) return yield* ClassificationPolicyNotFound.make();
  const { policy: override } = yield* decodePolicy(row).pipe(Effect.mapError(unreadable));
  const classifier = yield* configuredClassifier;
  return { classifier, defaults: defaultClassificationPolicies[classifier], override };
});

const save = Effect.fn("ClassificationPolicies.save")(function* (
  scope: OrganizationScope,
  override: OrganizationClassificationPolicy | null,
) {
  const db = yield* database;
  const key = [scope.userId, scope.organizationId] as const;
  const policy =
    override === null ? null : yield* encodePolicy(override).pipe(Effect.mapError(unavailable));
  const write =
    policy === null
      ? db
          .prepare(`
        DELETE FROM organization_classification_policies
        WHERE organization_id = ?2 AND EXISTS (${membership})
      `)
          .bind(...key)
      : db
          .prepare(`
        INSERT INTO organization_classification_policies (organization_id, policy)
        SELECT ?2, ?3 WHERE EXISTS (${membership})
        ON CONFLICT (organization_id) DO UPDATE SET policy = excluded.policy
      `)
          .bind(...key, policy);
  const [, after] = yield* d1(() => db.batch([write, db.prepare(scopedPolicy).bind(...key)]));
  if (after?.results[0] === undefined) return yield* ClassificationPolicyNotFound.make();
});

export const classificationPoliciesLive = Layer.succeed(ClassificationPolicies, {
  resolve,
  settings,
  save,
});
