import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

it.effect("distinguishes known permanent binding errors from retryable failures", () =>
  Effect.gen(function* () {
    const cases = [
      { message: "AiGatewayError: 7003: User Input Error", retryable: false },
      { message: "5007: No such model", retryable: false },
      { message: "AiGatewayError: 2005: Failed to get a response", retryable: true },
      { message: "3040: Out of capacity", retryable: true },
      { message: "9999: Unknown error code", retryable: true },
      { message: "Network error", retryable: true },
    ];
    for (const score of [scoreWithJev, scoreWithOpenAi]) {
      for (const { message, retryable } of cases) {
        const failure = yield* Effect.flip(
          score({ run: () => Promise.reject(new Error(message)) }, { message: "Hello" }, ""),
        );
        assert.strictEqual(failure.retryable, retryable, message);
      }
    }
  }),
);

it.effect("aborts a binding call when the classifier times out", () =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(services);
    for (const score of [scoreWithJev, scoreWithOpenAi]) {
      let aborted = false;
      const call = score(
        {
          run: (_model, _input, { signal }) =>
            runPromise(
              Effect.callback<{ aborted: boolean }>((resume) => {
                signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    resume(Effect.succeed({ aborted: true }));
                  },
                  { once: true },
                );
              }),
            ),
        },
        { message: "Hello" },
        "",
      );
      const fiber = yield* call.pipe(Effect.timeout("12 seconds"), Effect.forkChild);
      yield* TestClock.adjust("12 seconds");
      const failure = yield* Effect.flip(Fiber.join(fiber));
      assert.strictEqual(failure._tag, "TimeoutError");
      assert.isTrue(aborted);
    }
  }),
);
