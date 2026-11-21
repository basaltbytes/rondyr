import { Schema } from "effect";

/**
 * The role of a member in an organization. A `reviewer` reads the Inbox and
 * the delivery history, accepts and archives. An `admin` does everything.
 */
export const MemberRole = Schema.Literals(["reviewer", "admin"]);
export type MemberRole = typeof MemberRole.Type;

/** An action in an organization that a role allows or not. */
export const Permission = Schema.Literals([
  "read-inbox",
  "review-submissions",
  "read-deliveries",
  "retry-deliveries",
  "test-destinations",
  "manage-forms",
  "manage-destinations",
  "manage-members",
  "manage-settings",
  "manage-api-tokens",
  "read-operations",
  "retry-stuck-submissions",
  "export-submissions",
  "delete-submissions",
  "manage-retention",
]);
export type Permission = typeof Permission.Type;

const reviewerPermissions: ReadonlyArray<Permission> = [
  "read-inbox",
  "review-submissions",
  "read-deliveries",
];

/**
 * Whether `role` allows `permission`. Every right in an organization is decided
 * here: by the administration routes and by the review session of the domain.
 */
export function allows(role: MemberRole, permission: Permission): boolean {
  return role === "admin" || reviewerPermissions.includes(permission);
}

/** An API token acts with the rights of a reviewer of its organization, and never more. */
export const apiTokenRole: MemberRole = "reviewer";
