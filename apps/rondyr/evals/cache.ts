import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";
import { Digest } from "effect/crypto";

import { ClassificationScores } from "../src/domain/submissions/classification.ts";
import { ClassifierInput } from "../src/domain/submissions/classifier-input.ts";
import type { ClassifierName } from "./classifiers.ts";
import type { EntryId } from "./corpus.ts";
import type { Transport } from "./workers-ai.ts";

/** Token counts as the model pages document them. Other keys are ignored. */
export const Usage = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  input_tokens_details: Schema.optionalKey(
    Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Int) }),
  ),
});

export type Usage = typeof Usage.Type;

export const ScoredCall = Schema.Struct({
  scores: ClassificationScores,
  latencyMs: Schema.Finite,
  usage: Schema.optionalKey(Usage),
});

export type ScoredCall = typeof ScoredCall.Type;

export interface CacheKeyParts {
  readonly transport: Transport;
  readonly classifier: ClassifierName;
  readonly model: string;
  readonly scoringVersion: number;
  readonly entryId: EntryId;
  /** SHA-256 of the complete classifier input, including facts from earlier lines. */
  readonly inputDigest: string;
}

export function cacheKey(parts: CacheKeyParts) {
  return [
    parts.transport,
    parts.classifier,
    parts.model,
    `rules-${parts.scoringVersion}`,
    parts.entryId,
    parts.inputDigest,
  ].join("|");
}

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ClassifierInput));

export const inputDigest = Effect.fn("Cache.inputDigest")(function* (input: ClassifierInput) {
  const digest = yield* Digest.Digest;
  const json = yield* encodeInput(input).pipe(Effect.orDie);
  return yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(json));
});

const CacheLine = Schema.Struct({ key: Schema.String, call: ScoredCall });
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheLine));
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(CacheLine));

/** Scored calls from earlier runs. Failures are not kept, so a rerun tries them again. */
export class ResultCache extends Context.Service<
  ResultCache,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<ScoredCall>>;
    readonly put: (key: string, call: ScoredCall) => Effect.Effect<void>;
  }
>()("rondyr/evals/cache/ResultCache") {}

/**
 * `cache.jsonl` in the output directory, read once and appended after each scored call. An
 * unreadable line, such as one cut short by an interrupted run, is skipped.
 */
export const fileCache = (directory: string, mode: "read-only" | "read-write" = "read-write") =>
  Layer.effect(
    ResultCache,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = (yield* Path.Path).join(directory, "cache.jsonl");
      yield* fs.makeDirectory(directory, { recursive: true });
      const entries = new Map<string, ScoredCall>();
      const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
      // End a line cut short by an interrupted run, so that the next result starts on its own line.
      if (mode === "read-write" && text !== "" && !text.endsWith("\n")) {
        yield* fs.writeFileString(file, "\n", { flag: "a" });
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const decoded = yield* decodeLine(line).pipe(Effect.option);
        if (Option.isSome(decoded)) entries.set(decoded.value.key, decoded.value.call);
      }
      const writes = yield* Semaphore.make(1);
      return {
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(entries.get(key))),
        put: Effect.fn("ResultCache.put")(function* (key: string, call: ScoredCall) {
          if (mode === "read-only") return yield* Effect.die("Cannot write to a read-only cache.");
          entries.set(key, call);
          const line = yield* encodeLine({ key, call });
          yield* writes.withPermit(fs.writeFileString(file, `${line}\n`, { flag: "a" }));
        }, Effect.orDie),
      };
    }),
  );
