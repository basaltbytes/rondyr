import { Schema } from "effect";

import { ClassificationPolicy, ClassifierProvider } from "../submissions/classification-policy.ts";

export const OrganizationClassificationPolicy = ClassificationPolicy.mapFields((fields) => ({
  thresholds: Schema.optionalKey(fields.thresholds),
  offTopic: Schema.optionalKey(fields.offTopic),
  escalation: fields.escalation,
}))
  .check(
    Schema.makeFilter(
      ({ thresholds, offTopic, escalation }) =>
        thresholds !== undefined ||
        offTopic !== undefined ||
        escalation !== undefined ||
        "Specify at least one override.",
    ),
  )
  .pipe(Schema.brand("OrganizationClassificationPolicy"));
export type OrganizationClassificationPolicy = typeof OrganizationClassificationPolicy.Type;

export const OrganizationClassificationSettings = Schema.Struct({
  classifier: ClassifierProvider,
  defaults: ClassificationPolicy,
  override: Schema.NullOr(OrganizationClassificationPolicy),
});
