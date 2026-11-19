import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { drizzle } from "drizzle-orm/d1";
import { Redacted } from "effect";

import * as schema from "../database/auth-schema.ts";

export function createBetterAuth(
  database: D1Database,
  origin: string,
  secret: Redacted.Redacted<string>,
) {
  return betterAuth({
    appName: "Rondyr",
    baseURL: origin,
    secret: Redacted.value(secret),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    database: drizzleAdapter(drizzle(database), { provider: "sqlite", schema }),
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}
