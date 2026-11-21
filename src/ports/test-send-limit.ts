import { Context, Effect, Schema } from "effect";

import type { TargetId } from "../domain/deliveries/delivery.ts";

/** The limit could not be checked: no test is sent. */
export class TestSendLimitUnavailable extends Schema.TaggedError<
  TestSendLimitUnavailable,
  { readonly brand: unique symbol }
>()("TestSendLimitUnavailable", {}) {}

/**
 * A limit on the test messages of one destination, counted before each test.
 * Each email test counts against the quota of the stage's email provider and
 * the reputation of its sending domain.
 */
export class TestSendLimit extends Context.Service<
  TestSendLimit,
  {
    /** Count one test of the target, and tell whether it is under its limit. */
    readonly admit: (
      targetId: typeof TargetId.Type,
    ) => Effect.Effect<boolean, TestSendLimitUnavailable>;
  }
>()("rondyr/ports/test-send-limit/TestSendLimit") {}
