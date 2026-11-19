import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable(
  "organizations",
  {
    id: text().primaryKey(),
    name: text().notNull(),
  },
  // SQLite permits NULL in a non-integer primary key unless explicitly constrained.
  (table) => [check("organizations_id_not_null", sql`${table.id} is not null`)],
);

export const forms = sqliteTable(
  "forms",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    publicId: text("public_id").notNull().unique(),
    name: text().notNull(),
  },
  (table) => [
    check("forms_id_not_null", sql`${table.id} is not null`),
    index("forms_organization_id_idx").on(table.organizationId),
  ],
);
