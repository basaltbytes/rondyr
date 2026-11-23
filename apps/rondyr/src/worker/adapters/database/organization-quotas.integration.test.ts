import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";

import { OrganizationId } from "../../../domain/submissions/submission.id.ts";
import { OrganizationQuotas } from "../../ports/organization-quotas.ts";
import { organizationQuotasLive } from "./organization-quotas.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const quotas = Effect.map(Layer.build(organizationQuotasLive), Context.get(OrganizationQuotas));

const readCounters = Schema.decodeUnknownEffect(
  Schema.Struct({
    current: Schema.Literals([0, 1]),
    submissions: Schema.Int,
    classifications: Schema.Int,
    junk: Schema.Int,
  }),
);

/** An organization with a counter row of `day`, an SQLite date expression. */
const seed = (organization: string, day: string, junk: number) =>
  Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        organization,
        organization,
      ),
      env.DB.prepare(`
        INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications, junk)
        VALUES (?, ${day}, 4, 2, ?)
      `).bind(organization, junk),
    ]),
  );

const counters = (organization: string) =>
  Effect.promise(() =>
    env.DB.prepare(`
      SELECT day = date('now') AS current, submissions, classifications, junk
      FROM organization_daily_usage WHERE organization_id = ?
    `)
      .bind(organization)
      .first(),
  ).pipe(Effect.flatMap(readCounters));

it.live("starts the junk count over when a reservation opens a new UTC day", () =>
  Effect.gen(function* () {
    yield* seed("reservation-new-day", "date('now', '-1 day')", 3);
    const { reserveClassification } = yield* quotas;

    const reserved = yield* reserveClassification(OrganizationId.make("reservation-new-day"));

    assert.strictEqual(reserved, "reserved");
    const counted = yield* counters("reservation-new-day");
    assert.deepEqual(counted, { current: 1, submissions: 0, classifications: 1, junk: 0 });
  }),
);

it.live("keeps the junk count of the current UTC day when a reservation counts", () =>
  Effect.gen(function* () {
    yield* seed("reservation-same-day", "date('now')", 3);
    const { reserveClassification } = yield* quotas;

    const reserved = yield* reserveClassification(OrganizationId.make("reservation-same-day"));

    assert.strictEqual(reserved, "reserved");
    const counted = yield* counters("reservation-same-day");
    assert.deepEqual(counted, { current: 1, submissions: 4, classifications: 3, junk: 3 });
  }),
);
