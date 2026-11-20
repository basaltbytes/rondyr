import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { parseCorpus } from "./corpus.ts";
import { replay } from "./replay.ts";

const fields = (content: string) => ({ email: "worker@example.test", content });
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "counts earlier dated occurrences through the 30-day boundary and keeps undated history separate",
  () =>
    Effect.gen(function* () {
      const lines = yield* Effect.forEach(
        [
          { id: "day-31", received: "2026-11-01", fields: fields("separate") },
          { id: "undated", fields: fields("original"), duplicates: 2 },
          { id: "day-30", received: "2026-10-31", fields: fields("updated") },
          { id: "day-0", received: "2026-10-01", fields: fields("original"), duplicates: 2 },
        ],
        (entry) => encodeLine({ label: "spam", ...entry }),
      );
      const parsed = yield* parseCorpus("dated.jsonl", lines.join("\n"), "");
      const inputs = replay({ name: "dated", ...parsed });
      assert.deepEqual(
        inputs.map(({ entry, input, firstOccurrence }) => [
          String(entry.id),
          firstOccurrence,
          input?.facts.prior_same_sender,
          input?.facts.prior_same_content,
        ]),
        [
          ["undated", 1, 0, 0],
          ["undated", 2, 1, 1],
          ["day-0", 1, 0, 0],
          ["day-0", 2, 1, 1],
          ["day-30", 1, 2, 0],
          ["day-31", 1, 1, 0],
        ],
      );
    }),
);
