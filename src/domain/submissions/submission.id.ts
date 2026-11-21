import { Schema } from "effect";

const StoredId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const SubmissionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
).pipe(Schema.brand("SubmissionId"));

export const OrganizationId = StoredId.pipe(Schema.brand("OrganizationId"));

export const FormId = StoredId.pipe(Schema.brand("FormId"));

export const ApiTokenId = StoredId.pipe(Schema.brand("ApiTokenId"));
export type ApiTokenId = typeof ApiTokenId.Type;

export const UserId = StoredId.pipe(Schema.brand("UserId"));
export type SubmissionId = typeof SubmissionId.Type;
export type OrganizationId = typeof OrganizationId.Type;
