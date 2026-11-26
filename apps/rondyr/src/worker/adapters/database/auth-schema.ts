import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("auth_users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "auth_sessions",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [index("auth_sessions_user_id_idx").on(table.userId)],
);

export const passkey = sqliteTable(
  "auth_passkeys",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    algorithm: integer().notNull(),
    counter: integer().notNull().default(0),
    transports: text(),
    rpId: text("rp_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("auth_passkeys_user_id_idx").on(table.userId)],
);

export const challenge = sqliteTable(
  "auth_challenges",
  {
    id: text().primaryKey(),
    purpose: text().notNull(),
    challengeHash: text("challenge_hash").notNull().unique(),
    payloadJson: text("payload_json").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("auth_challenges_expires_at_idx").on(table.expiresAt)],
);

export const emailOtp = sqliteTable(
  "auth_email_otps",
  {
    id: text().primaryKey(),
    email: text().notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer().notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("auth_email_otps_email_created_idx").on(table.email, table.createdAt),
    index("auth_email_otps_expires_at_idx").on(table.expiresAt),
  ],
);
